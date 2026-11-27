import { useCallback, useState, type ReactNode } from 'react';

export type ViewMode = 'card' | 'compact';

/** Stored preference, or null when nothing valid is stored. Never throws on blocked storage. */
function readStoredView(storageKey: string): ViewMode | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(storageKey);
    return value === 'compact' || value === 'card' ? value : null;
  } catch {
    // Private mode, sandboxed frames, or quota errors: fall back to the default view.
    return null;
  }
}

/** Card/compact preference, remembered per panel. Storage is best-effort; the default is cards. */
export function useViewMode(storageKey: string): readonly [ViewMode, (next: ViewMode) => void] {
  const [view, setView] = useState<ViewMode>(() => readStoredView(storageKey) ?? 'card');

  const selectView = useCallback(
    (next: ViewMode) => {
      setView(next);
      try {
        window.localStorage.setItem(storageKey, next);
      } catch {
        // Preference simply stays in memory when storage is unavailable.
      }
    },
    [storageKey],
  );

  return [view, selectView];
}

function ViewIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="icon"
    >
      {children}
    </svg>
  );
}

interface Props {
  view: ViewMode;
  onChange: (next: ViewMode) => void;
  /** Names the panel in the accessible label, e.g. "drops". */
  label: string;
}

export function ViewToggle({ view, onChange, label }: Props) {
  return (
    <div className="seg-group seg-group-compact view-toggle" role="group" aria-label={`${label} view`}>
      <button
        type="button"
        className="seg-btn"
        aria-pressed={view === 'card'}
        title="Card view"
        onClick={() => onChange('card')}
      >
        <ViewIcon>
          <rect width="7" height="7" x="3" y="3" rx="1" />
          <rect width="7" height="7" x="14" y="3" rx="1" />
          <rect width="7" height="7" x="3" y="14" rx="1" />
          <rect width="7" height="7" x="14" y="14" rx="1" />
        </ViewIcon>
        <span>Cards</span>
      </button>
      <button
        type="button"
        className="seg-btn"
        aria-pressed={view === 'compact'}
        title="Compact table view"
        onClick={() => onChange('compact')}
      >
        <ViewIcon>
          <path d="M3 6h18" />
          <path d="M3 12h18" />
          <path d="M3 18h18" />
        </ViewIcon>
        <span>Compact</span>
      </button>
    </div>
  );
}
