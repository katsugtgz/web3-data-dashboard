import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { FIT } from '../../shared/constants';
import type { AgentProfile, Card, FeedItem } from '../../shared/types';
import { DetailDialog } from './DetailDialog';
import { DropsDetailDialog } from './DropsDetailDialog';
import { FeedCard } from './FeedCard';
import { ProjectCard } from './ProjectCard';

const render = (node: React.ReactElement) => renderToStaticMarkup(node);
const noop = () => {};

const PROFILE: AgentProfile = {
  agent: 'hermes',
  host: 'vps',
  os: 'linux',
  browserMode: 'headed',
  residentialIp: true,
  wallet: 'burner-extension',
  budgetUsd: 15,
  maxMinutes: 25,
  language: 'en',
};

const CARD: Card = {
  r: 3,
  id: 'surf-1',
  n: 'Acme',
  chain: 'Base',
  t: 'ACME',
  g: 'S',
  b: ['live'],
  f: '$1.20M',
  tk: '2',
  h: 100,
  u: 'today',
  fit: ['zero'],
  best: { n: 'Do the quest', ty: 'quest', c: 'Free', m: '5 min' },
  sc: 90,
  sub: [9, 9, 1],
  url: 'https://acme.xyz',
  ogImage: 'https://cdn.example.com/og.png',
  description: 'A concise description.',
  tvlUsd: 2_500_000,
  apy: '12.4%',
  deadline: '2099-12-31',
  rewardPool: '$1M',
  verifiedDomain: true,
};

const PLAIN_ITEM: FeedItem = {
  id: 'd1',
  project: 'Acme',
  ticker: 'ACME',
  domain: 'acme.xyz',
  chains: ['Base'],
  taskTypes: ['quest'],
  summary: 'Connect wallet · Follow @acme · Swap tokens',
  links: [{ url: 'https://app.acme.xyz/quest', known: true }],
  sources: [{ platform: 'telegram', handle: 'acme_tg', postUrl: 'https://t.me/acme_tg/12', postedAt: 300 }],
  sourceCount: 1,
  score: 0.8,
  risk: { level: 'ok', reasons: [] },
  firstSeen: 100,
  lastSeen: 900,
  radarId: 'surf-1',
};

const RICH_ITEM: FeedItem = {
  ...PLAIN_ITEM,
  verifiedDomain: false,
  rewardPool: '$50,000 USDC',
  deadline: '2099-12-31',
  cost: 'Free',
  tvlUsd: 12_400_000,
  funding: '$1.20M',
  steps: ['Connect wallet', 'Follow @acme', 'Swap tokens', 'Bridge funds'],
  ogImage: 'https://cdn.example.com/og.png',
  ogTitle: 'Acme quest is live',
  ogDescription: 'Complete tasks to earn.',
  risk: { level: 'warn', reasons: ['URL shortener used: t.co'] },
  links: [
    { url: 'https://app.acme.xyz/quest', known: true },
    { url: 'https://blog.example.net/acme-guide', known: false },
  ],
  sources: [
    { platform: 'telegram', handle: 'acme_tg', postUrl: 'https://t.me/acme_tg/12', postedAt: 300 },
    { platform: 'x', handle: 'acme_x', postUrl: 'https://x.com/acme_x/status/7', postedAt: 500 },
  ],
  sourceCount: 2,
};

const RADAR_INDEX = new Map<string, Card>([[CARD.id as string, CARD]]);

function renderDropDialog(item: FeedItem | null) {
  return render(
    <DropsDetailDialog
      item={item}
      radarIndex={RADAR_INDEX}
      profile={PROFILE}
      copyStatus={null}
      onCopyBrief={noop}
      onOpenRadar={noop}
      onClose={noop}
    />,
  );
}

describe('DropsDetailDialog', () => {
  test('is a labelled modal dialog shell that stays empty when nothing is selected', () => {
    const html = renderDropDialog(null);

    expect(html).toContain('<dialog id="drops-detail"');
    expect(html).toContain('aria-labelledby="drops-detail-title"');
    expect(html).toContain('closedby="any"');
    expect(html).toContain('</dialog>');
    expect(html).not.toContain('dlg-inner');
  });

  test('shows identity, trust badges, the OG card, and the offer grid', () => {
    const html = renderDropDialog(RICH_ITEM);

    expect(html).toContain('id="drops-detail-title"');
    expect(html).toContain('pill-unverified');
    expect(html).toContain('badge-warn');
    expect(html).toContain('og-card');
    expect(html).toContain('Acme quest is live');
    expect(html).toContain('Complete tasks to earn.');
    expect(html).toContain('Offer details');
    expect(html).toContain('$50,000 USDC');
    expect(html).toContain('$12.40M');
    expect(html).toContain('$1.20M');
    expect(html).toContain('2099-12-31');
    expect(html).toContain('Chains');
    expect(html).toContain('Task types');
  });

  test('lists every numbered step and escapes hostile step text', () => {
    const html = renderDropDialog({ ...RICH_ITEM, steps: ['<script>alert(1)</script>', 'Bridge funds'] });

    expect(html).toContain('drop-step-list');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html.match(/drop-step-num/g)).toHaveLength(2);
  });

  test('gives every link a verification badge and a safe external anchor', () => {
    const html = renderDropDialog(RICH_ITEM);

    expect(html).toContain('Link verification');
    expect(html).toContain('1 of 2 verified');
    expect(html.match(/link-matrix-state"/g)).toHaveLength(1);
    expect(html.match(/link-matrix-state is-known/g)).toHaveLength(1);
    expect(html).toContain('blog.example.net');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('unverified link');
  });

  test('orders the source timeline newest first with timestamps', () => {
    const html = renderDropDialog(RICH_ITEM);

    expect(html).toContain('Source timeline');
    expect(html.indexOf('acme_x')).toBeLessThan(html.indexOf('acme_tg'));
    expect(html).toContain('<time dateTime="1970-01-01T00:00:00.500Z"');
    expect(html).toContain('UTC');
  });

  test('shows safety notes, the radar cross-link, and the brief actions', () => {
    const html = renderDropDialog(RICH_ITEM);

    expect(html).toContain('Safety notes');
    expect(html).toContain('URL shortener used: t.co');
    expect(html).toContain('View on Curated Radar');
    expect(html).toContain('Rank #3 · Tier S');
    expect(html).toContain('Copy agent brief');
    expect(html).toContain('Download .md');
  });

  test('replaces the brief actions with the guardrail notice for a RISK drop and hides unmatched radar links', () => {
    const html = renderDropDialog({ ...RICH_ITEM, risk: { level: 'risk', reasons: ['Drainer phrasing'] }, radarId: 'nope' });

    expect(html).toContain('Brief unavailable for RISK items.');
    expect(html).not.toContain('Copy agent brief');
    expect(html).toContain('High risk signals');
    expect(html).not.toContain('View on Curated Radar');
  });
});

describe('FeedCard', () => {
  const renderCard = (item: FeedItem, radarCard: Card | null = null) =>
    render(<FeedCard item={item} radarCard={radarCard} onDetails={noop} onCopyBrief={noop} onOpenRadar={noop} />);

  test('adds offer pills, a steps preview, trust badges, the OG band, and a Details action for a rich drop', () => {
    const html = renderCard(RICH_ITEM, CARD);

    expect(html).toContain('feed-title-btn');
    expect(html).toContain('class="og-strip"');
    expect(html).toContain('Reward pool');
    expect(html).toContain('$50,000 USDC');
    expect(html).toContain('feed-radar-pill');
    expect(html).toContain('pill-unverified');
    expect(html).toContain('badge-warn');
    expect(html).toContain('feed-steps');
    expect(html).toContain('Connect wallet');
    expect(html).not.toContain('Bridge funds');
    expect(html).toContain('+1 more in details');
    // Structured steps replace the bullets picked out of the summary text.
    expect(html).not.toContain('feed-bullets');
    expect(html).toContain('aria-label="Details for Acme"');
  });

  test('keeps the plain layout for a drop without the new fields', () => {
    const html = renderCard(PLAIN_ITEM);

    expect(html).not.toContain('feed-meta');
    expect(html).not.toContain('og-strip');
    expect(html).not.toContain('feed-steps');
    expect(html).not.toContain('feed-radar-pill');
    expect(html).toContain('feed-bullets');
  });

  test('never renders untrusted project text as markup', () => {
    const html = renderCard({ ...PLAIN_ITEM, project: '<img src=x onerror=alert(1)>' });

    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('Curated card surface', () => {
  test('DetailDialog shows the new facts, the description, and the OG banner', () => {
    const html = render(
      <DetailDialog
        card={CARD}
        fit={FIT}
        profile={PROFILE}
        saved={false}
        doneTasks={new Set()}
        onToggleSaved={noop}
        onToggleTask={noop}
        onCopyBrief={noop}
        onClose={noop}
        copyStatus={null}
      />,
    );

    expect(html).toContain('<dialog id="detail"');
    expect(html).toContain('closedby="any"');
    expect(html).toContain('og-banner');
    expect(html).toContain('dlg-description');
    expect(html).toContain('A concise description.');
    expect(html).toContain('>TVL<');
    expect(html).toContain('$2.50M');
    expect(html).toContain('>APY<');
    expect(html).toContain('12.4%');
    expect(html).toContain('>Reward pool<');
    expect(html).toContain('$1M');
    expect(html).toContain('pill-verified');
  });

  test('DetailDialog adds no empty rich rows for a plain card', () => {
    const {
      ogImage: _og,
      description: _desc,
      tvlUsd: _tvl,
      apy: _apy,
      deadline: _dl,
      rewardPool: _rp,
      verifiedDomain: _vd,
      ...plain
    } = CARD;
    const html = render(
      <DetailDialog
        card={plain}
        fit={FIT}
        profile={PROFILE}
        saved={false}
        doneTasks={new Set()}
        onToggleSaved={noop}
        onToggleTask={noop}
        onCopyBrief={noop}
        onClose={noop}
        copyStatus={null}
      />,
    );

    expect(html).not.toContain('og-banner');
    expect(html).not.toContain('dlg-description');
    expect(html).not.toContain('>TVL<');
    expect(html).not.toContain('pill-verified');
  });

  test('ProjectCard shows the new facts as pills with a short description', () => {
    const html = render(
      <ProjectCard
        card={CARD}
        fit={FIT}
        saved={false}
        doneTasks={new Set()}
        onToggleSaved={noop}
        onDetails={noop}
        onCopyBrief={noop}
      />,
    );

    expect(html).toContain('feed-meta');
    expect(html).toContain('Reward pool');
    expect(html).toContain('$2.50M');
    expect(html).toContain('12.4%');
    expect(html).toContain('pill-verified');
    expect(html).toContain('project-description');
    expect(html).toContain('A concise description.');
  });
});
