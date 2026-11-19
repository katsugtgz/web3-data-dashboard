import { join, resolve, sep } from 'node:path';
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

async function listSections(): Promise<SectionSummary[]> {
  const out: SectionSummary[] = [];
  for (const source of Object.keys(SOURCES) as Source[]) {
    for (const name of await readdir(SOURCES[source])) {
      if (name.endsWith('.json')) out.push({ source, name });
    }
  }
  return out;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const notFound = (msg = 'Not found') => json({ error: msg }, 404);

async function serveStatic(pathname: string): Promise<Response> {
  const file = pathname === '/' ? null : Bun.file(resolve(DIST, '.' + pathname));
  if (file && resolve(DIST, '.' + pathname).startsWith(DIST + sep) && (await file.exists())) {
    return new Response(file);
  }
  const index = Bun.file(join(DIST, 'index.html'));
  if (!(await index.exists())) return new Response('Run `bun run build` first.', { status: 503 });
  return new Response(index, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

Bun.serve({
  port: PORT,
  routes: {
    '/api/dashboard': () => json(dashboard),
    '/api/cards': () => json(dashboard.CARDS),
    '/api/sections': async () => json(await listSections()),
    '/api/sections/:source/:name': async req => {
      const { source, name } = req.params;
      if (!(source in SOURCES)) return notFound('Unknown source');
      const listed = (await listSections()).some(s => s.source === source && s.name === name);
      if (!listed) return notFound('Unknown section');
      return new Response(Bun.file(join(SOURCES[source as Source], name)), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    },
    '/api/*': () => notFound(),
  },
  fetch(req) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    return serveStatic(new URL(req.url).pathname);
  },
});

console.log(`API + dist on http://localhost:${PORT}`);
