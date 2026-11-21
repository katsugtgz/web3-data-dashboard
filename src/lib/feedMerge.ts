import type { FeedItem } from '../../shared/types';

/**
 * Decides what a background fetch result means for the pending queue.
 *
 * Returns the items to queue, or null when nothing should be queued:
 * - a background result with brand-new ids queues the FULL latest list while
 *   the user reads (explicit merge on the "N new drops" pill);
 * - a background result with only already-known ids clears any stale queue —
 *   the latest fetch supersedes it, so a superseded snapshot (possibly with
 *   outdated risk state) is never revived;
 * - `manual`/`initial` results apply immediately and clear the queue.
 */
export function selectPending(latest: FeedItem[], knownIds: Iterable<string>): FeedItem[] | null {
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds);
  return latest.some(it => !known.has(it.id)) ? latest : null;
}

/**
 * Refreshes entries the user already sees, in place:
 * - displayed order is preserved (no auto-insert of new items),
 * - risk/summary always come from the LATEST payload (never revive the stale
 *   queued state),
 * - displayed entries that vanished from the latest bounded response are
 *   dropped — a cluster no longer present must not linger.
 */
export function mergeVisibleUpdates(displayed: FeedItem[], latest: FeedItem[]): FeedItem[] {
  const byId = new Map(latest.map(it => [it.id, it]));
  const out: FeedItem[] = [];
  for (const shown of displayed) {
    const fresh = byId.get(shown.id);
    if (!fresh) continue;
    out.push(fresh);
  }
  return out;
}
