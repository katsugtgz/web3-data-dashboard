const HANDLE_RE = /^[A-Za-z0-9_]{4,32}$/;
const RESERVED_PATHS = new Set(['s', 'addlist', 'joinchat', 'c', 'share', 'iv', 'proxy', 'socks']);

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
    if (lower === selfLower || RESERVED_PATHS.has(lower) || existingHandles.has(lower)) return;
    if (!found.has(lower)) found.set(lower, h);
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

  const existingRows = await Promise.all(
    handles.map(h =>
      db
        .prepare('SELECT handle, mentions, from_sources FROM source_candidates WHERE handle = ?1')
        .bind(h)
        .first<{ handle: string; mentions: number; from_sources: string }>(),
    ),
  );

  const stmts = handles.map((h, i) => {
    const prev = existingRows[i];
    const prevSources = prev ? (JSON.parse(prev.from_sources) as string[]) : [];
    const nextSources = new Set(prevSources);
    nextSources.add(fromSourceId);
    return db
      .prepare(
        `INSERT INTO source_candidates (handle, mentions, first_seen, last_seen, from_sources)
         VALUES (?1, 1, ?2, ?2, ?3)
         ON CONFLICT(handle) DO UPDATE SET
           mentions = mentions + 1,
           last_seen = excluded.last_seen,
           from_sources = ?3`,
      )
      .bind(h, nowMs, JSON.stringify([...nextSources]));
  });

  await db.batch(stmts);
}

export async function getTopCandidates(db: D1Database, limit = 50): Promise<CandidateSource[]> {
  const res = await db
    .prepare(
      `SELECT handle, mentions, first_seen, last_seen, from_sources
       FROM source_candidates
       WHERE json_array_length(from_sources) >= 2
       ORDER BY mentions DESC, last_seen DESC
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
