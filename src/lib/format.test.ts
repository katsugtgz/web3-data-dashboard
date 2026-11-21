import { expect, test } from 'bun:test';
import { sortVal } from './format';

test('parses legacy magnitude suffixes and negative arrows', () => {
  expect(sortVal('1.5\u4e07')).toBe(15_000);
  expect(sortVal('2\u4ebf')).toBe(200_000_000);
  expect(sortVal('▼5%')).toBe(-5);
  expect(sortVal('▼-5')).toBe(-5);
});
