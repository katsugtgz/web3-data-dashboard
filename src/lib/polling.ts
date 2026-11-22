import { useEffect } from 'react';

export type PollMode = 'initial' | 'manual' | 'background';

export interface PollLifecycle {
  /** AbortController of the current/last request; `beginRequest` rotates it. */
  ctrlRef: { current: AbortController | null };
  /** True while a request is outstanding (background polls skip when set). */
  inFlightRef: { current: boolean };
  /** Date.now() of the last COMPLETED fetch, for visibility catch-up. */
  lastFetchedRef: { current: number };
}

export interface PollLifecycleApi extends PollLifecycle {
  /**
   * Start a request: skips redundant background polls, aborts the previous
   * request, and returns the fresh signal. `skipped` means "don't fetch".
   */
  beginRequest: (mode: PollMode) => { signal: AbortSignal; skipped: boolean };
  /** Marks the outstanding request finished and stamps completion time. */
  settle: () => void;
  /** Mount/unmount wiring: initial fetch + interval + visibility + teardown. */
  useInterval: (fetchNowRef: { current: (mode: PollMode) => void }, pollMs: number) => void;
}

/** One instance per polling hook; carries zero knowledge of response shapes. */
export function createPollLifecycle(): PollLifecycleApi {
  const ctrlRef = { current: null as AbortController | null };
  const inFlightRef = { current: false };
  const lastFetchedRef = { current: 0 };

  const beginRequest = (mode: PollMode): { signal: AbortSignal; skipped: boolean } => {
    if (mode === 'background' && inFlightRef.current) {
      return { signal: new AbortController().signal, skipped: true };
    }
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    inFlightRef.current = true;
    return { signal: ctrl.signal, skipped: false };
  };

  const settle = (): void => {
    inFlightRef.current = false;
    lastFetchedRef.current = Date.now();
  };

  const dispose = (): void => {
    ctrlRef.current?.abort();
    inFlightRef.current = false;
  };

  const useInterval = (fetchNowRef: { current: (mode: PollMode) => void }, pollMs: number): void => {
    useEffect(() => {
      fetchNowRef.current('initial');
      const id = setInterval(() => {
        if (document.visibilityState === 'visible') fetchNowRef.current('background');
      }, pollMs);
      const onVisibility = () => {
        if (document.visibilityState === 'visible' && Date.now() - lastFetchedRef.current >= pollMs) {
          fetchNowRef.current('background');
        }
      };
      document.addEventListener('visibilitychange', onVisibility);
      return () => {
        dispose();
        clearInterval(id);
        document.removeEventListener('visibilitychange', onVisibility);
      };
      // Poll wiring is set up once; fetchNow is always read through the ref.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pollMs]);
  };

  return { ctrlRef, inFlightRef, lastFetchedRef, beginRequest, settle, useInterval };
}
