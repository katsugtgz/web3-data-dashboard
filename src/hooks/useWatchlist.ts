import { useCallback, useEffect, useState } from 'react';

const SAVED_KEY = 'icq:saved-projects';
const TASKS_KEY = 'icq:done-tasks';

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

export function taskStorageKey(projectName: string, taskTitle: string, taskType = '', index = 0): string {
  return `${projectName}::${taskTitle}::${taskType}::${index}`;
}

export function useWatchlist() {
  const [saved, setSaved] = useState<Set<string>>(() => readSet(SAVED_KEY));
  const [doneTasks, setDoneTasks] = useState<Set<string>>(() => readSet(TASKS_KEY));

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === SAVED_KEY) setSaved(readSet(SAVED_KEY));
      if (e.key === TASKS_KEY) setDoneTasks(readSet(TASKS_KEY));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const toggleSaved = useCallback((projectName: string) => {
    setSaved(prev => {
      const next = new Set(prev);
      if (next.has(projectName)) next.delete(projectName);
      else next.add(projectName);
      writeSet(SAVED_KEY, next);
      return next;
    });
  }, []);

  const toggleTaskDone = useCallback((projectName: string, taskTitle: string, taskType = '', index = 0) => {
    const key = taskStorageKey(projectName, taskTitle, taskType, index);
    setDoneTasks(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeSet(TASKS_KEY, next);
      return next;
    });
  }, []);

  const clearSaved = useCallback(() => {
    const empty = new Set<string>();
    setSaved(empty);
    writeSet(SAVED_KEY, empty);
  }, []);

  return { saved, doneTasks, toggleSaved, toggleTaskDone, clearSaved };
}
