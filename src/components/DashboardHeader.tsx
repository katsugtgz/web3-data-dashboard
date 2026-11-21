import { formatClock } from '../lib/format';

interface Props {
  cardCount: number;
  fetchedAt: number | null;
  loading: boolean;
  failed: boolean;
  isLiveApi: boolean;
  resolvedTheme: 'light' | 'dark';
  onRefresh: () => void;
  onOpenProfile: () => void;
  onToggleTheme: () => void;
}

function FeedStatusText({
  cardCount,
  fetchedAt,
  failed,
  isLiveApi,
}: {
  cardCount: number;
  fetchedAt: number | null;
  failed: boolean;
  isLiveApi: boolean;
}) {
  if (fetchedAt !== null) {
    return (
      <span>
        {failed ? 'Refresh failed · showing last data' : isLiveApi ? 'Live' : 'Snapshot'} · <span className="mono">{cardCount}</span>{' '}
        <span className="mono">{formatClock(fetchedAt)}</span>
      </span>
    );
  }
  if (failed) {
    return <span>Unable to load radar data</span>;
  }
  return <span>Syncing radar…</span>;
}

export function DashboardHeader({
  cardCount,
  fetchedAt,
  loading,
  failed,
  isLiveApi,
  resolvedTheme,
  onRefresh,
  onOpenProfile,
  onToggleTheme,
}: Props) {
  const isLive = fetchedAt !== null && isLiveApi && !failed;
  const themeAction = resolvedTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';

  return (
    <header className="top">
      <div className="container top-inner">
        <div className="brand-block">
          <div className="titlerow">
            <img
              className="logo"
              src={`${import.meta.env.BASE_URL}icon.svg`}
              alt=""
              width={40}
              height={40}
              decoding="async"
            />
            <div>
              <h1 className="pagetitle">Web3 Radar</h1>
              <p className="sub">
                Keyless English airdrop aggregator &amp; live market tracker · $0 Cloudflare Workers + GitHub Pages
              </p>
            </div>
          </div>
        </div>

        <div className="top-controls">
          <div className={`feed-pill${isLive ? ' is-live' : ''}`} role="status" aria-live="polite">
            <span className="status-dot" aria-hidden="true" />
            <FeedStatusText cardCount={cardCount} fetchedAt={fetchedAt} failed={failed} isLiveApi={isLiveApi} />
          </div>

          <button
            type="button"
            className="ctrl-btn"
            onClick={onRefresh}
            disabled={loading}
            aria-label="Refresh feeds"
            title="Refresh feeds"
          >
            <svg
              className={loading ? 'spin' : undefined}
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
            </svg>
            <span>Refresh</span>
          </button>

          <button
            type="button"
            className="ctrl-btn"
            onClick={onOpenProfile}
            aria-label="Configure agent profile"
            title="Configure agent environment profile"
          >
            <span>Agent profile</span>
          </button>

          <button
            type="button"
            className="ctrl-btn"
            onClick={onToggleTheme}
            aria-label={themeAction}
            title={themeAction}
          >
            {resolvedTheme === 'dark' ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
              </svg>
            )}
            <span>{resolvedTheme === 'dark' ? 'Light' : 'Dark'}</span>
          </button>
        </div>
      </div>
    </header>
  );
}
