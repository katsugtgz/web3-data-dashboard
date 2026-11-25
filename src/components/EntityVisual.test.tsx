import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { advanceAvatarImageIndex } from '../lib/visualAssets';
import {
  ChainBadge,
  CryptoTickerPill,
  EntityAvatar,
  PlatformBadge,
} from './EntityVisual';
import {
  CheckIcon,
  ChevronUpIcon,
  ClockIcon,
  CompassIcon,
  DatabaseIcon,
  DollarSignIcon,
  FlameIcon,
  GithubIcon,
  GlobeIcon,
  InfoIcon,
  LinkIcon,
  RssIcon,
  SheetIcon,
  TagIcon,
  TelegramIcon,
  XBrandIcon,
} from './Icons';

describe('Icons additions', () => {
  test('renders all newly required Lucide-style icons with explicit size and aria-hidden', () => {
    const icons = [
      TelegramIcon,
      XBrandIcon,
      GithubIcon,
      GlobeIcon,
      RssIcon,
      SheetIcon,
      FlameIcon,
      ClockIcon,
      DollarSignIcon,
      CheckIcon,
      InfoIcon,
      ChevronUpIcon,
      LinkIcon,
      TagIcon,
      DatabaseIcon,
      CompassIcon,
    ];
    for (const Icon of icons) {
      const html = renderToStaticMarkup(<Icon size={18} className="test-icon" />);
      expect(html).toContain('<svg');
      expect(html).toContain('width="18"');
      expect(html).toContain('height="18"');
      expect(html).toContain('aria-hidden="true"');
      expect(html).toContain('icon test-icon');
    }
  });
});

describe('EntityAvatar', () => {
  test('renders crisp inline crypto SVG and zero <img> when no remote image URL exists', () => {
    const html = renderToStaticMarkup(<EntityAvatar name="Bitcoin (BTC)" ticker="BTC" size={32} />);
    expect(html).toContain('<svg');
    expect(html).not.toContain('<img');
    expect(html).toContain('width:32px');
    expect(html).toContain('height:32px');
  });

  test('renders deterministic branded geometric SVG emblem for unknown project without <img>', () => {
    const html = renderToStaticMarkup(<EntityAvatar name="Quantum Foundry" size={38} shape="rounded" />);
    expect(html).toContain('<svg');
    expect(html).toContain('QF');
    expect(html).not.toContain('<img');
  });

  test('renders safe lazy no-referrer <img> over inline SVG fallback when upstream URL exists', () => {
    const html = renderToStaticMarkup(
      <EntityAvatar
        name="Lido"
        src="https://images.asksurf.ai/lido.png"
        size={40}
        shape="circle"
      />,
    );
    expect(html).toContain('<svg');
    expect(html).toContain('<img');
    expect(html).toContain('src="https://images.asksurf.ai/lido.png"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
    expect(html.toLowerCase()).toContain('referrerpolicy="no-referrer"');
    expect(html).toContain('width="40"');
    expect(html).toContain('height="40"');
    expect(html).toContain('border-radius:50%');
  });

  test('accepts img, logo, and icon prop aliases seamlessly for Card, FeedItem, and MarketRow callers', () => {
    const imgHtml = renderToStaticMarkup(
      <EntityAvatar name="Merkl" img="https://images.asksurf.ai/merkl.png" size={32} />,
    );
    expect(imgHtml).toContain('src="https://images.asksurf.ai/merkl.png"');

    const logoHtml = renderToStaticMarkup(
      <EntityAvatar name="OpenSea" logo="https://images.asksurf.ai/opensea.png" size={32} />,
    );
    expect(logoHtml).toContain('src="https://images.asksurf.ai/opensea.png"');

    const iconHtml = renderToStaticMarkup(
      <EntityAvatar name="Aave V3" icon="https://icons.llamao.fi/icons/protocols/aave-v3?w=48&h=48" size={24} />,
    );
    expect(iconHtml).toContain('src="https://icons.llamao.fi/icons/protocols/aave-v3?w=48&amp;h=48"');
  });

  test('ignores unsafe non-https image URLs and falls back cleanly to inline SVG', () => {
    const html = renderToStaticMarkup(
      <EntityAvatar name="Testnet Alpha" src="http://insecure.example/logo.png" size={32} />,
    );
    expect(html).toContain('<svg');
    expect(html).not.toContain('<img');
  });

  test('advances fallback image index sequentially and exhausts cleanly', () => {
    const urls = ['https://a.example/1.png', 'https://b.example/2.png'];
    expect(advanceAvatarImageIndex(0, urls.length)).toBe(1);
    expect(advanceAvatarImageIndex(1, urls.length)).toBe(2);
    expect(advanceAvatarImageIndex(2, urls.length)).toBe(2);
    expect(advanceAvatarImageIndex(0, 0)).toBe(0);
  });
});

describe('ChainBadge', () => {
  test('renders inline chain SVG glyph and full label by default', () => {
    const html = renderToStaticMarkup(<ChainBadge chain="Arbitrum" />);
    expect(html).toContain('<svg');
    expect(html).toContain('Arbitrum');
    expect(html).toContain('title="Arbitrum"');
  });

  test('renders compact short label while preserving full accessible title and aria-label', () => {
    const html = renderToStaticMarkup(<ChainBadge chain="Ethereum" compact />);
    expect(html).toContain('<svg');
    expect(html).toContain('ETH');
    expect(html).toContain('aria-label="Ethereum"');
    expect(html).toContain('title="Ethereum"');
  });

  test('renders graceful fallback badge for unrecognized chain names', () => {
    const html = renderToStaticMarkup(<ChainBadge chain="CustomNet" />);
    expect(html).toContain('<svg');
    expect(html).toContain('CustomNet');
  });
});

describe('PlatformBadge', () => {
  test('renders platform icon and resolved label, with optional label override', () => {
    const tgHtml = renderToStaticMarkup(<PlatformBadge source="telegram" />);
    expect(tgHtml).toContain('<svg');
    expect(tgHtml).toContain('Telegram');

    const cgHtml = renderToStaticMarkup(<PlatformBadge source="CoinGecko" label="CoinGecko API" />);
    expect(cgHtml).toContain('<svg');
    expect(cgHtml).toContain('CoinGecko API');
  });
});

describe('CryptoTickerPill', () => {
  test('renders mini inline crypto SVG coin emblem for known tickers and clean pill for unknown tickers', () => {
    const solHtml = renderToStaticMarkup(<CryptoTickerPill ticker="$sol" />);
    expect(solHtml).toContain('<svg');
    expect(solHtml).toContain('$SOL');

    const unknownHtml = renderToStaticMarkup(<CryptoTickerPill ticker="MYSTERY" />);
    expect(unknownHtml).toContain('$MYSTERY');
    expect(unknownHtml).not.toContain('<svg');
  });
});
