export const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '');

/** `VITE_API_BASE` sentinel for Docker/srv2 builds where the Worker serves `/feed.json` & co. from this origin. */
export const SAME_ORIGIN_API_BASE = 'same-origin';

export interface JsonSource {
  /** `''` = static snapshot mode, `'same-origin'` = live API on this origin, else an absolute URL. */
  apiBase: string;
  /** Directory holding the offline snapshots, e.g. `${BASE_URL}data`. */
  snapshotBase: string;
}

const DEFAULT_SOURCE: JsonSource = {
  apiBase: API_BASE,
  snapshotBase: `${import.meta.env.BASE_URL}data`,
};

/** URL prefix for live requests, or `null` when the app is snapshot-only. */
export function resolveApiPrefix(apiBase: string): string | null {
  if (apiBase === SAME_ORIGIN_API_BASE) return '';
  return apiBase || null;
}

export type JsonFetchResult<T> =
  | { status: 200; body: T; etag: string | null; source: 'api' | 'snapshot' }
  | { status: 304 };

declare global {
  interface Window {
    __RADAR_PREFETCH__?: Record<string, Promise<unknown> | undefined>;
    __RADAR_PREFETCH_RESOLVED__?: Record<string, unknown>;
  }
}

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Fallback-eligible failures: transport errors, deadlines, or a reachable
 * Worker answering 5xx (e.g. 503 while a cold deploy warms up). 4xx client
 * errors still throw.
 */
export function fallbackEligible(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) return true;
  return err instanceof Error && /^HTTP 5\d\d$/.test(err.message);
}

export async function readPrefetched<T>(
  key: string,
  signal?: AbortSignal,
  consume = false,
  timeoutMs = 2_500,
): Promise<T | null> {
  signal?.throwIfAborted();
  if (typeof window === 'undefined') return null;

  const resolvedMap = window.__RADAR_PREFETCH_RESOLVED__;
  if (resolvedMap && Object.hasOwn(resolvedMap, key)) {
    const cached = resolvedMap[key] as T;
    if (consume) {
      delete resolvedMap[key];
      if (window.__RADAR_PREFETCH__) delete window.__RADAR_PREFETCH__[key];
    }
    return cached;
  }

  const map = window.__RADAR_PREFETCH__;
  const pending = map?.[key];
  if (!pending) return null;
  const deadline = AbortSignal.timeout(timeoutMs);
  const stop = signal ? AbortSignal.any([deadline, signal]) : deadline;
  const { promise, resolve } = Promise.withResolvers<null>();
  const release = () => resolve(null);
  stop.addEventListener('abort', release, { once: true });
  try {
    const body = await Promise.race([pending.catch(() => null), promise]);
    signal?.throwIfAborted();
    // Always retire the pending promise once awaited or timed out so a stalled
    // prefetch never triggers a second 2.5s stall on mount.
    if (map[key] === pending) delete map[key];
    if (body !== null && !consume) {
      window.__RADAR_PREFETCH_RESOLVED__ = { ...window.__RADAR_PREFETCH_RESOLVED__, [key]: body };
    }
    return body as T | null;
  } finally {
    stop.removeEventListener('abort', release);
  }
}

async function fetchJson<T>(
  url: string,
  source: 'api' | 'snapshot',
  headers: HeadersInit,
  signal?: AbortSignal,
): Promise<JsonFetchResult<T>> {
  const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const res = await fetch(url, { headers, signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
  if (source === 'api' && res.status === 304) return { status: 304 };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { status: 200, body: (await res.json()) as T, etag: source === 'api' ? res.headers.get('ETag') : null, source };
}

export async function getJson<T>(
  path: string,
  etag?: string | null,
  signal?: AbortSignal,
  source: JsonSource = DEFAULT_SOURCE,
): Promise<JsonFetchResult<T>> {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const prefetchKey = cleanPath.replace(/^\//, '').replace(/\.json(?:\?.*)?$/, '');
  const snapshotUrl = `${source.snapshotBase}${cleanPath.split('?')[0]}`;
  const apiPrefix = resolveApiPrefix(source.apiBase);

  if (apiPrefix === null) {
    const body = await readPrefetched<T>(prefetchKey, signal, true);
    if (body !== null) return { status: 200, body, etag: null, source: 'snapshot' };
    return fetchJson(snapshotUrl, 'snapshot', {}, signal);
  }

  const headers: Record<string, string> = {};
  if (etag) headers['If-None-Match'] = etag;

  try {
    return await fetchJson(`${apiPrefix}${cleanPath}`, 'api', headers, signal);
  } catch (err) {
    // Transport failures, deadlines, and Worker 5xx qualify for offline fallback.
    if (signal?.aborted || !fallbackEligible(err)) throw err;
    try {
      return await fetchJson(snapshotUrl, 'snapshot', {}, signal);
    } catch (snapshotError) {
      if (signal?.aborted) throw snapshotError;
      throw new AggregateError([err, snapshotError], 'Worker and snapshot requests both failed', { cause: err });
    }
  }
}
