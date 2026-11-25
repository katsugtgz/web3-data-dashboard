import { readFile } from 'node:fs/promises';
import type { CandidateSource } from '../worker/src/sources/discover';
import { SEED_SOURCES, type SourceConfig } from '../worker/src/sources/registry';

const USER_AGENT = 'web3-radar-discovery/1.0';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_PAGES = 100;

export interface CliArgs {
  dryRun: boolean;
  inputPath: string | null;
}

export function parseCliArgs(argv: string[]): CliArgs {
  let dryRun = false;
  let inputPath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--input') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        throw new Error('--input requires a file path');
      }
      inputPath = next;
      i++;
    } else if (arg.startsWith('--input=')) {
      const val = arg.slice('--input='.length);
      if (!val || val.startsWith('-')) {
        throw new Error('--input requires a file path');
      }
      inputPath = val;
    }
  }
  return { dryRun, inputPath };
}

export function inferCandidateLang(
  fromSources: readonly string[],
  sources: readonly SourceConfig[] = SEED_SOURCES,
): string {
  if (fromSources.length === 0) return 'en';
  const langByKey = new Map<string, string>();
  for (const s of sources) {
    langByKey.set(`${s.platform}:${s.handle}`.toLowerCase(), s.lang);
    const bare = s.handle.toLowerCase();
    if (!langByKey.has(bare)) langByKey.set(bare, s.lang);
  }
  const langs = new Set<string>();
  for (const src of fromSources) {
    const lang = langByKey.get(src.toLowerCase());
    if (!lang) return 'en';
    langs.add(lang);
  }
  return langs.size === 1 ? [...langs][0] : 'en';
}

function escapeTableText(raw: string): string {
  return raw
    .replace(/[\r\n]+/g, ' ')
    .replace(/\|/g, '\\|')
    .replace(/`/g, '\\`');
}

function formatHandleCodeSpan(handle: string): string {
  const safe = `@${handle.replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|')}`;
  const runs = safe.match(/`+/g);
  const maxRun = runs ? Math.max(...runs.map(r => r.length)) : 0;
  const fence = '`'.repeat(maxRun + 1);
  const needsPad = safe.startsWith('`') || safe.endsWith('`') || safe.startsWith(' ') || safe.endsWith(' ');
  return needsPad ? `${fence} ${safe} ${fence}` : `${fence}${safe}${fence}`;
}

function formatLastSeen(ts: number): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return 'unknown';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return d.toISOString().slice(0, 10);
}

async function loadCandidates(inputPath: string | null, dryRun: boolean, apiBase: string): Promise<CandidateSource[]> {
  if (inputPath) {
    return JSON.parse(await readFile(inputPath, 'utf8')) as CandidateSource[];
  }
  if (!apiBase) {
    if (dryRun) return [];
    // An empty candidate list published to the issue reads as "nothing
    // qualified"; a missing config must fail the run instead of wiping it.
    // Local --dry-run previews without a worker stay possible.
    throw new Error('VITE_API_BASE / WORKER_URL is not set — refusing to publish an empty candidates issue');
  }
  const res = await fetch(`${apiBase}/sources/candidates.json`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching candidates`);
  return (await res.json()) as CandidateSource[];
}

export function renderCandidatesIssueBody(
  candidates: CandidateSource[],
  sources: readonly SourceConfig[] = SEED_SOURCES,
): string {
  const snippet = candidates.slice(0, 20).map(c => ({
    platform: 'telegram',
    handle: c.handle,
    lang: inferCandidateLang(c.fromSources, sources),
    trust: 0.4,
    tags: ['discovered'],
    enabled: false,
  }));

  const rows = candidates.slice(0, 20).map(c => {
    const handleCell = formatHandleCodeSpan(c.handle);
    const fromCell = c.fromSources.slice(0, 4).map(escapeTableText).join(', ');
    const lastSeenCell = formatLastSeen(c.lastSeen);
    return `| ${handleCell} | ${c.mentions} | ${c.fromSources.length} (${fromCell}) | ${lastSeenCell} |`;
  });

  // Escape backticks inside JSON strings as \u0060 so untrusted handles cannot
  // break out of the fenced ```json block while preserving 100% valid JSON.
  const safeJson = JSON.stringify(snippet, null, 2).replace(/`/g, '\\u0060');

  return [
    'Automated weekly list of public Telegram channels discovered via forwards & mentions in ≥ 2 distinct seed sources.',
    'Review and copy desired entries into `worker/sources.json` (set `enabled: true` only after verifying).',
    '',
    '| Handle | Mentions | Distinct sources | Last seen |',
    '| --- | ---: | --- | --- |',
    ...(rows.length > 0 ? rows : ['| _None qualified yet_ | 0 | 0 | — |']),
    '',
    '### Ready-to-paste `worker/sources.json` snippet',
    '```json',
    safeJson,
    '```',
  ].join('\n');
}

interface GithubIssueItem {
  number: number;
  title: string;
  pull_request?: unknown;
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/i);
  if (!match?.[1]) return null;
  try {
    const u = new URL(match[1]);
    return u.origin === 'https://api.github.com' ? u.toString() : null;
  } catch {
    return null;
  }
}

export interface UpsertIssueOptions {
  repo?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxPages?: number;
}

export async function upsertGithubIssue(
  title: string,
  body: string,
  opts: UpsertIssueOptions = {},
): Promise<{ action: 'updated' | 'created'; number?: number }> {
  const repo = opts.repo ?? process.env.GITHUB_REPOSITORY ?? '';
  const token = opts.token ?? process.env.GITHUB_TOKEN ?? '';
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;

  if (!repo || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': USER_AGENT,
  };
  const writeHeaders = {
    ...headers,
    'Content-Type': 'application/json',
  };

  // Paginate with the same label filter the POST applies and skip pull requests:
  // GitHub's /issues endpoint includes PRs (`pull_request` field), and trackers
  // with many labeled items may span beyond 10 pages.
  let existingIssue: GithubIssueItem | undefined;
  let nextUrl: string | null =
    `https://api.github.com/repos/${repo}/issues?state=open&labels=source-discovery&per_page=100&page=1`;

  for (let page = 1; page <= maxPages && nextUrl; page++) {
    const listRes = await fetchImpl(nextUrl, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!listRes.ok) throw new Error(`GitHub list issues HTTP ${listRes.status}`);
    const issues = (await listRes.json()) as GithubIssueItem[];
    existingIssue = issues.find(i => !i.pull_request && i.title === title);
    if (existingIssue) break;

    const linkNext = parseNextLink(listRes.headers.get('Link'));
    if (linkNext) {
      nextUrl = linkNext;
    } else if (issues.length === 100) {
      nextUrl = `https://api.github.com/repos/${repo}/issues?state=open&labels=source-discovery&per_page=100&page=${page + 1}`;
    } else {
      nextUrl = null;
    }
  }

  if (existingIssue) {
    const patchRes = await fetchImpl(`https://api.github.com/repos/${repo}/issues/${existingIssue.number}`, {
      method: 'PATCH',
      headers: writeHeaders,
      body: JSON.stringify({ body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!patchRes.ok) throw new Error(`GitHub patch issue HTTP ${patchRes.status}`);
    console.log(`Updated existing issue #${existingIssue.number}`);
    return { action: 'updated', number: existingIssue.number };
  }

  if (nextUrl) {
    throw new Error(
      `Reached maxPages (${maxPages}) before exhausting open source-discovery issues; refusing to create a duplicate`,
    );
  }

  const createRes = await fetchImpl(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({ title, body, labels: ['source-discovery'] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!createRes.ok) throw new Error(`GitHub create issue HTTP ${createRes.status}`);
  console.log('Created new Source candidates issue');
  return { action: 'created' };
}

async function main() {
  const { dryRun, inputPath } = parseCliArgs(process.argv.slice(2));
  const apiBase = (process.env.VITE_API_BASE?.trim() || process.env.WORKER_URL?.trim() || '').replace(/\/+$/, '');
  const repo = process.env.GITHUB_REPOSITORY ?? '';
  const token = process.env.GITHUB_TOKEN ?? '';

  const candidates = await loadCandidates(inputPath, dryRun, apiBase);
  const body = renderCandidatesIssueBody(candidates);
  if (dryRun) {
    console.log('=== DRY-RUN ISSUE BODY ===\n' + body);
    return;
  }
  // Missing credentials must fail the run: a silent exit 0 reads as "published"
  // in CI while nothing was upserted (the old gate swallowed upsertGithubIssue's
  // credential check forever).
  if (!repo || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required to publish the issue');
  await upsertGithubIssue('Source candidates', body, { repo, token });
}

if (import.meta.main) {
  await main();
}
