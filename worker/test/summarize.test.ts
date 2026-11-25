import { describe, expect, test } from 'bun:test';
import { createTestD1 } from './helpers';
import { HAN_RE } from '../src/normalize/i18n';
import {
  AI_MAX_ATTEMPTS,
  hasAiQuotaRemaining,
  parseAndValidateAiJson,
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
    // M-15: raw IPv4, dangerous schemes, and @handles are blocked.
    expect(unsafeContentRe('Connect node at 45.33.12.9')).toBe(true);
    expect(unsafeContentRe('Claim at 45.33.12.9:8080/claim')).toBe(true);
    expect(unsafeContentRe('Join tg://resolve?domain=scam')).toBe(true);
    expect(unsafeContentRe('Click javascript:alert(1)')).toBe(true);
    expect(unsafeContentRe('Open data:text/html;base64,PHNjcmlwdD4=')).toBe(true);
    expect(unsafeContentRe('Follow @scam_channel for claim')).toBe(true);
    expect(unsafeContentRe('@airdrop_bot sends rewards')).toBe(true);
    // Common dev suffixes must not false-positive as domains.
    expect(
      unsafeContentRe('Deploy Vault.sol with ethers.js, index.ts, bot.py, lib.rs, config.json, and README.md'),
    ).toBe(false);
    // Explicit scheme:// URLs must be rejected independently of dev file-suffix exceptions.
    expect(unsafeContentRe('Read updates at ftp://claim.md/rewards.')).toBe(true);
    expect(unsafeContentRe('Connect via ws://ethers.js/rpc')).toBe(true);
    expect(unsafeContentRe('Download http://Vault.sol/bin')).toBe(true);
    expect(unsafeContentRe('Fetch ipfs://README.md')).toBe(true);
  });

  test('M-15: parseAndValidateAiJson rejects drainer/scam/wallet-confirm phrases and strictly filters chains', () => {
    const blockedSummaries = [
      'Confirm in your wallet to claim bonus tokens.',
      'Please confirm in your wallets to unlock allocation.',
      'Verify your wallet before snapshot ends.',
      'Approve your wallet to receive airdrop rewards.',
      'Enter your recovery phrase to restore points.',
      'Import your mnemonic to claim allocation.',
      'Send 100 USDT to receive 1000 back instantly.',
      'Claim SOL now and connect active wallet for drop.',
    ];
    for (const summary of blockedSummaries) {
      expect(
        parseAndValidateAiJson(JSON.stringify({ summary, taskTypes: ['quest'], chains: ['Base'] })),
      ).toBeNull();
    }

    const res = parseAndValidateAiJson(
      JSON.stringify({
        summary: 'Deploy Vault.sol with ethers.js and complete testnet quests.',
        taskTypes: ['testnet', 'quest'],
        chains: [
          'Base',
          'Arbitrum One',
          'zkSync Era',
          'TON',
          'IGNORED_PROMPT',
          'IGNORE ALL PREVIOUS',
          '@scam_handle',
          '45.33.12.9',
          'https://evil.xyz',
          'connect wallet',
        ],
      }),
    );
    expect(res).not.toBeNull();
    expect(res!.chains).toEqual(['Base', 'Arbitrum One', 'zkSync Era', 'TON']);
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
    // Reset to rule summary to exercise a subsequent SQL-side chain merge on the same cluster.
    await db.prepare(`UPDATE clusters SET summary_source = 'rule' WHERE id = 'c1'`).run();
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

  test('concurrent summaries across distinct clusters cannot exceed the daily cap', async () => {
    const { db, sqlite } = createTestD1();
    const cap = 3;
    for (let i = 0; i < 8; i++) {
      seedCluster(sqlite, `c_cap_${i}`, 'rule');
    }
    let calls = 0;
    const ai: AiBindingLike = {
      async run() {
        calls++;
        return { response: JSON.stringify({ summary: 'Concurrent reservation probe.', taskTypes: [], chains: [] }) };
      },
    };

    // Seed the counter at 0, then fire 8 concurrent callers across 8 clusters at cap 3.
    const day = new Date().toISOString().slice(0, 10);
    await db.prepare(`INSERT INTO ai_usage (day, calls) VALUES (?1, ?2)`).bind(day, 0).run();

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        summarizeClusterWithAi(ai, db, {
          clusterId: `c_cap_${i}`,
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

  test('atomic 2-minute row lease prevents concurrent double-runs on the same cluster and success issues zero SELECTs', async () => {
    const { db, sqlite, queries } = createTestD1();
    seedCluster(sqlite, 'c_lease', 'rule');
    const now = 1_795_240_000_000;

    let aiCalls = 0;
    const slowAi: AiBindingLike = {
      async run() {
        aiCalls++;
        await new Promise(resolve => setTimeout(resolve, 10));
        return {
          response: JSON.stringify({
            summary: 'Complete KiteAI testnet quests on Base.',
            taskTypes: ['testnet', 'quest'],
            chains: ['Base'],
          }),
        };
      },
    };

    const before = queries.length;
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        summarizeClusterWithAi(slowAi, db, {
          clusterId: 'c_lease',
          project: 'KiteAI',
          rawTexts: ['post'],
          isNewCluster: true,
          isNonLatinSource: false,
          riskLevel: 'ok',
          nowMs: now,
        }),
      ),
    );

    expect(aiCalls).toBe(1);
    expect(results.filter(r => r !== null).length).toBe(1);
    const issued = queries.slice(before);
    expect(issued.some(q => /^\s*SELECT\b/i.test(q))).toBe(false);

    const row = sqlite
      .query('SELECT summary_source, task_types, chains, ai_attempts, ai_retry_after FROM clusters WHERE id = ?1')
      .get('c_lease') as { summary_source: string; task_types: string; chains: string; ai_attempts: number; ai_retry_after: number };
    expect(row.summary_source).toBe('ai');
    expect(JSON.parse(row.task_types).sort()).toEqual(['quest', 'testnet']);
    expect(JSON.parse(row.chains)).toEqual(['Base']);
    expect(row.ai_attempts).toBe(0);
    expect(row.ai_retry_after).toBe(0);
  });

  test('throwing ai.run logs error, refunds ai_usage quota, and records backoff', async () => {
    const { db, sqlite } = createTestD1();
    seedCluster(sqlite, 'c_err', 'rule');
    const now = 1_795_240_000_000;
    const day = new Date(now).toISOString().slice(0, 10);

    const throwingAi: AiBindingLike = {
      async run() {
        throw new Error('Workers AI 503');
      },
    };

    const origErr = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      const res = await summarizeClusterWithAi(throwingAi, db, {
        clusterId: 'c_err',
        project: 'KiteAI',
        rawTexts: ['post'],
        isNewCluster: true,
        isNonLatinSource: false,
        riskLevel: 'ok',
        nowMs: now,
      });
      expect(res).toBeNull();
    } finally {
      console.error = origErr;
    }

    expect(logged.some(args => args[0] === 'ai-summary-error' && args[1] === 'c_err')).toBe(true);
    const usage = sqlite.query('SELECT calls FROM ai_usage WHERE day = ?1').get(day) as { calls: number } | null;
    expect(usage?.calls).toBe(0);
    expect(readAttemptState(sqlite, 'c_err')).toEqual({
      summary_source: 'rule',
      ai_attempts: 1,
      ai_retry_after: now + 6 * 3_600_000,
    });
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
    seedCluster(sqlite, 'c_recover', 'rule');

    const t1 = 1_795_240_000_000;
    const sixHours = 6 * 3_600_000;
    const oneDay = 24 * 3_600_000;
    const t2 = t1 + sixHours;
    const t3 = t2 + oneDay;
    const t4 = t3 + oneDay;

    // 1st failure: ai.run throws -> ai_attempts = 1, +6h backoff, zero SELECT reads
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
    expect(queries.some(q => /^\s*SELECT\b/i.test(q))).toBe(false);
    expect(readAttemptState(sqlite, 'c1')).toEqual({
      summary_source: 'rule',
      ai_attempts: 1,
      ai_retry_after: t1 + sixHours,
    });

    // 2nd failure at t1 + 6h: empty response -> ai_attempts = 2, +24h backoff
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

    // 3rd failure at t2 + 24h: CJK summary -> ai_attempts = 3, +24h backoff
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

    // After reaching AI_MAX_ATTEMPTS (3), further attempts on c1 are refused by the lease guard.
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
    expect(
      await summarizeClusterWithAi(okAi, db, {
        clusterId: 'c1',
        project: 'KiteAI',
        rawTexts: ['post'],
        isNewCluster: true,
        isNonLatinSource: false,
        riskLevel: 'ok',
        nowMs: t4,
      }),
    ).toBeNull();

    // Valid AI summary on a cluster with prior failed attempts (< AI_MAX_ATTEMPTS) resets ai_attempts = 0 and ai_retry_after = 0.
    await summarizeClusterWithAi(emptyAi, db, {
      clusterId: 'c_recover',
      project: 'KiteAI',
      rawTexts: ['post'],
      isNewCluster: true,
      isNonLatinSource: false,
      riskLevel: 'ok',
      nowMs: t1,
    });
    const r4 = await summarizeClusterWithAi(okAi, db, {
      clusterId: 'c_recover',
      project: 'KiteAI',
      rawTexts: ['post'],
      isNewCluster: true,
      isNonLatinSource: false,
      riskLevel: 'ok',
      nowMs: t2,
    });
    expect(r4).not.toBeNull();
    expect(readAttemptState(sqlite, 'c_recover')).toEqual({
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
        nowMs: now + sixHours,
      }),
    ).toBeNull();
    expect(readAttemptState(sqlite, 'c_json')).toEqual({
      summary_source: 'rule',
      ai_attempts: 2,
      ai_retry_after: now + sixHours + oneDay,
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
        nowMs: now + sixHours,
      }),
    ).toBeNull();
    expect(readAttemptState(sqlite, 'c_null')).toEqual({
      summary_source: 'rule',
      ai_attempts: 2,
      ai_retry_after: now + sixHours + oneDay,
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

  test('non-string choices[0].message.content returns null and triggers backoff instead of throwing', async () => {
    const { db, sqlite } = createTestD1();
    seedCluster(sqlite, 'c_obj', 'rule');

    const now = 1_795_240_000_000;
    const sixHours = 6 * 3_600_000;
    const oneDay = 24 * 3_600_000;

    const objectContentAi: AiBindingLike = {
      async run() {
        return { choices: [{ message: { content: { summary: 'object payload' } } }] };
      },
    };
    const r1 = await summarizeClusterWithAi(objectContentAi, db, {
      clusterId: 'c_obj',
      project: 'KiteAI',
      rawTexts: ['post'],
      isNewCluster: true,
      isNonLatinSource: false,
      riskLevel: 'ok',
      nowMs: now,
    });
    expect(r1).toBeNull();
    expect(readAttemptState(sqlite, 'c_obj')).toEqual({
      summary_source: 'rule',
      ai_attempts: 1,
      ai_retry_after: now + sixHours,
    });

    const numericContentAi: AiBindingLike = {
      async run() {
        return { choices: [{ message: { content: 12345 } }] };
      },
    };
    const r2 = await summarizeClusterWithAi(numericContentAi, db, {
      clusterId: 'c_obj',
      project: 'KiteAI',
      rawTexts: ['post'],
      isNewCluster: true,
      isNonLatinSource: false,
      riskLevel: 'ok',
      nowMs: now + sixHours,
    });
    expect(r2).toBeNull();
    expect(readAttemptState(sqlite, 'c_obj')).toEqual({
      summary_source: 'rule',
      ai_attempts: 2,
      ai_retry_after: now + sixHours + oneDay,
    });

    const validChoicesAi: AiBindingLike = {
      async run() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: 'Complete KiteAI quests via choices string response.',
                  taskTypes: ['quest'],
                  chains: ['Base'],
                }),
              },
            },
          ],
        };
      },
    };
    const r3 = await summarizeClusterWithAi(validChoicesAi, db, {
      clusterId: 'c_obj',
      project: 'KiteAI',
      rawTexts: ['post'],
      isNewCluster: true,
      isNonLatinSource: false,
      riskLevel: 'ok',
      nowMs: now + sixHours + oneDay,
    });
    expect(r3).not.toBeNull();
    expect(readAttemptState(sqlite, 'c_obj')).toEqual({
      summary_source: 'ai',
      ai_attempts: 0,
      ai_retry_after: 0,
    });
  });

  test('calculates lease expiry from acquisition clock rather than stale caller nowMs and guards final summary write on lease match', async () => {
    const { db, sqlite } = createTestD1();
    seedCluster(sqlite, 'c_stale_clock', 'rule');
    seedCluster(sqlite, 'c_reclaimed', 'rule');

    const tStart = 1_795_240_000_000;
    const tAcquire = tStart + 120_000; // polling took 2 minutes before lease acquisition

    // 1. Lease expiry uses acquisition clock (tAcquire + 120_000), NOT stale tStart + 120_000,
    //    so an overlapping caller at tAcquire is blocked while AI is still running.
    let observedLeaseWhileInFlight = 0;
    let secondCallerBlocked = false;
    const probeAi: AiBindingLike = {
      async run() {
        const row = sqlite
          .query('SELECT ai_retry_after FROM clusters WHERE id = ?1')
          .get('c_stale_clock') as { ai_retry_after: number };
        observedLeaseWhileInFlight = row.ai_retry_after;
        const concurrent = await summarizeClusterWithAi(
          {
            async run() {
              throw new Error('overlapping caller should not run AI');
            },
          },
          db,
          {
            clusterId: 'c_stale_clock',
            project: 'KiteAI',
            rawTexts: ['post'],
            isNewCluster: true,
            isNonLatinSource: false,
            riskLevel: 'ok',
            nowMs: tAcquire,
            clock: () => tAcquire,
          },
        );
        secondCallerBlocked = concurrent === null;
        return {
          response: JSON.stringify({
            summary: 'Complete KiteAI testnet quests on Base.',
            taskTypes: ['quest'],
            chains: ['Base'],
          }),
        };
      },
    };

    const res = await summarizeClusterWithAi(probeAi, db, {
      clusterId: 'c_stale_clock',
      project: 'KiteAI',
      rawTexts: ['post'],
      isNewCluster: true,
      isNonLatinSource: false,
      riskLevel: 'ok',
      nowMs: tStart,
      clock: () => tAcquire,
    });
    expect(res).not.toBeNull();
    expect(observedLeaseWhileInFlight).toBe(tAcquire + 120_000);
    expect(secondCallerBlocked).toBe(true);

    // 2. If another caller reclaims the cluster and writes a newer summary while the first
    //    AI call is still in flight, the stale first call's final UPDATE must match 0 rows,
    //    leave the newer summary intact, and return null.
    const staleWinnerAi: AiBindingLike = {
      async run() {
        // Simulate lease expiration + reclaim + completion by a newer caller while this call runs.
        sqlite
          .query(
            `UPDATE clusters
             SET summary = 'Newer reclaimed summary.', summary_source = 'ai', ai_attempts = 0, ai_retry_after = 0
             WHERE id = 'c_reclaimed'`,
          )
          .run();
        return {
          response: JSON.stringify({
            summary: 'Stale summary from expired lease.',
            taskTypes: ['testnet'],
            chains: ['Arbitrum'],
          }),
        };
      },
    };

    const staleRes = await summarizeClusterWithAi(staleWinnerAi, db, {
      clusterId: 'c_reclaimed',
      project: 'KiteAI',
      rawTexts: ['post'],
      isNewCluster: true,
      isNonLatinSource: false,
      riskLevel: 'ok',
      nowMs: tStart,
      clock: () => tStart,
    });
    expect(staleRes).toBeNull();
    const afterReclaim = sqlite
      .query('SELECT summary, summary_source, chains FROM clusters WHERE id = ?1')
      .get('c_reclaimed') as { summary: string; summary_source: string; chains: string };
    expect(afterReclaim).toEqual({
      summary: 'Newer reclaimed summary.',
      summary_source: 'ai',
      chains: '[]',
    });
  });
});
