import { describe, expect, test } from 'bun:test';
import { normalizeExternalUrl, sortVal } from './format';

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
