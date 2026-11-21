import { extname, join, resolve, sep } from 'node:path';
import { readdir } from 'node:fs/promises';
import type { Dashboard, SectionSummary } from '../shared/types';

const ROOT = resolve(import.meta.dir, '..');
const DIST = join(ROOT, 'dist');
const DATA = join(ROOT, 'data');
const SOURCES = {
  harvest: join(DATA, 'harvest'),
  'harvest-net': join(DATA, 'harvest-net'),
} as const;
type Source = keyof typeof SOURCES;

const PORT = Number(Bun.env.PORT ?? 3000);
const dashboard = (await Bun.file(join(DATA, 'dashboard.json')).json()) as Dashboard;

const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
} as const;

const COMPRESSIBLE_RE = /^(?:text\/|application\/(?:javascript|json|xml)|image\/svg\+xml)/;
const GZIP_CACHE_MAX = 64;

interface GzipEntry {
  mtime: number;
  size: number;
  data: Uint8Array<ArrayBuffer>;
}

const gzipCache = new Map<string, GzipEntry>();

function acceptsGzip(header: string): boolean {
  let wildcardQ: number | null = null;
  for (const part of header.split(',')) {
    const [rawCoding, ...params] = part.trim().split(';');
    const coding = rawCoding.trim().toLowerCase();
    if (!coding) continue;
    let q = 1;
    for (const p of params) {
      const [k, v] = p.split('=').map(s => s.trim().toLowerCase());
      if (k === 'q') {
        const parsed = Number(v);
        q = Number.isFinite(parsed) ? parsed : 0;
      }
    }
    if (coding === 'gzip' || coding === 'x-gzip') return q > 0;
    if (coding === '*') wildcardQ = q;
  }
  return wildcardQ !== null && wildcardQ > 0;
}

async function getGzipped(filePath: string, file: ReturnType<typeof Bun.file>): Promise<Uint8Array<ArrayBuffer>> {
  const mtime = file.lastModified;
  const size = file.size;
  const cached = gzipCache.get(filePath);
  if (cached && cached.mtime === mtime && cached.size === size) {
    return cached.data;
  }
  const compressed = Bun.gzipSync(new Uint8Array(await file.arrayBuffer()));
  if (gzipCache.size >= GZIP_CACHE_MAX) {
    const oldest = gzipCache.keys().next().value;
    if (oldest !== undefined) gzipCache.delete(oldest);
  }
  gzipCache.set(filePath, { mtime, size, data: compressed });
  return compressed;
}

async function listSections(): Promise<SectionSummary[]> {
  const out: SectionSummary[] = [];
  for (const source of Object.keys(SOURCES) as Source[]) {
    for (const name of await readdir(SOURCES[source])) {
      if (name.endsWith('.json')) out.push({ source, name });
    }
  }
  return out;
}

const json = (body: unknown, status = 200, cache = 'public, max-age=60') =>
  Response.json(body, {
    status,
    headers: { ...BASE_HEADERS, 'cache-control': cache },
  });

const notFound = (msg = 'Not found') => json({ error: msg }, 404, 'no-store');

async function respondFile(
  filePath: string,
  file: ReturnType<typeof Bun.file>,
  headers: Record<string, string>,
  acceptEncoding: string,
  isHead: boolean,
): Promise<Response> {
  const mime = headers['content-type'] ?? file.type;
  const compressible = COMPRESSIBLE_RE.test(mime) && file.size > 1024;
  if (compressible && acceptsGzip(acceptEncoding)) {
    const gzipHeaders = {
      ...headers,
      'content-type': mime,
      'content-encoding': 'gzip',
      vary: 'Accept-Encoding',
    };
    if (isHead) return new Response(null, { headers: gzipHeaders });
    const compressed = await getGzipped(filePath, file);
    return new Response(compressed, { headers: gzipHeaders });
  }
  const finalHeaders = compressible ? { ...headers, vary: 'Accept-Encoding' } : headers;
  if (isHead) return new Response(null, { headers: { ...finalHeaders, 'content-type': mime } });
  return new Response(file, { headers: finalHeaders });
}

async function serveStatic(pathname: string, acceptEncoding: string, isHead: boolean): Promise<Response> {
  const safePath = resolve(DIST, '.' + pathname);
  const file = pathname === '/' ? null : Bun.file(safePath);
  if (file && safePath.startsWith(DIST + sep) && (await file.exists())) {
    const isHtml = file.type.startsWith('text/html') || safePath.toLowerCase().endsWith('.html');
    const immutable = pathname.startsWith('/assets/');
    return respondFile(
      safePath,
      file,
      {
        ...BASE_HEADERS,
        'cache-control': isHtml
          ? 'no-cache'
          : immutable
            ? 'public, max-age=31536000, immutable'
            : 'public, max-age=300',
      },
      acceptEncoding,
      isHead,
    );
  }
  if (pathname !== '/' && extname(pathname) !== '') {
    return new Response(isHead ? null : 'Not found', {
      status: 404,
      headers: { ...BASE_HEADERS, 'cache-control': 'no-store' },
    });
  }
  const indexPath = join(DIST, 'index.html');
  const index = Bun.file(indexPath);
  if (!(await index.exists())) return new Response('Run `bun run build` first.', { status: 503 });
  return respondFile(
    indexPath,
    index,
    {
      ...BASE_HEADERS,
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
    },
    acceptEncoding,
    isHead,
  );
}

Bun.serve({
  port: PORT,
  routes: {
    '/api/health': async () =>
      json({ status: 'ok', cards: dashboard.CARDS.length, sections: (await listSections()).length }, 200, 'no-store'),
    '/api/dashboard': () => json(dashboard),
    '/api/cards': () => json(dashboard.CARDS),
    '/api/sections': async () => json(await listSections()),
    '/api/sections/:source/:name': async req => {
      const { source, name } = req.params;
      if (!(source in SOURCES)) return notFound('Unknown source');
      const listed = (await listSections()).some(s => s.source === source && s.name === name);
      if (!listed) return notFound('Unknown section');
      return new Response(Bun.file(join(SOURCES[source as Source], name)), {
        headers: {
          ...BASE_HEADERS,
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'public, max-age=300',
        },
      });
    },
    '/api/*': () => notFound(),
  },
  fetch(req) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    return serveStatic(new URL(req.url).pathname, req.headers.get('accept-encoding') ?? '', req.method === 'HEAD');
  },
});

console.log(`API + dist on http://localhost:${PORT}`);
