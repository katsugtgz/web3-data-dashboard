import { describe, expect, test } from 'bun:test';
import type { AirdropFeed, Card, FeedItem, Tge } from './types';
import {
  filterGamblingAirdropFeed,
  filterGamblingFeedItems,
  findGamblingAirdropViolations,
  findGamblingFeedViolations,
  isGamblingCard,
  isGamblingCategory,
  isGamblingDomain,
  isGamblingFeedItem,
  isGamblingPost,
  isGamblingProjectName,
  isGamblingTask,
  isGamblingTaskUrl,
  isGamblingText,
  isGamblingTge,
} from './gamblingFilter';

function makeCard(overrides: Partial<Card> & { n: string }): Card {
  return {
    r: 1,
    t: null,
    g: 'A',
    b: ['live'],
    x: null,
    img: '',
    f: '$10.00M',
    raiseNum: 10_000_000,
    tk: '1/1',
    h: 500,
    u: 'today',
    fit: ['zero'],
    best: { n: 'Testnet', ty: 'testnet', c: 'Free', m: '5 min' },
    costNum: 0,
    taskTypes: ['testnet'],
    tasks: [{ title: 'Testnet', type: 'testnet', status: 'OPEN', cost: 0, timeMinutes: 5, url: 'https://proto.xyz/testnet' }],
    sc: 75,
    sub: [8, 8, null],
    url: 'https://proto.xyz/',
    ...overrides,
  };
}

function makeFeedItem(overrides: Partial<FeedItem> & { id: string; project: string }): FeedItem {
  return {
    chains: ['Base'],
    taskTypes: ['testnet'],
    summary: 'Complete testnet tasks to qualify for the airdrop.',
    links: [{ url: 'https://proto.xyz/testnet', known: true }],
    sources: [{ platform: 'telegram', handle: 'alpha', postUrl: 'https://t.me/alpha/1', postedAt: 1_700_000_000_000 }],
    sourceCount: 1,
    score: 80,
    risk: { level: 'ok', reasons: [] },
    firstSeen: 1_700_000_000_000,
    lastSeen: 1_700_000_000_000,
    ...overrides,
  };
}

describe('gambling / betting / casino hard filter', () => {
  test('isGamblingDomain catches casinos, sportsbooks, prediction markets, gambling TLDs & subdomains without false positives', () => {
    for (const bad of [
      'https://comingsoon.yeet.com/',
      'https://polymarket.com/?r=cryptorank',
      'https://kalshi.com/march-matchups',
      'https://stake.com/casino',
      'https://stake.us/',
      'https://rollbit.com/',
      'https://shuffle.com/',
      'https://bc.game/airdrop',
      'https://roobet.com/',
      'https://betfury.io/',
      'https://sx.bet/',
      'https://app.azuro.org/',
      'https://beta.melee.markets/',
      'https://ticket.42.space/',
      'https://beta.xo.market/?r=1',
      'https://beta.myriad.markets/',
      'https://testnet.outcome.market/events',
      'https://predictions.blinq.fi/?ref=x',
      'https://predict.fun/',
      'https://upshot.cards/',
      'https://beta.touch.market/',
      'https://world.xyz/?ref=x',
      'https://app.kairos.trade/',
      'https://catalyst.markets/',
      'https://forecastprotocol.xyz/',
      'https://www.hit.one/',
      'https://www.tf.xyz/join',
      'https://cool.bet/airdrop',
      'https://moon.casino/bonus',
      'https://degen.poker/',
      'https://casino.example.org/',
      'https://bet.drift.trade/',
      'https://sportsbook.example.xyz/',
      'https://predictions.example.com/',
    ]) {
      expect(isGamblingDomain(bad)).toBe(true);
    }

    // Legitimate Web3 domains (staking subdomains, beta subdomains, normal DeFi/L2) must NEVER match.
    for (const good of [
      'https://testnet.stake.aztec.network/',
      'https://stake.bracket.fi/',
      'https://app.drosera.io/stake',
      'https://beta.panoptic.xyz/',
      'https://beta.loafmarkets.com/',
      'https://www.base.org/names',
      'https://jup.ag/lend/earn',
      'https://omni.variational.io/',
      'https://app.aave.com/',
      'https://www.montecarlo.trade/',
      'https://app.rabbithole.gg/raffle',
      'https://wheel.dogeos.com/',
      'https://play.immutable.com/',
      'https://alphabot.app/',
      'https://arbitrum.io/',
    ]) {
      expect(isGamblingDomain(good)).toBe(false);
    }
  });

  test('isGamblingTaskUrl flags prediction/betting/casino subpaths on otherwise clean hosts', () => {
    expect(isGamblingTaskUrl('https://www.coinbase.com/predictions')).toBe(true);
    expect(isGamblingTaskUrl('https://jup.ag/prediction')).toBe(true);
    expect(isGamblingTaskUrl('https://jup.ag/prediction/world-cup')).toBe(true);
    expect(isGamblingTaskUrl('https://app.justbeep.it/prediction-market')).toBe(true);
    expect(isGamblingTaskUrl('https://example.com/casino/lobby')).toBe(true);
    expect(isGamblingTaskUrl('https://example.com/sportsbook')).toBe(true);
    expect(isGamblingTaskUrl('https://example.com/parlays')).toBe(true);
    expect(isGamblingTaskUrl('https://jup.ag/lend/earn')).toBe(false);
    expect(isGamblingTaskUrl('https://www.base.org/names')).toBe(false);
    expect(isGamblingTaskUrl('https://app.rabbithole.gg/raffle')).toBe(false);
  });

  test('isGamblingCategory catches English and CJK gambling/betting/casino/prediction categories', () => {
    for (const bad of [
      'Gambling',
      'Prediction Market',
      'Prediction Markets',
      'Casino',
      'Betting',
      'Lottery',
      'GambleFi',
      'Sportsbook',
      '\u535a\u5f69',
      '\u8d4c\u535a',
      '\u5f69\u7968',
      '\u9884\u6d4b\u5e02\u573a',
      '\u9884\u6d4b',
    ]) {
      expect(isGamblingCategory(bad)).toBe(true);
    }
    for (const good of ['DeFi', 'Dexes', 'Derivatives', 'Lending', 'Liquid Staking', 'Gaming', 'Layer2', 'Bridge', '\u4ea4\u6613\u7c7b']) {
      expect(isGamblingCategory(good)).toBe(false);
    }
  });

  test('isGamblingText and isGamblingProjectName catch casino/betting/prediction copy without false positives on staking/beta/games', () => {
    expect(isGamblingText('Crypto casino airdrop: wager $100 on slots and roulette to earn tokens')).toBe(true);
    expect(isGamblingText('Decentralized sportsbook and betting protocol on Arbitrum')).toBe(true);
    expect(isGamblingText('Trade binary prediction markets and sports parlays for points')).toBe(true);
    expect(isGamblingText('Online poker & blackjack provably fair casino rewards')).toBe(true);
    expect(isGamblingText('World Cup Predict Arena')).toBe(true);
    expect(isGamblingText('\u535a\u5f69\u7a7a\u6295\u4e0b\u6ce8\u8d62\u5956\u52b1')).toBe(true);

    expect(isGamblingText('Stake ETH on Aztec testnet to earn validator rewards')).toBe(false);
    expect(isGamblingText('Public beta trading competition on perp DEX')).toBe(false);
    expect(isGamblingText('Play Pudgy World Telegram game and mint free SBT')).toBe(false);
    expect(isGamblingText('Early Access Raffle on RabbitHole')).toBe(false);
    expect(isGamblingText('Wheel of Doge daily testnet quest')).toBe(false);

    expect(isGamblingProjectName('Polymarket')).toBe(true);
    expect(isGamblingProjectName('Kalshi')).toBe(true);
    expect(isGamblingProjectName('Yeet')).toBe(true);
    expect(isGamblingProjectName('Rollbit')).toBe(true);
    expect(isGamblingProjectName('BetFury')).toBe(true);
    expect(isGamblingProjectName('SolBet')).toBe(true);
    expect(isGamblingProjectName('MegaCasino')).toBe(true);
    expect(isGamblingProjectName('predict.fun')).toBe(true);
    expect(isGamblingProjectName('XO Market')).toBe(true);

    expect(isGamblingProjectName('Arbitrum')).toBe(false);
    expect(isGamblingProjectName('Aztec')).toBe(false);
    expect(isGamblingProjectName('Base')).toBe(false);
    expect(isGamblingProjectName('Jupiter')).toBe(false);
    expect(isGamblingProjectName('BetterSwap')).toBe(false);
    expect(isGamblingProjectName('BetaFinance')).toBe(false);
    expect(isGamblingProjectName('Bracket Labs')).toBe(false);
    expect(isGamblingProjectName('Monaco')).toBe(false);
  });

  test('filterGamblingAirdropFeed drops casino/betting/prediction cards & TGEs, strips prediction tasks from multi-product protocols, and re-ranks cleanly', () => {
    const feed: AirdropFeed = {
      cards: [
        makeCard({ r: 1, n: 'Variational', url: 'https://omni.variational.io/' }),
        makeCard({
          r: 2,
          n: 'Polymarket',
          url: 'https://polymarket.com/?r=cryptorank',
          best: { n: 'Interaction', ty: 'predictions', c: '$200', m: '10 min' },
          taskTypes: ['predictions'],
          tasks: [{ title: 'Interaction', type: 'predictions', status: 'OPEN', cost: 200, timeMinutes: 10, url: 'https://polymarket.com/' }],
        }),
        makeCard({
          r: 3,
          n: 'Yeet',
          url: 'https://comingsoon.yeet.com/',
          best: { n: 'Waitlist Form', ty: 'form', c: 'Free', m: '1 min' },
          taskTypes: ['form'],
          tasks: [{ title: 'Waitlist Form', type: 'form', status: 'OPEN', cost: 0, timeMinutes: 1, url: 'https://comingsoon.yeet.com/' }],
        }),
        makeCard({
          r: 4,
          n: 'UnknownCasinoProto',
          url: 'https://unknownproto.xyz/',
          description: 'On-chain crypto casino with slots, roulette, and sportsbook wagering',
          best: { n: 'Wager to earn', ty: 'trading', c: '$20', m: '10 min' },
          taskTypes: ['trading'],
          tasks: [{ title: 'Wager to earn', type: 'trading', status: 'OPEN', cost: 20, timeMinutes: 10, url: 'https://unknownproto.xyz/' }],
        }),
        makeCard({
          r: 5,
          n: 'Base',
          b: ['live'],
          url: 'https://www.base.org/names',
          tk: '2/2',
          best: { n: 'Basenames', ty: 'mainnet', c: 'Free', m: '3 min' },
          taskTypes: ['mainnet', 'predictions'],
          tasks: [
            { title: 'Basenames', type: 'mainnet', status: 'OPEN', cost: 0, timeMinutes: 3, url: 'https://www.base.org/names' },
            { title: 'Coinbase Predict', type: 'predictions', status: 'OPEN', cost: 0, timeMinutes: 5, url: 'https://www.coinbase.com/predictions' },
          ],
        }),
        makeCard({
          r: 6,
          n: 'Jupiter',
          b: ['live', 'token'],
          url: 'https://gum.jup.net/waitlist',
          tk: '2/3',
          best: { n: 'Waitlist', ty: 'form', c: 'Free', m: '1 min' },
          taskTypes: ['form', 'mainnet', 'predictions'],
          tasks: [
            { title: 'Waitlist', type: 'form', status: 'OPEN', cost: 0, timeMinutes: 1, url: 'https://gum.jup.net/waitlist' },
            { title: 'Prediction Market', type: 'mainnet', status: 'OPEN', cost: 10, timeMinutes: 5, url: 'https://jup.ag/prediction' },
            { title: 'World Cup Challenge', type: 'predictions', status: 'CLOSED', cost: 0, timeMinutes: 5, url: 'https://jup.ag/prediction/world-cup' },
          ],
        }),
      ],
      tge: [
        { n: 'GenLayer', t: 'GEN', s: 'Eligibility check', d: 'TBA', url: 'https://genlayer.com' } as Tge,
        { n: 'predict.fun', t: 'PREDICT', s: 'Claimable', d: '2026-11-18', url: 'https://docs.google.com/forms/d/e/abc' } as Tge,
        { n: 'Rollbit', t: 'RLB', s: 'Claimable', d: 'TBA', url: 'https://rollbit.com/claim' } as Tge,
      ],
      counts: { active: 6, preToken: 5 },
      fetchedAt: 1_700_000_000_000,
    };

    const clean = filterGamblingAirdropFeed(feed);
    expect(clean.cards.map(c => c.n)).toEqual(['Variational', 'Base', 'Jupiter']);
    expect(clean.cards.map(c => c.r)).toEqual([1, 2, 3]);
    expect(clean.counts).toEqual({ active: 3, preToken: 2 });
    expect(clean.tge.map(t => t.n)).toEqual(['GenLayer']);

    const base = clean.cards.find(c => c.n === 'Base')!;
    expect(base.taskTypes).toEqual(['mainnet']);
    expect(base.tasks?.map(t => t.title)).toEqual(['Basenames']);
    expect(base.tk).toBe('1/1');

    const jup = clean.cards.find(c => c.n === 'Jupiter')!;
    expect(jup.taskTypes).toEqual(['form']);
    expect(jup.tasks?.map(t => t.title)).toEqual(['Waitlist']);
    expect(jup.tk).toBe('1/1');

    expect(findGamblingAirdropViolations(clean)).toEqual([]);
    expect(findGamblingAirdropViolations(feed).length).toBeGreaterThanOrEqual(5);
  });

  test('isGamblingCard, isGamblingTask, isGamblingTge, isGamblingPost, and filterGamblingFeedItems work consistently', () => {
    expect(isGamblingTask({ title: 'World Cup', type: 'predictions', url: 'https://example.com' })).toBe(true);
    expect(isGamblingTask({ title: 'Swap ETH', type: 'mainnet', url: 'https://example.com/swap' })).toBe(false);
    expect(isGamblingTge({ n: 'predict.fun', t: 'PREDICT', s: 'Claimable', url: null })).toBe(true);
    expect(isGamblingTge({ n: 'Ritual', t: 'RITUAL', s: 'Claimable', url: 'https://ritual.net' })).toBe(false);

    const polymarketCard = makeCard({ n: 'Polymarket', url: 'https://polymarket.com' });
    expect(isGamblingCard(polymarketCard)).toBe(true);

    expect(
      isGamblingPost({
        project: 'Rollbit',
        domain: 'rollbit.com',
        text: 'Rollbit airdrop live! Wager on casino slots.',
        urls: ['https://rollbit.com/airdrop'],
      }),
    ).toBe(true);

    expect(
      isGamblingPost({
        project: 'NovaChain',
        domain: 'novachain.xyz',
        text: 'NovaChain testnet & faucet airdrop live on Monad https://novachain.xyz/testnet',
        urls: ['https://novachain.xyz/testnet'],
      }),
    ).toBe(false);

    const items = [
      makeFeedItem({ id: '1', project: 'NovaChain', domain: 'novachain.xyz' }),
      makeFeedItem({
        id: '2',
        project: 'Yeet',
        domain: 'yeet.com',
        summary: 'Yeet waitlist live for crypto casino rewards',
        links: [{ url: 'https://comingsoon.yeet.com/', known: false }],
      }),
      makeFeedItem({
        id: '3',
        project: 'UnknownBet',
        domain: 'unknownbet.xyz',
        summary: 'Place sports bets and casino spins to farm points',
        links: [{ url: 'https://unknownbet.xyz/', known: false }],
      }),
    ];

    expect(isGamblingFeedItem(items[0])).toBe(false);
    expect(isGamblingFeedItem(items[1])).toBe(true);
    expect(isGamblingFeedItem(items[2])).toBe(true);

    const filtered = filterGamblingFeedItems(items);
    expect(filtered.map(i => i.id)).toEqual(['1']);
    expect(findGamblingFeedViolations({ items: filtered })).toEqual([]);
    expect(findGamblingFeedViolations({ items }).length).toBe(2);
  });
});
