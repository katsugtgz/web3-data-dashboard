import { describe, expect, test } from 'bun:test';
import type { Grade, MarketSection, RiskLevel } from '../../shared/types';
import { createTestD1 } from './helpers';
import { buildSurfIndex, computeClusterId, ingestPostIntoCluster, queryFeed } from '../src/normalize/cluster';
import { HAN_RE, stripOrTranslateCjk } from '../src/normalize/i18n';
import { cleanUrl, extractUrls, getRegistrableDomain, parseDropPost } from '../src/normalize/parse';
import { computeScore, decayClusterScores } from '../src/normalize/score';
import {
  collectKnownDomainEntries,
  evaluateSafety,
  findLookalikeDomain,
  isPunycodeOrMixedScript,
  levenshtein,
  loadKnownDomains,
  seedKnownDomains,
} from '../src/safety';
import { pollTelegramBatch, pruneOldPosts } from '../src/sources/telegram';

/** Minimal synchronous D1Database shim backed by bun:sqlite for fast worker DB unit tests. */
function createSqliteD1(): D1Database {
  return createTestD1().db;
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

  test('persists clusters.trust_max on insert and keeps it monotonically non-decreasing', async () => {
    const { db } = createTestD1();
    const now = 1_795_200_000_000;
    await db
      .prepare(
        `INSERT INTO sources (id, platform, handle, lang, trust, enabled)
         VALUES ('telegram:s1', 'telegram', 's1', 'en', 0.6, 1),
                ('telegram:s2', 'telegram', 's2', 'en', 0.9, 1),
                ('telegram:s3', 'telegram', 's3', 'en', 0.3, 1),
                ('telegram:s4', 'telegram', 's4', 'en', 0.4, 1)`,
      )
      .run();

    const known = new Map([['trustproto.xyz', 'TrustProto']]);
    const surfIndex = { byDomain: new Map(), byTicker: new Map() };

    const r1 = await ingestPostIntoCluster(
      db,
      {
        postId: 'telegram:s1:1',
        sourceId: 'telegram:s1',
        sourceTrust: 0.6,
        postUrl: 'https://t.me/s1/1',
        postedAt: now - 4000,
        text: 'TrustProto testnet live https://trustproto.xyz',
      },
      { knownDomains: known },
      surfIndex,
      known,
      new Set<string>(),
      now,
    );
    const c1 = await db.prepare('SELECT trust_max FROM clusters WHERE id = ?1').bind(r1.clusterId).first<{ trust_max: number }>();
    expect(c1?.trust_max).toBe(0.6);

    await ingestPostIntoCluster(
      db,
      {
        postId: 'telegram:s2:2',
        sourceId: 'telegram:s2',
        sourceTrust: 0.9,
        postUrl: 'https://t.me/s2/2',
        postedAt: now - 3000,
        text: 'TrustProto bridge live https://trustproto.xyz',
      },
      { knownDomains: known },
      surfIndex,
      known,
      new Set<string>(),
      now,
    );
    const c2 = await db.prepare('SELECT trust_max FROM clusters WHERE id = ?1').bind(r1.clusterId).first<{ trust_max: number }>();
    expect(c2?.trust_max).toBe(0.9);

    await ingestPostIntoCluster(
      db,
      {
        postId: 'telegram:s3:3',
        sourceId: 'telegram:s3',
        sourceTrust: 0.3,
        postUrl: 'https://t.me/s3/3',
        postedAt: now - 2000,
        text: 'TrustProto faucet live https://trustproto.xyz',
      },
      { knownDomains: known },
      surfIndex,
      known,
      new Set<string>(),
      now,
    );
    const c3 = await db.prepare('SELECT trust_max FROM clusters WHERE id = ?1').bind(r1.clusterId).first<{ trust_max: number }>();
    expect(c3?.trust_max).toBe(0.9);

    // Simulate a higher trust_max already stored in DB that is not in prevAgg.
    await db.prepare('UPDATE clusters SET trust_max = 0.95 WHERE id = ?1').bind(r1.clusterId).run();
    await ingestPostIntoCluster(
      db,
      {
        postId: 'telegram:s4:4',
        sourceId: 'telegram:s4',
        sourceTrust: 0.4,
        postUrl: 'https://t.me/s4/4',
        postedAt: now - 1000,
        text: 'TrustProto quest live https://trustproto.xyz',
      },
      { knownDomains: known },
      surfIndex,
      known,
      new Set<string>(),
      now,
    );
    const c4 = await db.prepare('SELECT trust_max FROM clusters WHERE id = ?1').bind(r1.clusterId).first<{ trust_max: number }>();
    expect(c4?.trust_max).toBe(0.95);
  });

  test('decayClusterScores reads trust_max from clusters without joining posts or sources', async () => {
    const { db, queries } = createTestD1();
    const t0 = 1_795_200_000_000;
    await db
      .prepare(
        `INSERT INTO sources (id, platform, handle, lang, trust, enabled)
         VALUES ('telegram:hi', 'telegram', 'hi', 'en', 0.9, 1),
                ('telegram:lo', 'telegram', 'lo', 'en', 0.4, 1)`,
      )
      .run();

    const known = new Map([
      ['hi.example', 'HiProto'],
      ['lo.example', 'LoProto'],
    ]);
    const surfIndex = { byDomain: new Map(), byTicker: new Map() };

    const hi = await ingestPostIntoCluster(
      db,
      {
        postId: 'telegram:hi:1',
        sourceId: 'telegram:hi',
        sourceTrust: 0.9,
        postUrl: 'https://t.me/hi/1',
        postedAt: t0,
        text: 'HiProto testnet live https://hi.example',
      },
      { knownDomains: known },
      surfIndex,
      known,
      new Set<string>(),
      t0,
    );
    const lo = await ingestPostIntoCluster(
      db,
      {
        postId: 'telegram:lo:1',
        sourceId: 'telegram:lo',
        sourceTrust: 0.4,
        postUrl: 'https://t.me/lo/1',
        postedAt: t0,
        text: 'LoProto testnet live https://lo.example',
      },
      { knownDomains: known },
      surfIndex,
      known,
      new Set<string>(),
      t0,
    );

    const initHi = await db.prepare('SELECT score FROM clusters WHERE id = ?1').bind(hi.clusterId).first<{ score: number }>();
    const initLo = await db.prepare('SELECT score FROM clusters WHERE id = ?1').bind(lo.clusterId).first<{ score: number }>();
    expect(initHi?.score).toBeGreaterThan(0);
    expect(initLo?.score).toBeGreaterThan(0);

    const t1 = t0 + 24 * 3_600_000;
    const before = queries.length;
    await decayClusterScores(db, t1);
    const decayQueries = queries.slice(before);

    expect(decayQueries.length).toBeGreaterThan(0);
    expect(decayQueries.some(q => /\b(posts|sources)\b/i.test(q))).toBe(false);

    for (const [cid, initScore] of [
      [hi.clusterId, initHi!.score],
      [lo.clusterId, initLo!.score],
    ] as const) {
      const row = await db
        .prepare('SELECT score, source_count, last_seen, surf_tier, risk_level, trust_max FROM clusters WHERE id = ?1')
        .bind(cid)
        .first<{
          score: number;
          source_count: number;
          last_seen: number;
          surf_tier: Grade | null;
          risk_level: RiskLevel;
          trust_max: number;
        }>();
      expect(row).not.toBeNull();
      const expected = computeScore({
        trustMax: row!.trust_max,
        sourceCount: row!.source_count,
        lastSeen: row!.last_seen,
        nowMs: t1,
        surfTier: row!.surf_tier,
        riskLevel: row!.risk_level,
      });
      expect(row!.score).toBe(expected);
      expect(row!.score).toBeLessThan(initScore);
    }
  });

  test('pruneOldPosts skips orphan cluster scan when no posts expire and prunes orphans otherwise', async () => {
    const { db, queries } = createTestD1();
    const now = 1_795_200_000_000;
    const DAY = 86_400_000;

    await db
      .prepare(
        `INSERT INTO clusters (id, project, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen)
         VALUES ('c-fresh', 'FreshProto', '[]', '["quest"]', 'Fresh', 'rule', 'ok', '[]', 1.0, 1, ?1, ?1)`,
      )
      .bind(now - 5 * DAY)
      .run();
    await db
      .prepare(
        `INSERT INTO posts (id, source_id, post_url, posted_at, text, urls, cluster_id, created_at)
         VALUES ('p-fresh', 'telegram:ch1', 'https://t.me/ch1/1', ?1, 'fresh post', '[]', 'c-fresh', ?1)`,
      )
      .bind(now - 5 * DAY)
      .run();

    const before0 = queries.length;
    const res0 = await pruneOldPosts(db, now);
    expect(res0).toEqual({ deletedPosts: 0, deletedClusters: 0 });
    expect(queries.slice(before0).some(q => /DELETE\s+FROM\s+clusters/i.test(q))).toBe(false);

    await db
      .prepare(
        `INSERT INTO clusters (id, project, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen)
         VALUES ('c-orphan', 'OrphanProto', '[]', '["quest"]', 'Orphan', 'rule', 'ok', '[]', 0.5, 1, ?1, ?1),
                ('c-mixed', 'MixedProto', '[]', '["quest"]', 'Mixed', 'rule', 'ok', '[]', 0.8, 1, ?1, ?2)`,
      )
      .bind(now - 31 * DAY, now - 2 * DAY)
      .run();
    await db
      .prepare(
        `INSERT INTO posts (id, source_id, post_url, posted_at, text, urls, cluster_id, created_at)
         VALUES ('p-old-orphan', 'telegram:ch1', 'https://t.me/ch1/2', ?1, 'old orphan', '[]', 'c-orphan', ?1),
                ('p-old-mixed', 'telegram:ch1', 'https://t.me/ch1/3', ?1, 'old mixed', '[]', 'c-mixed', ?1),
                ('p-new-mixed', 'telegram:ch1', 'https://t.me/ch1/4', ?2, 'new mixed', '[]', 'c-mixed', ?2)`,
      )
      .bind(now - 31 * DAY, now - 2 * DAY)
      .run();

    const before1 = queries.length;
    const res1 = await pruneOldPosts(db, now);
    expect(res1).toEqual({ deletedPosts: 2, deletedClusters: 1 });
    expect(queries.slice(before1).some(q => /DELETE\s+FROM\s+clusters/i.test(q))).toBe(true);

    const remainingClusters = await db.prepare('SELECT id FROM clusters ORDER BY id ASC').all<{ id: string }>();
    expect(remainingClusters.results.map(r => r.id)).toEqual(['c-fresh', 'c-mixed']);
    const remainingPosts = await db.prepare('SELECT COUNT(*) AS n FROM posts').first<{ n: number }>();
    expect(remainingPosts?.n).toBe(2);
  });

  test('pollTelegramBatch defers loadKnownDomains until a channel has new posts', async () => {
    const makeTelegramHtml = (handle: string, msgId: number, isoDate: string, text: string) =>
      `<div class="tgme_widget_message" data-post="${handle}/${msgId}"><div class="tgme_widget_message_text">${text}</div><a class="tgme_widget_message_date"><time datetime="${isoDate}">12:00</time></a></div>`;

    const { db, queries } = createTestD1();
    const now = Date.parse('2026-11-24T10:00:00Z');
    await db
      .prepare(
        `INSERT INTO sources (id, platform, handle, lang, trust, enabled, last_seen_id)
         VALUES ('telegram:ch1', 'telegram', 'ch1', 'en', 0.8, 1, '100'),
                ('telegram:ch2', 'telegram', 'ch2', 'en', 0.7, 1, '200'),
                ('telegram:ch3', 'telegram', 'ch3', 'en', 0.6, 1, '300')`,
      )
      .run();
    await db
      .prepare(`INSERT INTO known_domains (domain, project, origin) VALUES ('novaprotocol.xyz', 'Nova Protocol', 'surf')`)
      .run();

    // Tick 1: ch1/ch2 return already-seen IDs, ch3 fails -> loadKnownDomains must NOT run.
    const before0 = queries.length;
    const s0 = await pollTelegramBatch(db, 4, now, null, async handle => {
      if (handle === 'ch1') return makeTelegramHtml('ch1', 100, '2026-11-24T09:00:00Z', 'Already seen ch1');
      if (handle === 'ch2') return makeTelegramHtml('ch2', 200, '2026-11-24T09:00:00Z', 'Already seen ch2');
      throw new Error('upstream 502');
    });
    expect(s0.polled).toBe(3);
    expect(s0.insertedPosts).toBe(0);
    expect(s0.errors).toBe(1);
    expect(queries.slice(before0).some(q => /FROM\s+known_domains/i.test(q))).toBe(false);

    const srcRows0 = await db
      .prepare(`SELECT id, last_polled_at, last_ok_at, status, fail_count FROM sources ORDER BY id ASC`)
      .all<{ id: string; last_polled_at: number; last_ok_at: number | null; status: string; fail_count: number }>();
    expect(srcRows0.results).toEqual([
      { id: 'telegram:ch1', last_polled_at: now, last_ok_at: now, status: 'ok', fail_count: 0 },
      { id: 'telegram:ch2', last_polled_at: now, last_ok_at: now, status: 'ok', fail_count: 0 },
      { id: 'telegram:ch3', last_polled_at: now, last_ok_at: null, status: 'ok', fail_count: 1 },
    ]);

    // Tick 2: ch1 has 1 new post, ch2/ch3 have no new posts -> loadKnownDomains runs once and ch1 ingests.
    const t1 = now + 60_000;
    const before1 = queries.length;
    const s1 = await pollTelegramBatch(db, 4, t1, null, async handle => {
      if (handle === 'ch1') {
        return makeTelegramHtml('ch1', 101, '2026-11-24T09:59:00Z', 'Nova Protocol testnet live https://novaprotocol.xyz');
      }
      if (handle === 'ch2') return makeTelegramHtml('ch2', 200, '2026-11-24T09:00:00Z', 'Already seen ch2');
      return makeTelegramHtml('ch3', 300, '2026-11-24T09:00:00Z', 'Already seen ch3');
    });
    expect(s1.polled).toBe(3);
    expect(s1.insertedPosts).toBe(1);
    expect(s1.errors).toBe(0);
    expect(s1.ingestedResults.length).toBe(1);
    expect(queries.slice(before1).filter(q => /FROM\s+known_domains/i.test(q)).length).toBe(1);

    const postRow = await db.prepare(`SELECT id FROM posts WHERE id = 'telegram:ch1:101'`).first<{ id: string }>();
    expect(postRow?.id).toBe('telegram:ch1:101');
    const srcRows1 = await db
      .prepare(`SELECT id, last_seen_id, last_polled_at, fail_count FROM sources ORDER BY id ASC`)
      .all<{ id: string; last_seen_id: string; last_polled_at: number; fail_count: number }>();
    expect(srcRows1.results).toEqual([
      { id: 'telegram:ch1', last_seen_id: '101', last_polled_at: t1, fail_count: 0 },
      { id: 'telegram:ch2', last_seen_id: '200', last_polled_at: t1, fail_count: 0 },
      { id: 'telegram:ch3', last_seen_id: '300', last_polled_at: t1, fail_count: 0 },
    ]);
  });

  test('loadKnownDomains caches per DB with 5m TTL, invalidates on seedKnownDomains, and never caches failures', async () => {
    const makeDefi = (entries: [string, string][], fetchedAt: number): MarketSection => ({
      id: 'defi',
      title: 'DeFi',
      blurb: 'DeFi',
      cols: ['Project'],
      rows: entries.map(([name, href]) => ({ cells: [name], href })),
      source: 'DefiLlama',
      sourceUrl: 'https://defillama.com',
      fetchedAt,
      stale: false,
    });

    const { db, queries } = createTestD1();
    const t0 = 1_795_200_000_000;
    const TTL = 5 * 60_000;

    await seedKnownDomains(db, null, makeDefi([['Alpha', 'https://alpha.xyz']], t0));
    const before1 = queries.length;
    const r1 = await loadKnownDomains(db, t0);
    const r2 = await loadKnownDomains(db, t0 + 60_000);
    expect(queries.slice(before1).filter(q => /FROM\s+known_domains/i.test(q)).length).toBe(1);
    expect(r1.projectDomains.get('alpha.xyz')).toBe('Alpha');
    expect(r2).toBe(r1);

    await seedKnownDomains(
      db,
      null,
      makeDefi(
        [
          ['Alpha', 'https://alpha.xyz'],
          ['Beta', 'https://beta.xyz'],
        ],
        t0 + 60_000,
      ),
    );
    const before2 = queries.length;
    const r3 = await loadKnownDomains(db, t0 + 60_000);
    expect(queries.slice(before2).filter(q => /FROM\s+known_domains/i.test(q)).length).toBe(1);
    expect(r3.projectDomains.get('beta.xyz')).toBe('Beta');

    await db
      .prepare(`INSERT INTO known_domains (domain, project, origin) VALUES ('gamma.xyz', 'Gamma', 'surf')`)
      .run();
    const before3 = queries.length;
    const r4 = await loadKnownDomains(db, t0 + 60_000 + TTL - 1);
    expect(queries.slice(before3).filter(q => /FROM\s+known_domains/i.test(q)).length).toBe(0);
    expect(r4.projectDomains.has('gamma.xyz')).toBe(false);

    const before4 = queries.length;
    const r5 = await loadKnownDomains(db, t0 + 60_000 + TTL);
    expect(queries.slice(before4).filter(q => /FROM\s+known_domains/i.test(q)).length).toBe(1);
    expect(r5.projectDomains.get('gamma.xyz')).toBe('Gamma');

    const { db: badDb } = createTestD1();
    await badDb.exec('DROP TABLE known_domains');
    await expect(loadKnownDomains(badDb, t0)).rejects.toThrow();
    await expect(loadKnownDomains(badDb, t0)).rejects.toThrow();

    // Concurrent seedKnownDomains finishing mid-SELECT must prevent caching stale rows.
    const { db: raceBaseDb, queries: raceQueries } = createTestD1();
    let interceptNextLoad = false;
    let notifySelectStarted!: () => void;
    let releaseSelect!: () => void;
    const selectStarted = new Promise<void>(resolve => {
      notifySelectStarted = resolve;
    });
    const selectGate = new Promise<void>(resolve => {
      releaseSelect = resolve;
    });
    const raceDb = {
      ...raceBaseDb,
      prepare(sql: string) {
        const stmt = raceBaseDb.prepare(sql);
        if (interceptNextLoad && /SELECT\s+domain,\s+project,\s+origin\s+FROM\s+known_domains/i.test(sql)) {
          interceptNextLoad = false;
          return {
            async all<T>() {
              const res = await stmt.all<T>();
              notifySelectStarted();
              await selectGate;
              return res;
            },
          };
        }
        return stmt;
      },
    } as unknown as D1Database;

    await seedKnownDomains(raceDb, null, makeDefi([['Alpha', 'https://alpha.xyz']], t0));
    interceptNextLoad = true;
    const inflightLoad = loadKnownDomains(raceDb, t0);
    await selectStarted;

    await seedKnownDomains(
      raceDb,
      null,
      makeDefi(
        [
          ['Alpha', 'https://alpha.xyz'],
          ['Beta', 'https://beta.xyz'],
        ],
        t0 + 1_000,
      ),
    );
    releaseSelect();
    const staleResult = await inflightLoad;
    expect(staleResult.projectDomains.has('beta.xyz')).toBe(false);

    const beforeFresh = raceQueries.length;
    const freshResult = await loadKnownDomains(raceDb, t0 + 2_000);
    expect(raceQueries.slice(beforeFresh).filter(q => /FROM\s+known_domains/i.test(q)).length).toBe(1);
    expect(freshResult.projectDomains.get('beta.xyz')).toBe('Beta');

    const beforeCached = raceQueries.length;
    const cachedResult = await loadKnownDomains(raceDb, t0 + 3_000);
    expect(raceQueries.slice(beforeCached).filter(q => /FROM\s+known_domains/i.test(q)).length).toBe(0);
    expect(cachedResult).toBe(freshResult);
  });

  test('pruneOldPosts retries pending orphan-cluster cleanup when zero posts expire after a failed cluster delete', async () => {
    const { db, queries } = createTestD1();
    const now = 1_795_200_000_000;
    const DAY = 86_400_000;

    await db
      .prepare(
        `INSERT INTO clusters (id, project, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen)
         VALUES ('c-fresh', 'FreshProto', '[]', '["quest"]', 'Fresh', 'rule', 'ok', '[]', 1.0, 1, ?1, ?1),
                ('c-orphan', 'OrphanProto', '[]', '["quest"]', 'Orphan', 'rule', 'ok', '[]', 0.5, 1, ?2, ?2)`,
      )
      .bind(now - 5 * DAY, now - 31 * DAY)
      .run();
    await db
      .prepare(
        `INSERT INTO posts (id, source_id, post_url, posted_at, text, urls, cluster_id, created_at)
         VALUES ('p-fresh', 'telegram:ch1', 'https://t.me/ch1/1', ?1, 'fresh post', '[]', 'c-fresh', ?1),
                ('p-old', 'telegram:ch1', 'https://t.me/ch1/2', ?2, 'old post', '[]', 'c-orphan', ?2)`,
      )
      .bind(now - 5 * DAY, now - 31 * DAY)
      .run();

    let failClusterDelete = true;
    const flakyDb = {
      ...db,
      prepare(sql: string) {
        const stmt = db.prepare(sql);
        if (failClusterDelete && /DELETE\s+FROM\s+clusters/i.test(sql)) {
          return {
            async run() {
              failClusterDelete = false;
              throw new Error('D1 clusters delete error');
            },
          };
        }
        return stmt;
      },
    } as unknown as D1Database;

    await expect(pruneOldPosts(flakyDb, now)).rejects.toThrow('D1 clusters delete error');

    const oldPost = await db.prepare(`SELECT id FROM posts WHERE id = 'p-old'`).first<{ id: string }>();
    expect(oldPost).toBeNull();
    const orphanStillThere = await db.prepare(`SELECT id FROM clusters WHERE id = 'c-orphan'`).first<{ id: string }>();
    expect(orphanStillThere?.id).toBe('c-orphan');
    const pendingMarker = await db
      .prepare(`SELECT key FROM cron_state WHERE key = 'prune:orphans'`)
      .first<{ key: string }>();
    expect(pendingMarker?.key).toBe('prune:orphans');

    // Next call deletes 0 expired posts, yet sees pending marker and removes the orphan cluster.
    const retryRes = await pruneOldPosts(db, now + 60_000);
    expect(retryRes).toEqual({ deletedPosts: 0, deletedClusters: 1 });
    const remaining = await db.prepare('SELECT id FROM clusters ORDER BY id ASC').all<{ id: string }>();
    expect(remaining.results.map(r => r.id)).toEqual(['c-fresh']);
    const clearedMarker = await db
      .prepare(`SELECT key FROM cron_state WHERE key = 'prune:orphans'`)
      .first<{ key: string }>();
    expect(clearedMarker).toBeNull();

    // Subsequent call with 0 expired posts restores the short-circuit (no cluster DELETE).
    const beforeSteady = queries.length;
    const steadyRes = await pruneOldPosts(db, now + 120_000);
    expect(steadyRes).toEqual({ deletedPosts: 0, deletedClusters: 0 });
    expect(queries.slice(beforeSteady).some(q => /DELETE\s+FROM\s+clusters/i.test(q))).toBe(false);
  });

  test('pruneOldPosts persists orphan marker atomically with posts delete so failed marker or posts writes leave no leaked orphans', async () => {
    const { db } = createTestD1();
    const now = 1_795_200_000_000;
    const DAY = 86_400_000;

    // Scenario A: marker write fails alongside failing clusters delete -> posts DELETE must roll back.
    await db
      .prepare(
        `INSERT INTO clusters (id, project, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen)
         VALUES ('c-fresh', 'FreshProto', '[]', '["quest"]', 'Fresh', 'rule', 'ok', '[]', 1.0, 1, ?1, ?1),
                ('c-orphan', 'OrphanProto', '[]', '["quest"]', 'Orphan', 'rule', 'ok', '[]', 0.5, 1, ?2, ?2)`,
      )
      .bind(now - 5 * DAY, now - 31 * DAY)
      .run();
    await db
      .prepare(
        `INSERT INTO posts (id, source_id, post_url, posted_at, text, urls, cluster_id, created_at)
         VALUES ('p-fresh', 'telegram:ch1', 'https://t.me/ch1/1', ?1, 'fresh post', '[]', 'c-fresh', ?1),
                ('p-old', 'telegram:ch1', 'https://t.me/ch1/2', ?2, 'old post', '[]', 'c-orphan', ?2)`,
      )
      .bind(now - 5 * DAY, now - 31 * DAY)
      .run();

    const flakyMarkerDb = {
      ...db,
      prepare(sql: string) {
        const stmt = db.prepare(sql);
        if (/INSERT\s+INTO\s+cron_state/i.test(sql)) {
          return {
            bind() {
              return {
                async run() {
                  throw new Error('D1 marker write error');
                },
              };
            },
          };
        }
        if (/DELETE\s+FROM\s+clusters/i.test(sql)) {
          return {
            async run() {
              throw new Error('D1 clusters delete error');
            },
          };
        }
        return stmt;
      },
    } as unknown as D1Database;

    await expect(pruneOldPosts(flakyMarkerDb, now)).rejects.toThrow();

    const oldPostAfterMarkerFail = await db.prepare(`SELECT id FROM posts WHERE id = 'p-old'`).first<{ id: string }>();
    expect(oldPostAfterMarkerFail?.id).toBe('p-old');
    const orphanAfterMarkerFail = await db.prepare(`SELECT id FROM clusters WHERE id = 'c-orphan'`).first<{ id: string }>();
    expect(orphanAfterMarkerFail?.id).toBe('c-orphan');
    const markerAfterMarkerFail = await db
      .prepare(`SELECT key FROM cron_state WHERE key = 'prune:orphans'`)
      .first<{ key: string }>();
    expect(markerAfterMarkerFail).toBeNull();

    expect(await pruneOldPosts(db, now + 60_000)).toEqual({ deletedPosts: 1, deletedClusters: 1 });

    // Scenario B: posts DELETE fails after marker statement in the same batch -> marker rolls back cleanly.
    await db
      .prepare(
        `INSERT INTO clusters (id, project, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen)
         VALUES ('c-orphan2', 'OrphanProto2', '[]', '["quest"]', 'Orphan2', 'rule', 'ok', '[]', 0.5, 1, ?1, ?1)`,
      )
      .bind(now - 31 * DAY)
      .run();
    await db
      .prepare(
        `INSERT INTO posts (id, source_id, post_url, posted_at, text, urls, cluster_id, created_at)
         VALUES ('p-old2', 'telegram:ch1', 'https://t.me/ch1/3', ?1, 'old post 2', '[]', 'c-orphan2', ?1)`,
      )
      .bind(now - 31 * DAY)
      .run();

    const flakyPostsDb = {
      ...db,
      prepare(sql: string) {
        const stmt = db.prepare(sql);
        if (/DELETE\s+FROM\s+posts/i.test(sql)) {
          return {
            bind() {
              return {
                async run() {
                  throw new Error('D1 posts delete error');
                },
              };
            },
          };
        }
        return stmt;
      },
    } as unknown as D1Database;

    await expect(pruneOldPosts(flakyPostsDb, now)).rejects.toThrow('D1 posts delete error');

    const markerAfterPostsFail = await db
      .prepare(`SELECT key FROM cron_state WHERE key = 'prune:orphans'`)
      .first<{ key: string }>();
    expect(markerAfterPostsFail).toBeNull();
    const oldPost2AfterFail = await db.prepare(`SELECT id FROM posts WHERE id = 'p-old2'`).first<{ id: string }>();
    expect(oldPost2AfterFail?.id).toBe('p-old2');
    const orphan2AfterFail = await db.prepare(`SELECT id FROM clusters WHERE id = 'c-orphan2'`).first<{ id: string }>();
    expect(orphan2AfterFail?.id).toBe('c-orphan2');

    expect(await pruneOldPosts(db, now + 60_000)).toEqual({ deletedPosts: 1, deletedClusters: 1 });
    const remaining = await db.prepare('SELECT id FROM clusters ORDER BY id ASC').all<{ id: string }>();
    expect(remaining.results.map(r => r.id)).toEqual(['c-fresh']);
  });

  test('collectKnownDomainEntries, seedKnownDomains, and buildSurfIndex enforce trust boundaries and prune stale curated rows', async () => {
    const makeCard = (overrides: Record<string, unknown>) => ({
      r: 1,
      n: 'Proto',
      t: null,
      g: 'A' as Grade,
      b: ['live'],
      x: null,
      img: '',
      f: '—',
      tk: '1/1',
      h: 10,
      u: 'today',
      fit: ['zero'],
      best: { n: 'Task', ty: 'testnet', c: 'Free', m: '5m' },
      sc: 70,
      sub: [7, 7, null],
      url: null,
      ...overrides,
    });

    const defiSection: MarketSection = {
      id: 'defi',
      title: 'DeFi',
      blurb: 'DeFi',
      cols: ['Project'],
      rows: [{ cells: ['Arbitrum'], href: 'https://arbitrum.io/' }],
      source: 'DefiLlama',
      sourceUrl: 'https://defillama.com',
      fetchedAt: 1000,
      stale: false,
    };

    const feed = {
      cards: [
        makeCard({ n: 'SurfGood', t: 'SGOOD', source: 'Surf', url: 'https://surfgood.xyz/' }),
        makeCard({ n: 'SurfRisk', t: 'SRISK', source: 'Surf', b: ['live', 'risk'], url: 'https://surfrisk.xyz/' }),
        makeCard({ n: 'AssoSheet', source: 'ASSO7878', url: 'https://assosheet.io/' }),
        makeCard({ n: 'ArndxtSheet', source: 'arndxt', url: 'https://arndxtsheet.io/' }),
        makeCard({ n: 'Ethena', source: 'Pendle', url: 'https://app.pendle.finance/trade/markets/0x1' }),
        makeCard({ n: 'Pendle', source: 'Pendle', url: 'https://pendle.finance/' }),
        makeCard({ n: 'Uniswap', source: 'Merkl', url: 'https://app.merkl.xyz/opportunities/1' }),
        makeCard({ n: 'DefiGood', source: 'DefiLlama', url: 'https://defigood.fi/' }),
        makeCard({ n: 'DefiRisk', source: 'DefiLlama', b: ['risk'], url: 'https://defirisk.fi/' }),
        makeCard({ n: 'PunyBad', source: 'DefiLlama', url: 'https://xn--arbitrm-91a.io/' }),
        makeCard({ n: 'LookalikeDefi', source: 'DefiLlama', url: 'https://arbitrurn.io/' }),
        makeCard({ n: 'LookalikePlatform', source: 'DefiLlama', url: 'https://zea1y.io/' }),
      ],
      tge: [],
      counts: { active: 12, preToken: 12 },
      fetchedAt: 1000,
    } as unknown as import('../../shared/types').AirdropFeed;

    const entries = collectKnownDomainEntries(feed, defiSection);
    const byDom = new Map(entries.map(e => [e.domain, e]));

    expect(byDom.get('surfgood.xyz')?.origin).toBe('surf');
    expect(byDom.get('arbitrum.io')?.origin).toBe('defi');
    expect(byDom.get('defigood.fi')?.origin).toBe('curated');
    expect(byDom.get('pendle.finance')?.project).toBe('Pendle');
    expect(byDom.get('pendle.finance')?.origin).toBe('curated');

    // Excluded: risk cards, editable sheets, aggregator hosts for 3rd-party cards, punycode, lookalikes.
    expect(byDom.has('surfrisk.xyz')).toBe(false);
    expect(byDom.has('defirisk.fi')).toBe(false);
    expect(byDom.has('assosheet.io')).toBe(false);
    expect(byDom.has('arndxtsheet.io')).toBe(false);
    expect(byDom.has('merkl.xyz')).toBe(false);
    expect(byDom.has('xn--arbitrm-91a.io')).toBe(false);
    expect(byDom.has('arbitrurn.io')).toBe(false);
    expect(byDom.has('zea1y.io')).toBe(false);

    // buildSurfIndex skips risk cards and curated aggregator domains for 3rd-party cards.
    const surfIndex = buildSurfIndex(feed);
    expect(surfIndex.byDomain.get('surfgood.xyz')?.name).toBe('SurfGood');
    expect(surfIndex.byTicker.get('SGOOD')?.name).toBe('SurfGood');
    expect(surfIndex.byDomain.has('surfrisk.xyz')).toBe(false);
    expect(surfIndex.byTicker.has('SRISK')).toBe(false);
    expect(surfIndex.byDomain.get('pendle.finance')?.name).toBe('Pendle');
    expect(surfIndex.byDomain.has('merkl.xyz')).toBe(false);

    // seedKnownDomains prunes stale origin='curated' rows while preserving surf/defi/platform.
    const { db } = createTestD1();
    await db
      .prepare(
        `INSERT INTO known_domains (domain, project, origin)
         VALUES ('stale-curated.io', 'OldCurated', 'curated'),
                ('keep-surf.io', 'KeepSurf', 'surf'),
                ('keep-defi.io', 'KeepDefi', 'defi')`,
      )
      .run();

    await seedKnownDomains(db, feed, defiSection);
    const rows = await db
      .prepare('SELECT domain, origin FROM known_domains ORDER BY domain ASC')
      .all<{ domain: string; origin: string }>();
    const domSet = new Set(rows.results.map(r => r.domain));
    expect(domSet.has('stale-curated.io')).toBe(false);
    expect(domSet.has('defigood.fi')).toBe(true);
    expect(domSet.has('keep-surf.io')).toBe(true);
    expect(domSet.has('keep-defi.io')).toBe(true);
    expect(domSet.has('galxe.com')).toBe(true);

    // Merged Surf + Pendle and ASSO7878 + Pendle cards must never poison known_domains or surfIndex with pendle.finance/merkl.xyz.
    const mergedAggFeed = {
      cards: [
        makeCard({
          n: 'Ethena',
          source: 'Surf',
          url: 'https://ethena.fi/',
          tasks: [
            { title: 'Stake USDe', type: 'staking', status: 'OPEN', cost: 100, timeMinutes: null, url: 'https://ethena.fi/stake' },
            { title: 'Pendle YT USDe', type: 'staking', status: 'OPEN', cost: 100, timeMinutes: null, url: 'https://app.pendle.finance/trade/markets/0x1' },
            { title: 'Merkl USDe', type: 'liquidity', status: 'OPEN', cost: 100, timeMinutes: null, url: 'https://app.merkl.xyz/opportunities/1' },
          ],
        }),
        makeCard({
          n: 'xStocks',
          source: 'ASSO7878',
          url: null,
          tasks: [
            { title: 'Pendle YT xStocks', type: 'staking', status: 'OPEN', cost: 100, timeMinutes: null, url: 'https://app.pendle.finance/trade/markets/0x2' },
          ],
        }),
      ],
      tge: [],
      counts: { active: 2, preToken: 2 },
      fetchedAt: 1000,
    } as unknown as import('../../shared/types').AirdropFeed;

    const mergedKnown = new Map(collectKnownDomainEntries(mergedAggFeed, null).map(e => [e.domain, e]));
    expect(mergedKnown.get('ethena.fi')?.origin).toBe('surf');
    expect(mergedKnown.has('pendle.finance')).toBe(false);
    expect(mergedKnown.has('merkl.xyz')).toBe(false);

    const mergedSurfIdx = buildSurfIndex(mergedAggFeed);
    expect(mergedSurfIdx.byDomain.get('ethena.fi')?.name).toBe('Ethena');
    expect(mergedSurfIdx.byDomain.has('pendle.finance')).toBe(false);
    expect(mergedSurfIdx.byDomain.has('merkl.xyz')).toBe(false);
  });

  test('seedKnownDomains preserves stored defi/surf/platform identities when defi input is absent and serializes concurrent curated upserts and prunes', async () => {
    const makeCard = (n: string, source: string, url: string) => ({
      r: 1,
      n,
      t: null,
      g: 'A' as Grade,
      b: ['live'],
      x: null,
      img: '',
      f: '—',
      tk: '1/1',
      h: 10,
      u: 'today',
      fit: ['zero'],
      best: { n: 'Task', ty: 'testnet', c: 'Free', m: '5m' },
      sc: 70,
      sub: [7, 7, null],
      url,
      source,
    });

    const { db } = createTestD1();
    await db
      .prepare(
        `INSERT INTO known_domains (domain, project, origin)
         VALUES ('aave.com', 'Aave', 'defi'),
                ('surfkeep.xyz', 'SurfKeep', 'surf'),
                ('oldcurated.fi', 'OldCurated', 'curated')`,
      )
      .run();

    // Reseed with defiSection = null while curated DefiLlama cards contain the same domains under different names.
    const curatedCollisionFeed = {
      cards: [
        makeCard('CuratedAaveAlias', 'DefiLlama', 'https://aave.com/'),
        makeCard('CuratedSurfAlias', 'DefiLlama', 'https://surfkeep.xyz/'),
        makeCard('FreshCurated', 'DefiLlama', 'https://freshcurated.fi/'),
      ],
      tge: [],
      counts: { active: 3, preToken: 3 },
      fetchedAt: 1000,
    } as unknown as import('../../shared/types').AirdropFeed;

    await seedKnownDomains(db, curatedCollisionFeed, null);
    const aaveRow = await db
      .prepare(`SELECT domain, project, origin FROM known_domains WHERE domain = 'aave.com'`)
      .first<{ domain: string; project: string; origin: string }>();
    const surfRow = await db
      .prepare(`SELECT domain, project, origin FROM known_domains WHERE domain = 'surfkeep.xyz'`)
      .first<{ domain: string; project: string; origin: string }>();
    expect(aaveRow).toEqual({ domain: 'aave.com', project: 'Aave', origin: 'defi' });
    expect(surfRow).toEqual({ domain: 'surfkeep.xyz', project: 'SurfKeep', origin: 'surf' });

    // Later reseed without aave.com must still preserve stored defi/surf rows while pruning stale curated rows.
    const emptyFeed = {
      cards: [],
      tge: [],
      counts: { active: 0, preToken: 0 },
      fetchedAt: 2000,
    } as unknown as import('../../shared/types').AirdropFeed;
    await seedKnownDomains(db, emptyFeed, null);
    const aaveAfter = await db
      .prepare(`SELECT domain, project, origin FROM known_domains WHERE domain = 'aave.com'`)
      .first<{ domain: string; project: string; origin: string }>();
    const freshAfter = await db
      .prepare(`SELECT domain FROM known_domains WHERE domain = 'freshcurated.fi'`)
      .first<{ domain: string }>();
    expect(aaveAfter).toEqual({ domain: 'aave.com', project: 'Aave', origin: 'defi' });
    expect(freshAfter).toBeNull();

    // Concurrent seed calls: an earlier seed's prune must never delete a curated row upserted by a newer seed.
    const feedOld = {
      cards: [makeCard('KeepOld', 'DefiLlama', 'https://keepold.fi/')],
      tge: [],
      counts: { active: 1, preToken: 1 },
      fetchedAt: 3000,
    } as unknown as import('../../shared/types').AirdropFeed;
    const feedNew = {
      cards: [
        makeCard('KeepOld', 'DefiLlama', 'https://keepold.fi/'),
        makeCard('BrandNew', 'DefiLlama', 'https://brandnew.fi/'),
      ],
      tge: [],
      counts: { active: 2, preToken: 2 },
      fetchedAt: 4000,
    } as unknown as import('../../shared/types').AirdropFeed;

    // Seed brandnew.fi first, then race feedOld against feedNew so feedOld runs first and feedNew second;
    // with per-db serialization + atomic batch, feedOld cannot read stale rows and delete feedNew's upsert afterwards.
    let delayFirstBatch = true;
    const delayedDb = {
      ...db,
      prepare(sql: string) {
        return db.prepare(sql);
      },
      async batch(stmts: D1PreparedStatement[]) {
        if (delayFirstBatch) {
          delayFirstBatch = false;
          await new Promise(r => setTimeout(r, 15));
        }
        return db.batch(stmts);
      },
    } as unknown as D1Database;

    await Promise.all([seedKnownDomains(delayedDb, feedOld, null), seedKnownDomains(delayedDb, feedNew, null)]);
    const brandNewRow = await db
      .prepare(`SELECT domain, origin FROM known_domains WHERE domain = 'brandnew.fi'`)
      .first<{ domain: string; origin: string }>();
    expect(brandNewRow).toEqual({ domain: 'brandnew.fi', origin: 'curated' });
  });
});
