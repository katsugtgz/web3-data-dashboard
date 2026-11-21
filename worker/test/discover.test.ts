import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderCandidatesIssueBody } from '../../scripts/discover-sources-issue.mts';
import { extractCandidateHandles, getTopCandidates, recordCandidates } from '../src/sources/discover';

function createSqliteD1(): D1Database {
  const sqlite = new Database(':memory:');
  for (const file of ['../migrations/0001_init.sql', '../migrations/0002_feed.sql', '../migrations/0003_p4.sql']) {
    sqlite.exec(readFileSync(new URL(file, import.meta.url), 'utf8'));
  }
  const makeStmt = (sql: string, params: unknown[] = []) => ({
    bind(...args: unknown[]) {
      return makeStmt(sql, args);
    },
    async first<T = unknown>(): Promise<T | null> {
      const row = sqlite.query(sql).get(...(params as [])) as T | undefined;
      return row ?? null;
    },
    async all<T = unknown>() {
      const results = sqlite.query(sql).all(...(params as [])) as T[];
      return { results, success: true, meta: { changes: 0 } };
    },
    async run() {
      const info = sqlite.query(sql).run(...(params as []));
      return { success: true, meta: { changes: info.changes } };
    },
  });
  return {
    prepare(sql: string) {
      return makeStmt(sql);
    },
    async batch(stmts: ReturnType<typeof makeStmt>[]) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
    async exec(sql: string) {
      sqlite.exec(sql);
      return { count: 1, duration: 0 };
    },
  } as unknown as D1Database;
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
});
