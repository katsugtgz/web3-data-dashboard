import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_DB_PATH = './data/radar.sqlite';
export const MIGRATIONS_DIR = fileURLToPath(new URL('../worker/migrations/', import.meta.url));

const MIGRATION_FILE_RE = /^\d+[\w-]*\.sql$/;
const IDENT = `["'\`\\[]?(\\w+)["'\`\\]]?`;
const ADD_COLUMN_RE = new RegExp(`\\bALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${IDENT}\\s+ADD\\s+(?:COLUMN\\s+)?${IDENT}`, 'gi');
const CREATE_OBJECT_RE = new RegExp(`\\bCREATE\\s+(?:UNIQUE\\s+)?(TABLE|INDEX|VIEW|TRIGGER)\\s+(?!IF\\s+NOT\\s+EXISTS)${IDENT}`, 'gi');

export function resolveDbPath(env: Record<string, string | undefined> = process.env): string {
  return env.DB_PATH?.trim() || DEFAULT_DB_PATH;
}

type Row = Record<string, unknown>;

function toSqlValue(value: unknown): unknown {
  if (value === undefined) return null;
  return typeof value === 'boolean' ? (value ? 1 : 0) : value;
}

function d1Result(changes: number, lastRowId?: number, results?: unknown[]) {
  return {
    ...(results ? { results } : {}),
    success: true,
    meta: { changes, ...(lastRowId === undefined ? {} : { last_row_id: lastRowId }), duration: 0 },
  };
}

class Stmt {
  constructor(
    private readonly sqlite: Database,
    readonly sql: string,
    private readonly params: readonly unknown[] = [],
  ) {}

  bind(...args: unknown[]): Stmt {
    return new Stmt(this.sqlite, this.sql, args);
  }

  private values(): SQLQueryBindings[] {
    return this.params.map(toSqlValue) as SQLQueryBindings[];
  }

  /** Synchronous on purpose: batch() must not yield between BEGIN and COMMIT. */
  runSync() {
    const query = this.sqlite.query(this.sql);
    const params = this.values();
    if (query.columnNames.length > 0) {
      const before = (this.sqlite.query('SELECT total_changes() AS n').get() as { n: number }).n;
      const results = query.all(...params);
      const after = this.sqlite
        .query('SELECT total_changes() AS n, last_insert_rowid() AS id')
        .get() as { n: number; id: number | bigint };
      const changes = after.n - before;
      return d1Result(changes, changes > 0 ? Number(after.id) : undefined, results);
    }
    const info = query.run(...params);
    return d1Result(info.changes, Number(info.lastInsertRowid), []);
  }

  async run() {
    return this.runSync();
  }

  async all<T = Row>() {
    const results = this.sqlite.query(this.sql).all(...this.values()) as T[];
    return d1Result(0, undefined, results);
  }

  async first<T = Row>(colName?: string) {
    const row = this.sqlite.query(this.sql).get(...this.values()) as Row | null;
    if (row == null) return null;
    return (colName === undefined ? row : (row[colName] ?? null)) as T | null;
  }
}

class SqliteD1 {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly sqlite: Database) {}

  prepare(sql: string): Stmt {
    return new Stmt(this.sqlite, sql);
  }

  batch(stmts: Stmt[]): Promise<ReturnType<Stmt['runSync']>[] | undefined[]> {
    if (stmts.length === 0) return Promise.resolve([]);
    const sqlite = this.sqlite;
    const run = () => {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const out = stmts.map(s => s.runSync());
        sqlite.exec('COMMIT');
        return out;
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async exec(sql: string) {
    this.sqlite.exec(sql);
    return { count: 1, duration: 0 };
  }
}

/** D1-shaped adapter over one bun:sqlite connection. */
export function createD1(sqlite: Database): D1Database {
  return new SqliteD1(sqlite) as unknown as D1Database;
}

function listMigrations(dir: string): string[] {
  return readdirSync(dir)
    .filter(name => MIGRATION_FILE_RE.test(name))
    .sort();
}

function objectExists(sqlite: Database, type: string, name: string): boolean {
  return (
    sqlite
      .query('SELECT 1 AS ok FROM sqlite_master WHERE type = ?1 AND name = ?2')
      .get(type.toLowerCase(), name.toLowerCase()) != null
  );
}

/**
 * True when `sql` has statements that would fail on replay (ADD COLUMN,
 * CREATE without IF NOT EXISTS) and every one of them is already part of the
 * schema. A migration without such statements returns false: replaying it is
 * always safe, and skipping it would leave a fresh database without its tables.
 */
function alreadyApplied(sqlite: Database, sql: string): boolean {
  const bare = sql.replace(/--[^\n]*/g, ' ');
  let checked = 0;
  for (const [, table, column] of bare.matchAll(ADD_COLUMN_RE)) {
    const found = sqlite
      .query('SELECT 1 AS ok FROM pragma_table_info(?1) WHERE name = ?2')
      .get(table.toLowerCase(), column.toLowerCase());
    if (found == null) return false;
    checked++;
  }
  for (const [, type, name] of bare.matchAll(CREATE_OBJECT_RE)) {
    if (!objectExists(sqlite, type, name)) return false;
    checked++;
  }
  return checked > 0;
}

/**
 * Applies worker/migrations/*.sql in lexical order, each in its own
 * transaction, and records filenames in `_migrations`. A database that already
 * carries the schema but no `_migrations` table (e.g. wrangler, or a D1 export)
 * is adopted without replaying. Returns the names recorded by this run.
 */
export function migrate(sqlite: Database, dir = MIGRATIONS_DIR): string[] {
  const tracked = objectExists(sqlite, 'table', '_migrations');
  sqlite.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const applied = new Set(
    (sqlite.query('SELECT name FROM _migrations').all() as { name: string }[]).map(r => r.name),
  );

  const recorded: string[] = [];
  for (const name of listMigrations(dir)) {
    if (applied.has(name)) continue;
    const sql = readFileSync(join(dir, name), 'utf8');
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      if (tracked || !alreadyApplied(sqlite, sql)) sqlite.exec(sql);
      sqlite.query('INSERT INTO _migrations (name, applied_at) VALUES (?1, ?2)').run(name, Date.now());
      sqlite.exec('COMMIT');
    } catch (err) {
      sqlite.exec('ROLLBACK');
      throw new Error(`Migration ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    recorded.push(name);
  }
  return recorded;
}

export interface RadarDb {
  path: string;
  sqlite: Database;
  d1: D1Database;
  /** Migrations applied (or adopted) by this open. */
  migrations: string[];
  close(): void;
}

export function openDb(path = resolveDbPath()): RadarDb {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  let sqlite: Database;
  try {
    sqlite = new Database(path, { create: true, strict: true });
    sqlite.exec(
      'PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;',
    );
  } catch (err) {
    // Most often the data directory is owned by another account (bind mount + container user).
    throw new Error(
      `Cannot open database at ${path}: ${err instanceof Error ? err.message : String(err)}. ` +
        'Make the directory writable for the server process (for the Docker stack: run deploy/srv2-deploy.sh, ' +
        'or chown the data directory to the container user set by RADAR_UID/RADAR_GID).',
    );
  }
  const migrations = migrate(sqlite);
  let closed = false;
  return {
    path,
    sqlite,
    d1: createD1(sqlite),
    migrations,
    close() {
      if (!closed) {
        closed = true;
        sqlite.close();
      }
    },
  };
}
