import sourcesJson from '../../sources.json';

export type SourcePlatform = 'telegram' | 'x' | 'sheet' | 'feed';

export const ALLOWED_SOURCE_PARSERS = [
  'asso7878',
  'arndxt',
  'rss',
  'wp_calendar',
  'substack',
  'galxe',
  'pendle',
  'merkl',
] as const;

export type SourceParser = (typeof ALLOWED_SOURCE_PARSERS)[number];

const ALLOWED_SOURCE_PARSER_SET: ReadonlySet<string> = new Set(ALLOWED_SOURCE_PARSERS);
const SHEET_SOURCE_PARSER_SET: ReadonlySet<SourceParser> = new Set(['asso7878', 'arndxt']);
const DROP_FEED_PARSER_SET: ReadonlySet<SourceParser> = new Set(['rss', 'wp_calendar', 'substack', 'galxe']);
const CURATED_FEED_PARSER_SET: ReadonlySet<SourceParser> = new Set(['wp_calendar', 'pendle', 'merkl']);
const FEED_SOURCE_PARSER_SET: ReadonlySet<SourceParser> = new Set([
  ...DROP_FEED_PARSER_SET,
  ...CURATED_FEED_PARSER_SET,
]);

export interface SourceConfig {
  platform: SourcePlatform;
  handle: string;
  lang: string;
  trust: number;
  tags: string[];
  enabled: boolean;
  url?: string;
  parser?: SourceParser;
}

const HANDLE_RE = /^[A-Za-z0-9_]{4,32}$/;

function validateHttpsUrl(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error(`${label} must be a valid https:// URL`);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error(`${label} invalid URL: ${raw}`);
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname) {
    throw new Error(`${label} must use https://: ${raw}`);
  }
  return parsed.toString();
}

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
    if (platform !== 'telegram' && platform !== 'x' && platform !== 'sheet' && platform !== 'feed') {
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
    // Strict boolean: Boolean("false") === true would silently enable a
    // source on a mistyped string, so reject non-boolean values instead.
    if (typeof item.enabled !== 'boolean') {
      throw new Error(`sources[${i}].enabled must be a boolean: ${String(item.enabled)}`);
    }
    const enabled = item.enabled;

    let url: string | undefined;
    if (platform === 'sheet' || platform === 'feed' || item.url !== undefined) {
      url = validateHttpsUrl(item.url, `sources[${i}].url`);
    }

    let parser: SourceParser | undefined;
    if (platform === 'sheet' || platform === 'feed' || item.parser !== undefined) {
      if (platform !== 'sheet' && platform !== 'feed') {
        throw new Error(`sources[${i}].parser is not supported for platform ${platform}`);
      }
      if (typeof item.parser !== 'string' || !ALLOWED_SOURCE_PARSER_SET.has(item.parser.trim())) {
        throw new Error(`sources[${i}].parser invalid: ${String(item.parser)}`);
      }
      parser = item.parser.trim() as SourceParser;
      if (platform === 'sheet') {
        if (!SHEET_SOURCE_PARSER_SET.has(parser)) {
          throw new Error(`sources[${i}].parser "${parser}" is not valid for sheet platform`);
        }
        if (tags.includes('drops')) {
          throw new Error(`sources[${i}] sheet source cannot use drops polling role`);
        }
      } else {
        if (!FEED_SOURCE_PARSER_SET.has(parser)) {
          throw new Error(`sources[${i}].parser "${parser}" is not valid for feed platform`);
        }
        if (tags.includes('drops') && !DROP_FEED_PARSER_SET.has(parser)) {
          throw new Error(`sources[${i}].parser "${parser}" cannot run in drops polling role`);
        }
        if (tags.includes('curated') && !CURATED_FEED_PARSER_SET.has(parser)) {
          throw new Error(`sources[${i}].parser "${parser}" cannot run in curated polling role`);
        }
      }
    }

    const entry: SourceConfig = { platform, handle, lang, trust, tags, enabled };
    if (url !== undefined) entry.url = url;
    if (parser !== undefined) entry.parser = parser;
    out.push(entry);
  }

  return out;
}

export const SEED_SOURCES: SourceConfig[] = validateSources(sourcesJson);

export const SEED_SOURCE_BY_ID: ReadonlyMap<string, SourceConfig> = new Map(
  SEED_SOURCES.map(s => [`${s.platform}:${s.handle.toLowerCase()}`, s]),
);

export function getSeedSourceById(id: string): SourceConfig | undefined {
  return SEED_SOURCE_BY_ID.get(id.toLowerCase());
}

export function resolveCuratedSourceUrl(
  overrideUrl: string | undefined,
  sourceId: string,
  fallbackUrl: string,
  registry: ReadonlyMap<string, SourceConfig> = SEED_SOURCE_BY_ID,
): string {
  const explicit = overrideUrl?.trim();
  if (explicit) return explicit;
  return registry.get(sourceId.toLowerCase())?.url ?? fallbackUrl;
}

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
  const existingRes = await db.prepare('SELECT id, lang, trust, enabled, tags FROM sources').all<{
    id: string;
    lang: string | null;
    trust: number;
    enabled: number;
    tags: string | null;
  }>();
  const byId = new Map((existingRes.results ?? []).map(r => [r.id, r]));
  // Case-insensitive index over stored ids: a case-only handle edit must
  // resolve to the existing row (handles are validated case-insensitively).
  const byLowerId = new Map((existingRes.results ?? []).map(r => [r.id.toLowerCase(), r]));

  const stmts: D1PreparedStatement[] = [];
  for (const s of sources) {
    // Resolve existing rows by lowercased handle: validation dedupes
    // case-insensitively, so a case-only handle edit must UPDATE the existing
    // row (keeping its id, status and poll cursor), never insert a parallel one.
    const id = `${s.platform}:${s.handle}`;
    const row = byLowerId.get(id.toLowerCase());
    if (row) {
      const langChanged = (row.lang ?? null) !== s.lang;
      const trustChanged = row.trust !== s.trust;
      const enabledChanged = (row.enabled === 1) !== s.enabled;
      const tagsChanged = (row.tags ?? null) !== JSON.stringify(s.tags);
      if (!langChanged && !trustChanged && !enabledChanged && !tagsChanged) continue;
      // Update under the row's STORED id: a case-only handle edit targets the
      // existing row (poll history preserved), it does not re-key it.
      stmts.push(
        db
          .prepare(
            `UPDATE sources
             SET lang = ?2, trust = ?3, enabled = ?4, tags = ?5
             WHERE id = ?1
               AND (lang IS NOT ?2 OR trust IS NOT ?3 OR enabled IS NOT ?4 OR tags IS NOT ?5)`,
          )
          .bind(row.id, s.lang, s.trust, s.enabled ? 1 : 0, JSON.stringify(s.tags)),
      );
    } else {
      stmts.push(
        db
          .prepare(
            `INSERT INTO sources (id, platform, handle, lang, trust, enabled, tags, status, fail_count)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'ok', 0)
             ON CONFLICT(id) DO UPDATE SET
               lang = excluded.lang,
               trust = excluded.trust,
               enabled = excluded.enabled,
               tags = excluded.tags
             WHERE sources.lang IS NOT excluded.lang
                OR sources.trust IS NOT excluded.trust
                OR sources.enabled IS NOT excluded.enabled
                OR sources.tags IS NOT excluded.tags`,
          )
          .bind(id, s.platform, s.handle, s.lang, s.trust, s.enabled ? 1 : 0, JSON.stringify(s.tags)),
      );
    }
  }

  // Sources removed from sources.json must stop being polled: flip any row
  // that is not in the current config to enabled = 0 (single guarded write;
  // runtime history stays intact for re-enable or audit).
  const keepIds = new Set(sources.map(s => `${s.platform}:${s.handle.toLowerCase()}`));
  for (const [storedId, row] of byId) {
    if (keepIds.has(storedId.toLowerCase())) continue;
    if (row.enabled === 0) continue;
    stmts.push(db.prepare('UPDATE sources SET enabled = 0 WHERE id = ?1 AND enabled IS NOT 0').bind(storedId));
  }

  // D1 caps a batch at ~100 bound parameters: 7 per upsert, 5 per update →
  // chunks of 16 stay under the cap. Chunks write disjoint rows and are
  // order-independent, so they run in parallel.
  await Promise.all(
    Array.from({ length: Math.ceil(stmts.length / 16) }, (_, i) =>
      db.batch(stmts.slice(i * 16, (i + 1) * 16)),
    ),
  );
}
