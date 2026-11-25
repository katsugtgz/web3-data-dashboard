import { describe, expect, test } from 'bun:test';
import { createPollLifecycle } from './polling';

describe('createPollLifecycle', () => {
  test('only stamps lastFetchedRef on successful settle, never on failed settle', () => {
    const poll = createPollLifecycle();
    expect(poll.lastFetchedRef.current).toBe(0);

    const req1 = poll.beginRequest('initial');
    expect(req1.skipped).toBe(false);
    expect(poll.inFlightRef.current).toBe(true);

    // Failed poll clears inFlight without stamping lastFetchedRef.
    poll.settle(false);
    expect(poll.inFlightRef.current).toBe(false);
    expect(poll.lastFetchedRef.current).toBe(0);

    // Successful poll stamps lastFetchedRef.
    const req2 = poll.beginRequest('manual');
    expect(req2.skipped).toBe(false);
    poll.settle(true);
    expect(poll.inFlightRef.current).toBe(false);
    const stamped = poll.lastFetchedRef.current;
    expect(stamped).toBeGreaterThan(0);

    // Subsequent failure preserves previous successful timestamp.
    poll.beginRequest('background');
    poll.settle(false);
    expect(poll.lastFetchedRef.current).toBe(stamped);
  });
});
