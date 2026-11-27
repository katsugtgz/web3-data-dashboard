import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Tge } from '../../shared/types';
import { describeTgeDate } from '../lib/feedDisplay';
import { TgeCarousel } from './TgeCarousel';

// 2026-11-27T12:00:00Z
const NOW = Date.UTC(2026, 10, 27, 12);

const ITEMS: Tge[] = [
  { n: 'SoonCoin', t: 'SOON', s: 'Claimable', d: '2026-11-30', tier: 'S', raise: '$5.80M' },
  { n: 'Undated', t: 'TBD', s: 'Eligibility check', d: 'TBA' },
  { n: 'TomorrowX', t: 'TMX', s: 'Claimable', d: '2026-11-28', tier: 'A' },
];

describe('describeTgeDate', () => {
  test('describes ISO dates with a countdown and passes undated entries through without guessing', () => {
    expect(describeTgeDate('2026-11-30', NOW)).toEqual({
      dateLabel: 'Nov 30',
      state: 'upcoming',
      countdown: 'in 3d',
      sortKey: Date.UTC(2026, 10, 30),
    });
    expect(describeTgeDate('2026-11-18', NOW).state).toBe('past');
    expect(describeTgeDate('2027-03-01', NOW).dateLabel).toBe('Mar 1, 2027');
    expect(describeTgeDate('TBA', NOW)).toEqual({
      dateLabel: 'Date TBA',
      state: 'unknown',
      countdown: null,
      sortKey: Number.MAX_SAFE_INTEGER,
    });
    expect(describeTgeDate('', NOW).dateLabel).toBe('Date TBA');
  });
});

describe('TgeCarousel', () => {
  test('renders cards in chronological order with undated events last', () => {
    const html = renderToStaticMarkup(<TgeCarousel items={ITEMS} />);

    const positions = ['TomorrowX', 'SoonCoin', 'Undated'].map(name => html.indexOf(`>${name}<`));
    expect(positions.every(position => position > -1)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  test('renders countdown chips, tier badges, funding chips, and a node for undated events', () => {
    const html = renderToStaticMarkup(<TgeCarousel items={ITEMS} />);

    expect(html).toContain('tge-timeline');
    expect(html).toContain('tge-countdown');
    expect(html).toContain('tge-node is-unknown');
    expect(html).toContain('Date TBA');
    expect(html).toContain('tge-funding');
    expect(html).toContain('$5.80M');
    expect(html).toContain('Tier S');
  });
});
