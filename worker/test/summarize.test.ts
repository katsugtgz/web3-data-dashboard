import { describe, expect, test } from 'bun:test';
import { createTestD1 } from './helpers';
import { HAN_RE } from '../src/normalize/i18n';
import {
  AI_MAX_ATTEMPTS,
  hasAiQuotaRemaining,
  summarizeClusterWithAi,
  unsafeContentRe,
  type AiBindingLike,
} from '../src/normalize/summarize';

function createSqliteD1(): D1Database {
  const { db, sqlite } = createTestD1();
  sqlite.exec(
    `INSERT INTO clusters (id, project, ticker, domain, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen)
     VALUES ('c1', 'KiteAI', 'KITE', 'kite.ai', '[]', '["other"]', 'KiteAI: other', 'rule', 'ok', '[]', 0.5, 1, 1000, 1000)`,
  );
  return db;
}

describe('Workers AI summary normalization & budget guard', () => {
  test('hasAiQuotaRemaining checks daily cap with 0 reads when disabled and 1 PK lookup otherwise', async () => {
    expect(AI_MAX_ATTEMPTS).toBe(3);

    const { db, queries } = createTestD1();
    const now = 1_795_240_000_000;
    const day = new Date(now).toISOString().slice(0, 10);

    expect(await hasAiQuotaRemaining(db, 0, now)).toBe(false);
    expect(await hasAiQuotaRemaining(db, -5, now)).toBe(false);
    expect(queries.length).toBe(0);

    expect(await hasAiQuotaRemaining(db, 5, now)).toBe(true);
    expect(queries.length).toBe(1);

    await db.prepare('INSERT INTO ai_usage (day, calls) VALUES (?1, ?2)').bind(day, 4).run();
    expect(await hasAiQuotaRemaining(db, 5, now)).toBe(true);

    await db.prepare('UPDATE ai_usage SET calls = ?2 WHERE day = ?1').bind(day, 5).run();
    expect(await hasAiQuotaRemaining(db, 5, now)).toBe(false);

    await db.prepare('UPDATE ai_usage SET calls = ?2 WHERE day = ?1').bind(day, 7).run();
    expect(await hasAiQuotaRemaining(db, 5, now)).toBe(false);

    expect(await hasAiQuotaRemaining(db, 5, now + 86_400_000)).toBe(true);
  });

  test('unsafeContentRe strips defanged hosts and catches base58 addresses', () => {
    // Plain content passes.
    expect(unsafeContentRe('Complete daily quests on the testnet')).toBe(false);
    // Two-label domains now match (previously only foo.bar.tld did).
    expect(unsafeContentRe('Visit claim-now.xyz for rewards')).toBe(true);
    // Defanged and obfuscated hosts are normalized before the test.
    expect(unsafeContentRe('claim-now[.]xyz')).toBe(true);
    expect(unsafeContentRe('claim-now(.)xyz')).toBe(true);
    expect(unsafeContentRe('claim-now\u3002xyz')).toBe(true);
    // Zero-width chars splitting the host do not hide it.
    expect(unsafeContentRe('claim-now\u200b.xyz')).toBe(true);
    // EVM and Solana (base58, no 0OIl) addresses both match.
    expect(unsafeContentRe('send funds to 0xAbCdEf0123456789AbCdEf0123456789AbCdEf01')).toBe(true);
    expect(unsafeContentRe('4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T')).toBe(true);
    // Base58 lookalike with forbidden char (0/O/I/l) is not an address.
    expect(unsafeContentRe('staking OI0l pool rewards here')).toBe(false);
  });


  test('AI summary rejects URLs and domain-like chains; merge caps and unions SQL-side', async () => {
    const db = createSqliteD1();

    // Uppercase URL / bare domain in a chain entry must be rejected CI.
    const urlAi: AiBindingLike = {
      async run() {
        return {
          response: JSON.stringify({
            summary: 'Bridge assets and farm points this week on the new network.',
            taskTypes: ['bridge'],
            chains: ['HTTPS://CLAIM-NOW.XYZ/AIRDROP', 'base'],
          }),
        };
      },
    };
    const res = await summarizeClusterWithAi(urlAi, db, {
      clusterId: 'c1',
      project: 'KiteAI',
      rawTexts: ['post'],
      isNewCluster: true,
      isNonLatinSource: false,
      riskLevel: 'ok',
    });
    expect(res).not.toBeNull();
    // The uppercase URL is rejected; the plain chain name survives.
    expect(res!.chains).toEqual(['base']);

    // Merge: stored chains survive, new ones union in, capped at 8 total;
    // concurrent ingest between SELECT and UPDATE is not lost (SQL-side merge).
    const seed = await db
      .prepare(`SELECT chains FROM clusters WHERE id = 'c1'`)
      .first<{ chains: string }>();
    // First call stored the surviving plain name.
    expect(JSON.parse(seed!.chains)).toEqual(['base']);
    const multiAi: AiBindingLike = {
      async run() {
        return {
          response: JSON.stringify({
            summary: 'Bridge assets and farm points this week on the new network.',
            taskTypes: ['bridge'],
            chains: ['Base', 'Arbitrum', 'Ethereum', 'Solana', 'Sui', 'Aptos', 'Polygon', 'TON', 'Scroll'],
          }),
        };
      },
    };
    const res2 = await summarizeClusterWithAi(multiAi, db, {
      clusterId: 'c1',
      project: 'KiteAI',
      rawTexts: ['post'],
      isNewCluster: true,
      isNonLatinSource: false,
      riskLevel: 'ok',
    });
    expect(res2).not.toBeNull();
    const row = await db
      .prepare(`SELECT chains FROM clusters WHERE id = 'c1'`)
      .first<{ chains: string }>();
    const chains = JSON.parse(row!.chains) as string[];
    expect(chains.length).toBeLessThanOrEqual(8);
    expect(chains).toContain('Base');
  });

  test('produces English AI summary from non-Latin post and updates cluster', async () => {
    const db = createSqliteD1();
    const ai: AiBindingLike = {
      async run() {
        return {
          response: JSON.stringify({
            summary: 'Complete KiteAI testnet faucet and daily AI agent quests on Base.',
            taskTypes: ['testnet', 'faucet', 'quest'],
            chains: ['Base'],
          }),
        };
      },
    };

    const res = await summarizeClusterWithAi(ai, db, {
      clusterId: 'c1',
      project: 'KiteAI',
      rawTexts: ['\u6d4b\u8bd5\u7f51\u9886\u6c34 Base \u4efb\u52a1'],
      isNewCluster: true,
      isNonLatinSource: true,
      riskLevel: 'ok',
      nowMs: 1_795_240_000_000,
    });

    expect(res).not.toBeNull();
    expect(HAN_RE.test(res!.summary)).toBe(false);

    const row = await db
      .prepare(`SELECT summary, summary_source, chains, task_types FROM clusters WHERE id = 'c1'`)
      .first<{ summary: string; summary_source: string; chains: string; task_types: string }>();
    expect(row?.summary_source).toBe('ai');
    expect(row?.summary).toContain('KiteAI testnet faucet');
    expect(JSON.parse(row!.chains)).toContain('Base');
  });

  test('falls back to rule summary when AI emits CJK or invalid JSON', async () => {
    const db = createSqliteD1();
    const badCjkAi: AiBindingLike = {
      async run() {
        return { response: JSON.stringify({ summary: '\u4e2d\u6587\u6458\u8981', taskTypes: [], chains: [] }) };
      },
    };
    const r1 = await summarizeClusterWithAi(badCjkAi, db, {
      clusterId: 'c1',
      project: 'KiteAI',
      rawTexts: ['post'],
      isNewCluster: true,
      isNonLatinSource: false,
      riskLevel: 'ok',
    });
    expect(r1).toBeNull();

    const badJsonAi: AiBindingLike = {
      async run() {
        return { response: 'not valid json at all' };
      },
    };
    const r2 = await summarizeClusterWithAi(badJsonAi, db, {
      clusterId: 'c1',
      project: 'KiteAI',
      rawTexts: ['post'],
      isNewCluster: true,
      isNonLatinSource: false,
      riskLevel: 'ok',
    });
    expect(r2).toBeNull();
  });

  test('enforces daily AI cap without invoking env.AI', async () => {
    const db = createSqliteD1();
    const now = 1_795_240_000_000;
    const day = new Date(now).toISOString().slice(0, 10);
    await db.prepare(`INSERT INTO ai_usage (day, calls) VALUES (?1, 300)`).bind(day).run();

    let called = false;
    const ai: AiBindingLike = {
      async run() {
        called = true;
        return { response: '{}' };
      },
    };

    const res = await summarizeClusterWithAi(ai, db, {
      clusterId: 'c1',
      project: 'KiteAI',
      rawTexts: ['post'],
      isNewCluster: true,
      isNonLatinSource: false,
      riskLevel: 'ok',
      dailyMax: 300,
      nowMs: now,
    });
    expect(res).toBeNull();
    expect(called).toBe(false);
  });

  test('dailyMax 0 reserves nothing and never calls AI, even on a fresh counter', async () => {
    const db = createSqliteD1();
    let called = false;
    const ai: AiBindingLike = {
      async run() {
        called = true;
        return { response: JSON.stringify({ summary: 'ok', taskTypes: [], chains: [] }) };
      },
    };

    const res = await summarizeClusterWithAi(ai, db, {
      clusterId: 'c1',
      project: 'KiteAI',
      rawTexts: ['post'],
      isNewCluster: true,
      isNonLatinSource: false,
      riskLevel: 'ok',
      dailyMax: 0,
    });
    expect(res).toBeNull();
    expect(called).toBe(false);

    const usage = await db.prepare(`SELECT calls FROM ai_usage`).all<{ calls: number }>();
    expect(usage.results?.length ?? 0).toBe(0);
  });

  test('concurrent summaries cannot exceed the daily cap', async () => {
    const db = createSqliteD1();
    const cap = 3;
    let calls = 0;
    const ai: AiBindingLike = {
      async run() {
        calls++;
        return { response: JSON.stringify({ summary: 'Concurrent reservation probe.', taskTypes: [], chains: [] }) };
      },
    };

    // Seed the counter at 0 (INTEGER column: SQLite stores '0' as integer 0,
    // so this does not exercise a text-typed D1 — the upsert's own arithmetic
    // and RETURNING are what's under test), then fire 8 concurrent callers at cap 3.
    const day = new Date().toISOString().slice(0, 10);
    await db.prepare(`INSERT INTO ai_usage (day, calls) VALUES (?1, ?2)`).bind(day, 0).run();

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        summarizeClusterWithAi(ai, db, {
          clusterId: 'c1',
          project: 'KiteAI',
          rawTexts: ['post'],
          isNewCluster: true,
          isNonLatinSource: false,
          riskLevel: 'ok',
          dailyMax: cap,
        }),
      ),
    );

    const succeeded = results.filter(r => r !== null).length;
    expect(succeeded).toBe(cap);
    expect(calls).toBe(cap);

    const row = await db.prepare(`SELECT calls FROM ai_usage WHERE day = ?1`).bind(day).first<{ calls: number }>();
    expect(Number(row?.calls)).toBe(cap);
  });

  function seedCluster(
    sqlite: ReturnType<typeof createTestD1>['sqlite'],
    id: string,
    summarySource: 'rule' | 'ai' = 'rule',
  ): void {
    sqlite
      .query(
        `INSERT INTO clusters (id, project, ticker, domain, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen)
         VALUES (?1, 'KiteAI', 'KITE', 'kite.ai', '[]', '["other"]', 'KiteAI: other', ?2, 'ok', '[]', 0.5, 1, 1000, 1000)`,
      )
      .run(id, summarySource);
  }

  function readAttemptState(
    sqlite: ReturnType<typeof createTestD1>['sqlite'],
    id: string,
  ): { summary_source: string; ai_attempts: number; ai_retry_after: number } {
    return sqlite
      .query('SELECT summary_source, ai_attempts, ai_retry_after FROM clusters WHERE id = ?1')
      .get(id) as { summary_source: string; ai_attempts: number; ai_retry_after: number };
  }

  test('AI failures apply 6h then 24h backoff with zero extra reads, and valid AI summary resets attempts', async () => {
    const { db, sqlite, queries } = createTestD1();
    seedCluster(sqlite, 'c1', 'rule');

    const t1 = 1_795_240_000_000;
    const t2 = t1 + 10_000;
    const t3 = t2 + 10_000;
    const t4 = t3 + 10_000;
    const sixHours = 6 * 3_600_000;
    const oneDay = 24 * 3_600_000;

    // 1st failure: ai.run throws -> ai_attempts = 1, +6h backoff, 2 queries total (reserve + update, 0 extra reads)
    const throwingAi: AiBindingLike = {
      async run() {
        throw new Error('AI timeout');
      },
    };
    const r1 = await summarizeClusterWithAi(throwingAi, db, {
      clusterId: 'c1',
      project: 'KiteAI',
      rawTexts: ['post'],
      isNewCluster: true,
      isNonLatinSource: false,
      riskLevel: 'ok',
      nowMs: t1,
    });
    expect(r1).toBeNull();
    expect(queries.length).toBe(2);
    expect(readAttemptState(sqlite, 'c1')).toEqual({
      summary_source: 'rule',
      ai_attempts: 1,
      ai_retry_after: t1 + sixHours,
    });

    // 2nd failure: empty response -> ai_attempts = 2, +24h backoff
    const emptyAi: AiBindingLike = {
      async run() {
        return { response: '' };
      },
    };
    const r2 = await summarizeClusterWithAi(emptyAi, db, {
      clusterId: 'c1',
      project: 'KiteAI',
      rawTexts: ['post'],
      isNewCluster: true,
      isNonLatinSource: false,
      riskLevel: 'ok',
      nowMs: t2,
    });
    expect(r2).toBeNull();
    expect(readAttemptState(sqlite, 'c1')).toEqual({
      summary_source: 'rule',
      ai_attempts: 2,
      ai_retry_after: t2 + oneDay,
    });

    // 3rd failure: CJK summary -> ai_attempts = 3, +24h backoff
    const cjkAi: AiBindingLike = {
      async run() {
        return { response: JSON.stringify({ summary: '\u4e2d\u6587\u6458\u8981', taskTypes: [], chains: [] }) };
      },
    };
    const r3 = await summarizeClusterWithAi(cjkAi, db, {
      clusterId: 'c1',
      project: 'KiteAI',
      rawTexts: ['post'],
      isNewCluster: true,
      isNonLatinSource: false,
      riskLevel: 'ok',
      nowMs: t3,
    });
    expect(r3).toBeNull();
    expect(readAttemptState(sqlite, 'c1')).toEqual({
      summary_source: 'rule',
      ai_attempts: 3,
      ai_retry_after: t3 + oneDay,
    });

    // Subsequent valid AI summary resets ai_attempts = 0 and ai_retry_after = 0
    const okAi: AiBindingLike = {
      async run() {
        return {
          response: JSON.stringify({
            summary: 'Complete KiteAI daily quests on Base.',
            taskTypes: ['quest'],
            chains: ['Base'],
          }),
        };
      },
    };
    const r4 = await summarizeClusterWithAi(okAi, db, {
      clusterId: 'c1',
      project: 'KiteAI',
      rawTexts: ['post'],
      isNewCluster: true,
      isNonLatinSource: false,
      riskLevel: 'ok',
      nowMs: t4,
    });
    expect(r4).not.toBeNull();
    expect(readAttemptState(sqlite, 'c1')).toEqual({
      summary_source: 'ai',
      ai_attempts: 0,
      ai_retry_after: 0,
    });
  });

  test('invalid JSON and null raw output each trigger 6h then 24h backoff on fresh rule clusters', async () => {
    const { db, sqlite } = createTestD1();
    seedCluster(sqlite, 'c_json', 'rule');
    seedCluster(sqlite, 'c_null', 'rule');

    const now = 1_795_240_000_000;
    const sixHours = 6 * 3_600_000;
    const oneDay = 24 * 3_600_000;

    const badJsonAi: AiBindingLike = {
      async run() {
        return { response: 'not json' };
      },
    };
    expect(
      await summarizeClusterWithAi(badJsonAi, db, {
        clusterId: 'c_json',
        project: 'KiteAI',
        rawTexts: ['post'],
        isNewCluster: true,
        isNonLatinSource: false,
        riskLevel: 'ok',
        nowMs: now,
      }),
    ).toBeNull();
    expect(readAttemptState(sqlite, 'c_json')).toEqual({
      summary_source: 'rule',
      ai_attempts: 1,
      ai_retry_after: now + sixHours,
    });

    expect(
      await summarizeClusterWithAi(badJsonAi, db, {
        clusterId: 'c_json',
        project: 'KiteAI',
        rawTexts: ['post'],
        isNewCluster: true,
        isNonLatinSource: false,
        riskLevel: 'ok',
        nowMs: now + 5_000,
      }),
    ).toBeNull();
    expect(readAttemptState(sqlite, 'c_json')).toEqual({
      summary_source: 'rule',
      ai_attempts: 2,
      ai_retry_after: now + 5_000 + oneDay,
    });

    const nullOutAi: AiBindingLike = {
      async run() {
        return null;
      },
    };
    expect(
      await summarizeClusterWithAi(nullOutAi, db, {
        clusterId: 'c_null',
        project: 'KiteAI',
        rawTexts: ['post'],
        isNewCluster: true,
        isNonLatinSource: false,
        riskLevel: 'ok',
        nowMs: now,
      }),
    ).toBeNull();
    expect(readAttemptState(sqlite, 'c_null')).toEqual({
      summary_source: 'rule',
      ai_attempts: 1,
      ai_retry_after: now + sixHours,
    });

    expect(
      await summarizeClusterWithAi(nullOutAi, db, {
        clusterId: 'c_null',
        project: 'KiteAI',
        rawTexts: ['post'],
        isNewCluster: true,
        isNonLatinSource: false,
        riskLevel: 'ok',
        nowMs: now + 5_000,
      }),
    ).toBeNull();
    expect(readAttemptState(sqlite, 'c_null')).toEqual({
      summary_source: 'rule',
      ai_attempts: 2,
      ai_retry_after: now + 5_000 + oneDay,
    });
  });

  test('backoff does not update clusters when quota is exhausted or cluster is already AI-summarized', async () => {
    const { db, sqlite } = createTestD1();
    seedCluster(sqlite, 'c_quota', 'rule');
    seedCluster(sqlite, 'c_ai', 'ai');

    const now = 1_795_240_000_000;
    const day = new Date(now).toISOString().slice(0, 10);
    sqlite.query('INSERT INTO ai_usage (day, calls) VALUES (?1, ?2)').run(day, 10);

    const throwingAi: AiBindingLike = {
      async run() {
        throw new Error('AI failure');
      },
    };

    expect(
      await summarizeClusterWithAi(throwingAi, db, {
        clusterId: 'c_quota',
        project: 'KiteAI',
        rawTexts: ['post'],
        isNewCluster: true,
        isNonLatinSource: false,
        riskLevel: 'ok',
        dailyMax: 10,
        nowMs: now,
      }),
    ).toBeNull();
    expect(readAttemptState(sqlite, 'c_quota')).toEqual({
      summary_source: 'rule',
      ai_attempts: 0,
      ai_retry_after: 0,
    });

    expect(
      await summarizeClusterWithAi(throwingAi, db, {
        clusterId: 'c_ai',
        project: 'KiteAI',
        rawTexts: ['post'],
        isNewCluster: true,
        isNonLatinSource: false,
        riskLevel: 'ok',
        dailyMax: 20,
        nowMs: now,
      }),
    ).toBeNull();
    expect(readAttemptState(sqlite, 'c_ai')).toEqual({
      summary_source: 'ai',
      ai_attempts: 0,
      ai_retry_after: 0,
    });
  });
});
