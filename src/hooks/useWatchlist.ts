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
  const persistSavedRef = useRef(false);
  const persistTasksRef = useRef(false);

  useEffect(() => {
    if (!persistSavedRef.current) return;
    persistSavedRef.current = false;
    writeSet(SAVED_KEY, saved);
  }, [saved]);

  useEffect(() => {
    if (!persistTasksRef.current) return;
    persistTasksRef.current = false;
    writeSet(TASKS_KEY, doneTasks);
  }, [doneTasks]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === SAVED_KEY) {
        persistSavedRef.current = false;
        setSaved(readSet(SAVED_KEY));
      }
      if (e.key === null || e.key === TASKS_KEY) {
        persistTasksRef.current = false;
        setDoneTasks(readSet(TASKS_KEY));
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const toggleSaved = useCallback((projectName: string) => {
    persistSavedRef.current = true;
    setSaved(prev => {
      const next = new Set(prev);
      if (next.has(projectName)) next.delete(projectName);
      else next.add(projectName);
      return next;
    });
  }, []);

  const toggleTaskDone = useCallback((taskKey: string) => {
    persistTasksRef.current = true;
    setDoneTasks(prev => {
      const next = new Set(prev);
      if (next.has(taskKey)) next.delete(taskKey);
      else next.add(taskKey);
      return next;
    });
  }, []);

  const clearSaved = useCallback(() => {
    persistSavedRef.current = true;
    setSaved(new Set());
  }, []);

  return { saved, doneTasks, toggleSaved, toggleTaskDone, clearSaved };
}
