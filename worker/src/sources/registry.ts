import sourcesJson from '../../sources.json';

export type SourcePlatform = 'telegram' | 'x';

export interface SourceConfig {
  platform: SourcePlatform;
  handle: string;
  lang: string;
  trust: number;
  tags: string[];
  enabled: boolean;
}

const HANDLE_RE = /^[A-Za-z0-9_]{4,32}$/;

export function validateSources(raw: unknown): SourceConfig[] {
  if (!Array.isArray(raw)) {
    throw new Error('sources.json must be a JSON array');
  }
  const seen = new Set<string>();
  const out: SourceConfig[] = [];

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as Record<string, unknown> | null;
    if (!item || typeof item !== 'object') {
      throw new Error(`sources[${i}] must be an object`);
    }
    const platform = item.platform;
    if (platform !== 'telegram' && platform !== 'x') {
      throw new Error(`sources[${i}].platform invalid: ${String(platform)}`);
    }
    const handle = item.handle;
    if (typeof handle !== 'string' || !HANDLE_RE.test(handle)) {
      throw new Error(`sources[${i}].handle invalid: ${String(handle)}`);
    }
    const trust = item.trust;
    if (typeof trust !== 'number' || !Number.isFinite(trust) || trust < 0 || trust > 1) {
      throw new Error(`sources[${i}].trust out of [0,1]: ${String(trust)}`);
    }
    const key = `${platform}:${handle.toLowerCase()}`;
    if (seen.has(key)) {
      throw new Error(`Duplicate source ${platform}:${handle}`);
    }
    seen.add(key);

    const lang = typeof item.lang === 'string' && item.lang ? item.lang : 'en';
    const tags = Array.isArray(item.tags) ? item.tags.filter((t): t is string => typeof t === 'string') : [];
    const enabled = Boolean(item.enabled);
    out.push({ platform, handle, lang, trust, tags, enabled });
  }

  return out;
}

export const SEED_SOURCES: SourceConfig[] = validateSources(sourcesJson);

/**
 * Conditionally syncs `sources.json` into D1 with one table read and one
 * batch of guarded writes.
 *
 * Each write is a single statement whose WHERE guard makes it idempotent:
 *   INSERT … ON CONFLICT(id) DO UPDATE SET lang/trust/enabled …
 *   WHERE sources.lang IS NOT excluded.lang OR …
 *   UPDATE … SET lang/trust/enabled WHERE id = ? AND (lang IS NOT ?2 OR …)
 * - a missing source is inserted with fresh runtime defaults ('ok', 0);
 * - a present source is updated only when its config actually differs —
 *   `status`, `fail_count`, `next_poll_at`, `first_fail_at`, `last_seen_id`,
 *   `last_ok_at`, `last_polled_at` are never touched;
 * - an unchanged source matches no write at all (zero row writes, so the
 *   crons and any config refresh cost nothing while config is stable).
 *
 * The guards also make concurrent syncs (1-min and 5-min crons on a fresh
 * database in the same minute) race-safe: whichever statement loses commits
 * zero rows instead of clobbering the winner.
 *
 * Diffing runs against one full-table read of `sources` (63 rows today; an
 * IN-list prefilter was dropped because binding one parameter per source
 * would hit D1's 100-variable limit as the registry grows).
 */
export async function syncSources(db: D1Database, sources: SourceConfig[] = SEED_SOURCES): Promise<void> {
  if (sources.length === 0) return;

  const existingRes = await db.prepare('SELECT id, lang, trust, enabled FROM sources').all<{
    id: string;
    lang: string | null;
    trust: number;
    enabled: number;
  }>();
  const byId = new Map((existingRes.results ?? []).map(r => [r.id, r]));

  const stmts: D1PreparedStatement[] = [];
  for (const s of sources) {
    const id = `${s.platform}:${s.handle}`;
    const row = byId.get(id);
    if (row) {
      const langChanged = (row.lang ?? null) !== s.lang;
      const trustChanged = row.trust !== s.trust;
      const enabledChanged = (row.enabled === 1) !== s.enabled;
      if (!langChanged && !trustChanged && !enabledChanged) continue;
      stmts.push(
        db
          .prepare(
            `UPDATE sources
             SET lang = ?2, trust = ?3, enabled = ?4
             WHERE id = ?1
               AND (lang IS NOT ?2 OR trust IS NOT ?3 OR enabled IS NOT ?4)`,
          )
          .bind(id, s.lang, s.trust, s.enabled ? 1 : 0),
      );
    } else {
      stmts.push(
        db
          .prepare(
            `INSERT INTO sources (id, platform, handle, lang, trust, enabled, status, fail_count)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'ok', 0)
             ON CONFLICT(id) DO UPDATE SET
               lang = excluded.lang,
               trust = excluded.trust,
               enabled = excluded.enabled
             WHERE sources.lang IS NOT excluded.lang
                OR sources.trust IS NOT excluded.trust
                OR sources.enabled IS NOT excluded.enabled`,
          )
          .bind(id, s.platform, s.handle, s.lang, s.trust, s.enabled ? 1 : 0),
      );
    }
  }

  // D1 caps a batch at ~100 bound parameters: 6 per upsert, 4 per update →
  // chunks of 16. Chunks write disjoint rows and are order-independent, so
  // they run in parallel.
  await Promise.all(
    Array.from({ length: Math.ceil(stmts.length / 16) }, (_, i) =>
      db.batch(stmts.slice(i * 16, (i + 1) * 16)),
    ),
  );
}
