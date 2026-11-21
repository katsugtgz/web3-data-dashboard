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

export async function syncSources(db: D1Database, sources: SourceConfig[] = SEED_SOURCES): Promise<void> {
  const stmts = sources.map(s => {
    const id = `${s.platform}:${s.handle}`;
    return db
      .prepare(
        `INSERT INTO sources (id, platform, handle, lang, trust, enabled, status, fail_count)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'ok', 0)
         ON CONFLICT(id) DO UPDATE SET
           lang = excluded.lang,
           trust = excluded.trust,
           enabled = excluded.enabled`,
      )
      .bind(id, s.platform, s.handle, s.lang, s.trust, s.enabled ? 1 : 0);
  });

  // Batch in chunks of 40 for D1 batch efficiency
  const chunks = [];
  for (let i = 0; i < stmts.length; i += 40) {
    chunks.push(db.batch(stmts.slice(i, i + 40)));
  }
  await Promise.all(chunks);
}
