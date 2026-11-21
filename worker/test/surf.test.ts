import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { HAN_RE, stripOrTranslateCjk, translateRiskItem, translateTagLabel, translateTgeStatus } from '../src/normalize/i18n';
import { normalizeSurf } from '../src/sources/surf';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/surf-airdrops.json', import.meta.url), 'utf8'));

describe('surf normalizer + i18n', () => {
  test('normalizes full surf fixture with zero CJK output', () => {
    const feed = normalizeSurf(fixture, 1_700_000_000_000);
    expect(feed.cards.length).toBe(fixture.active.length);
    expect(feed.tge.length).toBe(fixture.tge.length);
    expect(feed.counts.active).toBe(fixture.counts.active_total);

    const serialized = JSON.stringify(feed);
    expect(HAN_RE.test(serialized)).toBe(false);
    expect(serialized).not.toContain('surf.computer');
  });

  test('translates closed risk/tag/TGE vocab and strips unknown CJK', () => {
    expect(translateRiskItem('3 项高成本任务')).toBe('3 high-cost tasks');
    expect(translateRiskItem('1 项高成本任务')).toBe('1 high-cost task');
    expect(translateRiskItem('非币奖励')).toBe('Non-token reward');
    expect(translateRiskItem('融资偏低')).toBe('Low funding');
    expect(translateTagLabel('1 风险')).toBe('1 risk flag');
    expect(translateTagLabel('2 风险')).toBe('2 risk flags');
    expect(translateTgeStatus('可领取 TGE')).toBe('Claimable TGE');
    expect(translateTgeStatus('资格核验')).toBe('Eligibility check');

    const originalWarn = console.warn;
    const warnings: unknown[] = [];
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      // Unmapped pure-CJK yields '' so the CALLER's fallback applies
      // (surf.ts: 'Unknown project'); mixed names keep their Latin remainder.
      expect(stripOrTranslateCjk('未知中文字符串')).toBe('');
      expect(stripOrTranslateCjk('KiteAI 铭文')).toBe('KiteAI');
      expect(warnings.length).toBe(2);
    } finally {
      console.warn = originalWarn;
    }
  });
});
