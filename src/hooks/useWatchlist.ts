import { useCallback, useEffect, useRef, useState } from 'react';
import type { Card, CardTask } from '../../shared/types';
import { parseCost, parseMinutes } from '../lib/format';

const SAVED_KEY = 'icq:saved-projects';
const TASKS_KEY = 'icq:done-tasks';

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

export function useWatchlist() {
  const [saved, setSaved] = useState<Set<string>>(() => readSet(SAVED_KEY));
  const [doneTasks, setDoneTasks] = useState<Set<string>>(() => readSet(TASKS_KEY));
  // Monotonic mutation counters ensure cross-tab storage events never cancel
  // pending local persistence before the effect commits.
  const savedMutationRef = useRef(0);
  const persistedSavedRef = useRef(0);
  const tasksMutationRef = useRef(0);
  const persistedTasksRef = useRef(0);

  useEffect(() => {
    if (savedMutationRef.current === persistedSavedRef.current) return;
    persistedSavedRef.current = savedMutationRef.current;
    writeSet(SAVED_KEY, saved);
  }, [saved]);

  useEffect(() => {
    if (tasksMutationRef.current === persistedTasksRef.current) return;
    persistedTasksRef.current = tasksMutationRef.current;
    writeSet(TASKS_KEY, doneTasks);
  }, [doneTasks]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === SAVED_KEY) {
        if (savedMutationRef.current === persistedSavedRef.current) {
          setSaved(readSet(SAVED_KEY));
        }
      }
      if (e.key === null || e.key === TASKS_KEY) {
        if (tasksMutationRef.current === persistedTasksRef.current) {
          setDoneTasks(readSet(TASKS_KEY));
        }
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const toggleSaved = useCallback((projectKey: string, legacyKey?: string) => {
    savedMutationRef.current += 1;
    setSaved(prev => toggleStorageEntry(prev, projectKey, legacyKey));
  }, []);

  const toggleTaskDone = useCallback((taskKey: string, legacyKey?: string) => {
    tasksMutationRef.current += 1;
    setDoneTasks(prev => toggleStorageEntry(prev, taskKey, legacyKey));
  }, []);

  const clearSaved = useCallback(() => {
    savedMutationRef.current += 1;
    setSaved(new Set());
  }, []);

  return { saved, doneTasks, toggleSaved, toggleTaskDone, clearSaved };
}
