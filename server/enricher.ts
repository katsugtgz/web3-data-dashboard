import { lookup as dnsLookup } from 'node:dns/promises';
import tls from 'node:tls';
import type { AirdropFeed, DomainMeta } from '../shared/types';
import { readSnapshot, upsertSnapshot } from '../worker/src/lib/db';
import { normalizeProjectKey } from '../worker/src/normalize/cluster';
import { getRegistrableDomain, isPlatformDomain } from '../worker/src/normalize/domains';
import { stripOrTranslateCjk } from '../worker/src/normalize/i18n';
import { URL_SHORTENERS } from '../worker/src/safety/shorteners';
import { USER_AGENT } from '../worker/src/lib/format';
import { safeHttpsUrl } from '../worker/src/lib/url';
import { decodeHtmlEntities } from '../worker/src/sources/telegram';

export const OK_TTL_MS = 7 * 86_400_000;
export const ERROR_TTL_MS = 6 * 3_600_000;
export const FETCH_TIMEOUT_MS = 5_000;
export const MAX_HEAD_BYTES = 128 * 1024;
export const ENRICH_CONCURRENCY = 4;

const MAX_REDIRECTS = 3;
const MAX_URL_LEN = 2048;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const SAFE_LLAMA_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/i;
const LOCAL_SUFFIXES = ['localhost', 'localdomain', 'local', 'internal', 'lan', 'home', 'arpa', 'onion', 'test', 'invalid'];

export type MetaSource = DomainMeta['source'];

// ---------------------------------------------------------------------------
// Address and host guards
// ---------------------------------------------------------------------------

function ipv6Groups(ip: string): number[] | null {
  let text = ip;
  const embedded = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (embedded) {
    const octets = embedded[1]!.split('.').map(Number);
    if (octets.some(n => n > 255)) return null;
    text = `${text.slice(0, -embedded[1]!.length)}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const gap = 8 - head.length - tail.length;
  if (gap < 0 || (halves.length === 1 && gap !== 0)) return null;
  const groups = [...head, ...Array<string>(gap).fill('0'), ...tail];
  return groups.every(g => /^[0-9a-f]{1,4}$/.test(g)) ? groups.map(g => Number.parseInt(g, 16)) : null;
}

/**
 * True only for globally routable unicast addresses. Denies every special-use
 * IPv4 range (loopback, private, link-local, CGNAT, benchmark, documentation,
 * multicast, reserved) and, by default, all IPv6 outside 2000::/3.
 */
export function isPublicIp(rawIp: string): boolean {
  const ip = rawIp.trim().toLowerCase();
  if (!ip || ip.includes('%')) return false;
  if (ip.includes('.')) {
    if (!IPV4_RE.test(ip)) return false;
    const [a = 256, b = 256, c = 256] = ip.split('.').map(Number);
    if (a > 255 || b > 255 || c > 255) return false;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || b === 0)) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  const g = ipv6Groups(ip);
  if (!g) return false;
  const g0 = g[0]!;
  const g1 = g[1]!;
  const reserved =
    (g0 === 0x2001 && (g1 === 0x0db8 || g1 === 0)) || g0 === 0x2002 || (g0 === 0x3fff && (g1 & 0xf000) === 0);
  return (g0 & 0xe000) === 0x2000 && !reserved;
}

/** Why `host` must never be fetched, or null when it is a plain public project host. */
export function hostBlockReason(rawHost: string): string | null {
  const host = rawHost.trim().toLowerCase().replace(/\.+$/, '');
  if (!host) return 'empty host';
  if (host.startsWith('[') || IPV4_RE.test(host)) return 'ip literal';
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(host)) return 'invalid hostname';
  if (host.includes('xn--')) return 'punycode host';
  if (!host.includes('.')) return 'dotless host';
  if (LOCAL_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`))) return 'local or reserved host';
  if (isPlatformDomain(host)) return 'platform domain';
  const registrable = getRegistrableDomain(`https://${host}`);
  if (registrable && URL_SHORTENERS[registrable]) return 'shortener';
  return null;
}

/** Lowercases a project domain and strips scheme, path, `www.` and trailing dots; null when empty. */
function normalizeDomain(rawDomain: string): string | null {
  const raw = rawDomain.trim().toLowerCase();
  if (!raw) return null;
  const host = /[/:]/.test(raw) ? (getRegistrableDomain(raw.includes('://') ? raw : `https://${raw}`) ?? '') : raw;
  return host.replace(/\.+$/, '').replace(/^www\./, '') || null;
}

// ---------------------------------------------------------------------------
// HTML head parsing
// ---------------------------------------------------------------------------

const NON_LATIN_RE = /[^\p{Script=Latin} -~]/gu;

/** Decodes entities, translates or drops every non-Latin script, collapses whitespace. */
export function englishText(raw: string, maxLen: number): string | null {
  const text = stripOrTranslateCjk(decodeHtmlEntities(raw))
    .replace(NON_LATIN_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, maxLen) : null;
}

/** Resolves an asset reference from a page against `base`; result is always https on a named public host. */
export function resolveAssetUrl(raw: string, base: URL): string | null {
  const text = decodeHtmlEntities(raw.trim());
  if (!text || text.length > MAX_URL_LEN || /[\s\\]/.test(text)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^https?:/i.test(text)) return null;
  try {
    const url = new URL(text.replace(/^http:/i, 'https:'), base);
    url.hash = '';
    return safeHttpsUrl(url.toString());
  } catch {
    return null;
  }
}

export interface HeadMeta {
  ogImage: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  icon: string | null;
}

function attr(blob: string, name: string): string | null {
  const match = blob.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i'));
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value ? value.trim() : null;
}

/** Reads og:image, og:title, og:description and the best icon link from `<head>` only. */
export function parseHeadMeta(html: string, baseUrl: URL): HeadMeta {
  const end = html.search(/<\/head\s*>/i);
  const head = end >= 0 ? html.slice(0, end) : html;
  const meta: HeadMeta = { ogImage: null, ogTitle: null, ogDescription: null, icon: null };
  const icons: { ref: string; score: number }[] = [];
  for (const [, kind, blob] of head.matchAll(/<(meta|link)\s+([^>]*?)>/gi)) {
    if (kind!.toLowerCase() === 'meta') {
      const key = (attr(blob!, 'property') ?? attr(blob!, 'name'))?.toLowerCase();
      const content = attr(blob!, 'content');
      if (!key || !content) continue;
      if (key === 'og:image' && !meta.ogImage) meta.ogImage = resolveAssetUrl(content, baseUrl);
      else if (key === 'og:title' && !meta.ogTitle) meta.ogTitle = englishText(content, 200);
      else if (key === 'og:description' && !meta.ogDescription) meta.ogDescription = englishText(content, 500);
      continue;
    }
    const href = attr(blob!, 'href');
    const rel = (attr(blob!, 'rel') ?? '').toLowerCase().split(/\s+/);
    if (!href) continue;
    if (rel.some(token => token.startsWith('apple-touch-icon'))) icons.push({ ref: href, score: 1_000_000 });
    else if (rel.includes('icon')) {
      const sizes = (attr(blob!, 'sizes') ?? '').toLowerCase();
      const [w = 0, h = w] = sizes.match(/\d+/g)?.map(Number) ?? [];
      const score = sizes.includes('any') ? 2_000_000 : w * h;
      icons.push({ ref: href, score: /\.ico(?:[?#]|$)/i.test(href) ? score : score + 1 });
    }
  }
  const best = icons.reduce<null | { ref: string; score: number }>((a, b) => (!a || b.score > a.score ? b : a), null);
  meta.icon = best ? resolveAssetUrl(best.ref, baseUrl) : null;
  return meta;
}

// ---------------------------------------------------------------------------
// SSRF-safe head fetch (DNS pinned, TLS verified against the hostname)
// ---------------------------------------------------------------------------

export interface HeadResponse {
  status: number;
  location?: string | null;
  html?: string | null;
}

export interface HeadDeps {
  lookup?: (host: string) => Promise<string[]>;
  request?: (url: URL, ip: string, signal: AbortSignal) => Promise<HeadResponse>;
  timeoutMs?: number;
}

export interface HeadPage {
  url: string;
  html: string | null;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('fetch aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      err => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
    if (signal.aborted) onAbort();
  });
}

async function defaultLookup(host: string): Promise<string[]> {
  const answers = await dnsLookup(host, { all: true, verbatim: true });
  return answers.map(a => a.address);
}

function dechunk(body: Buffer): Buffer {
  const parts: Buffer[] = [];
  let i = 0;
  while (i < body.length) {
    const lineEnd = body.indexOf('\r\n', i);
    if (lineEnd < 0) break;
    const size = Number.parseInt(body.subarray(i, lineEnd).toString(), 16);
    if (!Number.isFinite(size) || size <= 0) break;
    const start = lineEnd + 2;
    const end = Math.min(start + size, body.length);
    parts.push(body.subarray(start, end));
    if (end < start + size) break;
    i = start + size + 2;
  }
  return Buffer.concat(parts);
}

/** Parses one raw HTTP/1.1 response (status line, headers, at most MAX_HEAD_BYTES of decoded HTML). */
export function parseHeadResponse(buf: Buffer): HeadResponse {
  const head = buf.toString('latin1');
  const sep = head.indexOf('\r\n\r\n');
  if (sep < 0) throw new Error('truncated response');
  const lines = head.slice(0, sep).split('\r\n');
  const status = Number.parseInt(lines[0]?.split(' ')[1] ?? '', 10);
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    const name = line.slice(0, colon).trim().toLowerCase();
    if (colon > 0 && name && !headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
  }
  const body = buf.subarray(sep + 4);
  const isHtml = status === 200 && /text\/html|application\/xhtml/i.test(headers.get('content-type') ?? '');
  if (!isHtml) return { status, location: headers.get('location') ?? null, html: null };
  const decoded = /chunked/i.test(headers.get('transfer-encoding') ?? '') ? dechunk(body) : body;
  return { status, location: headers.get('location') ?? null, html: decoded.subarray(0, MAX_HEAD_BYTES).toString('utf8') };
}

/** GET over TLS connected to `ip` (never to the hostname, which DNS could rebind), cert checked against the hostname. */
function pinnedRequest(url: URL, ip: string, signal: AbortSignal): Promise<HeadResponse> {
  const host = url.hostname;
  const received = new Promise<Buffer>((resolve, reject) => {
    const socket = tls.connect({ host: ip, port: 443, servername: host, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      socket.destroy();
      settle();
    };
    const onAbort = () =>
      finish(() => reject(signal.reason instanceof Error ? signal.reason : new Error('fetch aborted')));
    signal.addEventListener('abort', onAbort, { once: true });
    socket.on('error', err => finish(() => reject(err)));
    socket.on('secureConnect', () => {
      socket.write(
        `GET ${url.pathname || '/'}${url.search} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: ${USER_AGENT}\r\nAccept: text/html,application/xhtml+xml\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`,
      );
    });
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      // <head> sits at the start: once its budget plus the header slack arrived, the rest of the page is dropped.
      if (size >= MAX_HEAD_BYTES + 16_384) finish(() => resolve(Buffer.concat(chunks)));
    });
    socket.on('end', () => finish(() => resolve(Buffer.concat(chunks))));
    socket.on('close', () => finish(() => reject(new Error('connection closed before the response completed'))));
    if (signal.aborted) onAbort();
  });
  return received.then(parseHeadResponse);
}

/**
 * Fetches the start of an https page. Every hop (start URL and each redirect)
 * must be https on port 443 with a named, non-platform host whose DNS answers
 * are all public; the connection goes to the validated IP. One deadline of
 * `timeoutMs` covers DNS and every hop together.
 */
export async function fetchHead(startUrl: string, deps: HeadDeps = {}): Promise<HeadPage> {
  const lookup = deps.lookup ?? defaultLookup;
  const request = deps.request ?? pinnedRequest;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('fetch timed out')), deps.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    let current = new URL(startUrl);
    for (let hop = 0; ; hop++) {
      const reason = hostBlockReason(current.hostname);
      if (reason) throw new Error(`blocked: ${reason}`);
      if (current.protocol !== 'https:' || current.port) throw new Error('blocked: only https on port 443 is fetched');
      if (current.username || current.password) throw new Error('blocked: URL carries credentials');
      const addresses = await abortable(lookup(current.hostname), controller.signal);
      if (!addresses.length || !addresses.every(isPublicIp)) {
        throw new Error('blocked: host resolves to a non-public address');
      }
      const response = await abortable(
        request(current, (addresses.find(a => !a.includes(':')) ?? addresses[0])!, controller.signal),
        controller.signal,
      );
      if (response.status >= 300 && response.status < 400) {
        if (hop >= MAX_REDIRECTS) throw new Error('too many redirects');
        if (!response.location) throw new Error(`redirect ${response.status} without location`);
        const next = new URL(response.location, current);
        if (next.protocol === 'http:') next.protocol = 'https:';
        current = next;
        continue;
      }
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      return { url: current.toString(), html: response.html ?? null };
    }
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// domain_meta persistence
// ---------------------------------------------------------------------------

interface MetaRow {
  domain: string;
  logo_url: string | null;
  og_image: string | null;
  og_title: string | null;
  og_description: string | null;
  tvl_usd: number | null;
  category: string | null;
  source: string;
  fetched_at: number;
  expires_at: number;
  error: string | null;
}

function toMeta(row: MetaRow): DomainMeta {
  return {
    domain: row.domain,
    logoUrl: row.logo_url,
    ogImage: row.og_image,
    ogTitle: row.og_title,
    ogDescription: row.og_description,
    tvlUsd: row.tvl_usd,
    category: row.category,
    source: row.source as MetaSource,
    fetchedAt: row.fetched_at,
    expiresAt: row.expires_at,
    error: row.error,
  };
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const runWorker = async (): Promise<void> => {
    if (next >= items.length) return;
    const i = next++;
    out[i] = await fn(items[i]!);
    return runWorker();
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runWorker()));
  return out;
}

interface Layer1Entry {
  logoUrl: string | null;
  tvlUsd: number | null;
  category: string | null;
  source: MetaSource;
}

interface Layer1 {
  defi: Map<string, Omit<Layer1Entry, 'source'>>;
  coin: Map<string, string>;
  projects: Map<string, string>;
}

/** Stored shape of the `markets:crypto` snapshot (see fetchCryptoSection). */
interface CryptoSnapshot {
  section?: { rows?: { cells?: unknown[]; icon?: string | null }[] };
}

/** Layer 1 sources already in the database: DefiLlama seeds, known project names, and the CoinGecko snapshot. */
async function loadLayer1(db: D1Database, domains: string[]): Promise<Layer1> {
  const layer1: Layer1 = { defi: new Map(), coin: new Map(), projects: new Map() };
  const defi = await db
    .prepare('SELECT domain, logo_url, tvl_usd, category FROM domain_meta WHERE source = ?1')
    .bind('defillama')
    .all<{ domain: string; logo_url: string | null; tvl_usd: number | null; category: string | null }>();
  for (const row of defi.results ?? []) layer1.defi.set(row.domain, { logoUrl: row.logo_url, tvlUsd: row.tvl_usd, category: row.category });

  const nameChunks = await Promise.all(
    chunks(domains, 100).map(part =>
      db
        .prepare(
          `SELECT domain, project FROM known_domains
           WHERE origin != 'platform' AND lower(domain) IN (${part.map((_, i) => `?${i + 1}`).join(', ')})`,
        )
        .bind(...part)
        .all<{ domain: string; project: string }>(),
    ),
  );
  for (const names of nameChunks) {
    for (const row of names.results ?? []) layer1.projects.set(row.domain.toLowerCase(), row.project);
  }
  if (layer1.projects.size === 0) return layer1;

  const row = await db
    .prepare("SELECT body FROM snapshots WHERE key = 'markets:crypto' AND ok = 1")
    .first<{ body: string }>();
  let body: CryptoSnapshot | null = null;
  try {
    body = row ? (JSON.parse(row.body) as CryptoSnapshot) : null;
  } catch {
    body = null;
  }
  for (const item of body?.section?.rows ?? []) {
    const icon = item.icon ? safeHttpsUrl(item.icon) : null;
    const label = typeof item.cells?.[0] === 'string' ? item.cells[0] : '';
    const [, name, symbol] = label.match(/^(.*?)\s*\(([^()]*)\)\s*$/) ?? [null, label, ''];
    if (!icon || !name) continue;
    for (const key of [name, symbol]) {
      const normalized = normalizeProjectKey(key);
      if (normalized && !layer1.coin.has(normalized)) layer1.coin.set(normalized, icon);
    }
  }
  return layer1;
}

function layer1For(layer1: Layer1, domain: string): Layer1Entry | null {
  const registrable = getRegistrableDomain(`https://${domain}`) ?? domain;
  const defi = layer1.defi.get(domain) ?? layer1.defi.get(registrable);
  const project = layer1.projects.get(domain);
  const coinLogo = project ? (layer1.coin.get(normalizeProjectKey(project)) ?? null) : null;
  if (!defi && !coinLogo) return null;
  return {
    logoUrl: defi?.logoUrl ?? coinLogo,
    tvlUsd: defi?.tvlUsd ?? null,
    category: defi?.category ?? null,
    source: defi ? 'defillama' : 'coingecko',
  };
}

export interface EnrichOptions extends HeadDeps {
  nowMs?: number;
  concurrency?: number;
}

async function loadMetaRows(db: D1Database, domains: string[]): Promise<Map<string, MetaRow>> {
  const rows = new Map<string, MetaRow>();
  const parts = await Promise.all(
    chunks(domains, 100).map(part =>
      db
        .prepare(
          `SELECT domain, logo_url, og_image, og_title, og_description, tvl_usd, category, source, fetched_at, expires_at, error
           FROM domain_meta WHERE domain IN (${part.map((_, i) => `?${i + 1}`).join(', ')})`,
        )
        .bind(...part)
        .all<MetaRow>(),
    ),
  );
  for (const res of parts) {
    for (const row of res.results ?? []) rows.set(row.domain, row);
  }
  return rows;
}

/** A fresh row that was already fetched over HTML (or is backing off after an error) is served as is. */
function needsFetch(row: MetaRow, nowMs: number): boolean {
  return row.expires_at <= nowMs || (row.error == null && row.source !== 'html');
}

function upsertStmt(db: D1Database, m: DomainMeta) {
  return db
    .prepare(
      `INSERT INTO domain_meta (domain, logo_url, og_image, og_title, og_description, tvl_usd, category, source, fetched_at, expires_at, error)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT(domain) DO UPDATE SET
         logo_url = excluded.logo_url, og_image = excluded.og_image, og_title = excluded.og_title,
         og_description = excluded.og_description, tvl_usd = excluded.tvl_usd, category = excluded.category,
         source = excluded.source, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at, error = excluded.error`,
    )
    .bind(
      m.domain,
      m.logoUrl ?? null,
      m.ogImage ?? null,
      m.ogTitle ?? null,
      m.ogDescription ?? null,
      m.tvlUsd ?? null,
      m.category ?? null,
      m.source,
      m.fetchedAt,
      m.expiresAt,
      m.error ?? null,
    );
}

/**
 * Enriches project domains with cached metadata: Layer 1 (DefiLlama seeds, CoinGecko snapshot) first,
 * Layer 2 (SSRF-safe page head fetch) for domains without a fetched cache entry. Writes domain_meta and
 * returns one entry per unique input domain, in input order.
 */
export async function enrichDomainsBatch(
  db: D1Database,
  domains: string[],
  opts: EnrichOptions = {},
): Promise<DomainMeta[]> {
  const nowMs = opts.nowMs ?? Date.now();
  const uniq = [...new Set(domains.map(normalizeDomain).filter((d): d is string => d !== null))];
  if (uniq.length === 0) return [];

  const stored = await loadMetaRows(db, uniq);
  const done = new Map<string, DomainMeta>();
  const todo: string[] = [];
  for (const domain of uniq) {
    const row = stored.get(domain);
    if (row && !needsFetch(row, nowMs)) done.set(domain, toMeta(row));
    else todo.push(domain);
  }

  const layer1 = await loadLayer1(db, todo);
  const fetched = await mapLimit(todo, opts.concurrency ?? ENRICH_CONCURRENCY, async (domain): Promise<DomainMeta> => {
    const previous = stored.get(domain);
    const base = layer1For(layer1, domain);
    try {
      const page = await fetchHead(`https://${domain}/`, opts);
      const head = page.html ? parseHeadMeta(page.html, new URL(page.url)) : null;
      return {
        domain,
        logoUrl: base?.logoUrl ?? head?.icon ?? previous?.logo_url ?? null,
        ogImage: head?.ogImage ?? previous?.og_image ?? null,
        ogTitle: head?.ogTitle ?? previous?.og_title ?? null,
        ogDescription: head?.ogDescription ?? previous?.og_description ?? null,
        tvlUsd: base?.tvlUsd ?? previous?.tvl_usd ?? null,
        category: base?.category ?? previous?.category ?? null,
        source: 'html',
        fetchedAt: nowMs,
        expiresAt: nowMs + OK_TTL_MS,
        error: null,
      };
    } catch (err) {
      return {
        domain,
        logoUrl: base?.logoUrl ?? previous?.logo_url ?? null,
        ogImage: previous?.og_image ?? null,
        ogTitle: previous?.og_title ?? null,
        ogDescription: previous?.og_description ?? null,
        tvlUsd: base?.tvlUsd ?? previous?.tvl_usd ?? null,
        category: base?.category ?? previous?.category ?? null,
        source: base?.source ?? 'html',
        fetchedAt: nowMs,
        expiresAt: nowMs + ERROR_TTL_MS,
        error: errorText(err),
      };
    }
  });

  await Promise.all(chunks(fetched, 200).map(part => db.batch(part.map(m => upsertStmt(db, m)))));
  for (const meta of fetched) done.set(meta.domain, meta);
  return uniq.map(domain => done.get(domain)!);
}

/**
 * Enriches the `limit` highest-scoring clusters whose domain has no fetched cache entry yet
 * (or whose entry expired), then backfills clusters.og_image / og_title / og_description / tvl_usd.
 */
export async function enrichActiveClusters(
  db: D1Database,
  nowMs: number,
  limit: number,
  opts: EnrichOptions = {},
): Promise<{ selected: number; errors: number }> {
  const res = await db
    .prepare(
      `SELECT c.id AS id, lower(c.domain) AS domain FROM clusters c
       LEFT JOIN domain_meta dm ON dm.domain = lower(c.domain)
       WHERE c.domain IS NOT NULL AND c.domain != ''
         AND (dm.domain IS NULL OR dm.expires_at <= ?1 OR (dm.error IS NULL AND dm.source != 'html'))
       ORDER BY c.score DESC, c.last_seen DESC, c.id ASC
       LIMIT ?2`,
    )
    .bind(nowMs, Math.max(0, limit))
    .all<{ id: string; domain: string }>();
  const clusters = res.results ?? [];
  if (clusters.length === 0) return { selected: 0, errors: 0 };

  const metas = await enrichDomainsBatch(
    db,
    clusters.map(c => c.domain),
    { ...opts, nowMs },
  );
  const byDomain = new Map(metas.map(m => [m.domain, m]));
  await db.batch(
    clusters.flatMap(c => {
      const meta = byDomain.get(c.domain);
      return meta
        ? [
            db
              .prepare('UPDATE clusters SET og_image = ?2, og_title = ?3, og_description = ?4, tvl_usd = ?5 WHERE id = ?1')
              .bind(c.id, meta.ogImage ?? null, meta.ogTitle ?? null, meta.ogDescription ?? null, meta.tvlUsd ?? null),
          ]
        : [];
    }),
  );
  return { selected: clusters.length, errors: metas.filter(m => m.error != null).length };
}

/**
 * Layer 1 seed: one `defillama` row per protocol site in the DefiLlama protocols payload.
 * An existing row keeps its fetched state, og data and error; only logo, TVL and category refresh.
 * Returns the number of domains written.
 */
export async function seedDefiLlamaDomains(db: D1Database, protocolsRaw: unknown, nowMs: number): Promise<number> {
  const sites = new Map<string, { logo: string | null; tvl: number | null; category: string | null }>();
  for (const p of Array.isArray(protocolsRaw) ? protocolsRaw : []) {
    if (!p || typeof p !== 'object') continue;
    const site = typeof p.url === 'string' ? p.url.trim() : '';
    const domain = site ? getRegistrableDomain(/^[a-z][a-z0-9+.-]*:/i.test(site) ? site : `https://${site}`) : undefined;
    if (!domain || hostBlockReason(domain)) continue;
    const slug = typeof p.slug === 'string' ? p.slug.trim().toLowerCase() : '';
    const logo =
      (typeof p.logo === 'string' && p.logo ? safeHttpsUrl(p.logo) : null) ??
      (SAFE_LLAMA_SLUG_RE.test(slug) ? `https://icons.llamao.fi/icons/protocols/${encodeURIComponent(slug)}?w=48&h=48` : null);
    const tvl = typeof p.tvl === 'number' && Number.isFinite(p.tvl) && p.tvl > 0 ? p.tvl : null;
    const category = typeof p.category === 'string' ? stripOrTranslateCjk(p.category).trim() || null : null;
    const previous = sites.get(domain);
    if (!previous || (tvl ?? 0) > (previous.tvl ?? 0)) sites.set(domain, { logo, tvl, category });
  }

  const rows = [...sites];
  await db.batch(
    rows.map(([domain, site]) =>
      db
        .prepare(
          `INSERT INTO domain_meta (domain, logo_url, tvl_usd, category, source, fetched_at, expires_at)
           VALUES (?1, ?2, ?3, ?4, 'defillama', ?5, ?6)
           ON CONFLICT(domain) DO UPDATE SET
             logo_url = COALESCE(excluded.logo_url, domain_meta.logo_url),
             tvl_usd = excluded.tvl_usd,
             category = excluded.category`,
        )
        .bind(domain, site.logo, site.tvl, site.category, nowMs, nowMs + OK_TTL_MS),
    ),
  );
  return rows.length;
}

/**
 * Enriches curated airdrop cards in the stored `airdrops` snapshot using cached `domain_meta`
 * (Layer 1 DefiLlama/CoinGecko + Layer 2 SSRF-safe HTML head fetch for up to `limit` uncached
 * card domains). Skips risk-badged cards and preserves the snapshot's original `fetched_at`.
 */
export async function enrichAirdropsSnapshot(
  db: D1Database,
  nowMs: number,
  limit: number,
  opts: EnrichOptions = {},
): Promise<{ enriched: number; fetched: number; errors: number }> {
  const row = await readSnapshot(db, 'airdrops');
  if (!row?.body || row.body === '{}') return { enriched: 0, fetched: 0, errors: 0 };

  let feed: AirdropFeed;
  try {
    feed = JSON.parse(row.body) as AirdropFeed;
  } catch {
    return { enriched: 0, fetched: 0, errors: 0 };
  }
  if (!Array.isArray(feed?.cards) || feed.cards.length === 0) return { enriched: 0, fetched: 0, errors: 0 };

  const cardDomains: (string | null)[] = feed.cards.map(card => {
    if (card.b?.includes('risk') || !card.url) return null;
    const raw = getRegistrableDomain(card.url);
    return raw ? normalizeDomain(raw) : null;
  });

  const uniqueDomains = [...new Set(cardDomains.filter((d): d is string => d !== null))];
  if (uniqueDomains.length === 0) return { enriched: 0, fetched: 0, errors: 0 };

  const stored = await loadMetaRows(db, uniqueDomains);
  const missingDomains: string[] = [];
  const seenMissing = new Set<string>();
  const cap = Math.max(0, limit);
  for (let i = 0; i < feed.cards.length && missingDomains.length < cap; i++) {
    const dom = cardDomains[i];
    if (!dom || seenMissing.has(dom)) continue;
    const card = feed.cards[i]!;
    if (card.img && card.ogImage) continue;
    const existing = stored.get(dom);
    if (!existing || needsFetch(existing, nowMs)) {
      seenMissing.add(dom);
      missingDomains.push(dom);
    }
  }

  const fetchedMetas =
    missingDomains.length > 0 ? await enrichDomainsBatch(db, missingDomains, { ...opts, nowMs }) : [];
  const metaByDomain = new Map<string, DomainMeta>();
  for (const [dom, metaRow] of stored) metaByDomain.set(dom, toMeta(metaRow));
  for (const meta of fetchedMetas) metaByDomain.set(meta.domain, meta);

  let enriched = 0;
  for (let i = 0; i < feed.cards.length; i++) {
    const dom = cardDomains[i];
    if (!dom) continue;
    const meta = metaByDomain.get(dom);
    if (!meta) continue;
    const card = feed.cards[i]!;
    let changed = false;
    if (!card.img && meta.logoUrl) {
      card.img = meta.logoUrl;
      changed = true;
    }
    if (!card.ogImage && meta.ogImage) {
      card.ogImage = meta.ogImage;
      changed = true;
    }
    if ((card.tvlUsd == null || card.tvlUsd <= 0) && meta.tvlUsd != null && meta.tvlUsd > 0) {
      card.tvlUsd = meta.tvlUsd;
      changed = true;
    }
    if (!card.description && meta.ogDescription) {
      card.description = meta.ogDescription;
      changed = true;
    }
    if (changed) enriched++;
  }

  if (enriched > 0) {
    await upsertSnapshot(db, 'airdrops', feed, row.fetched_at);
  }
  return {
    enriched,
    fetched: fetchedMetas.length,
    errors: fetchedMetas.filter(m => m.error != null).length,
  };
}
