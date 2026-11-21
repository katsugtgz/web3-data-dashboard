export const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '');

export type JsonFetchResult<T> =
  | { status: 200; body: T; etag: string | null }
  | { status: 304 };

declare global {
  interface Window {
    __RADAR_PREFETCH__?: Record<string, Promise<unknown> | undefined>;
  }
}

const REQUEST_TIMEOUT_MS = 15_000;

function readPrefetched<T>(key: string): Promise<T | null> | null {
  const map = typeof window !== 'undefined' ? window.__RADAR_PREFETCH__ : undefined;
  const pending = map?.[key];
  if (!pending) return null;
  delete map[key];
  return pending as Promise<T | null>;
}

async function fetchWithTimeout(url: string, headers: HeadersInit, signal?: AbortSignal): Promise<Response> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(new Error('Request timed out')), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { headers, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
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
    const pre = readPrefetched<T>(prefetchKey);
    if (pre) {
      const preBody = await pre;
      if (preBody !== null) return { status: 200, body: preBody, etag: null };
    }
    const res = await fetchWithTimeout(snapshotUrl, {}, signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { status: 200, body: (await res.json()) as T, etag: res.headers.get('ETag') };
  }

  const headers: Record<string, string> = {};
  if (etag) headers['If-None-Match'] = etag;

  try {
    const res = await fetchWithTimeout(`${API_BASE}${cleanPath}`, headers, signal);
    if (res.status === 304) return { status: 304 };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { status: 200, body: (await res.json()) as T, etag: res.headers.get('ETag') };
  } catch (err) {
    if (signal?.aborted) throw err;
    // Fallback to committed offline snapshot when worker is unreachable
    const fallback = await fetchWithTimeout(snapshotUrl, {}, signal);
    if (!fallback.ok) throw err;
    return { status: 200, body: (await fallback.json()) as T, etag: null };
  }
}
