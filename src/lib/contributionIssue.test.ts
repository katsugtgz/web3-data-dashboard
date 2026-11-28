import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTRIBUTION_REPO } from '../../shared/constants';
import {
  MAX_CONTRIBUTION_BYTES,
  contributionIdMarker,
  validateContribution,
  type ContributionPreview,
} from '../../shared/contribution';
import { parseManifest, parseStrictJson, parseTaskRef, type TaskManifestV1, type TaskRefV1 } from '../../shared/taskContract';
import {
  CONTRIBUTION_STORAGE_KEY,
  MAX_ISSUE_URL_LENGTH,
  MAX_RECORDED_CONTRIBUTIONS,
  blankIssueUrl,
  buildIssueUrl,
  contributionId,
  loadRecordedContributionIds,
  recordContributionId,
} from './contributionIssue';

const ROOT = join(import.meta.dir, '../..');
const GOLDEN_PATH = 'skills/web3-radar-task/tests/golden/flop-testnet-voucher.v1.blocked_not_active.json';
const GOLDEN = readFileSync(join(ROOT, GOLDEN_PATH), 'utf8');
const ID = 'ab'.repeat(32);

function parseFile(path: string): unknown {
  const json = parseStrictJson(readFileSync(join(ROOT, path), 'utf8'), 1 << 20);
  if (!json.ok) throw new Error(`${path}: ${json.error}`);
  return json.value;
}

const parsedManifest = parseManifest(parseFile('data/tasks/manifest.json'));
if (!parsedManifest.ok) throw new Error('manifest must parse');
const manifest: TaskManifestV1 = parsedManifest.manifest;
const refs = new Map<string, TaskRefV1>();
for (const entry of manifest.tasks) {
  const parsedRef = parseTaskRef(parseFile(`data/tasks/${entry.ref_path}`));
  if (!parsedRef.ok) throw new Error(`${entry.ref_path} must parse`);
  refs.set(entry.task_id, parsedRef.ref);
}

const validated = validateContribution(GOLDEN, manifest, refs);
if (!validated.ok) throw new Error(`golden report must validate: ${validated.code}`);
const CANONICAL = validated.canonical;
const PREVIEW = validated.preview;

/** Installs a stand-in localStorage for one block, then removes it again. */
function withStorage(storage: unknown, run: () => void): void {
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  try {
    run();
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('contribution constants', () => {
  test('match the agreed limits', () => {
    expect(MAX_CONTRIBUTION_BYTES).toBe(16384);
    expect(MAX_ISSUE_URL_LENGTH).toBe(8000);
    expect(MAX_RECORDED_CONTRIBUTIONS).toBe(50);
    expect(CONTRIBUTION_STORAGE_KEY).toBe('radar.contributions.v1');
  });
});

describe('contributionId', () => {
  test('is the lowercase SHA-256 hex of the canonical report, the same value CI computes', async () => {
    const id = await contributionId(CANONICAL);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    // A literal, so a change to canonicalization or hashing shows up here.
    expect(id).toBe('87748cba3a4ebeccfac28a92f8d75ef3e44e3dcf580b071483ca27fea6006410');
    expect(id).toBe(createHash('sha256').update(CANONICAL, 'utf8').digest('hex'));
    expect(await contributionId('other')).not.toBe(id);
  });

  test('is empty where the browser withholds SubtleCrypto', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: { subtle: undefined }, configurable: true, writable: true });
    try {
      expect(await contributionId(CANONICAL)).toBe('');
    } finally {
      if (original) Object.defineProperty(globalThis, 'crypto', original);
      else delete (globalThis as { crypto?: unknown }).crypto;
    }
  });
});

describe('buildIssueUrl', () => {
  test('builds a prefilled GitHub form for the validated report', () => {
    const issue = buildIssueUrl(PREVIEW, CANONICAL, ID);
    const url = new URL(issue.url!);

    expect(issue.tooLong).toBe(false);
    expect(issue.title).toBe('[contribution] flop-testnet-voucher v1 (blocked_not_active)');
    expect(url.origin + url.pathname).toBe(`https://github.com/${CONTRIBUTION_REPO}/issues/new`);
    expect(url.searchParams.get('template')).toBe('task-contribution.md');
    expect(url.searchParams.get('labels')).toBe('task-contribution,needs-review');
    expect(url.searchParams.get('title')).toBe(issue.title);
    expect(url.searchParams.get('body')).toBe(issue.body);
    expect(issue.url!.length).toBeLessThanOrEqual(MAX_ISSUE_URL_LENGTH);
  });

  test('puts the canonical JSON and the id marker in the body', () => {
    const issue = buildIssueUrl(PREVIEW, CANONICAL, ID, 'owner/other');

    expect(issue.body).toContain(`\`\`\`json\n${CANONICAL}\n\`\`\``);
    expect(issue.body).toContain(contributionIdMarker(ID));
    expect(issue.url).toContain('https://github.com/owner/other/issues/new?template=task-contribution.md');
    expect(issue.body).toContain('| Status | blocked_not_active |');
    expect(issue.body).toContain(`| Ref SHA-256 | ${PREVIEW.ref_sha256} |`);
  });

  test('leaves the marker out when no id could be computed', () => {
    const issue = buildIssueUrl(PREVIEW, CANONICAL, '');
    expect(issue.body).not.toContain('contribution-id');
  });

  test('keeps a pipe inside reviewed text from opening a new table cell', () => {
    const piped: ContributionPreview = {
      ...PREVIEW,
      attempted_steps: [{ ...PREVIEW.attempted_steps[0], title: 'Read a | b and report' }],
      checkpoint: PREVIEW.checkpoint && { ...PREVIEW.checkpoint, action: 'Wait | then verify' },
    };
    for (const line of buildIssueUrl(piped, CANONICAL, ID).body.split('\n').filter(line => line.startsWith('|'))) {
      expect(line.replace(/\\\|/g, '').match(/\|/g)).toHaveLength(3);
    }
  });

  test('falls back to a body to copy when the link would be too long', () => {
    const manySteps = Array.from({ length: 200 }, (_, index) => ({
      id: `step_${index}`,
      title: `Step ${index} ` + 'x'.repeat(300),
      outcome: 'pass' as const,
      source_ids: [] as string[],
    }));
    const huge: ContributionPreview = { ...PREVIEW, attempted_steps: manySteps };
    const issue = buildIssueUrl(huge, CANONICAL, ID);

    expect(issue.tooLong).toBe(true);
    expect(issue.url).toBeNull();
    expect(issue.title).toBe('[contribution] flop-testnet-voucher v1 (blocked_not_active)');
    expect(issue.body).toContain(CANONICAL);
    expect(issue.body).toContain(`<!-- contribution-id: ${ID} -->`);
    // The body alone fits the contribution limit, so the report itself is not what grew.
    expect(new TextEncoder().encode(CANONICAL).byteLength).toBeLessThan(MAX_CONTRIBUTION_BYTES);
    expect(blankIssueUrl()).toBe(`https://github.com/${CONTRIBUTION_REPO}/issues/new?template=task-contribution.md`);
  });
});

describe('recorded contribution ids', () => {
  test('stays empty and never throws when storage is absent, blocked, or holds garbage', () => {
    // The test runner has no localStorage at all, which is the absent case.
    expect(loadRecordedContributionIds()).toEqual([]);
    expect(() => recordContributionId(ID)).not.toThrow();
    expect(loadRecordedContributionIds()).toEqual([]);

    const blocked = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    withStorage(blocked, () => {
      expect(() => recordContributionId(ID)).not.toThrow();
      expect(loadRecordedContributionIds()).toEqual([]);
    });

    for (const raw of ['not json', '{}', 'null', JSON.stringify([ID.toUpperCase(), 7, null, 'short'])]) {
      withStorage({ getItem: () => raw }, () => expect(loadRecordedContributionIds()).toEqual([]));
    }
  });

  test('records an id once and drops the oldest past the cap', () => {
    const values = new Map<string, string>();
    withStorage(
      {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          values.set(key, value);
        },
      },
      () => {
        recordContributionId(ID);
        recordContributionId(ID);
        expect(loadRecordedContributionIds()).toEqual([ID]);
        for (let index = 0; index < MAX_RECORDED_CONTRIBUTIONS; index++) recordContributionId(index.toString(16).padStart(64, '0'));
        const recorded = loadRecordedContributionIds();
        expect(recorded).toHaveLength(MAX_RECORDED_CONTRIBUTIONS);
        // 51 ids went in, so the first one in (ID) is the first one out.
        expect(recorded).not.toContain(ID);
        expect(recorded[0]).toBe('0'.padStart(64, '0'));
        expect(recorded[MAX_RECORDED_CONTRIBUTIONS - 1]).toBe((MAX_RECORDED_CONTRIBUTIONS - 1).toString(16).padStart(64, '0'));
        expect([...new Set(recorded)].length).toBe(MAX_RECORDED_CONTRIBUTIONS);
        expect(JSON.parse(values.get(CONTRIBUTION_STORAGE_KEY)!)).toEqual(recorded);
      },
    );
  });
});
