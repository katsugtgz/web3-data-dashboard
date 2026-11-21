import { readFile } from 'node:fs/promises';
import type { CandidateSource } from '../worker/src/sources/discover';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const inputIdx = args.indexOf('--input');
const inputPath = inputIdx >= 0 ? args[inputIdx + 1] : null;

const apiBase = (process.env.VITE_API_BASE ?? process.env.WORKER_URL ?? '').replace(/\/+$/, '');
const repo = process.env.GITHUB_REPOSITORY ?? '';
const token = process.env.GITHUB_TOKEN ?? '';

async function loadCandidates(): Promise<CandidateSource[]> {
  if (inputPath) {
    return JSON.parse(await readFile(inputPath, 'utf8')) as CandidateSource[];
  }
  if (!apiBase) {
    // An empty candidate list published to the issue reads as "nothing
    // qualified"; a missing config must fail the run instead of wiping it.
    throw new Error('VITE_API_BASE / WORKER_URL is not set — refusing to publish an empty candidates issue');
  }
  const res = await fetch(`${apiBase}/sources/candidates.json`, {
    headers: { 'User-Agent': 'web3-radar-discovery/1.0' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching candidates`);
  return (await res.json()) as CandidateSource[];
}

export function renderCandidatesIssueBody(candidates: CandidateSource[]): string {
  const snippet = candidates.slice(0, 20).map(c => ({
    platform: 'telegram',
    handle: c.handle,
    lang: 'en',
    trust: 0.4,
    tags: ['discovered'],
    enabled: false,
  }));

  const rows = candidates
    .slice(0, 20)
    .map(
      c =>
        `| @${c.handle} | ${c.mentions} | ${c.fromSources.length} (${c.fromSources.slice(0, 4).join(', ')}) | ${new Date(c.lastSeen).toISOString().slice(0, 10)} |`,
    );

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
    JSON.stringify(snippet, null, 2),
    '```',
  ].join('\n');
}

async function upsertGithubIssue(title: string, body: string): Promise<void> {
  if (!repo || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'web3-radar-discovery/1.0',
  };
  const listRes = await fetch(
    `https://api.github.com/repos/${repo}/issues?state=open&per_page=100`,
    { headers },
  );
  if (!listRes.ok) throw new Error(`GitHub list issues HTTP ${listRes.status}`);
  const issues = (await listRes.json()) as { number: number; title: string }[];
  const existing = issues.find(i => i.title === title);

  if (existing) {
    const patchRes = await fetch(`https://api.github.com/repos/${repo}/issues/${existing.number}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ body }),
    });
    if (!patchRes.ok) throw new Error(`GitHub patch issue HTTP ${patchRes.status}`);
    console.log(`Updated existing issue #${existing.number}`);
  } else {
    const createRes = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title, body, labels: ['source-discovery'] }),
    });
    if (!createRes.ok) throw new Error(`GitHub create issue HTTP ${createRes.status}`);
    console.log('Created new Source candidates issue');
  }
}

async function main() {
  const candidates = await loadCandidates();
  const body = renderCandidatesIssueBody(candidates);
  if (dryRun || !repo || !token) {
    console.log('=== DRY-RUN ISSUE BODY ===\n' + body);
    return;
  }
  await upsertGithubIssue('Source candidates', body);
}

if (import.meta.main) {
  await main();
}
