import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Card, CardTask } from '../../shared/types';
import { parseCost, parseMinutes } from '../lib/format';

const SAVED_KEY = 'icq:saved-projects';
const TASKS_KEY = 'icq:done-tasks';
const LEGACY_SHEET_ID_RE = /^(asso7878|arndxt|pendle|merkl):([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const HASHED_SHEET_SUFFIX_RE = /^[0-9a-f]{8}(?:[0-9a-f]{8})?(?:-[0-9a-f]{8}|-\d+)*$/;
const EMPTY_STRING_SET: ReadonlySet<string> = new Set();

function slugifyCardName(name: string): string {
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
  return out || 'project';
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

function resolveLegacySheetId(
  legacyId: string,
  exactIds: ReadonlySet<string>,
  hashedCards: readonly { id: string; prefix: string; isCanonicalForName: boolean }[],
): string {
  const match = LEGACY_SHEET_ID_RE.exec(legacyId);
  if (!match || exactIds.has(legacyId)) return legacyId;
  const prefix = match[1];
  const candidatePrefix = `${legacyId}-`;
  let matchedId: string | null = null;
  for (const entry of hashedCards) {
    if (entry.prefix !== prefix || entry.isCanonicalForName) continue;
    if (!entry.id.startsWith(candidatePrefix)) continue;
    const suffix = entry.id.slice(candidatePrefix.length);
    if (!HASHED_SHEET_SUFFIX_RE.test(suffix)) continue;
    if (matchedId !== null && matchedId !== entry.id) return legacyId;
    matchedId = entry.id;
  }
  return matchedId ?? legacyId;
}

/**
 * Migrates legacy bare-slug sheet/feed IDs (`asso7878:<slug>`, `arndxt:<slug>`,
 * `pendle:<slug>`, `merkl:<slug>`) in saved projects and JSON-encoded task keys
 * to `<prefix>:<slug>-<hash>` when no live card has exact primary ID `<prefix>:<slug>`
 * and exactly one live card matches `<prefix>:<slug>-<hash>`.
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
  const hashedCards: { id: string; prefix: string; isCanonicalForName: boolean }[] = [];
  for (const card of cards) {
    const id = card.id;
    if (!id) continue;
    exactIds.add(id);
    const colonIdx = id.indexOf(':');
    if (colonIdx <= 0) continue;
    const prefix = id.slice(0, colonIdx);
    if (prefix !== 'asso7878' && prefix !== 'arndxt' && prefix !== 'pendle' && prefix !== 'merkl') continue;
    hashedCards.push({
      id,
      prefix,
      isCanonicalForName: id === `${prefix}:${slugifyCardName(card.n)}`,
    });
  }

  const resolvedCache = new Map<string, string>();
  const resolve = (projectKey: string): string => {
    const cached = resolvedCache.get(projectKey);
    if (cached !== undefined) return cached;
    const next = resolveLegacySheetId(projectKey, exactIds, hashedCards);
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
  const [savedState, setSaved] = useState<Set<string>>(() => readSet(SAVED_KEY));
  const [doneTasksState, setDoneTasks] = useState<Set<string>>(() => readSet(TASKS_KEY));
  // Monotonic mutation counters ensure cross-tab storage events never cancel
  // pending local persistence before the effect commits.
  const savedMutationRef = useRef(0);
  const persistedSavedRef = useRef(0);
  const tasksMutationRef = useRef(0);
  const persistedTasksRef = useRef(0);
  const cardsRef = useRef(cards);
  const lastPersistedSavedMigrationRef = useRef<string | null>(null);
  const lastPersistedTasksMigrationRef = useRef<string | null>(null);

  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);

  const migrated = useMemo(() => {
    if (!cards || cards.length === 0) return null;
    const res = migrateLegacySheetIds(savedState, doneTasksState, cards);
    return res.changed ? res : null;
  }, [savedState, doneTasksState, cards]);

  const savedMigrated = migrated !== null && !setsEqual(savedState, migrated.saved);
  const tasksMigrated = migrated !== null && !setsEqual(doneTasksState, migrated.doneTasks);
  const saved = savedMigrated ? migrated.saved : savedState;
  const doneTasks = tasksMigrated ? migrated.doneTasks : doneTasksState;

  useEffect(() => {
    if (savedMutationRef.current !== persistedSavedRef.current) {
      persistedSavedRef.current = savedMutationRef.current;
      lastPersistedSavedMigrationRef.current = null;
      writeSet(SAVED_KEY, saved);
      return;
    }
    if (savedMigrated) {
      const sig = JSON.stringify([...saved]);
      if (lastPersistedSavedMigrationRef.current !== sig) {
        lastPersistedSavedMigrationRef.current = sig;
        writeSet(SAVED_KEY, saved);
      }
    }
  }, [saved, savedMigrated]);

  useEffect(() => {
    if (tasksMutationRef.current !== persistedTasksRef.current) {
      persistedTasksRef.current = tasksMutationRef.current;
      lastPersistedTasksMigrationRef.current = null;
      writeSet(TASKS_KEY, doneTasks);
      return;
    }
    if (tasksMigrated) {
      const sig = JSON.stringify([...doneTasks]);
      if (lastPersistedTasksMigrationRef.current !== sig) {
        lastPersistedTasksMigrationRef.current = sig;
        writeSet(TASKS_KEY, doneTasks);
      }
    }
  }, [doneTasks, tasksMigrated]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === SAVED_KEY) {
        if (savedMutationRef.current === persistedSavedRef.current) {
          lastPersistedSavedMigrationRef.current = null;
          setSaved(readSet(SAVED_KEY));
        }
      }
      if (e.key === null || e.key === TASKS_KEY) {
        if (tasksMutationRef.current === persistedTasksRef.current) {
          lastPersistedTasksMigrationRef.current = null;
          setDoneTasks(readSet(TASKS_KEY));
        }
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const toggleSaved = useCallback((projectKey: string, legacyKey?: string) => {
    savedMutationRef.current += 1;
    setSaved(prev => {
      const liveCards = cardsRef.current;
      const base = liveCards?.length ? migrateLegacySheetIds(prev, EMPTY_STRING_SET, liveCards).saved : prev;
      return toggleStorageEntry(base, projectKey, legacyKey);
    });
  }, []);

  const toggleTaskDone = useCallback((taskKey: string, legacyKey?: string) => {
    tasksMutationRef.current += 1;
    setDoneTasks(prev => {
      const liveCards = cardsRef.current;
      const base = liveCards?.length ? migrateLegacySheetIds(EMPTY_STRING_SET, prev, liveCards).doneTasks : prev;
      return toggleStorageEntry(base, taskKey, legacyKey);
    });
  }, []);

  const clearSaved = useCallback(() => {
    savedMutationRef.current += 1;
    setSaved(new Set());
  }, []);

  return { saved, doneTasks, toggleSaved, toggleTaskDone, clearSaved };
}
