import { expect, test } from 'bun:test';
import { sortVal } from './format';

test('parses legacy magnitude suffixes and negative arrows', () => {
  expect(sortVal('1.5\u4e07')).toBe(15_000);
  expect(sortVal('2\u4ebf')).toBe(200_000_000);
  expect(sortVal('▼5%')).toBe(-5);
  expect(sortVal('▼-5')).toBe(-5);
});

test('fmtUsd tiny amounts: fixed decimals then em-dash floor', async () => {
  const { fmtUsd } = await import('./format');
  expect(fmtUsd(0.000000089)).toBe('$0.0000000890'); // 8.9e-8, 12-decimal fixed
  expect(fmtUsd(4e-13)).toBe('—'); // below 5e-13: no false zero
});
