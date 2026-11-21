import type { HealthSnapshotStatus } from '../../../shared/types';
import { sha1Hex } from './hash';

export { sha1Hex };

export interface SnapshotRow {
  key: string;
  body: string;
  etag: string;
  fetched_at: number;
  ok: number;
  error: string | null;
}

export async function upsertSnapshot(db: D1Database, key: string, bodyObj: unknown, nowMs: number): Promise<string> {
  const body = JSON.stringify(bodyObj);
  const etag = `"${await sha1Hex(body)}"`;
  await db
    .prepare(
      `INSERT INTO snapshots (key, body, etag, fetched_at, ok, error)
       VALUES (?1, ?2, ?3, ?4, 1, NULL)
       ON CONFLICT(key) DO UPDATE SET
         body = excluded.body,
         etag = excluded.etag,
         fetched_at = excluded.fetched_at,
         ok = 1,
         error = NULL`,
    )
    .bind(key, body, etag, nowMs)
    .run();
  return etag;
}

export async function markSnapshotError(db: D1Database, key: string, error: unknown, nowMs: number): Promise<void> {
  const msg = error instanceof Error ? error.message : String(error);
  const existing = await readSnapshot(db, key);
  if (existing) {
    await db
      .prepare(`UPDATE snapshots SET ok = 0, error = ?2 WHERE key = ?1`)
      .bind(key, msg.slice(0, 400))
      .run();
    return;
  }
  const body = '{}';
  const etag = `"${await sha1Hex(body)}"`;
  await db
    .prepare(
      `INSERT INTO snapshots (key, body, etag, fetched_at, ok, error)
       VALUES (?1, ?2, ?3, ?4, 0, ?5)`,
    )
    .bind(key, body, etag, nowMs, msg.slice(0, 400))
    .run();
}

export async function readSnapshot(db: D1Database, key: string): Promise<SnapshotRow | null> {
  const row = await db
    .prepare('SELECT key, body, etag, fetched_at, ok, error FROM snapshots WHERE key = ?1')
    .bind(key)
    .first<SnapshotRow>();
  return row ?? null;
}

export async function listSnapshots(db: D1Database): Promise<SnapshotRow[]> {
  const res = await db
    .prepare('SELECT key, body, etag, fetched_at, ok, error FROM snapshots ORDER BY key ASC')
    .all<SnapshotRow>();
  return res.results ?? [];
}

export function toHealthMap(rows: SnapshotRow[]): Record<string, HealthSnapshotStatus> {
  const out: Record<string, HealthSnapshotStatus> = {};
  for (const r of rows) {
    out[r.key] = {
      fetchedAt: r.fetched_at,
      ok: r.ok === 1,
      error: r.error,
    };
  }
  return out;
}
