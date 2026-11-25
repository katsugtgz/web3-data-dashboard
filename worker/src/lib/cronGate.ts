const MAX_LEASE_MS = 5 * 60_000;

/**
 * Gates periodic background work with a single D1 primary-key lookup so
 * sub-interval cron ticks exit without running or writing state.
 * Atomically claims a short in-flight execution lease before running `fn`,
 * commits the full `nowMs` timestamp on success, and releases on failure.
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

  // Claim a short in-flight lease so overlapping invocations cannot run
  // concurrently, while an unhandled crash recovers after leaseMs instead
  // of locking out the job for the full intervalMs.
  const leaseMs = Math.max(0, Math.min(intervalMs, MAX_LEASE_MS));
  const leaseStamp = nowMs - intervalMs + leaseMs;

  const claimed = await db
    .prepare(
      `INSERT INTO cron_state (key, last_run_at) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET last_run_at = excluded.last_run_at
       WHERE ?4 >= cron_state.last_run_at
         AND ?4 - cron_state.last_run_at >= ?3
       RETURNING last_run_at`,
    )
    .bind(key, leaseStamp, intervalMs, nowMs)
    .first<{ last_run_at: number }>();

  if (claimed === null) {
    return false;
  }

  try {
    await fn();
  } catch (err) {
    // Release our reservation only if no newer invocation overwrote last_run_at.
    try {
      if (row === null) {
        await db.prepare('DELETE FROM cron_state WHERE key = ?1 AND last_run_at = ?2').bind(key, leaseStamp).run();
      } else {
        await db
          .prepare('UPDATE cron_state SET last_run_at = ?3 WHERE key = ?1 AND last_run_at = ?2')
          .bind(key, leaseStamp, row.last_run_at)
          .run();
      }
    } catch (rollbackErr) {
      console.error(`cron-gate-rollback:${key}`, rollbackErr);
    }
    throw err;
  }

  if (leaseStamp !== nowMs) {
    try {
      await db
        .prepare('UPDATE cron_state SET last_run_at = ?2 WHERE key = ?1 AND last_run_at = ?3')
        .bind(key, nowMs, leaseStamp)
        .run();
    } catch (commitErr) {
      console.error(`cron-gate-commit:${key}`, commitErr);
    }
  }
  return true;
}
