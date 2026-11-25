import { describe, expect, test } from 'bun:test';
import { isEscapeKey, isOutsideContainer } from './usePopoverDismiss';

describe('usePopoverDismiss pure helpers', () => {
  test('isEscapeKey matches Escape only', () => {
    expect(isEscapeKey('Escape')).toBe(true);
    expect(isEscapeKey('Esc')).toBe(false);
    expect(isEscapeKey('Enter')).toBe(false);
    expect(isEscapeKey('Tab')).toBe(false);
    expect(isEscapeKey('')).toBe(false);
  });

  test('isOutsideContainer returns true only when target is outside a mounted container', () => {
    const insideNode = { id: 'inside' };
    const outsideNode = { id: 'outside' };
    const container = {
      contains: (node: unknown) => node === insideNode,
    };

    expect(isOutsideContainer(container, outsideNode)).toBe(true);
    expect(isOutsideContainer(container, insideNode)).toBe(false);
    expect(isOutsideContainer(container, null)).toBe(false);
    expect(isOutsideContainer(null, outsideNode)).toBe(false);
  });
});
