export const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '');

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

export async function takePrefetched<T>(key: string, signal?: AbortSignal): Promise<T | null> {
  signal?.throwIfAborted();
  const map = typeof window !== 'undefined' ? window.__RADAR_PREFETCH__ : undefined;
  const pending = map?.[key];
  if (!pending) return null;
  delete map[key];
  const deadline = AbortSignal.timeout(2_500);
  const stop = signal ? AbortSignal.any([deadline, signal]) : deadline;
  const { promise, resolve } = Promise.withResolvers<null>();
  const release = () => resolve(null);
  stop.addEventListener('abort', release, { once: true });
  try {
    const body = await Promise.race([pending.catch(() => null), promise]);
    signal?.throwIfAborted();
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
): Promise<JsonFetchResult<T>> {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const prefetchKey = cleanPath.replace(/^\//, '').replace(/\.json(?:\?.*)?$/, '');
  const snapshotUrl = `${import.meta.env.BASE_URL}data${cleanPath.split('?')[0]}`;

  if (!API_BASE) {
    const body = await takePrefetched<T>(prefetchKey, signal);
    if (body !== null) return { status: 200, body, etag: null, source: 'snapshot' };
    return fetchJson(snapshotUrl, 'snapshot', {}, signal);
  }

  const headers: Record<string, string> = {};
  if (etag) headers['If-None-Match'] = etag;

  try {
    return await fetchJson(`${API_BASE}${cleanPath}`, 'api', headers, signal);
  } catch (err) {
    // Only transport failures and deadlines qualify for offline fallback.
    if (signal?.aborted || !(err instanceof TypeError || (err instanceof DOMException &&
      (err.name === 'TimeoutError' || err.name === 'AbortError')))) throw err;
    return fetchJson(snapshotUrl, 'snapshot', {}, signal);
  }
}
