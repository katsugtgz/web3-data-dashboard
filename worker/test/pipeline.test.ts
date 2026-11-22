import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { computeClusterId, ingestPostIntoCluster, queryFeed } from '../src/normalize/cluster';
import { HAN_RE, stripOrTranslateCjk } from '../src/normalize/i18n';
import { cleanUrl, extractUrls, getRegistrableDomain, parseDropPost } from '../src/normalize/parse';
import { computeScore, decayClusterScores } from '../src/normalize/score';
import { evaluateSafety, findLookalikeDomain, isPunycodeOrMixedScript, levenshtein } from '../src/safety';

/** Minimal synchronous D1Database shim backed by bun:sqlite for fast worker DB unit tests. */
function createSqliteD1(): D1Database {
  const sqlite = new Database(':memory:');
  const m1 = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8');
  const m2 = readFileSync(new URL('../migrations/0002_feed.sql', import.meta.url), 'utf8');
  const m3 = readFileSync(new URL('../migrations/0003_p4.sql', import.meta.url), 'utf8');
  const m4 = readFileSync(new URL('../migrations/0004_tags.sql', import.meta.url), 'utf8');
  sqlite.exec(m1);
  sqlite.exec(m2);
  sqlite.exec(m3);
  sqlite.exec(m4);

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

describe('parser, clustering, safety, and scoring pipeline', () => {
  test('extracts multi-part domains, ignores platform links, strips tracking params', () => {
    const urls = extractUrls(
      'Join https://app.example.co.uk/airdrop?utm_source=x&keep=1 and https://galxe.com/campaign/1',
    );
    expect(urls).toEqual(['https://app.example.co.uk/airdrop?keep=1', 'https://galxe.com/campaign/1']);
    expect(getRegistrableDomain(urls[0])).toBe('example.co.uk');

    const parsed = parseDropPost('Join Galxe quest https://galxe.com/foo and site https://myproto.xyz/quest on Base');
    expect(parsed.projectDomain).toBe('myproto.xyz');
    expect(parsed.chains).toContain('Base');
    expect(parsed.taskTypes).toContain('quest');
  });

  test('cleanUrl strips glued text after long id segments and trailing percent-encoded emoji', () => {
    // Glued prose after a snowflake-style id segment (data/snapshot violation).
    expect(cleanUrl('https://x.com/foo/status/2094749026323189786Update')).toBe(
      'https://x.com/foo/status/2094749026323189786',
    );
    // Trailing percent-encoded non-ASCII decoration (emoji).
    expect(cleanUrl('https://x.com/foo/status/103153%F0%9F%8F%82')).toBe('https://x.com/foo/status/103153');
    // Controls: short ids, alphanumeric slugs, encoded ASCII, and version
    // paths stay intact.
    expect(cleanUrl('https://x.com/foo/status/123')).toBe('https://x.com/foo/status/123');
    expect(cleanUrl('https://x.com/foo/page-2')).toBe('https://x.com/foo/page-2');
    expect(cleanUrl('https://example.com/v2/12345abc')).toBe('https://example.com/v2/12345abc');
    expect(cleanUrl('https://x.com/foo/status/2094749026323189786?utm_source=x')).toBe(
      'https://x.com/foo/status/2094749026323189786',
    );
  });

  test('safety catches punycode, lookalikes, drainer phrasing, shorteners, and low-trust singletons', () => {
    const known = new Map([['arbitrum.io', 'Arbitrum'], ['uniswap.org', 'Uniswap']]);
    const platforms = new Set(['zealy.io', 'galxe.com']);

    expect(isPunycodeOrMixedScript('xn--arbitrm-91a.io')).toBe(true);
    expect(levenshtein('arbitrurn.io', 'arbitrum.io')).toBe(2);
    expect(findLookalikeDomain('arbitrurn.io', known)).toBe('arbitrum.io');

    // Quest-platform clones are lookalike targets even though platforms are
    // never trusted as project identity.
    expect(evaluateSafety({
      domain: 'zea1y.io',
      urls: [],
      text: 'quest',
      knownProjectDomains: known,
      platformDomains: platforms,
      trustMax: 0.9,
      sourceCount: 3,
    }).level).toBe('risk');

    const riskRes = evaluateSafety({
      domain: 'arbitrurn.io',
      urls: ['https://arbitrurn.io/claim'],
      text: 'Arbitrum airdrop is live! Claim now and connect your wallet to claim rewards.',
      knownProjectDomains: known,
      trustMax: 0.7,
      sourceCount: 1,
    });
    expect(riskRes.level).toBe('risk');
    expect(riskRes.reasons.some(r => r.includes('lookalike'))).toBe(true);
    expect(riskRes.reasons.some(r => r.includes('wallet-connect'))).toBe(true);

    const warnRes = evaluateSafety({
      domain: 'brandnewprotocol.xyz',
      urls: ['https://bit.ly/3xyz', 'https://brandnewprotocol.xyz'],
      text: 'Testnet live on Monad',
      knownProjectDomains: known,
      trustMax: 0.3,
      sourceCount: 1,
    });
    expect(warnRes.level).toBe('warn');
    expect(warnRes.reasons.length).toBeGreaterThanOrEqual(3);
  });

  test('dedupes cross-channel posts and never inflates source_count on same-channel reposts', async () => {
    const db = createSqliteD1();
    const now = 1_795_200_000_000;
    await db
      .prepare(`INSERT INTO sources (id, platform, handle, lang, trust, enabled) VALUES ('telegram:ch1', 'telegram', 'ch1', 'en', 0.7, 1), ('telegram:ch2', 'telegram', 'ch2', 'en', 0.8, 1)`)
      .run();

    const known = new Map([['novaprotocol.xyz', 'Nova Protocol']]);
    const surfIndex = { byDomain: new Map(), byTicker: new Map() };

    const r1 = await ingestPostIntoCluster(
      db,
      {
        postId: 'telegram:ch1:10',
        sourceId: 'telegram:ch1',
        sourceTrust: 0.7,
        postUrl: 'https://t.me/ch1/10',
        postedAt: now - 3600_000,
        text: 'Nova Protocol $NOVA testnet & faucet live on Monad https://novaprotocol.xyz',
      },
      { knownDomains: known },
      surfIndex,
      known,
      new Set<string>(),
      now,
    );

    // Same channel reposting same project -> sourceCount stays 1
    await ingestPostIntoCluster(
      db,
      {
        postId: 'telegram:ch1:11',
        sourceId: 'telegram:ch1',
        sourceTrust: 0.7,
        postUrl: 'https://t.me/ch1/11',
        postedAt: now - 1800_000,
        text: 'Reminder: Nova Protocol bridge is also live https://novaprotocol.xyz',
      },
      { knownDomains: known },
      surfIndex,
      known,
      new Set<string>(),
      now,
    );

    // Second distinct channel posting same project -> sourceCount becomes 2
    const r2 = await ingestPostIntoCluster(
      db,
      {
        postId: 'telegram:ch2:55',
        sourceId: 'telegram:ch2',
        sourceTrust: 0.8,
        postUrl: 'https://t.me/ch2/55',
        postedAt: now - 600_000,
        text: '测试网空投任务：Nova Protocol $NOVA on Monad https://novaprotocol.xyz',
      },
      { knownDomains: known },
      surfIndex,
      known,
      new Set<string>(),
      now,
    );

    expect(r1.clusterId).toBe(r2.clusterId);
    expect(r1.clusterId).toBe(await computeClusterId('novaprotocol.xyz'));

    const feed = await queryFeed(db, new Set(['novaprotocol.xyz']), { risk: 'include' });
    expect(feed.items.length).toBe(1);
    const item = feed.items[0];
    expect(item.sourceCount).toBe(2);
    expect(item.taskTypes).toContain('testnet');
    expect(item.taskTypes).toContain('bridge');
    expect(item.risk.level).toBe('ok');
    expect(HAN_RE.test(JSON.stringify(feed))).toBe(false);
  });

  test('chain keywords require qualifiers; registrable domains split by public suffix', () => {
    // Ambiguous English words never tag a chain without a qualifier.
    expect(parseDropPost('Scroll down to claim your rewards').chains).not.toContain('Scroll');
    expect(parseDropPost('Check our knowledge base for the guide').chains).not.toContain('Base');
    expect(parseDropPost('An abstract concept and a base ball').chains).not.toContain('Abstract');
    expect(parseDropPost('A blast from the past, movement of funds on the ARB token').chains).toEqual([]);
    // Qualifier forms do tag.
    expect(parseDropPost('Live on Base chain').chains).toContain('Base');
    expect(parseDropPost('Airdrop on Base mainnet').chains).toContain('Base');
    expect(parseDropPost('Trade $ARB on Arbitrum').chains).toContain('Arbitrum');
    expect(parseDropPost('Scroll chain quests').chains).toContain('Scroll');
    expect(parseDropPost('Blast chain is live').chains).toContain('Blast');
    expect(parseDropPost('Abstract chain mint').chains).toContain('Abstract');
    expect(parseDropPost('Movement chain testnet').chains).toContain('Movement');
    // Unambiguous names stay bare.
    expect(parseDropPost('Solana rewards are live').chains).toContain('Solana');
    expect(parseDropPost('Deposit on Arbitrum').chains).toContain('Arbitrum');

    // Same last-two labels are distinct registrable domains under a known
    // multipart public suffix; unlisted suffixes keep last-two fallback.
    expect(getRegistrableDomain('https://foo.co.za/x')).toBe('foo.co.za');
    expect(getRegistrableDomain('https://bar.co.za/x')).toBe('bar.co.za');
    expect(getRegistrableDomain('https://deep.sub.example.co.uk/')).toBe('example.co.uk');
    expect(getRegistrableDomain('https://a.b.example.mz/')).toBe('example.mz');
  });

  test('a $TICKER pointing at a different surf card never renames a domain-identified post', () => {
    // Adjacent Latin tokens around a CJK run stay separate after strip.
    expect(stripOrTranslateCjk('Galxe任务Zealy')).toBe('Galxe Zealy');

    const surfByDomain = new Map([['novaprotocol.xyz', { name: 'Nova Protocol', tier: 'B' as const }]]);
    const surfByTicker = new Map([['SCAM', { name: 'ScamCoin', tier: 'C' as const }]]);

    const parsed = parseDropPost(
      'Big news $SCAM https://novaprotocol.xyz/quest',
      [],
      { surfByDomain, surfByTicker },
    );
    expect(parsed.projectDomain).toBe('novaprotocol.xyz');
    expect(parsed.project).toBe('Nova Protocol');

    // Without a domain the ticker fallback still resolves the surf name.
    const tickerOnly = parseDropPost('Big news $SCAM everywhere', [], { surfByDomain, surfByTicker });
    expect(tickerOnly.projectDomain).toBeUndefined();
    expect(tickerOnly.project).toBe('ScamCoin');
  });

  test('a stale-view UPDATE cannot downgrade risk escalated by a concurrent ingest', async () => {
    const db = createSqliteD1();
    const now = 1_795_200_000_000;
    await db
      .prepare(`INSERT INTO sources (id, platform, handle, lang, trust, enabled) VALUES ('telegram:ch1', 'telegram', 'ch1', 'en', 0.7, 1)`)
      .run();

    const known = new Map([['novaprotocol.xyz', 'Nova Protocol']]);
    const surfIndex = { byDomain: new Map(), byTicker: new Map() };
    const base = {
      sourceId: 'telegram:ch1',
      sourceTrust: 0.7,
      htmlUrls: [] as string[],
      forwardedFrom: null,
    };

    // 1. Seed the cluster with a safe post (ok, no reasons).
    const seeded = await ingestPostIntoCluster(db, {
      ...base,
      postId: 'telegram:ch1:10',
      postUrl: 'https://t.me/ch1/10',
      postedAt: now - 7200_000,
      text: 'Nova Protocol testnet live https://novaprotocol.xyz',
    }, { knownDomains: known }, surfIndex, known, new Set<string>(), now);
    const cid = seeded.clusterId;

    // 2. Simulate the race at the DB seam: the racing writer's cluster SELECT
    //    ran against the safe row, but the concurrent escalation commits
    //    BEFORE its UPDATE lands (intercepted at statement-run time). The
    //    stale in-memory view then says 'ok' while the stored row is 'risk';
    //    the UPDATE must union reasons and keep 'risk' anyway.
    let escalated = false;
    const racingDb = {
      ...db,
      prepare(sql: string) {
        const stmt = db.prepare(sql);
        if (/^\s*UPDATE\s+clusters/i.test(sql)) {
          return {
            bind(...args: unknown[]) {
              return { run: () => runBound(args) };
            },
            async run() {
              return runBound([]);
            },
          };
          async function runBound(args: unknown[]) {
            if (!escalated) {
              escalated = true;
              await db
                .prepare(`UPDATE clusters SET risk_level = 'risk', risk_reasons = ?2 WHERE id = ?1`)
                .bind(cid, JSON.stringify(['Possible lookalike domain (novaprotocol2.xyz vs novaprotocol.xyz)']))
                .run();
            }
            return stmt.bind(...args).run();
          }
        }
        return stmt;
      },
    } as unknown as D1Database;
    const r3 = await ingestPostIntoCluster(racingDb, {
      ...base,
      postId: 'telegram:ch1:11',
      postUrl: 'https://t.me/ch1/11',
      postedAt: now - 3600_000,
      text: 'Nova Protocol bridge is live on Monad https://novaprotocol.xyz',
    }, { knownDomains: known }, surfIndex, known, new Set<string>(), now);

    const row = await db
      .prepare('SELECT risk_level, risk_reasons, first_seen, last_seen, summary_source FROM clusters WHERE id = ?1')
      .bind(cid)
      .first<{ risk_level: string; risk_reasons: string; first_seen: number; last_seen: number; summary_source: string }>();
    expect(row?.risk_level).toBe('risk');
    const reasons = JSON.parse(row?.risk_reasons ?? '[]') as string[];
    expect(reasons.some(x => x.includes('lookalike'))).toBe(true); // concurrent escalation kept
    expect(row?.first_seen).toBe(now - 7200_000);
    expect(row?.last_seen).toBe(now - 3600_000);
    expect(row?.summary_source).toBe('rule');
    // The racing writer's RETURN value still reflects its stale in-memory
    // view ('ok') — the guarantee is that the STORED row keeps 'risk'.
    expect(r3.riskLevel).toBe('ok');
  });

  test('a rule UPDATE never overwrites an AI summary', async () => {
    const db = createSqliteD1();
    const now = 1_795_200_000_000;
    await db
      .prepare(`INSERT INTO sources (id, platform, handle, lang, trust, enabled) VALUES ('telegram:ch1', 'telegram', 'ch1', 'en', 0.7, 1)`)
      .run();

    const known = new Map([['novaprotocol.xyz', 'Nova Protocol']]);
    const surfIndex = { byDomain: new Map(), byTicker: new Map() };

    const seeded = await ingestPostIntoCluster(db, {
      sourceId: 'telegram:ch1',
      sourceTrust: 0.7,
      htmlUrls: [],
      forwardedFrom: null,
      postId: 'telegram:ch1:20',
      postUrl: 'https://t.me/ch1/20',
      postedAt: now - 3600_000,
      text: 'Nova Protocol testnet live https://novaprotocol.xyz',
    }, { knownDomains: known }, surfIndex, known, new Set<string>(), now);

    // AI summary lands between the read and the next rule write.
    await db
      .prepare(`UPDATE clusters SET summary = 'AI-crafted summary.', summary_source = 'ai' WHERE id = ?1`)
      .bind(seeded.clusterId)
      .run();

    await ingestPostIntoCluster(db, {
      sourceId: 'telegram:ch1',
      sourceTrust: 0.7,
      htmlUrls: [],
      forwardedFrom: null,
      postId: 'telegram:ch1:21',
      postUrl: 'https://t.me/ch1/21',
      postedAt: now - 1800_000,
      text: 'Nova Protocol faucet live https://novaprotocol.xyz',
    }, { knownDomains: known }, surfIndex, known, new Set<string>(), now);

    const row = await db
      .prepare('SELECT summary, summary_source FROM clusters WHERE id = ?1')
      .bind(seeded.clusterId)
      .first<{ summary: string; summary_source: string }>();
    expect(row?.summary).toBe('AI-crafted summary.');
    expect(row?.summary_source).toBe('ai');
  });


  test('warn downgrades to ok when merged sources clear the only reason', async () => {
    const db = createSqliteD1();
    const now = 1_795_200_000_000;
    await db
      .prepare(`INSERT INTO sources (id, platform, handle, lang, trust, enabled) VALUES ('telegram:lo', 'telegram', 'lo', 'en', 0.3, 1), ('telegram:hi', 'telegram', 'hi', 'en', 0.9, 1)`)
      .run();

    const surfIndex = { byDomain: new Map(), byTicker: new Map() };
    // Registered domain: the only warn reason is single-low-trust.
    const known = new Map([['brandnew.example', 'BrandNew Protocol']]);

    // First post: single low-trust source -> warn with that one reason.
    const r1 = await ingestPostIntoCluster(db, {
      postId: 'telegram:lo:1',
      sourceId: 'telegram:lo',
      sourceTrust: 0.3,
      postUrl: 'https://t.me/lo/1',
      postedAt: now - 3600_000,
      text: 'Fresh protocol quests at https://brandnew.example',
    }, { knownDomains: known }, surfIndex, known, new Set<string>(), now);
    expect(r1.riskLevel).toBe('warn');

    // Second post from a distinct higher-trust channel: the single-low-trust
    // reason must clear, leaving no reasons -> risk downgrades to ok.
    await ingestPostIntoCluster(db, {
      postId: 'telegram:hi:2',
      sourceId: 'telegram:hi',
      sourceTrust: 0.9,
      postUrl: 'https://t.me/hi/2',
      postedAt: now - 1800_000,
      text: 'Fresh protocol quests at https://brandnew.example',
    }, { knownDomains: known }, surfIndex, known, new Set<string>(), now);

    const row = await db
      .prepare('SELECT risk_level, risk_reasons FROM clusters WHERE id = ?1')
      .bind(r1.clusterId)
      .first<{ risk_level: string; risk_reasons: string }>();
    const reasons = JSON.parse(row?.risk_reasons ?? '[]') as string[];
    expect(reasons.some(r => r === 'Single low-trust source')).toBe(false);
    expect(row?.risk_level).toBe('ok');
  });

  test('concurrent risky first post cannot leave an unpenalized score behind', async () => {
    const db = createSqliteD1();
    const now = 1_795_200_000_000;
    await db
      .prepare(`INSERT INTO sources (id, platform, handle, lang, trust, enabled) VALUES ('telegram:ch1', 'telegram', 'ch1', 'en', 0.9, 1), ('telegram:ch2', 'telegram', 'ch2', 'en', 0.9, 1)`)
      .run();

    const known = new Map([['novaprotocol.xyz', 'Nova Protocol']]);
    const surfIndex = { byDomain: new Map(), byTicker: new Map() };

    // First post: safe, unpenalized score.
    const seeded = await ingestPostIntoCluster(db, {
      postId: 'telegram:ch1:10',
      sourceId: 'telegram:ch1',
      sourceTrust: 0.9,
      postUrl: 'https://t.me/ch1/10',
      postedAt: now - 7200_000,
      text: 'Nova Protocol testnet live https://novaprotocol.xyz',
    }, { knownDomains: known }, surfIndex, known, new Set<string>(), now);
    expect(seeded.riskLevel).toBe('ok');

    // Second post carries drainer phrasing -> merged risk = 'risk'. The
    // INSERT ... ON CONFLICT path must MIN its penalized score against the
    // stored unpenalized one, not MAX both.
    const risky = await ingestPostIntoCluster(db, {
      postId: 'telegram:ch2:20',
      sourceId: 'telegram:ch2',
      sourceTrust: 0.9,
      postUrl: 'https://t.me/ch2/20',
      postedAt: now - 3600_000,
      text: 'Nova Protocol airdrop is live! Claim now and connect your wallet to claim rewards. https://novaprotocol.xyz',
    }, { knownDomains: known }, surfIndex, known, new Set<string>(), now);
    expect(risky.riskLevel).toBe('risk');

    const row = await db
      .prepare('SELECT risk_level, score FROM clusters WHERE id = ?1')
      .bind(seeded.clusterId)
      .first<{ risk_level: string; score: number }>();
    expect(row?.risk_level).toBe('risk');
    // Stored score must be the risk-penalized one: <= 20% of the same inputs
    // computed risk-free.
    const penalized = computeScore({
      trustMax: 0.9,
      sourceCount: 2,
      lastSeen: now - 3600_000,
      nowMs: now,
      surfTier: null,
      riskLevel: 'risk',
    });
    const unpenalized = computeScore({
      trustMax: 0.9,
      sourceCount: 2,
      lastSeen: now - 3600_000,
      nowMs: now,
      surfTier: null,
      riskLevel: 'ok',
    });
    expect(row!.score).toBeCloseTo(penalized, 3);
    expect(row!.score).toBeLessThan(unpenalized);
  });

  test('decay CAS guard skips rows a concurrent ingest changed', async () => {
    const db = createSqliteD1();
    const now = 1_795_200_000_000;
    await db
      .prepare(`INSERT INTO sources (id, platform, handle, lang, trust, enabled) VALUES ('telegram:ch1', 'telegram', 'ch1', 'en', 0.7, 1)`)
      .run();
    const known = new Map([['novaprotocol.xyz', 'Nova Protocol']]);
    const surfIndex = { byDomain: new Map(), byTicker: new Map() };
    const seeded = await ingestPostIntoCluster(db, {
      postId: 'telegram:ch1:1',
      sourceId: 'telegram:ch1',
      sourceTrust: 0.7,
      postUrl: 'https://t.me/ch1/1',
      postedAt: now - 7200_000,
      text: 'Nova Protocol testnet live https://novaprotocol.xyz',
    }, { knownDomains: known }, surfIndex, known, new Set<string>(), now);
    const cid = seeded.clusterId;

    const before = await db
      .prepare('SELECT score FROM clusters WHERE id = ?1')
      .bind(cid)
      .first<{ score: number }>();

    // Intercept decay's UPDATE: escalate risk between the decay's SELECT and
    // its write (simulate a concurrent ingest). The CAS guard
    // (score = old AND risk_level = read) must then match zero rows and the
    // stale decay score must NOT overwrite the escalated row.
    let escalated = false;
    const racingDb = {
      ...db,
      prepare(sql: string) {
        const stmt = db.prepare(sql);
        if (/UPDATE clusters SET score = \?2 WHERE id = \?1 AND score = \?3 AND risk_level = \?4/.test(sql)) {
          return {
            bind(...args: unknown[]) {
              return { run: () => runBound(args) };
            },
          };
          async function runBound(args: unknown[]) {
            if (!escalated) {
              escalated = true;
              await db
                .prepare(`UPDATE clusters SET score = 9.5, risk_level = 'risk' WHERE id = ?1`)
                .bind(cid)
                .run();
            }
            return stmt.bind(...args).run();
          }
        }
        return stmt;
      },
    } as unknown as D1Database;
    await decayClusterScores(racingDb, now + 3_600_000);

    const row = await db
      .prepare('SELECT score, risk_level FROM clusters WHERE id = ?1')
      .bind(cid)
      .first<{ score: number; risk_level: string }>();
    // The concurrent write (9.5, risk) survived untouched.
    expect(row?.risk_level).toBe('risk');
    expect(row?.score).toBe(9.5);
    expect(before).not.toBeNull();
  });

  test('computes score with surf tier bonus and risk penalty', () => {
    const now = 1_795_200_000_000;
    const okScore = computeScore({ trustMax: 0.8, sourceCount: 3, lastSeen: now, nowMs: now, surfTier: 'S', riskLevel: 'ok' });
    const riskScore = computeScore({ trustMax: 0.8, sourceCount: 3, lastSeen: now, nowMs: now, surfTier: 'S', riskLevel: 'risk' });
    expect(okScore).toBeCloseTo(riskScore * 5, 3);
  });
});
