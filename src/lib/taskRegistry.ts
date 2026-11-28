import type { Card, FeedItem } from '../../shared/types';
import {
  parseManifest,
  parseTaskRef,
  type ManifestEntryV1,
  type TaskManifestV1,
  type TaskRefV1,
} from '../../shared/taskContract';
import { normalizeExternalUrl } from './format';
import rawManifest from '../../data/tasks/manifest.json';
import browserEmailDemoV1 from '../../data/tasks/browser-email-demo.v1.json';
import flopTestnetVoucherV1 from '../../data/tasks/flop-testnet-voucher.v1.json';
import voucherDemoV1 from '../../data/tasks/voucher-demo.v1.json';

/**
 * Every reference the manifest can list, bundled at build time and keyed by its
 * exact `ref_path`. The registry reads these in memory: it never loads a file
 * over the network, so a brief is always built synchronously and offline.
 */
export const RAW_REFS: Readonly<Record<string, unknown>> = {
  'browser-email-demo.v1.json': browserEmailDemoV1,
  'flop-testnet-voucher.v1.json': flopTestnetVoucherV1,
  'voucher-demo.v1.json': voucherDemoV1,
};

/** One manifest row with the reference it pins. */
export type ReviewedTaskMatch = { entry: ManifestEntryV1; ref: TaskRefV1 };

export interface TaskRegistry {
  manifest: TaskManifestV1;
  byTaskId: ReadonlyMap<string, TaskRefV1>;
  byCardId: ReadonlyMap<string, ReviewedTaskMatch>;
  byFeedId: ReadonlyMap<string, ReviewedTaskMatch>;
  byDomain: ReadonlyMap<string, ReviewedTaskMatch>;
}

const EMPTY_MANIFEST: TaskManifestV1 = Object.freeze({ schema_version: 1, kind: 'task_manifest', tasks: [] });

/** The registry that matches nothing. Every invalid input falls back to it. */
function emptyRegistry(): TaskRegistry {
  return { manifest: EMPTY_MANIFEST, byTaskId: new Map(), byCardId: new Map(), byFeedId: new Map(), byDomain: new Map() };
}

/**
 * Validates the manifest and each reference it pins, then indexes the rows by
 * their bindings. Never throws and never keeps a partial result: one invalid
 * manifest, reference, or binding returns the registry that matches nothing.
 *
 * ponytail: the browser cannot re-hash a bundled reference synchronously, so the
 * build gate (`bun run check:tasks`) owns the hash check. Add a runtime hash
 * check if refs ever load from somewhere other than this bundle.
 */
export function buildTaskRegistry(raw: unknown, rawRefs: Readonly<Record<string, unknown>>): TaskRegistry {
  try {
    const parsed = parseManifest(raw);
    if (!parsed.ok) return emptyRegistry();
    const { manifest } = parsed;
    const byTaskId = new Map<string, TaskRefV1>();
    const byCardId = new Map<string, ReviewedTaskMatch>();
    const byFeedId = new Map<string, ReviewedTaskMatch>();
    const byDomain = new Map<string, ReviewedTaskMatch>();
    for (const entry of manifest.tasks) {
      const bundled = rawRefs !== null && typeof rawRefs === 'object' && Object.hasOwn(rawRefs, entry.ref_path);
      const parsedRef = parseTaskRef(bundled ? rawRefs[entry.ref_path] : undefined);
      if (!parsedRef.ok) return emptyRegistry();
      const { ref } = parsedRef;
      // The file is keyed by name, so its content must still name the row that pins it.
      if (ref.task_id !== entry.task_id || ref.revision !== entry.revision) return emptyRegistry();
      const { bindings } = entry;
      const bound = bindings.card_ids.length + bindings.feed_ids.length + bindings.domains.length;
      if (ref.mode === 'synthetic_fixture' && bound > 0) return emptyRegistry();
      const match = { entry, ref };
      byTaskId.set(entry.task_id, ref);
      for (const id of bindings.card_ids) byCardId.set(id, match);
      for (const id of bindings.feed_ids) byFeedId.set(id, match);
      for (const host of bindings.domains) byDomain.set(host, match);
    }
    return { manifest, byTaskId, byCardId, byFeedId, byDomain };
  } catch {
    return emptyRegistry();
  }
}

/** The registry built from the files bundled into this module. */
export const BUNDLED_TASK_REGISTRY: TaskRegistry = buildTaskRegistry(rawManifest, RAW_REFS);

/** Exact lowercase hostname of an http(s) URL, or null when it does not parse. */
function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The reviewed task bound to `item`, or null when none is. Lookups are exact
 * map hits: no pattern, suffix, or `www.` folding, so a lookalike never matches.
 */
export function findReviewedTask(
  item: FeedItem | Card,
  registry: TaskRegistry = BUNDLED_TASK_REGISTRY,
): ReviewedTaskMatch | null {
  if ('risk' in item) {
    const byId = registry.byFeedId.get(item.id);
    if (byId) return byId;
    const domain = item.domain?.trim().toLowerCase();
    if (domain) return registry.byDomain.get(domain) ?? null;
    // No declared domain: only a link the feed marked as known may supply the hostname.
    for (const link of item.links) {
      if (link.known !== true) continue;
      const host = hostnameOf(link.url);
      const match = host ? registry.byDomain.get(host) : undefined;
      if (match) return match;
    }
    return null;
  }
  const byId = item.id ? registry.byCardId.get(item.id) : undefined;
  if (byId) return byId;
  const projectUrl = normalizeExternalUrl(item.url);
  const host = projectUrl ? hostnameOf(projectUrl) : null;
  return (host && registry.byDomain.get(host)) || null;
}
