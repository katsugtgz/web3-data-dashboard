import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkTaskRefs } from './check-task-refs.mts';

const REPO = join(import.meta.dir, '..');
const MANIFEST = 'data/tasks/manifest.json';
const VOUCHER = 'data/tasks/voucher-demo.v1.json';
const GOLDEN = 'skills/web3-radar-task/tests/golden/flop-testnet-voucher.v1.blocked_not_active.json';
const SKILL_MD = 'skills/web3-radar-task/SKILL.md';
// Everything the checker reads lives under one of these paths of its root directory.
const CHECKED_PATHS = ['data/tasks', 'skills/web3-radar-task/SKILL.md', 'skills/web3-radar-task/tests/golden'];
const FLOP_FEED_ID = '7331604250321743f7293ccd2a8740720b4df8b1';

const roots: string[] = [];

/** A fresh copy of the checked paths of the repository. */
function copyOfRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'task-refs-'));
  roots.push(root);
  for (const relPath of CHECKED_PATHS) {
    const target = join(root, relPath);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(REPO, relPath), target, { recursive: true });
  }
  return root;
}

const read = (root: string, relPath: string): string => readFileSync(join(root, relPath), 'utf8');
function write(root: string, relPath: string, text: string): void {
  const target = join(root, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
}
const sha256 = (root: string, relPath: string): string =>
  createHash('sha256').update(readFileSync(join(root, relPath))).digest('hex');

function editJson(root: string, relPath: string, change: (doc: Record<string, any>) => void): void {
  const doc = JSON.parse(read(root, relPath));
  change(doc);
  write(root, relPath, `${JSON.stringify(doc, null, 2)}\n`);
}

/** Applies `change`, then returns the problems the checker reports without `fix`. */
async function problemsAfter(change: (root: string) => void): Promise<string[]> {
  const root = copyOfRepo();
  change(root);
  return (await checkTaskRefs({ rootDir: root })).problems;
}

// Windows releases file handles late, so removal retries.
afterAll(async () => {
  for (let attempt = 0; attempt < 10 && roots.length > 0; attempt++) {
    try {
      for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
});

describe('checkTaskRefs', () => {
  test('passes on the repository and on an unmodified copy', async () => {
    expect(await checkTaskRefs({ rootDir: REPO })).toEqual({ ok: true, problems: [], fixed: [] });
    expect(await checkTaskRefs({ rootDir: copyOfRepo() })).toEqual({ ok: true, problems: [], fixed: [] });
  });

  test('fails when one byte of a pinned reference changes', async () => {
    const problems = await problemsAfter((root) => write(root, VOUCHER, read(root, VOUCHER).replace('Demo only.', 'Demo 0nly.')));
    expect(problems).toEqual([expect.stringMatching(/^data\/tasks\/voucher-demo\.v1\.json: ref_sha256 in the manifest does not match the file \(actual [0-9a-f]{64}\)$/)]);
  });

  test('fails on a JSON file that the manifest does not list', async () => {
    const problems = await problemsAfter((root) => write(root, 'data/tasks/stray.v1.json', '{}\n'));
    expect(problems).toEqual(['data/tasks/stray.v1.json: not listed in data/tasks/manifest.json']);
  });

  test('fails when a synthetic fixture binds a card, feed, or domain', async () => {
    for (const [field, value] of [['feed_ids', 'a'.repeat(40)], ['card_ids', '021766f0-3b1d-488f-9c0c-0a4c37a92a52'], ['domains', 'demo.test']]) {
      const problems = await problemsAfter((root) =>
        editJson(root, MANIFEST, (doc) => {
          doc.tasks[0].bindings[field] = [value];
        }),
      );
      expect(problems, field).toEqual([`data/tasks/manifest.json: voucher-demo is a synthetic fixture and must leave ${field} empty`]);
    }
  });

  test('fails when two tasks claim one binding', async () => {
    const problems = await problemsAfter((root) =>
      editJson(root, MANIFEST, (doc) => {
        doc.tasks[0].bindings.feed_ids = [FLOP_FEED_ID];
      }),
    );
    // The checker names the later row, which claims a feed the FLOP row already holds.
    expect(problems).toEqual(['data/tasks/manifest.json: invalid_manifest at $.tasks[2].bindings.feed_ids[0]']);
  });

  test('fails when the golden report is stale or no longer a run report', async () => {
    const stale = await problemsAfter((root) => editJson(root, GOLDEN, (doc) => void (doc.ref_sha256 = '0'.repeat(64))));
    expect(stale).toEqual([expect.stringMatching(/^skills\/web3-radar-task\/tests\/golden\/flop-testnet-voucher\.v1\.blocked_not_active\.json: ref_sha256 is stale for flop-testnet-voucher/)]);
    const broken = await problemsAfter((root) => editJson(root, GOLDEN, (doc) => void (doc.status = 'done')));
    expect(broken).toEqual([expect.stringContaining(': invalid_field_value at $.status')]);
  });

  test('fails when the skill preflight drifts from PREFLIGHT_LINES', async () => {
    const problems = await problemsAfter((root) =>
      write(root, SKILL_MD, read(root, SKILL_MD).replace('**Confirm scope.**', '**Confirm the scope.**')),
    );
    expect(problems).toEqual(['skills/web3-radar-task/SKILL.md: PREFLIGHT_LINES[1] is missing or changed']);
  });

  test('fails when a reference holds a secret outside the exempt paths', async () => {
    const problems = await problemsAfter((root) => write(root, VOUCHER, read(root, VOUCHER).replace('Demo only.', 'Demo 1234.')));
    expect(problems).toEqual([
      expect.stringMatching(/^data\/tasks\/voucher-demo\.v1\.json: ref_sha256 in the manifest does not match the file/),
      'data/tasks/voucher-demo.v1.json: secret_detected',
    ]);
  });

  test('with fix, rewrites a stale manifest hash and writes the manifest with LF and a final newline', async () => {
    const root = copyOfRepo();
    const original = read(root, VOUCHER);
    const tampered = original.replace('"revision": 1,', '"revision": 1, ').replaceAll('\n', '\r\n');
    write(root, VOUCHER, tampered);
    const before = JSON.parse(read(root, MANIFEST)).tasks[0].ref_sha256;

    const result = await checkTaskRefs({ rootDir: root, fix: true });

    // `fix` rewrites the hash only. A reference with CR bytes stays a problem.
    expect(result.fixed).toEqual([`data/tasks/voucher-demo.v1.json -> ${sha256(root, VOUCHER)}`]);
    expect(result.problems).toEqual(['data/tasks/voucher-demo.v1.json: holds CR bytes; write it with LF line endings']);
    expect(result.ok).toBe(false);
    const manifest = read(root, MANIFEST);
    expect(manifest).toContain(sha256(root, VOUCHER));
    expect(manifest).not.toContain(before);
    expect(manifest.includes('\r')).toBe(false);
    expect(manifest.at(-1)).toBe('\n');
    expect(JSON.parse(manifest).tasks[0].bindings).toEqual({ card_ids: [], feed_ids: [], domains: [] });
  });

  test('with fix, a repaired manifest passes on the next run', async () => {
    const root = copyOfRepo();
    write(root, VOUCHER, read(root, VOUCHER).replace('Demo only.', 'Demo 0nly.'));
    expect(await checkTaskRefs({ rootDir: root, fix: true })).toEqual({
      ok: true,
      problems: [],
      fixed: [`data/tasks/voucher-demo.v1.json -> ${sha256(root, VOUCHER)}`],
    });
    expect(await checkTaskRefs({ rootDir: root })).toEqual({ ok: true, problems: [], fixed: [] });
  });

  test('checks the task registry only once src/lib/taskRegistry.ts exists', async () => {
    const registry = 'src/lib/taskRegistry.ts';
    const missingOne = await problemsAfter((root) => write(root, registry, "const RAW_REFS = { 'voucher-demo.v1.json': '' };\n"));
    expect(missingOne).toEqual([
      'src/lib/taskRegistry.ts: does not bundle browser-email-demo.v1.json',
      'src/lib/taskRegistry.ts: does not bundle flop-testnet-voucher.v1.json',
    ]);
    const root = copyOfRepo();
    write(root, registry, "const RAW_REFS = { 'voucher-demo.v1.json': '', 'browser-email-demo.v1.json': '', 'flop-testnet-voucher.v1.json': '' };\n");
    expect(await checkTaskRefs({ rootDir: root })).toEqual({ ok: true, problems: [], fixed: [] });
  });
});
