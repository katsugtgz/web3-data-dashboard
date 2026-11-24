/**
 * Gates periodic background work with a single D1 primary-key lookup so
 * sub-interval cron ticks exit without running or writing state.
 * Atomically claims the execution slot before running `fn` and releases on failure.
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

  // Reserve before invoking `fn` so overlapping cron invocations cannot run concurrently.
  const claimed = await db
    .prepare(
      `INSERT INTO cron_state (key, last_run_at) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET last_run_at = excluded.last_run_at
       WHERE excluded.last_run_at >= cron_state.last_run_at
         AND excluded.last_run_at - cron_state.last_run_at >= ?3
       RETURNING last_run_at`,
    )
    .bind(key, nowMs, intervalMs)
    .first<{ last_run_at: number }>();

  if (claimed === null) {
    return false;
  }

  try {
    await fn();
    return true;
  } catch (err) {
    // Release our reservation only if no newer invocation overwrote last_run_at.
    try {
      if (row === null) {
        await db.prepare('DELETE FROM cron_state WHERE key = ?1 AND last_run_at = ?2').bind(key, nowMs).run();
      } else {
        await db
          .prepare('UPDATE cron_state SET last_run_at = ?3 WHERE key = ?1 AND last_run_at = ?2')
          .bind(key, nowMs, row.last_run_at)
          .run();
      }
    } catch (rollbackErr) {
      console.error(`cron-gate-rollback:${key}`, rollbackErr);
    }
    throw err;
  }
}
