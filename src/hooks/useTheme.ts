import { useCallback, useEffect, useState } from 'react';

type Scheme = 'light' | 'dark';
const STORAGE_KEY = 'color-scheme';

function readStored(): Scheme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

function getSystemScheme(): Scheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyMeta(override: Scheme | null): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
  if (meta) meta.content = override ?? 'light dark';
}

/**
 * Two-state color-scheme toggle backed by <meta name="color-scheme"> and localStorage.
 * Reverts to following system preference (deletes stored override) when toggled back to OS default.
 */
export function useTheme() {
  const [override, setOverride] = useState<Scheme | null>(() => readStored());
  const [system, setSystem] = useState<Scheme>(() => getSystemScheme());

  const resolved: Scheme = override ?? system;

  useEffect(() => {
    applyMeta(override);
  }, [override]);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystem(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', onChange);

    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        const next = readStored();
        setOverride(next);
        applyMeta(next);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => {
      mq.removeEventListener('change', onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const toggle = useCallback(() => {
    const currentSystem = getSystemScheme();
    const currentRendered = readStored() ?? currentSystem;
    const target: Scheme = currentRendered === 'dark' ? 'light' : 'dark';
    const nextOverride = target === currentSystem ? null : target;
    try {
      if (nextOverride) localStorage.setItem(STORAGE_KEY, nextOverride);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Still apply to current document even if persistence is blocked
    }
    setOverride(nextOverride);
    applyMeta(nextOverride);
  }, []);

  return { resolved, isOverride: override !== null, toggle };
}
