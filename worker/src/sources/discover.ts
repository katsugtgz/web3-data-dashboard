const HANDLE_RE = /^[A-Za-z0-9_]{4,32}$/;
const TELEGRAM_BOT_RE = /bot$/i;
const MAX_CANDIDATE_BATCH = 20;
const RESERVED_PATHS = new Set([
  's',
  'addlist',
  'addstickers',
  'addemoji',
  'addtheme',
  'bg',
  'setlanguage',
  'joinchat',
  'c',
  'share',
  'iv',
  'proxy',
  'socks',
]);

export interface CandidateSource {
  handle: string;
  mentions: number;
  firstSeen: number;
  lastSeen: number;
  fromSources: string[];
}

export function extractCandidateHandles(
  forwardedFrom: string | null,
  urls: string[],
  selfHandle: string,
  existingHandles: Set<string>,
): string[] {
  const found = new Map<string, string>();
  const selfLower = selfHandle.toLowerCase();

  const tryAdd = (raw: string | null | undefined) => {
    if (!raw) return;
    const h = raw.trim().replace(/^@/, '');
    if (!HANDLE_RE.test(h)) return;
    const lower = h.toLowerCase();
    if (lower === selfLower || RESERVED_PATHS.has(lower) || existingHandles.has(lower) || TELEGRAM_BOT_RE.test(lower)) {
      return;
    }
    // Store the canonical lowercase form: source_candidates.handle is a
    // case-sensitive PRIMARY KEY, so mixed-case variants would split rows.
    if (!found.has(lower)) found.set(lower, lower);
  };

  tryAdd(forwardedFrom);

  for (const rawUrl of urls) {
    try {
      const u = new URL(rawUrl);
      if (!/^(?:www\.)?(?:t\.me|telegram\.me)$/i.test(u.hostname)) continue;
      const segs = u.pathname.split('/').filter(Boolean);
      if (segs.length === 0) continue;
      const first = segs[0].toLowerCase();
      if (first.startsWith('+') || RESERVED_PATHS.has(first)) {
        if (first === 's' && segs[1]) tryAdd(segs[1]);
        continue;
      }
      tryAdd(segs[0]);
    } catch {
      // Ignore malformed URL
    }
  }

  return [...found.values()];
}

export async function recordCandidates(
  db: D1Database,
  handles: string[],
  fromSourceId: string,
  nowMs = Date.now(),
): Promise<void> {
  if (handles.length === 0) return;

  // Merge inside the upsert: reading from_sources first and writing the
  // extended list loses sources when two ingests for the same handle race.
  // json_group_array(DISTINCT ...) unions the stored list with the new source.
  const stmts = handles.slice(0, MAX_CANDIDATE_BATCH).map(h =>
    db
      .prepare(
        `INSERT INTO source_candidates (handle, mentions, first_seen, last_seen, from_sources)
         VALUES (?1, 1, ?2, ?2, json_array(?3))
         ON CONFLICT(handle) DO UPDATE SET
           mentions = mentions + 1,
           last_seen = excluded.last_seen,
           from_sources = (
             SELECT json_group_array(DISTINCT value)
             FROM (SELECT DISTINCT value FROM json_each(source_candidates.from_sources)
                   UNION SELECT DISTINCT value FROM json_each(excluded.from_sources)
                   ORDER BY value)
           )`,
      )
      .bind(h, nowMs, fromSourceId),
  );

  await db.batch(stmts);
}

export async function getTopCandidates(db: D1Database, limit = 50): Promise<CandidateSource[]> {
  const res = await db
    .prepare(
      `SELECT handle, mentions, first_seen, last_seen, from_sources
       FROM source_candidates
       WHERE json_array_length(from_sources) >= 2
       -- handle ASC: same-tick ties must resolve deterministically so two
       -- cache-miss builds of /sources/candidates.json agree on body + ETag.
       ORDER BY mentions DESC, last_seen DESC, handle ASC
       LIMIT ?1`,
    )
    .bind(limit)
    .all<{
      handle: string;
      mentions: number;
      first_seen: number;
      last_seen: number;
      from_sources: string;
    }>();

  return (res.results ?? []).map(r => ({
    handle: r.handle,
    mentions: r.mentions,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    fromSources: JSON.parse(r.from_sources) as string[],
  }));
}
