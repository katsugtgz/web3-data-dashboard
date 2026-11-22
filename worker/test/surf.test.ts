import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { stripOrTranslateCjk, translateRiskItem, translateTagLabel, translateTgeStatus } from '../src/normalize/i18n';
import { normalizeSurf } from '../src/sources/surf';
import { FORBIDDEN_CJK_RE } from './helpers';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/surf-airdrops.json', import.meta.url), 'utf8'));

describe('surf normalizer + i18n', () => {
  test('treats fullwidth digits as content: normalized after Han strip', () => {
    // U+FF10–FF19 → ASCII runs after Han stripping, so the digits survive.
    expect(stripOrTranslateCjk('２０２５年')).toBe('2025');
    expect(stripOrTranslateCjk('铭文１２３')).toBe('123');
  });

  test('strips forbidden CJK punctuation globally, not only at edges', () => {
    // Cubic PRRT_kwDOV0YtbM66Wygn: mixed labels must not leak 。 mid-string.
    expect(stripOrTranslateCjk('中foo。bar文')).toBe('foo bar');
    // Fullwidth letter/punctuation range U+FF21–U+FF60 is decoration in this
    // vocabulary (CI forbids FF01–FF9F in output); only digits fold to ASCII.
    expect(stripOrTranslateCjk('铭文ＡＢＣ')).toBe('');
  });

  test('CJK-only task types fall back to other, not empty', () => {
    // Cubic PRRT_kwDOV0YtbM66Wygz: normalizeTaskType must keep filter entries
    // non-empty when stripOrTranslateCjk yields '' for unmapped CJK.
    const feed = normalizeSurf(
      {
        active: [{ project_name: 'Proj', tasks: [{ title: 'T', type: '类型', status: 'OPEN' }], task_summary: { types: ['类型'] } }],
        tge: [],
      },
      1_700_000_000_000,
    );
    expect(feed.cards[0].tasks?.[0].type).toBe('other');
    expect(feed.cards[0].taskTypes).toContain('other');
  });

  test('normalizes full surf fixture with zero CJK output', () => {
    const feed = normalizeSurf(fixture, 1_700_000_000_000);
    expect(feed.cards.length).toBe(fixture.active.length);
    expect(feed.tge.length).toBe(fixture.tge.length);
    expect(feed.counts.active).toBe(fixture.counts.active_total);

    const serialized = JSON.stringify(feed);
    // Full CI gate (scripts/check-no-cjk.sh), not just Han: Kana, Hangul,
    // Bopomofo, CJK punctuation and fullwidth forms must all be rejected.
    expect(FORBIDDEN_CJK_RE.test(serialized)).toBe(false);
    expect(serialized).not.toContain('surf.computer');

    // Stable identity: each card carries its upstream project_id so storage
    // keys stay unique even when CJK stripping collapses distinct names.
    const withId = feed.cards.filter(c => c.id);
    expect(withId.length).toBeGreaterThan(0);
    expect(new Set(withId.map(c => c.id)).size).toBe(withId.length);
    const first = fixture.active[0];
    expect(feed.cards[0].id).toBe(first.project_id);
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
