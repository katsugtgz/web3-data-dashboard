import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Card, FeedItem } from '../../shared/types';
import { CompactDropsTable } from './CompactDropRow';
import { CompactProjectsTable } from './CompactProjectRow';
import { DomainPill } from './DomainPill';
import { FeedStepsPreview } from './FeedStepsPreview';
import { KpiSparkline, MiniBars } from './KpiSparkline';
import { KpiStrip } from './KpiStrip';
import { MetaPills } from './MetaPills';
import { OgPreview } from './OgPreview';
import { RiskBadge } from './RiskBadge';
import { useViewMode, ViewToggle } from './ViewToggle';

const render = (node: React.ReactElement) => renderToStaticMarkup(node);
const noop = () => {};

const ITEM: FeedItem = {
  id: 'd1',
  project: 'Acme',
  ticker: 'ACME',
  domain: 'acme.xyz',
  chains: ['Base'],
  taskTypes: ['quest'],
  summary: 'Do the quest.',
  links: [
    { url: 'https://app.acme.xyz/quest', known: true },
    { url: 'https://t.me/acme/12', known: false },
  ],
  sources: [{ platform: 'telegram', handle: 'acme', postUrl: 'https://t.me/acme/12', postedAt: 500 }],
  sourceCount: 1,
  score: 0.8,
  risk: { level: 'ok', reasons: [] },
  firstSeen: 100,
  lastSeen: 900,
  radarId: 'surf-1',
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
  tvlUsd: 2_500_000,
  apy: '12.4%',
  deadline: '2099-12-31',
  rewardPool: '$1M',
  verifiedDomain: true,
};

/** Renders the view a component starts with, so the stored-preference read path is observable. */
function ViewProbe() {
  const [view] = useViewMode('drops');
  return <span data-view={view} />;
}

function withStorage(storage: unknown, run: () => void) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: { localStorage: storage }, configurable: true, writable: true });
  try {
    run();
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else delete (globalThis as { window?: unknown }).window;
  }
}

describe('ViewToggle', () => {
  test('marks exactly one of the two views as pressed', () => {
    const html = render(<ViewToggle view="compact" onChange={noop} label="drops" />);

    expect(html).toContain('aria-label="drops view"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('Cards');
    expect(html).toContain('Compact');
  });

  test('starts from the stored preference and falls back to cards for garbage or blocked storage', () => {
    const store = new Map<string, string>([
      ['drops', 'compact'],
      ['junk', 'list'],
    ]);
    const read = () => render(<ViewProbe />).match(/data-view="(\w+)"/)?.[1];

    withStorage({ getItem: (key: string) => store.get(key) ?? null }, () => {
      expect(read()).toBe('compact');
      store.set('drops', 'list');
      expect(read()).toBe('card');
    });
    withStorage(
      {
        getItem: () => {
          throw new Error('SecurityError');
        },
      },
      () => expect(read()).toBe('card'),
    );
    expect(read()).toBe('card');
  });
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('OgPreview', () => {
  const preview = { image: 'https://cdn.example.com/og.png', title: 'Acme quest', description: 'Earn points' };
  const strip = render(<OgPreview preview={preview} variant="strip" />);

  test('renders nothing without a preview and reserves a band when there is an image', () => {
    expect(render(<OgPreview preview={null} variant="strip" />)).toBe('');
    expect(strip).toContain('class="og-strip"');
    expect(strip).toContain('loading="lazy"');
    expect(strip).toContain('referrerPolicy');
    expect(strip).toContain('width="1200"');
  });

  test('bands need an image, while the card variant still shows text alone', () => {
    const textOnly = { image: null, title: 'Acme quest', description: 'Earn points' };

    expect(render(<OgPreview preview={textOnly} variant="strip" />)).toBe('');
    expect(render(<OgPreview preview={textOnly} variant="banner" />)).toBe('');
    const html = render(<OgPreview preview={textOnly} variant="card" />);
    expect(html).toContain('og-card is-text-only');
    expect(html).toContain('Acme quest');
    expect(html).toContain('Earn points');
    expect(render(<OgPreview preview={preview} variant="banner" />)).toContain('og-banner"');
  });
});

describe('DomainPill', () => {
  test('verified reads green, unverified stays muted, and unknown renders nothing', () => {
    const verified = render(<DomainPill verified={true} domain="acme.xyz" />);
    const unverified = render(<DomainPill verified={false} domain="acme.xyz" />);

    expect(verified).toContain('pill-verified');
    expect(verified).toContain('Verified');
    expect(unverified).toContain('pill-unverified');
    expect(unverified).toContain('not a security alert');
    // An unverified domain is a note, never styled as a security alert.
    expect(unverified).not.toContain('badge-warn');
    expect(unverified).not.toContain('badge-risk');
    expect(render(<DomainPill verified={undefined} />)).toBe('');
    expect(render(<DomainPill verified={null} />)).toBe('');
  });
});

describe('RiskBadge', () => {
  test('shows nothing for ok and separates warn from risk', () => {
    expect(render(<RiskBadge level="ok" notes={[]} />)).toBe('');
    expect(render(<RiskBadge level="warn" notes={[{ id: 'a', text: 'URL shortener used' }]} />)).toContain('badge-warn');
    const risk = render(<RiskBadge level="risk" notes={[{ id: 'a', text: 'Drainer phrasing' }]} />);
    expect(risk).toContain('badge-risk');
    expect(risk).toContain('Drainer phrasing');
  });
});

describe('MetaPills', () => {
  test('renders nothing without pills and turns an ISO deadline into a countdown', () => {
    expect(render(<MetaPills pills={[]} />)).toBe('');

    const html = render(
      <MetaPills
        pills={[
          { id: 'reward', label: 'Reward pool', value: '$50,000 USDC' },
          { id: 'deadline', label: 'Deadline', value: '2026-11-30' },
        ]}
        deadline={{ text: '2026-11-30', state: 'upcoming', countdown: 'in 3d' }}
      />,
    );
    expect(html).toContain('$50,000 USDC');
    expect(html).toContain('is-upcoming');
    expect(html).toContain('in 3d');
    expect(html).toContain('title="Deadline: 2026-11-30"');
  });
});

describe('FeedStepsPreview', () => {
  test('shows the first three steps and counts the rest', () => {
    const html = render(<FeedStepsPreview steps={['Connect wallet', 'Follow @acme', 'Do the quest', 'Bridge', 'Swap']} />);

    expect(html).toContain('Connect wallet');
    expect(html).not.toContain('Bridge');
    expect(html).toContain('+2 more in details');
    expect(render(<FeedStepsPreview steps={[]} />)).toBe('');
  });
});

describe('KPI micro-charts', () => {
  test('draws the sparkline as an inline SVG whose label carries the meaning', () => {
    const html = render(<KpiSparkline values={[1, 3, 2]} label="Activity" />);

    expect(html).toContain('<svg');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('kpi-spark-area');
    expect(html).toContain('kpi-spark-line');
    expect(html).toContain('>Activity<');
  });

  test('leaves zero segments out of a distribution bar', () => {
    const html = render(
      <MiniBars
        segments={[
          { id: 's', label: 'S', value: 0, tone: 's' },
          { id: 'a', label: 'A', value: 3, tone: 'a' },
        ]}
        label="Tiers"
      />,
    );
    expect(html).toContain('width:100%');
    expect(html).toContain('aria-label="Tiers"');
    expect(html).not.toContain('>S<');
    expect(
      render(
        <MiniBars
          segments={[{ id: 's', label: 'S', value: 0, tone: 's' }]}
          label="Tiers"
        />,
      ),
    ).toBe('');
  });

  test('KpiStrip exposes KPI status, activity, and distribution segment counts via aria-describedby', () => {
    const html = render(
      <KpiStrip
        counts={{ total: 10, pre: 4, sTier: 2, savedMatch: 1 }}
        mix={{
          updated: [Date.now()],
          tiers: [
            { id: 's', label: 'S', value: 2, tone: 's' },
            { id: 'a', label: 'A', value: 8, tone: 'a' },
            { id: 'b', label: 'B', value: 0, tone: 'b' },
          ],
          sources: [
            { id: 'galxe', label: 'Galxe', value: 6, tone: 'src-1' },
            { id: 'merkl', label: 'Merkl', value: 4, tone: 'src-2' },
          ],
        }}
        tgeCount={3}
        isLive={false}
        failed={true}
        status="all"
        grade="All"
        onSelectAll={noop}
        onTogglePre={noop}
        onToggleSTier={noop}
        onJumpTge={noop}
        onToggleSaved={noop}
      />,
    );

    expect(html).toContain('aria-label="Projects by tier: S 2, A 8"');
    expect(html).toContain('aria-label="Projects by source: Galxe 6, Merkl 4"');
    expect(html).toContain('Last available data');

    // Every aria-describedby token on the buttons must match an existing id in the rendered markup.
    const describedByMatches = [...html.matchAll(/aria-describedby="([^"]+)"/g)];
    expect(describedByMatches).toHaveLength(2);
    for (const [, refs] of describedByMatches) {
      for (const id of refs.split(/\s+/)) {
        expect(html).toContain(`id="${id}"`);
      }
    }

    // When distributions are empty, aria-describedby omits the unrendered MiniBars ids.
    const emptyHtml = render(
      <KpiStrip
        counts={{ total: 0, pre: 0, sTier: 0, savedMatch: 0 }}
        mix={{ updated: [], tiers: [], sources: [] }}
        tgeCount={0}
        isLive={true}
        failed={false}
        status="all"
        grade="All"
        onSelectAll={noop}
        onTogglePre={noop}
        onToggleSTier={noop}
        onJumpTge={noop}
        onToggleSaved={noop}
      />,
    );
    for (const [, refs] of emptyHtml.matchAll(/aria-describedby="([^"]+)"/g)) {
      for (const id of refs.split(/\s+/)) {
        expect(emptyHtml).toContain(`id="${id}"`);
      }
    }
  });
});

describe('Compact tables', () => {
  test('drops table renders one row per drop with details and radar actions', () => {
    const html = render(
      <CompactDropsTable
        items={[ITEM]}
        radarIndex={new Map([[CARD.id as string, CARD]])}
        onDetails={noop}
        onCopyBrief={noop}
        onOpenRadar={noop}
      />,
    );

    expect(html.match(/<tr/g)).toHaveLength(2);
    expect(html).toContain('Details for Acme');
    expect(html).toContain('Open Acme on Curated Radar');
    expect(html).toContain('scope="row"');
    expect(html).toContain('ACME · acme.xyz');
    expect(html).toContain('Copy agent brief for Acme');
  });

  test('projects table renders one row per card with the new facts and save state', () => {
    const html = render(
      <CompactProjectsTable
        cards={[CARD]}
        saved={new Set()}
        doneTasks={new Set()}
        onToggleSaved={noop}
        onDetails={noop}
        onCopyBrief={noop}
      />,
    );

    expect(html.match(/<tr/g)).toHaveLength(2);
    expect(html).toContain('$2.50M');
    expect(html).toContain('12.4%');
    expect(html).toContain('2099-12-31');
    expect(html).toContain('$1M');
    expect(html).toContain('Save Acme to watchlist');
    expect(html).toContain('aria-pressed="false"');
  });
});
