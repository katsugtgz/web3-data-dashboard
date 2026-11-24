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
         error = NULL
       -- Completion order ≠ scheduled order: a delayed overlapping cron must
       -- never overwrite a newer snapshot, so only advance fetched_at forward.
       WHERE excluded.fetched_at >= snapshots.fetched_at`,
    )
    .bind(key, body, etag, nowMs)
    .run();
  return etag;
}

export async function markSnapshotError(db: D1Database, key: string, error: unknown, nowMs: number): Promise<void> {
  const msg = (error instanceof Error ? error.message : String(error)).slice(0, 400);
  const body = '{}';
  const etag = `"${await sha1Hex(body)}"`;
  // Single atomic upsert: the old read-then-branch could hit a UNIQUE
  // violation against a concurrent upsertSnapshot and abort the cron.
  // Errors use the same fetched_at timestamp guard as upserts: a delayed
  // failed cron must never flip a NEWER successful snapshot back to ok=0
  // ("error marks only advance forward"). Body/etag of the last good
  // payload are left untouched, so health stays accurate while the last
  // good payload keeps serving; fetchedAt = last successful fetch.
  await db
    .prepare(
      `INSERT INTO snapshots (key, body, etag, fetched_at, ok, error)
       VALUES (?1, ?2, ?3, ?4, 0, ?5)
       ON CONFLICT(key) DO UPDATE SET
         ok = 0,
         error = excluded.error
       WHERE excluded.fetched_at >= snapshots.fetched_at`,
    )
    .bind(key, body, etag, nowMs, msg)
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

export async function listSnapshotsByPrefix(db: D1Database, prefix: string): Promise<SnapshotRow[]> {
  if (!prefix) {
    return listSnapshots(db);
  }
  const end = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
  const res = await db
    .prepare('SELECT key, body, etag, fetched_at, ok, error FROM snapshots WHERE key >= ?1 AND key < ?2 ORDER BY key ASC')
    .bind(prefix, end)
    .all<SnapshotRow>();
  return res.results ?? [];
}

export interface SnapshotMetaRow {
  key: string;
  fetched_at: number;
  ok: number;
  error: string | null;
}

/** /health only: skips the (large) body column so the no-store endpoint does
 *  not read both full payloads on every request. */
export async function listSnapshotMeta(db: D1Database): Promise<SnapshotMetaRow[]> {
  const res = await db
    .prepare('SELECT key, fetched_at, ok, error FROM snapshots ORDER BY key ASC')
    .all<SnapshotMetaRow>();
  return res.results ?? [];
}

export function toHealthMap(
  rows: (Pick<SnapshotRow, 'key' | 'fetched_at' | 'ok' | 'error'>)[],
): Record<string, HealthSnapshotStatus> {
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
