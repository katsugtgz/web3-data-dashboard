import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TYPE_MAP, TYPES } from '../shared/constants';
import { findGamblingAirdropViolations, findGamblingFeedViolations } from '../shared/gamblingFilter';
import type { AirdropFeed, FeedResponse } from '../shared/types';

export async function checkNoGamblingInDir(dir: string): Promise<string[]> {
  const violations: string[] = [];

  if (TYPES.some(t => t.toLowerCase() === 'betting') || Object.hasOwn(TYPE_MAP, 'Betting')) {
    violations.push('shared/constants.ts still exposes Betting airdrop type filter');
  }

  const airdropsRaw = await readFile(join(dir, 'airdrops.json'), 'utf8');
  const airdrops = JSON.parse(airdropsRaw) as AirdropFeed;
  violations.push(...findGamblingAirdropViolations(airdrops));

  const feedRaw = await readFile(join(dir, 'feed.json'), 'utf8');
  const feed = JSON.parse(feedRaw) as FeedResponse;
  violations.push(...findGamblingFeedViolations(feed));

  return violations;
}

if (import.meta.main) {
  const dir = process.argv[2] ?? 'data/snapshot';
  const violations = await checkNoGamblingInDir(dir);
  if (violations.length > 0) {
    console.error(`ERROR: Found ${violations.length} forbidden gambling/betting airdrop violation(s) in ${dir}:`);
    for (const v of violations.slice(0, 20)) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log(`OK: Zero gambling/betting airdrop violations found in ${dir}.`);
}
