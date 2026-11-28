import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertTaskRefsIntact, copyAndValidateSnapshots, copyTaskRefs, validatePagesDataDir } from './build-pages.mts';

const REPO = join(import.meta.dir, '..');
const TASKS = 'data/tasks';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'build-pages-test-'));
  tempDirs.push(dir);
  return dir;
}

async function seedValidSnapshots(dir: string): Promise<void> {
  await writeFile(join(dir, 'airdrops.json'), JSON.stringify({ cards: [{ r: 1 }], tge: [], counts: { active: 1, preToken: 1 }, fetchedAt: 1 }));
  await writeFile(join(dir, 'markets.json'), JSON.stringify({ generatedAt: 1, sections: [{ id: 'crypto', rows: [{}] }], sectors: [] }));
  await writeFile(join(dir, 'feed.json'), JSON.stringify({ generatedAt: 1, items: [{ id: '1' }] }));
  await writeFile(join(dir, 'sources.json'), JSON.stringify([{ id: 'telegram:alpha', status: 'ok' }]));
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe('build-pages snapshot validation', () => {
  test('copies JSON snapshots and accepts valid non-empty payloads', async () => {
    const src = await makeTempDir();
    const dest = await makeTempDir();
    await seedValidSnapshots(src);

    const copied = await copyAndValidateSnapshots(src, dest);
    expect(copied.sort()).toEqual(['airdrops.json', 'feed.json', 'markets.json', 'sources.json']);
  });

  test('copies task refs byte for byte, JSON files only', async () => {
    const src = await makeTempDir();
    const dest = await makeTempDir();
    const manifest = '{\n  "kind": "task_manifest"\n}\n';
    await writeFile(join(src, 'manifest.json'), manifest);
    await writeFile(join(src, 'voucher-demo.v1.json'), '{\n  "kind": "task_ref"\n}\n');
    await writeFile(join(src, 'notes.txt'), 'skip me');

    const copied = await copyTaskRefs(src, join(dest, 'tasks'));

    expect(copied.sort()).toEqual(['manifest.json', 'voucher-demo.v1.json']);
    // The manifest pins each reference by the hash of its bytes, so nothing may be rewritten.
    expect(await readFile(join(dest, 'tasks', 'manifest.json'), 'utf8')).toBe(manifest);
    expect(await Bun.file(join(dest, 'tasks', 'notes.txt')).exists()).toBe(false);
  });

  test('copies the bundled task manifest and every reference it pins byte for byte', async () => {
    const dest = await makeTempDir();

    const copied = await copyTaskRefs(join(REPO, TASKS), join(dest, 'tasks'));

    const manifest = JSON.parse(await readFile(join(REPO, TASKS, 'manifest.json'), 'utf8'));
    expect(copied.sort()).toEqual(['manifest.json', ...manifest.tasks.map((task: { ref_path: string }) => task.ref_path)].sort());
    for (const name of copied) {
      const source = await readFile(join(REPO, TASKS, name));
      expect((await readFile(join(dest, 'tasks', name))).equals(source), name).toBe(true);
    }
    expect(await readdir(join(dest, 'tasks'))).toHaveLength(copied.length);
  });

  test('rejects when a required snapshot file is missing', async () => {
    const dir = await makeTempDir();
    await seedValidSnapshots(dir);
    await rm(join(dir, 'feed.json'));

    await expect(validatePagesDataDir(dir)).rejects.toThrow(/feed\.json/i);
  });

  test('rejects invalid JSON or empty required collections', async () => {
    const dir = await makeTempDir();
    await seedValidSnapshots(dir);
    await writeFile(join(dir, 'markets.json'), JSON.stringify({ generatedAt: 1, sections: [], sectors: [] }));

    await expect(validatePagesDataDir(dir)).rejects.toThrow(/markets\.json/i);

    await seedValidSnapshots(dir);
    await writeFile(join(dir, 'sources.json'), '{not-json');
    await expect(validatePagesDataDir(dir)).rejects.toThrow(/sources\.json/i);
  });

  test('rejects Pages snapshots containing gambling, casino, or betting airdrops or drops', async () => {
    const dir = await makeTempDir();
    await seedValidSnapshots(dir);
    await writeFile(
      join(dir, 'airdrops.json'),
      JSON.stringify({
        cards: [
          {
            r: 1,
            n: 'Yeet',
            t: null,
            g: 'B',
            b: ['live'],
            f: '$7.75M',
            tk: '1/1',
            h: 100,
            u: 'today',
            fit: ['zero'],
            best: { n: 'Waitlist', ty: 'form', c: 'Free', m: '1 min' },
            taskTypes: ['form'],
            sc: 50,
            sub: [5, 5, null],
            url: 'https://comingsoon.yeet.com/',
          },
        ],
        tge: [],
        counts: { active: 1, preToken: 1 },
        fetchedAt: 1,
      }),
    );
    await expect(validatePagesDataDir(dir)).rejects.toThrow(/gambling\/betting/i);

    await seedValidSnapshots(dir);
    await writeFile(
      join(dir, 'airdrops.json'),
      JSON.stringify({
        cards: [
          {
            r: 1,
            n: 'Base',
            t: null,
            g: 'A',
            b: ['live'],
            f: '—',
            tk: '1/1',
            h: 100,
            u: 'today',
            fit: ['zero'],
            best: { n: 'Basenames', ty: 'mainnet', c: 'Free', m: '3 min' },
            taskTypes: ['mainnet', 'predictions'],
            tasks: [
              { title: 'Coinbase Predict', type: 'predictions', status: 'OPEN', cost: 0, timeMinutes: 5, url: 'https://coinbase.com/predictions' },
            ],
            sc: 70,
            sub: [7, 7, null],
            url: 'https://base.org/',
          },
        ],
        tge: [],
        counts: { active: 1, preToken: 1 },
        fetchedAt: 1,
      }),
    );
    await expect(validatePagesDataDir(dir)).rejects.toThrow(/gambling\/betting/i);

    await seedValidSnapshots(dir);
    await writeFile(
      join(dir, 'feed.json'),
      JSON.stringify({
        generatedAt: 1,
        items: [
          {
            id: 'bet-1',
            project: 'Rollbit',
            domain: 'rollbit.com',
            chains: [],
            taskTypes: ['quest'],
            summary: 'Rollbit crypto casino airdrop live',
            links: [{ url: 'https://rollbit.com/airdrop', known: false }],
            sources: [],
            sourceCount: 1,
            score: 80,
            risk: { level: 'ok', reasons: [] },
            firstSeen: 1,
            lastSeen: 1,
          },
        ],
      }),
    );
    await expect(validatePagesDataDir(dir)).rejects.toThrow(/gambling\/betting/i);
  });
});

describe('build-pages task reference gate', () => {
  test('passes on the repository', async () => {
    await expect(assertTaskRefsIntact(REPO)).resolves.toBeUndefined();
  });

  test('refuses a task directory whose manifest fails the contract', async () => {
    const root = await makeTempDir();
    await mkdir(join(root, TASKS), { recursive: true });
    await writeFile(join(root, TASKS, 'manifest.json'), '{\n  "kind": "task_manifest"\n}\n');

    await expect(assertTaskRefsIntact(root)).rejects.toThrow('data/tasks/manifest.json');
  });
});
