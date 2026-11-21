import { describe, expect, test } from 'bun:test';
import type { AgentProfile, Card, FeedItem } from '../../shared/types';
import { buildBrief } from './agentBrief';

const HAN_RE = /\p{Script=Han}/u;

const profile: AgentProfile = {
  agent: 'hermes',
  agentNote: 'test-model',
  host: 'vps',
  os: 'linux',
  specs: '4 vCPU / 8 GB',
  browserMode: 'headed',
  residentialIp: true,
  wallet: 'burner-extension',
  walletNote: 'Rabby burner max $20',
  budgetUsd: 15,
  maxMinutes: 25,
  language: 'en',
};

describe('agentBrief generator', () => {
  test('returns null for RISK FeedItem', () => {
    const riskItem: FeedItem = {
      id: 'c1',
      project: 'FakeDrop',
      chains: ['Ethereum'],
      taskTypes: ['quest'],
      summary: 'Connect wallet to claim now',
      links: [{ url: 'https://xn--fake.io/claim', known: false }],
      sources: [{ platform: 'telegram', handle: 'ch1', postUrl: 'https://t.me/ch1/1', postedAt: Date.now() }],
      sourceCount: 1,
      score: 0.1,
      risk: { level: 'risk', reasons: ['Drainer phrasing'] },
      firstSeen: Date.now(),
      lastSeen: Date.now(),
    };
    expect(buildBrief(riskItem, profile)).toBeNull();
  });

  test('marks Turnstile and Sign message as HUMAN-REQUIRED and isolates unknown links', () => {
    const card: Card = {
      r: 1,
      n: 'MegaTestnet',
      chains: ['Monad'],
      t: 'MEGA',
      g: 'S',
      b: ['live'],
      f: '$25.00M',
      tk: '2/2',
      h: 900,
      u: 'today',
      fit: ['zero'],
      best: { n: 'Complete Turnstile faucet claim', ty: 'faucet', c: 'Free', m: '5 min' },
      tasks: [
        { title: 'Pass Cloudflare Turnstile faucet check', type: 'faucet', status: 'OPEN', cost: 0, timeMinutes: 5, url: 'https://faucet.megatestnet.xyz' },
        { title: 'Sign message to register eligibility', type: 'quest', status: 'OPEN', cost: 0, timeMinutes: 2, url: 'https://app.megatestnet.xyz' },
      ],
      sc: 92,
      sub: [9, 9, null],
      url: 'https://megatestnet.xyz',
    };

    const md = buildBrief(card, profile);
    expect(md).not.toBeNull();
    expect(md!).toContain('# Task: MegaTestnet');
    expect(md!).toContain('## Goal');
    expect(md!).toContain('## Official links (verified)');
    expect(md!).toContain('## Steps');
    expect(md!).toContain('1. ⛔ HUMAN-REQUIRED: Pass Cloudflare Turnstile faucet check');
    expect(md!).toContain('2. ⛔ HUMAN-REQUIRED: Sign message to register eligibility');
    expect(md!).toContain('## Constraints');
    expect(md!).toContain('Budget cap: $15; time cap: 25 min');
    expect(md!).toContain('## Environment');
    expect(md!).toContain('Agent: hermes / Host: vps / OS: linux');
    expect(md!).toContain('## Report back');
    expect(md!).toContain('## Sources');
    expect(HAN_RE.test(md!)).toBe(false);
  });

  test('renders WARN caution and places unknown links only under Unverified section', () => {
    const warnItem: FeedItem = {
      id: 'w1',
      project: `NewChain\u6d4b\u8bd5`,
      ticker: 'NEW',
      chains: ['Base'],
      taskTypes: ['testnet', 'social'],
      summary: 'Run testnet interactions and follow social',
      links: [
        { url: 'https://galxe.com/newchain', known: true },
        { url: 'https://sketchy-unverified.xyz/app', known: false },
      ],
      sources: [{ platform: 'telegram', handle: 'alpha_ch', postUrl: 'https://t.me/alpha_ch/9', postedAt: Date.now() }],
      sourceCount: 1,
      score: 0.45,
      risk: { level: 'warn', reasons: ['Domain not in verified registry: sketchy-unverified.xyz'] },
      firstSeen: Date.now(),
      lastSeen: Date.now(),
    };

    const md = buildBrief(warnItem, profile)!;
    expect(md).toContain('CAUTION: Marked WARN');
    expect(md).toContain('### Unverified, do NOT open');
    const [verifiedSection, unverifiedSection] = md.split('### Unverified, do NOT open');
    expect(verifiedSection).toContain('https://galxe.com/newchain');
    expect(verifiedSection).not.toContain('https://sketchy-unverified.xyz/app');
    expect(unverifiedSection).toContain('https://sketchy-unverified.xyz/app');
    expect(md).toContain('⛔ HUMAN-REQUIRED:');
    expect(HAN_RE.test(md)).toBe(false);
  });
});
