import { describe, expect, test } from 'bun:test';
import { fallbackEligible } from './api';

describe('getJson snapshot fallback eligibility', () => {
  test('5xx HTTP errors qualify, 4xx do not', () => {
    expect(fallbackEligible(new Error('HTTP 503'))).toBe(true);
    expect(fallbackEligible(new Error('HTTP 500'))).toBe(true);
    expect(fallbackEligible(new Error('HTTP 404'))).toBe(false);
    expect(fallbackEligible(new Error('HTTP 400'))).toBe(false);
    expect(fallbackEligible(new TypeError('Network request failed'))).toBe(true);
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    expect(fallbackEligible(timeout)).toBe(true);
    expect(fallbackEligible(new Error('boom'))).toBe(false);
  });
});
