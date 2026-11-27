import { describe, expect, test } from 'bun:test';
import { createTestD1, MIGRATION_FILES } from './helpers';
import { HAN_RE } from '../src/normalize/i18n';
import {
  AI_COMPAT_TIMEOUT_MS,
  AI_MAX_ATTEMPTS,
  AI_MODEL,
  createOpenAiCompatBinding,
  hasAiQuotaRemaining,
  OPENAI_COMPAT_DEFAULT_MODEL,
  parseAndValidateAiJson,
  summarizeClusterWithAi,
  unsafeContentRe,
  type AiBindingLike,
} from '../src/normalize/summarize';

type FetchCall = { url: string; init: RequestInit };

/** Records every request and answers from a queue (last entry repeats). */
function stubFetch(...responses: Array<{ status?: number; body: unknown }>): { calls: FetchCall[]; fetch: typeof fetch } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url, init: init ?? {} });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    return new Response(JSON.stringify(next?.body ?? null), { status: next?.status ?? 200 });
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('provider-agnostic OpenAI-compatible LLM binding', () => {
  test('returns undefined without a complete credential pair, so callers fall back to rule summaries', () => {
    expect(createOpenAiCompatBinding({})).toBeUndefined();
    expect(createOpenAiCompatBinding({ baseUrl: 'https://llm.example/v1' })).toBeUndefined();
    expect(createOpenAiCompatBinding({ apiKey: 'k' })).toBeUndefined();
    expect(createOpenAiCompatBinding({ cfAccountId: 'acc' })).toBeUndefined();
    expect(createOpenAiCompatBinding({ cfApiToken: 'tok' })).toBeUndefined();
    expect(createOpenAiCompatBinding({ baseUrl: 'https://llm.example/v1', apiKey: 'k' })).toBeDefined();
    expect(createOpenAiCompatBinding({ cfAccountId: 'acc', cfApiToken: 'tok' })).toBeDefined();
  });

  test('calls /chat/completions with a Bearer token, JSON mode, and a 15s abort timeout', async () => {
    const content = '```json\n{"summary":"Complete the testnet quests."}\n```';
    const { calls, fetch } = stubFetch({ body: { choices: [{ message: { content } }] } });
    const binding = createOpenAiCompatBinding(
      { baseUrl: 'https://llm.example/v1/', apiKey: 'secret', model: 'gpt-4.1-mini' },
      { fetch },
    )!;

    const out = await binding.run(AI_MODEL, {
      messages: [
        { role: 'system', content: 'Reply with JSON.' },
        { role: 'user', content: 'Project: Nova' },
      ],
      max_tokens: 120,
    });

    // Raw provider payload comes back unchanged; the existing text extractor and fence-tolerant parser handle it.
    expect(out).toEqual({ choices: [{ message: { content } }] });
    expect(parseAndValidateAiJson(extractText(out))).toEqual({
      summary: 'Complete the testnet quests.',
      taskTypes: [],
      chains: [],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://llm.example/v1/chat/completions');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer secret');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      model: 'gpt-4.1-mini',
      max_tokens: 120,
      messages: [
        { role: 'system', content: 'Reply with JSON.' },
        { role: 'user', content: 'Project: Nova' },
      ],
      response_format: { type: 'json_object' },
    });
    const signal = calls[0]!.init.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(AI_COMPAT_TIMEOUT_MS).toBe(15_000);
  });

  test('defaults to gpt-4o-mini when the Workers AI model name is requested', async () => {
    const { calls, fetch } = stubFetch({ body: { choices: [{ message: { content: '{}' } }] } });
    await createOpenAiCompatBinding({ baseUrl: 'https://llm.example', apiKey: 'k' }, { fetch })!.run(AI_MODEL, {
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(JSON.parse(String(calls[0]!.init.body)).model).toBe(OPENAI_COMPAT_DEFAULT_MODEL);
    expect(OPENAI_COMPAT_DEFAULT_MODEL).toBe('gpt-4o-mini');
  });

  test('retries once without response_format when the provider rejects JSON mode', async () => {
    const { calls, fetch } = stubFetch(
      { status: 400, body: { error: { message: 'response_format is not supported' } } },
      { body: { choices: [{ message: { content: '{"summary":"ok"}' } }] } },
    );
    const binding = createOpenAiCompatBinding({ baseUrl: 'https://llm.example', apiKey: 'k' }, { fetch })!;
    await binding.run(AI_MODEL, { messages: [{ role: 'user', content: 'hi' }] });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[0]!.init.body)).response_format).toEqual({ type: 'json_object' });
    expect(JSON.parse(String(calls[1]!.init.body)).response_format).toBeUndefined();
  });

  test('rejects on a non-2xx response and aborts when the request exceeds the timeout', async () => {
    const failing = stubFetch({ status: 503, body: { error: 'overloaded' } });
    await expect(
      createOpenAiCompatBinding({ baseUrl: 'https://llm.example', apiKey: 'k' }, { fetch: failing.fetch })!.run(AI_MODEL, {
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow(/503/);

    const hanging = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })) as typeof fetch;
    await expect(
      createOpenAiCompatBinding({ baseUrl: 'https://llm.example', apiKey: 'k' }, { fetch: hanging, timeoutMs: 20 })!.run(
        AI_MODEL,
        { messages: [{ role: 'user', content: 'hi' }] },
      ),
    ).rejects.toThrow('aborted');
  });

  test('Cloudflare Workers AI REST fallback posts to the account endpoint and returns result', async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse(200, { success: true, errors: [], result: { response: '{"summary":"ok"}', usage: { prompt: 3 } } });
    }) as typeof fetch;
    const binding = createOpenAiCompatBinding({ cfAccountId: 'acc 1', cfApiToken: 'cf-token' }, { fetch: fetchImpl })!;

    const out = await binding.run(AI_MODEL, { messages: [{ role: 'user', content: 'hi' }], max_tokens: 200 });
    expect(out).toEqual({ response: '{"summary":"ok"}', usage: { prompt: 3 } });
    expect(calls[0]!.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent('acc 1')}/ai/run/${encodeURIComponent(AI_MODEL)}`);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer cf-token');
    expect(JSON.parse(String(calls[0]!.init.body)).messages[0].content).toBe('hi');
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);

    const failing = stubFetch({ status: 500, body: { success: false } });
    await expect(
      createOpenAiCompatBinding({ cfAccountId: 'acc', cfApiToken: 'tok' }, { fetch: failing.fetch })!.run(AI_MODEL, {
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow(/500/);
  });
});

describe('AI rich field validation and persistence', () => {
  test('parseAndValidateAiJson keeps safe rich fields, caps steps at 4, and omits the rest', () => {
    const res = parseAndValidateAiJson(
      JSON.stringify({
        summary: 'Complete the Nova testnet quests to earn points.',
        taskTypes: ['quest'],
        chains: ['Base'],
        steps: ['Connect your wallet', 'Complete 5 quests', 'Claim your points', 'Bridge assets', 'Invite friends'],
        rewardPool: '$500K',
        deadline: 'Ends Friday',
        cost: 'Free',
      }),
    );
    expect(res).toEqual({
      summary: 'Complete the Nova testnet quests to earn points.',
      taskTypes: ['quest'],
      chains: ['Base'],
      steps: ['Connect your wallet', 'Complete 5 quests', 'Claim your points', 'Bridge assets'],
      rewardPool: '$500K',
      deadline: 'Ends Friday',
      cost: 'Free',
    });

    // A payload without rich fields keeps the original shape.
    expect(parseAndValidateAiJson(JSON.stringify({ summary: 'Plain summary.', taskTypes: [], chains: [] }))).toEqual({
      summary: 'Plain summary.',
      taskTypes: [],
      chains: [],
    });
    expect(parseAndValidateAiJson(JSON.stringify({ summary: 'Plain summary.', steps: 'not an array', rewardPool: 42 }))).toEqual({
      summary: 'Plain summary.',
      taskTypes: [],
      chains: [],
    });
  });

  test('parseAndValidateAiJson drops unsafe or oversized rich fields: links, handles, wallets, secrets, scam text, CJK', () => {
    const res = parseAndValidateAiJson(
      JSON.stringify({
        summary: 'Complete the Nova testnet quests to earn points.',
        taskTypes: [],
        chains: [],
        steps: [
          'Visit https://evil.example/join',
          'Follow @scam_handle',
          'Send 0.01 ETH to 0xAbCdEf0123456789AbCdEf0123456789AbCdEf01',
          'Connect your wallet and enter your seed phrase',
          'x'.repeat(101),
          '中文步骤',
          'Send 100 USDT to receive 1000 back instantly',
        ],
        rewardPool: 'https://evil.example/pool',
        deadline: 'Confirm in your wallet to unlock the deadline',
        cost: 'a'.repeat(41),
      }),
    );
    expect(res).toEqual({ summary: 'Complete the Nova testnet quests to earn points.', taskTypes: [], chains: [] });

    // Length limits are inclusive: exactly on the limit passes (one over is dropped above).
    const pad = (text: string, len: number) => `${text}${'pool '.repeat(40)}`.slice(0, len);
    const rewardPool = pad('$500K ', 60);
    const deadline = pad('Ends Friday ', 40);
    const cost = pad('Free entry ', 40);
    const step = `${pad('Complete the quests ', 99)}x`;
    expect([rewardPool, deadline, cost, step].map(s => s.length)).toEqual([60, 40, 40, 100]);
    expect(
      parseAndValidateAiJson(
        JSON.stringify({
          summary: 'Complete the Nova testnet quests to earn points.',
          rewardPool,
          deadline,
          cost,
          steps: [step],
        }),
      ),
    ).toEqual({
      summary: 'Complete the Nova testnet quests to earn points.',
      taskTypes: [],
      chains: [],
      rewardPool,
      deadline,
      cost,
      steps: [step],
    });
    expect(
      parseAndValidateAiJson(
        JSON.stringify({ summary: 'Complete the Nova testnet quests.', rewardPool: `${pad('$500K ', 60)}x` }),
      ),
    ).toEqual({ summary: 'Complete the Nova testnet quests.', taskTypes: [], chains: [] });
  });

  test('persists validated AI rich fields into the cluster alongside the AI summary', async () => {
    const { db, sqlite, queries } = createTestD1();
    sqlite.exec(
      `INSERT INTO clusters (id, project, ticker, domain, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen)
       VALUES ('c1', 'KiteAI', 'KITE', 'kite.ai', '[]', '["other"]', 'KiteAI: other', 'rule', 'ok', '[]', 0.5, 1, 1000, 1000)`,
    );
    const ai: AiBindingLike = {
      async run() {
        return {
          response: JSON.stringify({
            summary: 'Complete KiteAI testnet quests on Base.',
            taskTypes: ['quest'],
            chains: ['Base'],
            rewardPool: '10M $KITE',
            deadline: 'Ends Friday',
            cost: 'Free',
            steps: ['Connect your wallet', 'Complete 5 quests'],
          }),
        };
      },
    };

    const res = await summarizeClusterWithAi(ai, db, {
      clusterId: 'c1',
      project: 'KiteAI',
      rawTexts: ['post'],
      isNewCluster: true,
      isNonLatinSource: false,
      riskLevel: 'ok',
    });

    expect(res).toEqual({
      summary: 'Complete KiteAI testnet quests on Base.',
      taskTypes: ['quest'],
      chains: ['Base'],
      rewardPool: '10M $KITE',
      deadline: 'Ends Friday',
      cost: 'Free',
      steps: ['Connect your wallet', 'Complete 5 quests'],
    });
    expect(
      sqlite.query('SELECT summary_source, reward_pool, deadline, cost, steps FROM clusters WHERE id = ?1').get('c1'),
    ).toEqual({
      summary_source: 'ai',
      reward_pool: '10M $KITE',
      deadline: 'Ends Friday',
      cost: 'Free',
      steps: '["Connect your wallet","Complete 5 quests"]',
    });
    // Persisting rich fields adds no read: the success path still issues zero SELECTs.
    expect(queries.some(q => /^\s*SELECT\b/i.test(q))).toBe(false);
  });

  test('AI rich fields only fill gaps: parser-derived values win and steps merge up to 4', async () => {
    const { db, sqlite } = createTestD1();
    sqlite.exec(
      `INSERT INTO clusters (id, project, ticker, domain, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen, reward_pool, deadline, cost, steps)
       VALUES ('c1', 'KiteAI', 'KITE', 'kite.ai', '[]', '["other"]', 'KiteAI: other', 'rule', 'ok', '[]', 0.5, 1, 1000, 1000, '$500K', 'May 30', 'Stake $100+', '["Connect your wallet"]')`,
    );
    const ai: AiBindingLike = {
      async run() {
        return {
          response: JSON.stringify({
            summary: 'Complete KiteAI testnet quests on Base.',
            rewardPool: '10M $KITE',
            deadline: 'Ends Friday',
            cost: 'Free',
            steps: ['Complete 5 quests'],
          }),
        };
      },
    };

    await summarizeClusterWithAi(ai, db, {
      clusterId: 'c1',
      project: 'KiteAI',
      rawTexts: ['post'],
      isNewCluster: true,
      isNonLatinSource: false,
      riskLevel: 'ok',
    });

    expect(sqlite.query('SELECT reward_pool, deadline, cost, steps, summary_source FROM clusters WHERE id = ?1').get('c1')).toEqual({
      reward_pool: '$500K',
      deadline: 'May 30',
      cost: 'Stake $100+',
      steps: '["Connect your wallet","Complete 5 quests"]',
      summary_source: 'ai',
    });
  });

  test('a pre-0009 schema still gets the AI summary when the rich columns are missing', async () => {
    const { db, sqlite } = createTestD1(MIGRATION_FILES.slice(0, 8));
    sqlite.exec(
      `INSERT INTO clusters (id, project, ticker, domain, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen)
       VALUES ('c1', 'KiteAI', 'KITE', 'kite.ai', '[]', '["other"]', 'KiteAI: other', 'rule', 'ok', '[]', 0.5, 1, 1000, 1000)`,
    );
    const ai: AiBindingLike = {
      async run() {
        return {
          response: JSON.stringify({
            summary: 'Complete KiteAI testnet quests on Base.',
            rewardPool: '10M $KITE',
            steps: ['Connect your wallet'],
          }),
        };
      },
    };
    const res = await summarizeClusterWithAi(ai, db, {
      clusterId: 'c1',
      project: 'KiteAI',
      rawTexts: ['post'],
      isNewCluster: true,
      isNonLatinSource: false,
      riskLevel: 'ok',
    });
    expect(res?.summary).toBe('Complete KiteAI testnet quests on Base.');
    expect(
      (sqlite.query('SELECT summary_source FROM clusters WHERE id = ?1').get('c1') as { summary_source: string }).summary_source,
    ).toBe('ai');
  });
});

function extractText(raw: unknown): string {
  const obj = raw as { choices?: { message?: { content?: unknown } }[] };
  const content = obj.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}

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
