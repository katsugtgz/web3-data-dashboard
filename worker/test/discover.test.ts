import { describe, expect, test } from 'bun:test';
import { createTestD1 } from './helpers';
import { renderCandidatesIssueBody } from '../../scripts/discover-sources-issue.mts';
import { extractCandidateHandles, getTopCandidates, recordCandidates } from '../src/sources/discover';

function createSqliteD1(): D1Database {
  return createTestD1().db;
}

describe('source auto-discovery', () => {
  test('extracts valid handles and excludes self, registered, and invite links', () => {
    const existing = new Set(['layergg']);
    const handles = extractCandidateHandles(
      'new_gem_channel',
      [
        'https://t.me/fresh_alpha_hub',
        'https://t.me/layergg/123',
        'https://t.me/+SecretInvite123',
        'https://t.me/addlist/VhL9U8igPD1mMjU1',
        'https://t.me/my_own_channel/5',
      ],
      'my_own_channel',
      existing,
    );
    expect(handles.sort()).toEqual(['fresh_alpha_hub', 'new_gem_channel']);
  });

  test('returns only candidates mentioned by >= 2 distinct sources and renders dry-run snippet', async () => {
    const db = createSqliteD1();
    const now = 1_795_240_000_000;
    await recordCandidates(db, ['cand_two', 'cand_one'], 'telegram:ch1', now);
    await recordCandidates(db, ['cand_two'], 'telegram:ch2', now + 1000);
    await recordCandidates(db, ['cand_one'], 'telegram:ch1', now + 2000);

    const top = await getTopCandidates(db, 50);
    expect(top.length).toBe(1);
    expect(top[0].handle).toBe('cand_two');
    expect(top[0].mentions).toBe(2);
    expect(top[0].fromSources.sort()).toEqual(['telegram:ch1', 'telegram:ch2']);

    const md = renderCandidatesIssueBody(top);
    expect(md).toContain('@cand_two');
    expect(md).toContain('"enabled": false');
    expect(md).toContain('"trust": 0.4');
  });

  test('recordCandidates upserts merge against the stored from_sources row, not a pre-read copy', async () => {
    const db = createSqliteD1();
    const now = 1_795_240_000_000;
    // Two recordCandidates calls target the same handle. (Sequential sqlite
    // batches cannot exercise true concurrent writers; what IS pinned here is
    // that the upsert merges against the STORED list — each call's write
    // unions the row left by the previous one instead of overwriting it.)
    await recordCandidates(db, ['racy'], 'telegram:chA', now);
    await recordCandidates(db, ['racy'], 'telegram:chB', now);

    const rows = await db
      .prepare('SELECT mentions, from_sources FROM source_candidates WHERE handle = ?1')
      .bind('racy')
      .first<{ mentions: number; from_sources: string }>();
    expect(rows?.mentions).toBe(2);
    expect(JSON.parse(rows?.from_sources ?? '[]').sort()).toEqual(['telegram:chA', 'telegram:chB']);
  });

  test('getTopCandidates breaks same-tick ties deterministically by handle ASC', async () => {
    const db = createSqliteD1();
    const now = 1_795_240_000_000;
    // Same mentions, same last_seen: body (and ETag) must not depend on row
    // return order.
    await recordCandidates(db, ['zeta_cand'], 'telegram:ch1', now);
    await recordCandidates(db, ['zeta_cand'], 'telegram:ch2', now);
    await recordCandidates(db, ['alpha_cand'], 'telegram:ch1', now);
    await recordCandidates(db, ['alpha_cand'], 'telegram:ch2', now);

    const top = await getTopCandidates(db, 50);
    expect(top.map(c => c.handle)).toEqual(['alpha_cand', 'zeta_cand']);
  });
});
