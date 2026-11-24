/**
 * Gates periodic background work with a single D1 primary-key lookup so
 * sub-interval cron ticks exit without running or writing state.
 */
export async function runIfDue(
  db: D1Database,
  key: string,
  intervalMs: number,
  nowMs: number,
  fn: () => Promise<void>,
): Promise<boolean> {
  const row = await db
    .prepare('SELECT last_run_at FROM cron_state WHERE key = ?1')
    .bind(key)
    .first<{ last_run_at: number }>();

  if (row !== null && (nowMs < row.last_run_at || nowMs - row.last_run_at < intervalMs)) {
    return false;
  }

  await fn();

  await db
    .prepare(
      `INSERT INTO cron_state (key, last_run_at) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET last_run_at = excluded.last_run_at
       WHERE excluded.last_run_at >= cron_state.last_run_at`,
    )
    .bind(key, nowMs)
    .run();

  return true;
}
