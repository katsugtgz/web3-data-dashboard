import { useEffect, useState } from 'react';
import type { Dashboard } from '../../shared/types';

/**
 * Dashboard data source:
 * - dev / `bun start`: `/api/dashboard` from the Bun server.
 * - static build (GitHub Pages): `${import.meta.env.BASE_URL}data/dashboard.json`,
 *   copied into dist at build time by `scripts/build-pages.mts`. No API server there.
 */
export function useDashboard(): { data: Dashboard | null; error: string | null } {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();

    const loadJson = (res: Response): Promise<void> => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (res.json() as Promise<Dashboard>).then(setData);
    };
    const fail = (e: unknown): void => {
      if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    };

    if (process.env.VITE_STATIC) {
      // Static Pages build: fetch the bundled snapshot only.
      fetch(`${import.meta.env.BASE_URL}data/dashboard.json`, { signal: ctrl.signal })
        .then(loadJson)
        .catch(fail);
    } else {
      // Dev / `bun start`: API first, fall back to the bundled snapshot if the API is unreachable.
      fetch('/api/dashboard', { signal: ctrl.signal })
        .then(loadJson)
        .catch(() => {
          if (ctrl.signal.aborted) return;
          fetch(`${import.meta.env.BASE_URL}data/dashboard.json`, { signal: ctrl.signal })
            .then(loadJson)
            .catch(fail);
        });
    }
    return () => ctrl.abort();
  }, []);

  return { data, error };
}
