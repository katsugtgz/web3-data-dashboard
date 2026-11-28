import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTRIBUTION_REPO } from '../shared/constants';
import { contributionIdMarker, validateContribution } from '../shared/contribution';
import { parseManifest, parseStrictJson, parseTaskRef, type TaskManifestV1, type TaskRefV1 } from '../shared/taskContract';
import {
  evaluateContributionIssue,
  extractContributionIdMarker,
  extractContributionJson,
  runContributionCheck,
  type ExistingIssueBody,
} from './check-contribution-issue.mts';

type Mutable = Record<string, any>;
interface Tasks {
  manifest: TaskManifestV1;
  refs: ReadonlyMap<string, TaskRefV1>;
}
interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

const ROOT = join(import.meta.dir, '..');
const GOLDEN_PATH = 'skills/web3-radar-task/tests/golden/flop-testnet-voucher.v1.blocked_not_active.json';
const GOLDEN = readFileSync(join(ROOT, GOLDEN_PATH), 'utf8');
const TEMPLATE = readFileSync(join(ROOT, '.github/ISSUE_TEMPLATE/task-contribution.md'), 'utf8');
const FLOP = 'flop-testnet-voucher';
const PLACEHOLDER = 'PASTE THE SANITIZED, SCHEMA-VALIDATED run_report JSON HERE, REPLACING THIS LINE';
const REPO = 'owner/repo';
const API = `https://api.github.com/repos/${REPO}/issues`;
const LIST_URL = `${API}?state=all&labels=task-contribution&per_page=100&page=1`;
const WORKFLOW_PATH = '.github/workflows/contribution-check.yml';

// Sample payloads are joined from fragments so no secret scanner reads them as live secrets.
const SECRET = ['Bea', 'rer abcdefghijklmnop'].join('');
const SECRET_TAIL = ['abcdef', 'ghijklmnop'].join('');
const EMAIL = ['someone', '@', 'example', '.', 'org'].join('');
const EMAIL_TAIL = ['example', '.', 'org'].join('');

const tempDirs: string[] = [];

function parseFile(path: string): unknown {
  const json = parseStrictJson(readFileSync(join(ROOT, path), 'utf8'), 1 << 20);
  if (!json.ok) throw new Error(`${path}: ${json.error}`);
  return json.value;
}

function loadTasks(): Tasks {
  const parsedManifest = parseManifest(parseFile('data/tasks/manifest.json'));
  if (!parsedManifest.ok) throw new Error(`data/tasks/manifest.json: ${parsedManifest.error}`);
  const refs = new Map<string, TaskRefV1>();
  for (const entry of parsedManifest.manifest.tasks) {
    const parsedRef = parseTaskRef(parseFile(`data/tasks/${entry.ref_path}`));
    if (!parsedRef.ok) throw new Error(`data/tasks/${entry.ref_path}: ${parsedRef.error}`);
    refs.set(entry.task_id, parsedRef.ref);
  }
  return { manifest: parsedManifest.manifest, refs };
}

const TASKS = loadTasks();
const golden = validateContribution(GOLDEN, TASKS.manifest, TASKS.refs);
if (!golden.ok) throw new Error(`golden report must validate: ${golden.code}`);
// SHA-256 of the canonical golden report. A literal, so a change to canonicalization or hashing shows up.
const GOLDEN_ID = '87748cba3a4ebeccfac28a92f8d75ef3e44e3dcf580b071483ca27fea6006410';

/** A JSON round trip hands `change` a plain copy of the golden report. */
const reportText = (change: (report: Mutable) => void = () => {}): string => {
  const report = JSON.parse(GOLDEN) as Mutable;
  change(report);
  return JSON.stringify(report);
};
const issueBody = (json: string, id?: string): string =>
  [
    'Read-only task run offered for maintainer review.',
    '',
    '```json',
    json,
    '```',
    '',
    '- [ ] Valid schema v1 & matching revision/ref_sha256',
    ...(id ? [`<!-- contribution-id: ${id} -->`] : []),
  ].join('\n');
const evaluate = (body: string, existingBodies: ExistingIssueBody[] = [], tasks: Tasks = TASKS) =>
  evaluateContributionIssue({ body, issueNumber: 7, manifest: tasks.manifest, refs: tasks.refs, existingBodies });

const json = (value: unknown): Response => new Response(JSON.stringify(value), { status: 200 });
const page = (value: unknown, next?: string): Response =>
  new Response(JSON.stringify(value), { status: 200, headers: next ? { Link: `<${next}>; rel="next"` } : {} });

/** Answers from a URL table, or from a route function that sees every call. Records each call. */
function fakeFetch(routes: Record<string, unknown> | ((call: Call) => Response), calls: Call[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body === undefined ? '' : String(init.body),
    });
    const route = typeof routes === 'function' ? routes(calls[calls.length - 1]) : routes[url];
    return route instanceof Response ? route : json([]);
  }) as typeof fetch;
}

async function withEvent<T>(body: string | null, issueNumber: number, run: (eventPath: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'contribution-check-'));
  tempDirs.push(dir);
  const eventPath = join(dir, 'event.json');
  writeFileSync(eventPath, JSON.stringify({ action: 'opened', issue: { number: issueNumber, body } }), 'utf8');
  return run(eventPath);
}

const methods = (calls: Call[]): string[] => calls.map(call => call.method);

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('extractContributionJson', () => {
  test('returns the text of the one fenced json block', () => {
    expect(extractContributionJson(issueBody(GOLDEN))).toBe(GOLDEN);
    expect(extractContributionJson(`\`\`\`json\n${GOLDEN}\n\`\`\``)).toBe(GOLDEN);
    // Line endings inside the block stay as written; strict JSON treats both as whitespace.
    expect(extractContributionJson(issueBody(GOLDEN).replace(/\n/g, '\r\n'))!.replace(/\r\n/g, '\n')).toBe(GOLDEN);
    expect(extractContributionJson(issueBody(GOLDEN).replace('```json', '```JSON'))).toBe(GOLDEN);
    expect(extractContributionJson('```json   \n{"a":1}\n```')).toBe('{"a":1}');
  });

  test('returns null without a block or when more than one could be meant', () => {
    expect(extractContributionJson('')).toBeNull();
    expect(extractContributionJson('No report here.')).toBeNull();
    expect(extractContributionJson('```python\nprint(1)\n```')).toBeNull();
    expect(extractContributionJson(`${issueBody(GOLDEN)}\n${issueBody(GOLDEN)}`)).toBeNull();
  });

  test('returns the untouched template placeholder, which the validator then rejects', () => {
    expect(extractContributionJson(TEMPLATE)).toBe(PLACEHOLDER);
  });
});

describe('extractContributionIdMarker', () => {
  test('reads one lowercase 64-hex id and nothing else', () => {
    const id = 'ab'.repeat(32);
    expect(extractContributionIdMarker(issueBody(GOLDEN, id))).toBe(id);
    expect(extractContributionIdMarker(`<!-- contribution-id:   ${id} -->`)).toBe(id);
    expect(extractContributionIdMarker(issueBody(GOLDEN))).toBeNull();
    expect(extractContributionIdMarker(`<!-- contribution-id: ${'AB'.repeat(32)} -->`)).toBeNull();
    expect(extractContributionIdMarker(`<!-- contribution-id: ${'a'.repeat(63)} -->`)).toBeNull();
    // The marker the dialog writes into an issue body is the one read back here.
    expect(extractContributionIdMarker(issueBody(GOLDEN, contributionIdMarker(GOLDEN_ID)))).toBe(GOLDEN_ID);
  });
});

describe('evaluateContributionIssue', () => {
  test('validates the Python-generated FLOP golden report and derives the id from the canonical report', () => {
    const check = evaluate(issueBody(GOLDEN));
    expect(check).toEqual({
      outcome: 'validated',
      contributionId: GOLDEN_ID,
      comment: check.comment,
    });
    expect(check.contributionId).toMatch(/^[0-9a-f]{64}$/);
    expect(check.comment).toContain('Contribution check: **validated**.');
    expect(check.comment.startsWith('<!-- contribution-check -->\n')).toBe(true);
  });

  test('reports stale-revision for an older, unknown, or unpinned revision', () => {
    const newerManifest: TaskManifestV1 = {
      ...TASKS.manifest,
      tasks: TASKS.manifest.tasks.map(entry =>
        entry.task_id === FLOP ? { ...entry, revision: 2, ref_path: `${FLOP}.v2.json` } : entry,
      ),
    };
    const cases: [name: string, body: string, tasks: Tasks][] = [
      ['older revision', issueBody(GOLDEN), { ...TASKS, manifest: newerManifest }],
      ['unknown revision', issueBody(reportText(report => { report.revision = 2; })), TASKS],
      ['other ref hash', issueBody(reportText(report => { report.ref_sha256 = 'cd'.repeat(32); })), TASKS],
    ];
    for (const [name, body, tasks] of cases) {
      const check = evaluate(body, [], tasks);
      expect({ name, outcome: check.outcome, id: check.contributionId }).toEqual({ name, outcome: 'stale-revision', id: null });
      expect(check.comment).toContain('Contribution check: **stale-revision**.');
    }
  });

  test('reports duplicate only when an earlier issue carries the same id', () => {
    const later: ExistingIssueBody = { number: 9, body: issueBody(GOLDEN, GOLDEN_ID) };
    const itself: ExistingIssueBody = { number: 7, body: issueBody(GOLDEN, GOLDEN_ID) };
    const other: ExistingIssueBody = { number: 3, body: issueBody(GOLDEN, 'ab'.repeat(32)) };
    const earlier: ExistingIssueBody = { number: 3, body: issueBody(GOLDEN, GOLDEN_ID) };

    for (const existing of [[], [later], [itself], [other]]) {
      expect(evaluate(issueBody(GOLDEN), existing).outcome).toBe('validated');
    }
    const duplicate = evaluate(issueBody(GOLDEN), [later, itself, other, earlier]);
    expect({ outcome: duplicate.outcome, id: duplicate.contributionId }).toEqual({ outcome: 'duplicate', id: GOLDEN_ID });
    expect(duplicate.comment).toContain('Contribution check: **duplicate**.');
  });

  test('takes the id from the report, not from a marker written into the issue', () => {
    const forged = 'ab'.repeat(32);
    const check = evaluate(issueBody(GOLDEN, forged), [{ number: 3, body: issueBody(GOLDEN, forged) }]);
    expect({ outcome: check.outcome, id: check.contributionId }).toEqual({ outcome: 'validated', id: GOLDEN_ID });
  });

  test('reports invalid-contribution without repeating the issue text', () => {
    const bodies = [
      // A report outside the template's fenced block is not a contribution either.
      GOLDEN,
      issueBody(reportText(report => { report.mode = 'synthetic_fixture'; })),
      issueBody(reportText(report => { report.status = 'verified_fixture'; report.checkpoint = null; })),
      issueBody(reportText(report => { report.checkpoint.action = SECRET; })),
      issueBody(reportText(report => { report.checkpoint.action = EMAIL; })),
      issueBody(reportText(report => { report.note = SECRET; })),
      TEMPLATE,
      '',
      '```json\n{"a":1}\n```\n```json\n{"b":2}\n```',
      'x'.repeat(10),
    ];
    for (const body of bodies) {
      const check = evaluate(body, [{ number: 3, body: issueBody(GOLDEN, GOLDEN_ID) }]);
      expect({ outcome: check.outcome, id: check.contributionId }).toEqual({ outcome: 'invalid-contribution', id: null });
      expect(check.comment).toContain('Contribution check: **invalid-contribution**.');
      for (const marker of [SECRET, SECRET_TAIL, EMAIL, EMAIL_TAIL]) {
        expect(JSON.stringify(check)).not.toContain(marker);
      }
    }
  });

  test('every comment is one fixed template', () => {
    const checks = [
      evaluate(issueBody(GOLDEN)),
      evaluate(issueBody(reportText(report => { report.revision = 2; }))),
      evaluate(issueBody(GOLDEN), [{ number: 3, body: issueBody(GOLDEN, GOLDEN_ID) }]),
      evaluate(''),
    ];
    const comments = checks.map(check => check.comment);
    expect(new Set(comments).size).toBe(4);
    for (const [check, comment] of checks.map((check, index) => [check, comments[index]] as const)) {
      // Marker line, verdict line, blank line, then the fixed explanation.
      expect(comment.split('\n').slice(0, 3)).toEqual([
        '<!-- contribution-check -->',
        `Contribution check: **${check.outcome}**.`,
        '',
      ]);
      expect(comment.split('\n')).toHaveLength(4);
      expect(comment).not.toContain(GOLDEN_ID);
    }
  });
});

describe('runContributionCheck', () => {
  test('reads the issue from the event file and posts one fixed comment', async () => {
    const calls: Call[] = [];
    const fetchImpl = fakeFetch(
      {
        [LIST_URL]: json([
          // The issues endpoint also lists pull requests that carry the label.
          { number: 2, body: issueBody(GOLDEN, GOLDEN_ID), pull_request: { url: 'https://api.github.com/pulls/2' } },
          { number: 3, body: 'an unrelated issue' },
        ]),
        [`${API}/7/comments?per_page=100`]: json([]),
        [`${API}/7/comments`]: json({ id: 50 }),
      },
      calls,
    );

    const check = await withEvent(issueBody(GOLDEN), 7, eventPath =>
      runContributionCheck({ eventPath, token: 'ghp_test', repo: REPO, rootDir: ROOT, fetchImpl }),
    );

    expect(check).toMatchObject({ outcome: 'validated', contributionId: GOLDEN_ID });
    expect(calls.map(call => [call.method, call.url])).toEqual([
      ['GET', LIST_URL],
      ['GET', `${API}/7/comments?per_page=100`],
      ['POST', `${API}/7/comments`],
    ]);
    for (const call of calls) {
      expect(call.headers.Authorization).toBe('Bearer ghp_test');
      expect(call.headers['User-Agent']).toBe('web3-radar-contribution/1.0');
    }
    expect(JSON.parse(calls[2].body)).toEqual({ body: check.comment });
  });

  test('replaces the earlier bot comment instead of adding another', async () => {
    const calls: Call[] = [];
    const fetchImpl = fakeFetch(
      {
        [LIST_URL]: json([{ number: 7, body: issueBody(GOLDEN) }]),
        [`${API}/7/comments?per_page=100`]: json([
          { id: 41, body: 'A human comment.', user: { type: 'User' } },
          { id: 42, body: '<!-- contribution-check -->\nClaimed by a human.', user: { type: 'User' } },
          { id: 43, body: '<!-- contribution-check -->\nOld verdict.', user: { type: 'Bot' } },
        ]),
        [`https://api.github.com/repos/${REPO}/issues/comments/43`]: json({ id: 43 }),
      },
      calls,
    );

    await withEvent(issueBody(reportText(report => { report.revision = 2; })), 7, async eventPath => {
      const check = await runContributionCheck({ eventPath, token: 'ghp_test', repo: REPO, rootDir: ROOT, fetchImpl });
      expect(check.outcome).toBe('stale-revision');
    });

    expect(methods(calls)).toEqual(['GET', 'GET', 'PATCH']);
    expect(calls[2].url).toBe(`https://api.github.com/repos/${REPO}/issues/comments/43`);
    expect(JSON.parse(calls[2].body).body).toContain('Contribution check: **stale-revision**.');
  });

  test('keeps the issue text out of every request body', async () => {
    const calls: Call[] = [];
    const fetchImpl = fakeFetch(
      {
        [LIST_URL]: json([]),
        [`${API}/7/comments?per_page=100`]: json([]),
        [`${API}/7/comments`]: json({ id: 50 }),
      },
      calls,
    );

    await withEvent(issueBody(reportText(report => { report.note = SECRET; })), 7, async eventPath => {
      const check = await runContributionCheck({ eventPath, token: 'ghp_test', repo: REPO, rootDir: ROOT, fetchImpl });
      expect(check.outcome).toBe('invalid-contribution');
    });

    // One request carries a body, and it holds the fixed comment only.
    const withBody = calls.filter(call => call.body !== '');
    expect(withBody).toHaveLength(1);
    for (const marker of [SECRET, SECRET_TAIL]) expect(withBody[0].body).not.toContain(marker);
  });

  test('refuses to run without a token and stops on a failing list call', async () => {
    await withEvent(issueBody(GOLDEN), 7, eventPath =>
      expect(runContributionCheck({ eventPath, repo: REPO, rootDir: ROOT })).rejects.toThrow(/GITHUB_TOKEN/),
    );

    const calls: Call[] = [];
    const fetchImpl = fakeFetch(
      {
        [LIST_URL]: new Response('no', { status: 500 }),
        [`${API}/7/comments`]: json({ id: 50 }),
      },
      calls,
    );
    await withEvent(issueBody(GOLDEN), 7, eventPath =>
      expect(runContributionCheck({ eventPath, token: 'ghp_test', repo: REPO, rootDir: ROOT, fetchImpl })).rejects.toThrow(/HTTP 500/),
    );
    expect(methods(calls)).toEqual(['GET']);
  });

  test('follows the next page link and refuses an incomplete duplicate search', async () => {
    const next = `${API}?state=all&labels=task-contribution&per_page=100&page=2`;
    const earlierIssue = { number: 3, body: issueBody(GOLDEN, GOLDEN_ID) };

    const complete: Call[] = [];
    const paged = fakeFetch(call => (call.url === LIST_URL ? page([earlierIssue], next) : page([])), complete);
    await withEvent(issueBody(GOLDEN), 7, async eventPath => {
      const check = await runContributionCheck({ eventPath, token: 'ghp_test', repo: REPO, rootDir: ROOT, fetchImpl: paged });
      expect(check.outcome).toBe('duplicate');
    });
    expect(complete.map(call => call.url)).toEqual([LIST_URL, next, `${API}/7/comments?per_page=100`, `${API}/7/comments`]);

    const capped: Call[] = [];
    const neverEnding = fakeFetch(() => page([], next), capped);
    await withEvent(issueBody(GOLDEN), 7, eventPath =>
      expect(
        runContributionCheck({ eventPath, token: 'ghp_test', repo: REPO, rootDir: ROOT, fetchImpl: neverEnding, maxPages: 1 }),
      ).rejects.toThrow(/maxPages/),
    );
    expect(methods(capped)).toEqual(['GET']);
  });

  test('refuses an event file that does not describe an issue', async () => {
    const calls: Call[] = [];
    const fetchImpl = fakeFetch({}, calls);
    await withEvent(issueBody(GOLDEN), 0, eventPath =>
      expect(runContributionCheck({ eventPath, token: 'ghp_test', repo: REPO, rootDir: ROOT, fetchImpl })).rejects.toThrow(
        /does not describe an issue/,
      ),
    );
    expect(calls).toEqual([]);
  });
});

describe('contribution workflow', () => {
  test('triggers on issues, guards on the task label, and keeps issue text out of the workflow expressions', () => {
    const workflow = readFileSync(join(ROOT, WORKFLOW_PATH), 'utf8');
    expect(workflow).toContain('issues:');
    expect(workflow).toContain('[opened, edited]');
    expect(workflow).toContain("contains(github.event.issue.labels.*.name, 'task-contribution')");
    expect(workflow).toContain('issues: write');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('GITHUB_EVENT_PATH: ${{ github.event_path }}');
    expect(workflow).toContain('bun scripts/check-contribution-issue.mts');
    // The issue title and body must never be interpolated into a shell command.
    expect(workflow).not.toContain('github.event.issue.body');
    expect(workflow).not.toContain('github.event.issue.title');
    expect(CONTRIBUTION_REPO).toBe('katsugtgz/web3-data-dashboard');
  });
});
