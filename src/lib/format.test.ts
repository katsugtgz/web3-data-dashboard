import { describe, expect, test } from 'bun:test';
import { changeToneClass, formatClock, isHttpUrl, isStaleTimestamp, normalizeExternalUrl, sortVal } from './format';

test('parses legacy magnitude suffixes and negative arrows', () => {
  expect(sortVal('1.5\u4e07')).toBe(15_000);
  expect(sortVal('2\u4ebf')).toBe(200_000_000);
  expect(sortVal('▼5%')).toBe(-5);
  expect(sortVal('▼-5')).toBe(-5);
});

describe('normalizeExternalUrl', () => {
  test('upgrades bare domain URLs like t.me/DoodlesUP_bot to https', () => {
    expect(normalizeExternalUrl('t.me/DoodlesUP_bot')).toBe('https://t.me/DoodlesUP_bot');
    expect(normalizeExternalUrl('app.example.xyz/claim?step=1&amp;mode=fast')).toBe(
      'https://app.example.xyz/claim?step=1&mode=fast',
    );
  });

  test('keeps valid http/https URLs and rejects unsafe schemes, raw bare IPs, or credentials', () => {
    expect(normalizeExternalUrl('https://galxe.com/newchain')).toBe('https://galxe.com/newchain');
    expect(normalizeExternalUrl('http://example.com/task')).toBe('http://example.com/task');
    expect(normalizeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeExternalUrl('data:text/html,hi')).toBeNull();
    expect(normalizeExternalUrl('https://user:pass@example.com/')).toBeNull();
    expect(normalizeExternalUrl('1.1.1.1/test')).toBeNull();
    expect(normalizeExternalUrl('not a url')).toBeNull();
    expect(normalizeExternalUrl('')).toBeNull();
    expect(normalizeExternalUrl(null)).toBeNull();
  });
});

describe('isHttpUrl', () => {
  test('allows clean http/https URLs and rejects embedded credentials or non-http schemes', () => {
    expect(isHttpUrl('https://example.com/path')).toBe(true);
    expect(isHttpUrl('  http://example.com  ')).toBe(true);
    expect(isHttpUrl('https://user:pass@example.com/')).toBe(false);
    expect(isHttpUrl('https://user@example.com/')).toBe(false);
    expect(isHttpUrl('https://:pass@example.com/')).toBe(false);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('data:text/html,hi')).toBe(false);
  });
});

describe('formatClock and isStaleTimestamp', () => {
  test('formatClock guards non-finite, non-positive, and out-of-range timestamps', () => {
    expect(formatClock(Number.NaN)).toBe('—');
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatClock(0)).toBe('—');
    expect(formatClock(-1000)).toBe('—');
    expect(formatClock(1e20)).toBe('—');
    expect(formatClock(1_795_364_909_000)).not.toBe('—');
  });

  test('isStaleTimestamp flags ages strictly over threshold and ignores invalid timestamps', () => {
    const now = 1_795_364_909_000;
    const sixHours = 6 * 3_600_000;
    expect(isStaleTimestamp(now - sixHours - 1, sixHours, now)).toBe(true);
    expect(isStaleTimestamp(now - sixHours, sixHours, now)).toBe(false);
    expect(isStaleTimestamp(now - 60_000, sixHours, now)).toBe(false);
    expect(isStaleTimestamp(null, sixHours, now)).toBe(false);
    expect(isStaleTimestamp(Number.NaN, sixHours, now)).toBe(false);
    expect(isStaleTimestamp(0, sixHours, now)).toBe(false);
  });
});

describe('changeToneClass', () => {
  test('returns neutral for zero and placeholder values, up/dn for non-zero signed changes', () => {
    expect(changeToneClass('+2.45%')).toBe('up');
    expect(changeToneClass('-1.20%')).toBe('dn');
    expect(changeToneClass('0.00%')).toBe('');
    expect(changeToneClass('+0.00%')).toBe('');
    expect(changeToneClass('-0.00%')).toBe('');
    expect(changeToneClass('—')).toBe('');
    expect(changeToneClass('')).toBe('');
  });
});
