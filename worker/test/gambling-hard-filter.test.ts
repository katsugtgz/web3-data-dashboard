import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TYPE_MAP, TYPES } from '../../shared/constants';
import { findGamblingAirdropViolations } from '../../shared/gamblingFilter';
import type { AirdropFeed, Card, FeedResponse } from '../../shared/types';
import { checkNoGamblingInDir } from '../../scripts/check-no-gambling.mts';
import worker from '../src/index';
import { upsertSnapshot } from '../src/lib/db';
import { queryFeed } from '../src/normalize/cluster';
import { parseDropPost } from '../src/normalize/parse';
import { classifyDropRelevance } from '../src/normalize/text';
import { extractDefiLlamaTokenlessAirdrops, mergeCuratedAirdropFeeds } from '../src/sources/curated';
import {
  parseAirdropAlertEvents,
  parseGalxeCampaignsToAirdropFeed,
  parseMerklOpportunities,
  parsePendlePoints,
  parseWpCalendarToAirdropFeed,
} from '../src/sources/feeds';
import { parseArndxtSheet } from '../src/sources/sheets';
import { createTestD1 } from './helpers';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const EXEC_CTX = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function makeCard(overrides: Partial<Card> & { n: string }): Card {
  return {
    r: 1,
    t: null,
    g: 'A',
    b: ['live'],
    x: null,
    img: '',
    f: '$10M',
    raiseNum: 10_000_000,
    tk: '1/1',
    h: 100,
    u: 'today',
    fit: ['zero'],
    best: { n: 'Complete testnet', ty: 'testnet', c: 'Free', m: '5 min' },
    costNum: 0,
    taskTypes: ['testnet'],
    tasks: [{ title: 'Complete testnet', type: 'testnet', status: 'OPEN', cost: 0, timeMinutes: 5, url: 'https://clean.xyz/' }],
    sc: 75,
    sub: [8, 8, null],
    url: 'https://clean.xyz/',
    ...overrides,
  };
}

describe('gambling / betting / casino end-to-end hard filters', () => {
  test('UI constants do not expose Betting airdrop type filter', () => {
    expect(TYPES).not.toContain('Betting');
    expect(Object.hasOwn(TYPE_MAP, 'Betting')).toBe(false);
  });

  test('DefiLlama, arndxt, curated merge, AirdropAlert, Galxe, Pendle, and Merkl strip all gambling/casino/betting entries', () => {
    // 1. DefiLlama tokenless extraction
    const llama = extractDefiLlamaTokenlessAirdrops(
      [
        { name: 'CleanDex', slug: 'cleandex', symbol: '-', category: 'Dexes', chains: ['Base'], tvl: 50_000_000, url: 'https://cleandex.xyz' },
        { name: 'CasinoFi', slug: 'casinofi', symbol: '-', category: 'Gambling', chains: ['Base'], tvl: 80_000_000, url: 'https://casinofi.xyz' },
        { name: 'Polymarket', slug: 'polymarket', symbol: '-', category: 'Prediction Market', chains: ['Polygon'], tvl: 300_000_000, url: 'https://polymarket.com' },
        { name: 'LottoPool', slug: 'lottopool', symbol: '-', category: 'Lottery', chains: ['Arbitrum'], tvl: 25_000_000, url: 'https://lottopool.xyz' },
        { name: 'DisguisedBet', slug: 'disguised', symbol: '-', category: 'DeFi', chains: ['Solana'], tvl: 40_000_000, url: 'https://disguised.bet', description: 'On-chain sportsbook and casino' },
      ],
      NOW,
    );
    expect(llama.cards.map(c => c.n)).toEqual(['CleanDex']);

    // 2. arndxt sheet
    const arndxtCsv = [
      'Project,Website,Total fundraised,TGE (approx),TGE reasoning (brief),Airdrop tasks,Airdrop score (1-5)',
      'Polymarket,https://polymarket.com,$100M,Q4 2026,Prediction market leader,Trade prediction markets,5',
      'Yeet,https://yeet.com,$7.75M,Q4 2026,Crypto casino waitlist,Join waitlist,4',
      'CleanL2,https://cleanl2.xyz,$40M,Q4 2026,ZK rollup testnet,Run testnet swaps,5',
    ].join('\n');
    const arndxt = parseArndxtSheet(arndxtCsv, NOW);
    expect(arndxt.cards.map(c => c.n)).toEqual(['CleanL2']);

    // 3. AirdropAlert calendar & events
    const wpCal = parseWpCalendarToAirdropFeed(
      [
        { id: 1, title: { rendered: 'Rollbit Casino Airdrop' }, link: 'https://airdropalert.com/rollbit', content: { rendered: '<a href="https://rollbit.com">Rollbit</a>' } },
        { id: 2, title: { rendered: 'CleanProto TGE' }, link: 'https://airdropalert.com/cleanproto', content: { rendered: '<a href="https://cleanproto.xyz">CleanProto</a>' } },
      ],
      NOW,
    );
    expect(wpCal.tge.map(t => t.n)).toEqual(['CleanProto TGE']);

    const aaEvents = parseAirdropAlertEvents(
      {
        events: [
          { listing: 10, type: 'tge', p: 'Stake Casino', title: 'Wager event', html: 'Casino airdrop', url: 'https://airdropalert.com/airdrops/stake-casino', d: '2026-11-30' },
          { listing: 11, type: 'tge', p: 'CleanApp', title: 'Claim opens', html: 'Mainnet airdrop', url: 'https://airdropalert.com/airdrops/cleanapp', d: '2026-11-30' },
        ],
      },
      NOW,
    );
    expect(aaEvents.cards.map(c => c.n)).toEqual(['CleanApp']);

    // 4. Galxe curated campaigns
    const galxe = parseGalxeCampaignsToAirdropFeed(
      {
        data: {
          campaigns: {
            list: [
              {
                id: 'g1',
                name: 'Casino Slots Bonus Quest',
                type: 'Points',
                status: 'Active',
                startTime: Math.floor(NOW / 1000) - 3600,
                endTime: Math.floor(NOW / 1000) + 86400,
                participants: { participantsCount: 5000 },
                space: { id: 's1', name: 'BetFury', alias: 'betfury', followersCount: 50000, isVerified: true, links: '{"HomePage":"https://betfury.io"}' },
              },
              {
                id: 'g2',
                name: 'Testnet Voyage',
                type: 'Points',
                status: 'Active',
                startTime: Math.floor(NOW / 1000) - 3600,
                endTime: Math.floor(NOW / 1000) + 86400,
                participants: { participantsCount: 5000 },
                space: { id: 's2', name: 'CleanLayer', alias: 'cleanlayer', followersCount: 50000, isVerified: true, links: '{"HomePage":"https://cleanlayer.xyz"}' },
              },
            ],
          },
        },
      },
      NOW,
    );
    expect(galxe.cards.map(c => c.n)).toEqual(['CleanLayer']);

    // 5. Pendle & Merkl
    const pendle = parsePendlePoints(
      [
        { name: 'PT-Polymarket', protocol: 'Polymarket', address: '0x1', chainId: 1, expiry: '2027-01-01T00:00:00Z', categoryIds: ['points'], details: { liquidity: 5_000_000 } },
        { name: 'PT-Ethena', protocol: 'Ethena', address: '0x2', chainId: 1, expiry: '2027-01-01T00:00:00Z', categoryIds: ['points'], details: { liquidity: 5_000_000 } },
      ],
      NOW,
    );
    expect(pendle.cards.map(c => c.n)).toEqual(['Ethena']);

    const merkl = parseMerklOpportunities(
      [
        { status: 'LIVE', tvl: 500_000, protocol: { id: 'azuro', name: 'Azuro' }, name: 'Azuro Betting LP', depositUrl: 'https://azuro.org/lp', action: 'PROVIDE' },
        { status: 'LIVE', tvl: 500_000, protocol: { id: 'morpho', name: 'Morpho' }, name: 'Morpho USDC Vault', depositUrl: 'https://morpho.org/vault', action: 'PROVIDE' },
      ],
      NOW,
    );
    expect(merkl.cards.map(c => c.n)).toEqual(['Morpho']);

    // 6. mergeCuratedAirdropFeeds final hard gate
    const merged = mergeCuratedAirdropFeeds(
      [
        {
          cards: [
            makeCard({ n: 'Yeet', url: 'https://comingsoon.yeet.com/' }),
            makeCard({ n: 'Kalshi', url: 'https://kalshi.com/', best: { n: 'Predict', ty: 'predictions', c: 'Free', m: '5 min' }, taskTypes: ['predictions'] }),
            makeCard({ n: 'CleanProto', url: 'https://cleanproto.xyz/' }),
          ],
          tge: [{ n: 'predict.fun', t: 'PREDICT', s: 'Claimable', d: 'TBA', url: 'https://predict.fun/' }],
          counts: { active: 3, preToken: 3 },
          fetchedAt: NOW,
        },
      ],
      NOW,
    );
    expect(merged.cards.map(c => c.n)).toEqual(['CleanProto']);
    expect(merged.tge).toEqual([]);
    expect(findGamblingAirdropViolations(merged)).toEqual([]);
  });

  test('drops parser and relevance classifier hard-reject casino, sportsbook, and betting posts', () => {
    const casinoPost = parseDropPost('Yeet Crypto Casino Airdrop Waitlist is live! Register at https://comingsoon.yeet.com/ to farm points');
    expect(casinoPost.isRelevantDrop).toBe(false);

    const polymarketPost = parseDropPost('Polymarket airdrop confirmed! Place bets on prediction markets https://polymarket.com/?r=ref');
    expect(polymarketPost.isRelevantDrop).toBe(false);

    const sportsbookPost = parseDropPost('New airdrop: wager $50 on decentralized sportsbook slots & roulette https://fastspin.xyz/airdrop');
    expect(sportsbookPost.isRelevantDrop).toBe(false);

    const rel = classifyDropRelevance({
      text: 'Complete quests and bet on sportsbook odds for airdrop rewards',
      urls: ['https://example.bet/quest'],
      projectDomain: 'example.bet',
      taskTypes: ['quest'],
    });
    expect(rel).toEqual({ isDrop: false, reason: 'gambling-or-betting' });

    // Clean staking / testnet drop must still pass
    const cleanPost = parseDropPost('Aztec testnet & staking airdrop live! Claim faucet at https://testnet.stake.aztec.network/faucet');
    expect(cleanPost.isRelevantDrop).toBe(true);
  });

  test('live Worker /airdrops.json and /feed.json strip stale pre-deploy gambling entries at read time', async () => {
    const { db } = createTestD1();
    const staleAirdrops: AirdropFeed = {
      cards: [
        makeCard({ r: 1, n: 'Polymarket', url: 'https://polymarket.com/', best: { n: 'Bet', ty: 'predictions', c: '$200', m: '10 min' }, taskTypes: ['predictions'] }),
        makeCard({ r: 2, n: 'Yeet', url: 'https://comingsoon.yeet.com/' }),
        makeCard({ r: 3, n: 'Variational', url: 'https://omni.variational.io/' }),
      ],
      tge: [
        { n: 'predict.fun', t: 'PREDICT', s: 'Claimable', d: 'TBA', url: 'https://predict.fun/' },
        { n: 'Ritual', t: 'RITUAL', s: 'Claimable', d: '2026-10-26', url: 'https://ritual.net/' },
      ],
      counts: { active: 3, preToken: 3 },
      fetchedAt: NOW,
    };
    await upsertSnapshot(db, 'airdrops', staleAirdrops, NOW);

    const res = await worker.fetch(new Request('https://radar.test/airdrops.json'), { DB: db }, EXEC_CTX);
    expect(res.status).toBe(200);
    const body = (await res.json()) as AirdropFeed;
    expect(body.cards.map(c => c.n)).toEqual(['Variational']);
    expect(body.cards[0].r).toBe(1);
    expect(body.tge.map(t => t.n)).toEqual(['Ritual']);
    expect(findGamblingAirdropViolations(body)).toEqual([]);

    // Legacy pre-deploy gambling cluster stored in D1 must be filtered out of queryFeed / /feed.json
    await db
      .prepare(`INSERT INTO sources (id, platform, handle, lang, trust, enabled) VALUES ('telegram:ch1', 'telegram', 'ch1', 'en', 0.8, 1)`)
      .run();
    await db
      .prepare(
        `INSERT INTO clusters (id, project, domain, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen, is_drop)
         VALUES
           ('c-gamble', 'Rollbit', 'rollbit.com', '[]', '["quest"]', 'Rollbit crypto casino wager airdrop', 'rule', 'ok', '[]', 95, 1, ?1, ?1, 1),
           ('c-clean', 'NovaChain', 'novachain.xyz', '["Base"]', '["testnet"]', 'NovaChain testnet live', 'rule', 'ok', '[]', 85, 1, ?1, ?1, 1)`,
      )
      .bind(NOW)
      .run();
    await db
      .prepare(
        `INSERT INTO posts (id, source_id, cluster_id, post_url, posted_at, text, urls, created_at)
         VALUES
           ('p1', 'telegram:ch1', 'c-gamble', 'https://t.me/ch1/1', ?1, 'Rollbit casino airdrop', '["https://rollbit.com/airdrop"]', ?1),
           ('p2', 'telegram:ch1', 'c-clean', 'https://t.me/ch1/2', ?1, 'NovaChain testnet', '["https://novachain.xyz/testnet"]', ?1)`,
      )
      .bind(NOW)
      .run();

    const feed = await queryFeed(db, new Set(['novachain.xyz']));
    expect(feed.items.map(i => i.project)).toEqual(['NovaChain']);

    const feedRes = await worker.fetch(new Request('https://radar.test/feed.json'), { DB: db }, EXEC_CTX);
    expect(feedRes.status).toBe(200);
    const feedBody = (await feedRes.json()) as FeedResponse;
    expect(feedBody.items.map(i => i.project)).toEqual(['NovaChain']);
  });

  test('check-no-gambling script passes on committed data/snapshot and flags dirty directories', async () => {
    expect(await checkNoGamblingInDir('data/snapshot')).toEqual([]);

    const dir = await mkdtemp(join(tmpdir(), 'gambling-check-'));
    try {
      await writeFile(
        join(dir, 'airdrops.json'),
        JSON.stringify({
          cards: [makeCard({ n: 'Yeet', url: 'https://comingsoon.yeet.com/' })],
          tge: [],
          counts: { active: 1, preToken: 1 },
          fetchedAt: NOW,
        }),
      );
      await writeFile(join(dir, 'feed.json'), JSON.stringify({ generatedAt: NOW, items: [] }));
      const violations = await checkNoGamblingInDir(dir);
      expect(violations.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
