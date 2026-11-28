import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { findGamblingAirdropViolations, findGamblingFeedViolations } from '../shared/gamblingFilter';
import type { AirdropFeed, FeedResponse } from '../shared/types';
import { checkTaskRefs } from './check-task-refs.mts';

const REQUIRED_SNAPSHOT_VALIDATORS: readonly [string, (data: unknown) => boolean][] = [
  [
    'airdrops.json',
    data =>
      Boolean(data) &&
      typeof data === 'object' &&
      !Array.isArray(data) &&
      Array.isArray((data as { cards?: unknown }).cards) &&
      ((data as { cards: unknown[] }).cards.length > 0),
  ],
  [
    'markets.json',
    data =>
      Boolean(data) &&
      typeof data === 'object' &&
      !Array.isArray(data) &&
      Array.isArray((data as { sections?: unknown }).sections) &&
      ((data as { sections: unknown[] }).sections.length > 0),
  ],
  [
    'feed.json',
    data =>
      Boolean(data) &&
      typeof data === 'object' &&
      !Array.isArray(data) &&
      Array.isArray((data as { items?: unknown }).items) &&
      ((data as { items: unknown[] }).items.length > 0),
  ],
  ['sources.json', data => Array.isArray(data) && data.length > 0],
];

export async function validatePagesDataDir(dataDir: string): Promise<void> {
  for (const [file, isValid] of REQUIRED_SNAPSHOT_VALIDATORS) {
    const filePath = join(dataDir, file);
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (err) {
      throw new Error(`Missing required Pages snapshot ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Invalid JSON in Pages snapshot ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!isValid(parsed)) {
      throw new Error(`Empty or malformed Pages snapshot ${file}`);
    }
    if (file === 'airdrops.json') {
      const violations = findGamblingAirdropViolations(parsed as AirdropFeed);
      if (violations.length > 0) {
        throw new Error(
          `Forbidden gambling/betting entries in Pages snapshot ${file}: ${violations.slice(0, 5).join('; ')}`,
        );
      }
    } else if (file === 'feed.json') {
      const violations = findGamblingFeedViolations(parsed as FeedResponse);
      if (violations.length > 0) {
        throw new Error(
          `Forbidden gambling/betting entries in Pages snapshot ${file}: ${violations.slice(0, 5).join('; ')}`,
        );
      }
    }
  }
}

export async function copyAndValidateSnapshots(srcDir: string, destDir: string): Promise<string[]> {
  await mkdir(destDir, { recursive: true });
  const files = await readdir(srcDir);
  const copied: string[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    await copyFile(join(srcDir, file), join(destDir, file));
    copied.push(file);
    console.log(`${destDir}/${file} copied`);
  }
  await validatePagesDataDir(destDir);
  return copied;
}

/** Copies the task manifest and its references byte for byte: the manifest pins each reference by hash. */
export async function copyTaskRefs(srcDir: string, destDir: string): Promise<string[]> {
  await mkdir(destDir, { recursive: true });
  const files = (await readdir(srcDir)).filter((file) => file.endsWith('.json'));
  for (const file of files) {
    await copyFile(join(srcDir, file), join(destDir, file));
    console.log(`${destDir}/${file} copied`);
  }
  return files;
}

/** Throws unless the task manifest and every reference it pins pass the integrity gate under `rootDir`. */
export async function assertTaskRefsIntact(rootDir = '.'): Promise<void> {
  const result = await checkTaskRefs({ rootDir });
  if (!result.ok) {
    throw new Error(`Task reference check failed:\n${result.problems.map(problem => ` - ${problem}`).join('\n')}`);
  }
}

if (import.meta.main) {
  await Bun.$`vite build`;
  await copyAndValidateSnapshots('data/snapshot', 'dist/data');
  await assertTaskRefsIntact();
  await copyTaskRefs('data/tasks', 'dist/data/tasks');
}
