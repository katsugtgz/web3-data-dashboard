import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_DB_PATH, MIGRATIONS_DIR, migrate, openDb, resolveDbPath } from './db';

const MIGRATION_NAMES = [
  '0001_init.sql',
  '0002_feed.sql',
  '0003_p4.sql',
  '0004_tags.sql',
  '0005_d1_reads_and_ai_queue.sql',
  '0006_drop_verdict.sql',
  '0007_hardening_and_indexes.sql',
  '0008_reconcile_cluster_last_seen.sql',
  '0009_rich_metadata.sql',
];

function readMigration(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'radar-db-'));
}

describe('resolveDbPath', () => {
  test('defaults to ./data/radar.sqlite', () => {
    expect(resolveDbPath({})).toBe(DEFAULT_DB_PATH);
    expect(resolveDbPath({ DB_PATH: '   ' })).toBe(DEFAULT_DB_PATH);
  });

  test('honors DB_PATH, trimmed', () => {
    expect(resolveDbPath({ DB_PATH: ' /srv/radar/db.sqlite ' })).toBe('/srv/radar/db.sqlite');
  });
});

describe('openDb migrations', () => {
  test('fresh database applies every worker migration in lexical order', () => {
    const db = openDb(':memory:');
    const rows = db.sqlite.query('SELECT name FROM _migrations ORDER BY name').all() as { name: string }[];
    expect(rows.map(r => r.name)).toEqual(MIGRATION_NAMES);
    expect(db.migrations).toEqual(MIGRATION_NAMES);
    expect(db.sqlite.query('SELECT count(*) AS n FROM domain_meta').get()).toEqual({ n: 0 });
    db.close();
  });

  test('reopening an existing database applies nothing twice', async () => {
    const dir = tempDir();
    const path = join(dir, 'nested', 'radar.sqlite');
    const first = openDb(path);
    first.d1
      .prepare(`INSERT INTO sources (id, platform, handle, trust) VALUES ('telegram:demo', 'telegram', 'demo', 0.5)`)
      .run();
    first.close();

    const second = openDb(path);
    expect(second.migrations).toEqual([]);
    const row = await second.d1.prepare('SELECT handle, tags FROM sources').first<{ handle: string; tags: string }>();
    expect(row).toEqual({ handle: 'demo', tags: '[]' });
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('file database uses WAL, busy timeout 5000, synchronous NORMAL and foreign keys', () => {
    const dir = tempDir();
    const db = openDb(join(dir, 'radar.sqlite'));
    expect(db.sqlite.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(db.sqlite.query('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
    expect(db.sqlite.query('PRAGMA synchronous').get()).toEqual({ synchronous: 1 });
    expect(db.sqlite.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('database created by another migration tool (no _migrations table) is adopted, not re-run', () => {
    const sqlite = new Database(':memory:');
    for (const name of MIGRATION_NAMES) sqlite.exec(readMigration(name));
    sqlite.exec(`INSERT INTO clusters (id, project, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen)
      VALUES ('c1', 'Kept', '[]', '[]', 's', 'rule', 'ok', '[]', 5, 1, 1, 1)`);

    expect(migrate(sqlite)).toEqual(MIGRATION_NAMES);
    const names = (sqlite.query('SELECT name FROM _migrations').all() as { name: string }[]).map(r => r.name);
    expect(names).toEqual(MIGRATION_NAMES);
    expect(sqlite.query('SELECT project FROM clusters').get()).toEqual({ project: 'Kept' });
    sqlite.close();
  });

  test('untracked database stopped at migration 0004 finishes the remaining migrations', () => {
    const sqlite = new Database(':memory:');
    for (const name of MIGRATION_NAMES.slice(0, 4)) sqlite.exec(readMigration(name));

    expect(migrate(sqlite)).toEqual(MIGRATION_NAMES);
    expect(sqlite.query('SELECT trust_max FROM clusters LIMIT 1').all()).toEqual([]);
    expect(sqlite.query('PRAGMA table_info(sources)').all().map(r => (r as { name: string }).name)).toContain('next_poll_at');
    sqlite.close();
  });

  test('a migration added later is the only one applied on reopen', () => {
    const dir = tempDir();
    for (const name of MIGRATION_NAMES) copyFileSync(join(MIGRATIONS_DIR, name), join(dir, name));
    const sqlite = new Database(':memory:');
    expect(migrate(sqlite, dir)).toEqual(MIGRATION_NAMES);

    copyFileSync(join(MIGRATIONS_DIR, '0001_init.sql'), join(dir, '0010_notes.txt'));
    writeFileSync(join(dir, '0010_notes.sql'), 'CREATE TABLE notes (id INTEGER PRIMARY KEY);');
    expect(migrate(sqlite, dir)).toEqual(['0010_notes.sql']);
    expect(sqlite.query('SELECT count(*) AS n FROM _migrations').get()).toEqual({ n: 10 });
    expect(migrate(sqlite, dir)).toEqual([]);
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('an unopenable database fails with a hint instead of a bare SQLite error', () => {
    const dir = tempDir();
    expect(() => openDb(dir)).toThrow('Cannot open database');
    rmSync(dir, { recursive: true, force: true });
  });

  test('a failing migration rolls back and is not recorded', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '0001_init.sql'), 'CREATE TABLE half (id INTEGER);');
    writeFileSync(join(dir, '0002_bad.sql'), 'CREATE TABLE bad (id INTEGER);\nCREATE TABLE half (id INTEGER);\n');
    const sqlite = new Database(':memory:');

    expect(() => migrate(sqlite, dir)).toThrow('Migration 0002_bad.sql failed');
    const tables = sqlite
      .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map(r => (r as { name: string }).name);
    expect(tables).toEqual(['_migrations', 'half']);
    expect(sqlite.query('SELECT name FROM _migrations').all().map(r => (r as { name: string }).name)).toEqual(['0001_init.sql']);
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('D1 adapter', () => {
  function freshDb() {
    const db = openDb(':memory:');
    db.d1.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, n INTEGER)');
    return db;
  }

  test('prepare().bind().first() returns the row, one column, or null', async () => {
    const db = freshDb();
    const insert = () => db.d1.prepare('INSERT INTO items (name, n) VALUES (?1, ?2)').bind('a', 7).run();
    await insert();

    const stmt = db.d1.prepare('SELECT id, name, n FROM items WHERE name = ?1');
    expect(await stmt.bind('a').first()).toEqual({ id: 1, name: 'a', n: 7 });
    expect(await stmt.bind('a').first('n')).toBe(7);
    expect(await stmt.bind('missing').first('n')).toBeNull();
    expect(await stmt.bind('missing').first()).toBeNull();
    db.close();
  });

  test('first() sees RETURNING rows, as the worker cron gate requires', async () => {
    const db = freshDb();
    const claimed = await db.d1
      .prepare('INSERT INTO items (name, n) VALUES (?1, ?2) ON CONFLICT(name) DO NOTHING RETURNING id')
      .bind('a', 1)
      .first<number>('id');
    const again = await db.d1
      .prepare('INSERT INTO items (name, n) VALUES (?1, ?2) ON CONFLICT(name) DO NOTHING RETURNING id')
      .bind('a', 2)
      .first<number>('id');
    expect(claimed).toBe(1);
    expect(again).toBeNull();
    db.close();
  });

  test('run() and all() return D1 result shapes', async () => {
    const db = freshDb();
    const run = await db.d1.prepare('INSERT INTO items (name, n) VALUES (?1, ?2)').bind('a', 1).run();
    expect(run.success).toBe(true);
    expect(run.meta?.changes).toBe(1);
    expect(run.meta?.last_row_id).toBe(1);

    const all = await db.d1.prepare('SELECT name FROM items ORDER BY id').all<{ name: string }>();
    expect(all.results).toEqual([{ name: 'a' }]);
    expect(all.success).toBe(true);

    const none = await db.d1.prepare('SELECT name FROM items WHERE n = 99').all();
    expect(none.results).toEqual([]);
    db.close();
  });

  test('bind() accepts undefined and booleans the way SQL stores them', async () => {
    const db = freshDb();
    await db.d1.prepare('INSERT INTO items (name, n) VALUES (?1, ?2)').bind('a', undefined).run();
    await db.d1.prepare('INSERT INTO items (name, n) VALUES (?1, ?2)').bind('b', true).run();
    const rows = await db.d1.prepare('SELECT name, n FROM items ORDER BY id').all<{ name: string; n: number | null }>();
    expect(rows.results).toEqual([{ name: 'a', n: null }, { name: 'b', n: 1 }]);
    db.close();
  });

  test('bind() rejects a wrong parameter count instead of silently binding NULL', async () => {
    const db = freshDb();
    await expect(db.d1.prepare('INSERT INTO items (name, n) VALUES (?1, ?2)').bind('a').run()).rejects.toThrow();
    db.close();
  });

  test('exec() runs several statements', async () => {
    const db = freshDb();
    const res = await db.d1.exec("INSERT INTO items (name) VALUES ('x'); INSERT INTO items (name) VALUES ('y');");
    expect(res.count).toBeGreaterThan(0);
    expect(await db.d1.prepare('SELECT count(*) AS n FROM items').first('n')).toBe(2);
    db.close();
  });

  test('batch() is atomic: a failure rolls back every statement', async () => {
    const db = freshDb();
    const stmts = [
      db.d1.prepare('INSERT INTO items (name, n) VALUES (?1, 1)').bind('a'),
      db.d1.prepare('INSERT INTO items (name, n) VALUES (?1, 2)').bind('b'),
      db.d1.prepare('INSERT INTO items (name, n) VALUES (?1, 3)').bind('a'),
    ];
    await expect(db.d1.batch(stmts)).rejects.toThrow('UNIQUE');
    expect(await db.d1.prepare('SELECT count(*) AS n FROM items').first('n')).toBe(0);

    const ok = await db.d1.batch([
      db.d1.prepare('INSERT INTO items (name, n) VALUES (?1, ?2)').bind('a', 1),
      db.d1.prepare('UPDATE items SET n = ?1 WHERE name = ?2').bind(9, 'a'),
    ]);
    expect(ok.map(r => r.meta?.changes)).toEqual([1, 1]);
    expect(await db.d1.prepare('SELECT name, n FROM items').all()).toEqual<unknown>({
      results: [{ name: 'a', n: 9 }],
      success: true,
      meta: { changes: 0, duration: 0 },
    });
    expect(await db.d1.batch([])).toEqual([]);
    db.close();
  });

  test('concurrent batches never lose an update or interleave with each other', async () => {
    const db = freshDb();
    await db.d1.prepare('INSERT INTO items (name, n) VALUES (?1, 0)').bind('counter').run();
    const bump = () => db.d1.batch([db.d1.prepare('UPDATE items SET n = n + 1 WHERE name = ?1').bind('counter')]);
    await Promise.all(Array.from({ length: 200 }, bump));
    expect(await db.d1.prepare('SELECT n FROM items').first('n')).toBe(200);
    db.close();
  });
});
