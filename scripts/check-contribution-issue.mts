// CI check for `task-contribution` issues. Validates the fenced run report, looks for an earlier
// issue with the same contribution id, and leaves one fixed-text comment. Run with
// `bun scripts/check-contribution-issue.mts` inside GitHub Actions. It never commits and never
// touches data/tasks.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CONTRIBUTION_REPO } from '../shared/constants';
import { validateContribution, type ContributionResult } from '../shared/contribution';
import { parseManifest, parseStrictJson, parseTaskRef, type TaskManifestV1, type TaskRefV1 } from '../shared/taskContract';

const USER_AGENT = 'web3-radar-contribution/1.0';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_PAGES = 10;
const TASK_LABEL = 'task-contribution';
// The largest limit contract.py applies to a task file.
const MAX_TASK_FILE_BYTES = 262144;
const COMMENT_MARK = '<!-- contribution-check -->';

export type ContributionOutcome = 'validated' | 'stale-revision' | 'duplicate' | 'invalid-contribution';

export interface ExistingIssueBody {
  number: number;
  body: string;
}

export interface ContributionCheck {
  outcome: ContributionOutcome;
  /** SHA-256 hex of the canonical report, or null when the report was rejected. */
  contributionId: string | null;
  comment: string;
}

interface GithubIssueItem {
  number: number;
  body: string | null;
  pull_request?: unknown;
}

interface GithubComment {
  id: number;
  body: string;
  user?: { type?: string } | null;
}

// Fixed text only. The issue body is untrusted and never reaches a comment.
const COMMENTS = {
  validated: [
    'Contribution check: **validated**.',
    '',
    'The run report parses as schema v1, matches the current revision and `ref_sha256` of its task, and no earlier issue carries the same contribution id. A maintainer still reviews the evidence by hand, so this comment is not an acceptance.',
  ],
  'stale-revision': [
    'Contribution check: **stale-revision**.',
    '',
    'The run report does not match the current revision or `ref_sha256` of its task. Run the task again with the current task files, then edit this issue and replace the report.',
  ],
  duplicate: [
    'Contribution check: **duplicate**.',
    '',
    'An earlier issue already carries this contribution id. Please continue there instead.',
  ],
  'invalid-contribution': [
    'Contribution check: **invalid-contribution**.',
    '',
    "This issue does not hold exactly one fenced `json` block with a valid read-only run report. Validate the report in the dashboard's contribution dialog, then edit this issue and replace it. This comment never repeats text from the issue.",
  ],
} as const satisfies Record<ContributionOutcome, readonly string[]>;

const commentFor = (outcome: ContributionOutcome): string => `${COMMENT_MARK}\n${COMMENTS[outcome].join('\n')}`;

/** The text inside the issue's one fenced `json` block, or null when there is not exactly one. */
export function extractContributionJson(body: string): string | null {
  const blocks = [...body.matchAll(/```json[ \t]*\r?\n([\s\S]*?)\r?\n```/gi)];
  return blocks.length === 1 ? blocks[0][1] : null;
}

/** The 64-hex contribution id from the issue's first marker comment, or null. */
export function extractContributionIdMarker(body: string): string | null {
  return body.match(/<!--\s*contribution-id:\s*([0-9a-f]{64})\s*-->/)?.[1] ?? null;
}

const STALE_CODES: ReadonlySet<string> = new Set(['stale_revision', 'unknown_revision', 'ref_sha256_mismatch']);

/** Decides the outcome for one issue body. `existingBodies` covers every other issue with the task label. */
export function evaluateContributionIssue(input: {
  body: string;
  issueNumber: number;
  manifest: TaskManifestV1;
  refs: ReadonlyMap<string, TaskRefV1>;
  existingBodies: readonly ExistingIssueBody[];
}): ContributionCheck {
  const json = extractContributionJson(input.body);
  const result: ContributionResult | null = json === null ? null : validateContribution(json, input.manifest, input.refs);
  if (!result?.ok) {
    const stale = result !== null && STALE_CODES.has(result.code);
    const outcome: ContributionOutcome = stale ? 'stale-revision' : 'invalid-contribution';
    return { outcome, contributionId: null, comment: commentFor(outcome) };
  }
  // The id comes from the validated report, never from a marker the issue author wrote.
  const contributionId = createHash('sha256').update(result.canonical, 'utf8').digest('hex');
  const duplicate = input.existingBodies.some(
    issue => issue.number < input.issueNumber && extractContributionIdMarker(issue.body) === contributionId,
  );
  const outcome: ContributionOutcome = duplicate ? 'duplicate' : 'validated';
  return { outcome, contributionId, comment: commentFor(outcome) };
}

async function loadTasks(rootDir: string): Promise<{ manifest: TaskManifestV1; refs: Map<string, TaskRefV1> }> {
  const read = async (relPath: string): Promise<unknown> => {
    const json = parseStrictJson(await readFile(join(rootDir, relPath), 'utf8'), MAX_TASK_FILE_BYTES);
    if (!json.ok) throw new Error(`${relPath}: ${json.error}`);
    return json.value;
  };
  const parsedManifest = parseManifest(await read('data/tasks/manifest.json'));
  if (!parsedManifest.ok) throw new Error(`data/tasks/manifest.json: ${parsedManifest.error}`);
  const refs = new Map<string, TaskRefV1>();
  for (const entry of parsedManifest.manifest.tasks) {
    const parsedRef = parseTaskRef(await read(`data/tasks/${entry.ref_path}`));
    if (!parsedRef.ok) throw new Error(`data/tasks/${entry.ref_path}: ${parsedRef.error}`);
    refs.set(entry.task_id, parsedRef.ref);
  }
  return { manifest: parsedManifest.manifest, refs };
}

function parseNextLink(linkHeader: string | null): string | null {
  const match = linkHeader?.match(/<([^>]+)>;\s*rel="next"/i);
  if (!match?.[1]) return null;
  try {
    const url = new URL(match[1]);
    return url.origin === 'https://api.github.com' ? url.toString() : null;
  } catch {
    return null;
  }
}

export interface RunContributionCheckOptions {
  eventPath?: string;
  token?: string;
  repo?: string;
  rootDir?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxPages?: number;
}

/**
 * Reads the issue from the GitHub Actions event file, because an issue body must never pass
 * through a workflow expression. Comments on the issue and returns the same outcome.
 */
export async function runContributionCheck(options: RunContributionCheckOptions = {}): Promise<ContributionCheck> {
  const token = options.token ?? process.env.GITHUB_TOKEN ?? '';
  const repo = options.repo ?? process.env.GITHUB_REPOSITORY ?? CONTRIBUTION_REPO;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  if (!token) throw new Error('GITHUB_TOKEN is required to comment on the issue');

  const eventPath = options.eventPath ?? process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH is required');
  const event = JSON.parse(await readFile(eventPath, 'utf8')) as { issue?: { number?: unknown; body?: unknown } };
  const issueNumber = event.issue?.number;
  if (typeof issueNumber !== 'number' || !Number.isInteger(issueNumber) || issueNumber < 1) {
    throw new Error('GITHUB_EVENT_PATH does not describe an issue');
  }
  // From here on the body is untrusted: it goes to the validator and nowhere else.
  const body = typeof event.issue?.body === 'string' ? event.issue.body : '';

  const { manifest, refs } = await loadTasks(resolve(options.rootDir ?? '.'));
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': USER_AGENT,
  };
  const api = `https://api.github.com/repos/${repo}/issues`;

  const existingBodies: ExistingIssueBody[] = [];
  let nextUrl: string | null = `${api}?state=all&labels=${TASK_LABEL}&per_page=100&page=1`;
  for (let page = 1; page <= maxPages && nextUrl; page++) {
    const response = await fetchImpl(nextUrl, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`GitHub list issues HTTP ${response.status}`);
    const items = (await response.json()) as GithubIssueItem[];
    // The issues endpoint also returns pull requests that carry the label.
    for (const item of items) {
      if (!item.pull_request && typeof item.body === 'string') existingBodies.push({ number: item.number, body: item.body });
    }
    nextUrl = parseNextLink(response.headers.get('Link'));
  }
  if (nextUrl) {
    throw new Error(`Reached maxPages (${maxPages}) before listing every contribution issue; the duplicate check would be incomplete`);
  }

  const check = evaluateContributionIssue({ body, issueNumber, manifest, refs, existingBodies });

  // One comment per issue: a later run on the same issue replaces the bot's earlier verdict.
  const listed = await fetchImpl(`${api}/${issueNumber}/comments?per_page=100`, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!listed.ok) throw new Error(`GitHub list comments HTTP ${listed.status}`);
  const earlier = ((await listed.json()) as GithubComment[]).find(
    comment => comment.body.startsWith(COMMENT_MARK) && comment.user?.type === 'Bot',
  );
  const commented = await fetchImpl(earlier ? `https://api.github.com/repos/${repo}/issues/comments/${earlier.id}` : `${api}/${issueNumber}/comments`, {
    method: earlier ? 'PATCH' : 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: check.comment }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!commented.ok) throw new Error(`GitHub ${earlier ? 'update' : 'create'} comment HTTP ${commented.status}`);
  return check;
}

if (import.meta.main) {
  const check = await runContributionCheck();
  console.log(`Contribution check: ${check.outcome}`);
}
