import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyAndValidateSnapshots, validatePagesDataDir } from './build-pages.mts';

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
});
