import { useCallback, useEffect, useRef, useState } from 'react';
import type { Card, CardTask } from '../../shared/types';
import { parseCost, parseMinutes } from '../lib/format';

const SAVED_KEY = 'icq:saved-projects';
const TASKS_KEY = 'icq:done-tasks';
const LEGACY_SHEET_ID_RE = /^(asso7878|arndxt|pendle|merkl):([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const DISAMBIGUATED_SHEET_ID_RE = /^(asso7878|arndxt):([^~]+)~([0-9a-f]{8}(?:-\d+)?)$/;
const HASHED_SHEET_SUFFIX_RE = /^[0-9a-f]{8}(?:[0-9a-f]{8})?(?:-[0-9a-f]{8}|-\d+)*$/;
const EMPTY_STRING_SET: ReadonlySet<string> = new Set();

function slugifyCardName(name: string, emptyFallback = 'project'): string {
  let out = '';
  let prevDash = true;
  for (let i = 0; i < name.length; i++) {
    let c = name.charCodeAt(i);
    if (c >= 65 && c <= 90) c += 32;
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      out += String.fromCharCode(c);
      prevDash = false;
    } else if (!prevDash) {
      out += '-';
      prevDash = true;
    }
  }
  if (out.endsWith('-')) out = out.slice(0, -1);
  return out || emptyFallback;
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

export interface LegacySheetIdMigration {
  saved: Set<string>;
  doneTasks: Set<string>;
  changed: boolean;
}

export interface PersistedWatchlistSet {
  values: Set<string>;
  version: number;
}

interface LegacyCandidate {
  id: string;
  prefix: string;
  nameSlug: string;
}

function isHashedLegacyVariant(candidateId: string, legacyId: string): boolean {
  if (candidateId.length <= legacyId.length + 1) return false;
  if (!candidateId.startsWith(legacyId)) return false;
  const sep = candidateId[legacyId.length];
  if (sep !== '-' && sep !== '~') return false;
  return HASHED_SHEET_SUFFIX_RE.test(candidateId.slice(legacyId.length + 1));
}

function resolveLegacySheetId(
  legacyId: string,
  exactIds: ReadonlySet<string>,
  candidates: readonly LegacyCandidate[],
): string {
  if (exactIds.has(legacyId)) return legacyId;

  // Explicit disambiguated-to-base sheet migration: when a duplicate sibling row
  // disappears from an ASSO7878/arndxt sheet, `<baseId>~<hash>[-n]` maps cleanly
  // to the sole surviving `<baseId>` card (never applied to Pendle/Merkl `~` IDs).
  const disambigMatch = DISAMBIGUATED_SHEET_ID_RE.exec(legacyId);
  if (disambigMatch) {
    const baseId = `${disambigMatch[1]}:${disambigMatch[2]}`;
    if (!exactIds.has(baseId)) return legacyId;
    const siblingPrefix = `${baseId}~`;
    for (const entry of candidates) {
      if (entry.id.startsWith(siblingPrefix)) return legacyId;
    }
    return baseId;
  }

  const match = LEGACY_SHEET_ID_RE.exec(legacyId);
  if (!match) return legacyId;
  const prefix = match[1];
  const legacySlug = match[2];
  let matchedId: string | null = null;
  for (const entry of candidates) {
    if (entry.prefix !== prefix || entry.nameSlug !== legacySlug) continue;
    if (prefix !== 'merkl' && !isHashedLegacyVariant(entry.id, legacyId)) continue;
    if (matchedId !== null && matchedId !== entry.id) return legacyId;
    matchedId = entry.id;
  }
  return matchedId ?? legacyId;
}

/**
 * Migrates legacy bare-slug sheet/feed IDs (`asso7878:<slug>`, `arndxt:<slug>`,
 * `pendle:<slug>`, `merkl:<slug>`) in saved projects and JSON-encoded task keys
 * to their current card IDs when no live card has exact primary ID `<prefix>:<slug>`
 * and exactly one live card's name-derived slug matches `<slug>`.
 */
export function migrateLegacySheetIds(
  saved: ReadonlySet<string>,
  doneTasks: ReadonlySet<string>,
  cards: readonly Pick<Card, 'id' | 'n'>[],
): LegacySheetIdMigration {
  if (cards.length === 0 || (saved.size === 0 && doneTasks.size === 0)) {
    return { saved: new Set(saved), doneTasks: new Set(doneTasks), changed: false };
  }

  const exactIds = new Set<string>();
  const candidates: LegacyCandidate[] = [];
  for (const card of cards) {
    const id = card.id;
    if (!id) continue;
    exactIds.add(id);
    const colonIdx = id.indexOf(':');
    if (colonIdx <= 0) continue;
    const prefix = id.slice(0, colonIdx);
    if (prefix !== 'asso7878' && prefix !== 'arndxt' && prefix !== 'pendle' && prefix !== 'merkl') continue;
    const emptyFallback = prefix === 'pendle' || prefix === 'merkl' ? 'item' : 'project';
    candidates.push({
      id,
      prefix,
      nameSlug: slugifyCardName(card.n, emptyFallback),
    });
  }

  const resolvedCache = new Map<string, string>();
  const resolve = (projectKey: string): string => {
    const cached = resolvedCache.get(projectKey);
    if (cached !== undefined) return cached;
    const next = resolveLegacySheetId(projectKey, exactIds, candidates);
    resolvedCache.set(projectKey, next);
    return next;
  };

  let changed = false;
  const nextSaved = new Set<string>();
  for (const entry of saved) {
    const migrated = resolve(entry);
    if (migrated !== entry) changed = true;
    nextSaved.add(migrated);
  }

  const nextDoneTasks = new Set<string>();
  for (const entry of doneTasks) {
    let migratedEntry = entry;
    try {
      const parsed: unknown = JSON.parse(entry);
      if (
        Array.isArray(parsed) &&
        parsed.length === 4 &&
        typeof parsed[0] === 'string' &&
        typeof parsed[1] === 'string' &&
        typeof parsed[2] === 'string' &&
        typeof parsed[3] === 'number'
      ) {
        const migratedProjectKey = resolve(parsed[0]);
        if (migratedProjectKey !== parsed[0]) {
          migratedEntry = taskStorageKey(migratedProjectKey, parsed[1], parsed[2], parsed[3]);
          changed = true;
        }
      }
    } catch {
      // Preserve malformed legacy task keys verbatim
    }
    nextDoneTasks.add(migratedEntry);
  }

  return { saved: nextSaved, doneTasks: nextDoneTasks, changed };
}

export function commitWatchlistSetMigration(
  prev: PersistedWatchlistSet,
  cards: readonly Pick<Card, 'id' | 'n'>[],
  kind: 'saved' | 'tasks',
): PersistedWatchlistSet {
  if (cards.length === 0 || prev.values.size === 0) return prev;
  const res =
    kind === 'saved'
      ? migrateLegacySheetIds(prev.values, EMPTY_STRING_SET, cards)
      : migrateLegacySheetIds(EMPTY_STRING_SET, prev.values, cards);
  const nextValues = kind === 'saved' ? res.saved : res.doneTasks;
  if (!res.changed || setsEqual(prev.values, nextValues)) return prev;
  return { values: nextValues, version: prev.version + 1 };
}

/**
 * Watchlist/done-task entries key on the stable upstream project id
 * (`card.id`), falling back to the display name — pre-id storage was
 * name-keyed, so the fallback keeps old entries readable with no migration
 * shim. ponytail: name fallback still collides for CJK-stripped duplicates;
 * drop it once every surf payload carries project_id.
 */
export function cardStorageKey(card: Pick<Card, 'id' | 'n'>): string {
  return card.id ?? card.n;
}

export function cardLegacyStorageKey(card: Pick<Card, 'id' | 'n'>): string | undefined {
  return card.id && card.id !== card.n ? card.n : undefined;
}

export function isCardSaved(saved: ReadonlySet<string>, card: Pick<Card, 'id' | 'n'>): boolean {
  const primary = cardStorageKey(card);
  const legacy = cardLegacyStorageKey(card);
  return saved.has(primary) || (legacy !== undefined && saved.has(legacy));
}

export interface TaskKeyPair {
  primary: string;
  legacy: string | null;
}

export function getCardTaskKeyPairs(
  card: Pick<Card, 'id' | 'n'>,
  tasks: readonly { title: string; type: string }[],
): TaskKeyPair[] {
  const primaryKeys = getTaskStorageKeys(cardStorageKey(card), tasks);
  const legacyProjectKey = cardLegacyStorageKey(card);
  const legacyKeys = legacyProjectKey ? getTaskStorageKeys(legacyProjectKey, tasks) : null;
  return primaryKeys.map((primary, i) => ({
    primary,
    legacy: legacyKeys ? legacyKeys[i] : null,
  }));
}

export function isTaskKeyDone(doneTasks: ReadonlySet<string>, pair: TaskKeyPair): boolean {
  return doneTasks.has(pair.primary) || (pair.legacy !== null && doneTasks.has(pair.legacy));
}

export function toggleStorageEntry(prev: ReadonlySet<string>, primaryKey: string, legacyKey?: string): Set<string> {
  const next = new Set(prev);
  const hasPrimary = next.has(primaryKey);
  const hasLegacy = Boolean(legacyKey && legacyKey !== primaryKey && next.has(legacyKey));
  if (hasPrimary || hasLegacy) {
    next.delete(primaryKey);
    if (legacyKey) next.delete(legacyKey);
  } else {
    next.add(primaryKey);
  }
  return next;
}

function readSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((v): v is string => typeof v === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function writeSet(key: string, values: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...values]));
  } catch {
    // Ignore storage quota / privacy mode errors
  }
}

export function taskStorageKey(projectKey: string, taskTitle: string, taskType = '', occurrence = 0): string {
  return JSON.stringify([projectKey, taskTitle, taskType, occurrence]);
}

export function getTaskStorageKeys(
  projectKey: string,
  tasks: readonly { title: string; type: string }[],
): string[] {
  const seen = new Map<string, number>();
  return tasks.map(t => {
    const base = JSON.stringify([projectKey, t.title, t.type]);
    const occ = seen.get(base) ?? 0;
    seen.set(base, occ + 1);
    return taskStorageKey(projectKey, t.title, t.type, occ);
  });
}

export function getCardTasks(card: Card): CardTask[] {
  if (card.tasks?.length) return card.tasks;
  const parsedCost = parseCost(card.best.c, card.costNum);
  return [
    {
      title: card.best.n,
      type: card.best.ty,
      status: '',
      cost: parsedCost < Number.MAX_SAFE_INTEGER ? parsedCost : -1,
      timeMinutes: parseMinutes(card.best.m),
      url: card.url,
    },
  ];
}

export function useWatchlist(cards?: readonly Pick<Card, 'id' | 'n'>[]) {
  const [savedState, setSavedState] = useState<PersistedWatchlistSet>(() => {
    const initial: PersistedWatchlistSet = { values: readSet(SAVED_KEY), version: 0 };
    return cards?.length ? commitWatchlistSetMigration(initial, cards, 'saved') : initial;
  });
  const [doneTasksState, setDoneTasksState] = useState<PersistedWatchlistSet>(() => {
    const initial: PersistedWatchlistSet = { values: readSet(TASKS_KEY), version: 0 };
    return cards?.length ? commitWatchlistSetMigration(initial, cards, 'tasks') : initial;
  });
  // Monotonic persisted version counters ensure cross-tab storage events never
  // clobber pending local mutations or migrations before the effect commits.
  const persistedSavedVersionRef = useRef(0);
  const persistedTasksVersionRef = useRef(0);
  const cardsRef = useRef(cards);

  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);

  useEffect(() => {
    if (savedState.version > persistedSavedVersionRef.current) {
      persistedSavedVersionRef.current = savedState.version;
      writeSet(SAVED_KEY, savedState.values);
    }
  }, [savedState]);

  useEffect(() => {
    if (doneTasksState.version > persistedTasksVersionRef.current) {
      persistedTasksVersionRef.current = doneTasksState.version;
      writeSet(TASKS_KEY, doneTasksState.values);
    }
  }, [doneTasksState]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      const liveCards = cardsRef.current;
      if (e.key === null || e.key === SAVED_KEY) {
        setSavedState(prev => {
          if (prev.version > persistedSavedVersionRef.current) return prev;
          const incoming: PersistedWatchlistSet = { values: readSet(SAVED_KEY), version: prev.version };
          return liveCards?.length ? commitWatchlistSetMigration(incoming, liveCards, 'saved') : incoming;
        });
      }
      if (e.key === null || e.key === TASKS_KEY) {
        setDoneTasksState(prev => {
          if (prev.version > persistedTasksVersionRef.current) return prev;
          const incoming: PersistedWatchlistSet = { values: readSet(TASKS_KEY), version: prev.version };
          return liveCards?.length ? commitWatchlistSetMigration(incoming, liveCards, 'tasks') : incoming;
        });
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const reconcileCards = useCallback((nextCards: readonly Pick<Card, 'id' | 'n'>[]) => {
    cardsRef.current = nextCards;
    if (nextCards.length === 0) return;
    setSavedState(prev => commitWatchlistSetMigration(prev, nextCards, 'saved'));
    setDoneTasksState(prev => commitWatchlistSetMigration(prev, nextCards, 'tasks'));
  }, []);

  const toggleSaved = useCallback((projectKey: string, legacyKey?: string) => {
    setSavedState(prev => {
      const liveCards = cardsRef.current;
      const base = liveCards?.length ? commitWatchlistSetMigration(prev, liveCards, 'saved').values : prev.values;
      return { values: toggleStorageEntry(base, projectKey, legacyKey), version: prev.version + 1 };
    });
  }, []);

  const toggleTaskDone = useCallback((taskKey: string, legacyKey?: string) => {
    setDoneTasksState(prev => {
      const liveCards = cardsRef.current;
      const base = liveCards?.length ? commitWatchlistSetMigration(prev, liveCards, 'tasks').values : prev.values;
      return { values: toggleStorageEntry(base, taskKey, legacyKey), version: prev.version + 1 };
    });
  }, []);

  const clearSaved = useCallback(() => {
    setSavedState(prev => ({ values: new Set(), version: prev.version + 1 }));
  }, []);

  return {
    saved: savedState.values,
    doneTasks: doneTasksState.values,
    toggleSaved,
    toggleTaskDone,
    clearSaved,
    reconcileCards,
  };
}
