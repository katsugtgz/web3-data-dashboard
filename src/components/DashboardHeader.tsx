import { useLayoutEffect, useRef } from 'react';
import type { NavGroup } from '../hooks/useDashboardTabs';
import { formatClock, formatRelativeTime } from '../lib/format';
import { BotIcon, MoonIcon, RefreshCwIcon, ShieldCheckIcon, SunIcon } from './Icons';

interface Props {
  activeTabLabel: string;
  activeSectionGroup: NavGroup;
  cardCount: number;
  fetchedAt: number | null;
  loading: boolean;
  failed: boolean;
  isLiveApi: boolean;
  isStale?: boolean;
  isMarketTab?: boolean;
  resolvedTheme: 'light' | 'dark';
  onRefresh: () => void;
  onOpenContribution: () => void;
  onOpenProfile: () => void;
  onToggleTheme: () => void;
}

function totalStatusPrefix(failed: boolean, isLiveApi: boolean, isStale: boolean): string {
  if (failed) return 'Refresh failed ·';
  return isLiveApi && !isStale ? 'Live ·' : 'Snapshot ·';
}

function FeedStatusText({
  cardCount,
  fetchedAt,
  failed,
  isLiveApi,
  isStale,
  isMarketTab,
}: {
  cardCount: number;
  fetchedAt: number | null;
  failed: boolean;
  isLiveApi: boolean;
  isStale: boolean;
  isMarketTab: boolean;
}) {
  if (fetchedAt !== null) {
    const modeLabel = failed
      ? 'Refresh failed · last data'
      : isLiveApi && !isStale
        ? 'Live'
        : 'Snapshot';
    const timeSuffix =
      isMarketTab || isStale
        ? ` updated ${formatRelativeTime(fetchedAt)}`
        : failed
          ? ` · ${formatClock(fetchedAt)}`
          : ` synced ${formatClock(fetchedAt)}`;

    const compactAge = formatRelativeTime(fetchedAt);

    return (
      <span>
        <span className="feed-pill-verbose">{modeLabel} · </span>
        {failed && <span className="feed-pill-mobile-status">Failed · </span>}
        <span className="mono">{cardCount}</span>
        <span className="feed-pill-mobile-age mono"> · {compactAge}</span>
        <span className="feed-pill-verbose">{timeSuffix}</span>
      </span>
    );
  }
  if (failed) {
    return (
      <span>
        <span className="feed-pill-verbose">Unable to load radar data</span>
        <span className="feed-pill-mobile-status">Offline</span>
      </span>
    );
  }
  return <span>Syncing…</span>;
}

export function DashboardHeader({
  activeTabLabel,
  activeSectionGroup,
  cardCount,
  fetchedAt,
  loading,
  failed,
  isLiveApi,
  isStale = false,
  isMarketTab = false,
  resolvedTheme,
  onRefresh,
  onOpenContribution,
  onOpenProfile,
  onToggleTheme,
}: Props) {
  const isWarn = failed || isStale;
  const isLive = fetchedAt !== null && isLiveApi && !isWarn;
  const themeAction = resolvedTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  const headerRef = useRef<HTMLElement>(null);

  // Publish the topbar's rendered height so the sticky mobile tab strip sits directly beneath it.
  useLayoutEffect(() => {
    const header = headerRef.current;
    const shell = header?.closest<HTMLElement>('.app-shell');
    if (!header || !shell || typeof ResizeObserver === 'undefined') return;
    const sync = () => shell.style.setProperty('--topbar-offset', `${header.offsetHeight}px`);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(header);
    return () => {
      observer.disconnect();
      shell.style.removeProperty('--topbar-offset');
    };
  }, []);

  return (
    <header className="top" ref={headerRef}>
      <h1 className="sr">Web3 Radar · {activeTabLabel}</h1>
      <div className="top-inner">
        <div className="top-left">
          <div className="top-mobile-brand">
            <img
              className="logo"
              src={`${import.meta.env.BASE_URL}icon.svg`}
              alt=""
              width={26}
              height={26}
              decoding="async"
            />
            <span className="mobile-brand-title">Web3 Radar</span>
          </div>

          <div className="top-context" aria-hidden="true">
            <span className="top-group-pill">{activeSectionGroup}</span>
            <span className="top-section-title">{activeTabLabel}</span>
          </div>
        </div>

        <div className="top-controls">
          <div
            className={`feed-pill${isLive ? ' is-live' : ''}${isWarn ? ' is-warn' : ''}`}
            role="status"
            aria-live="polite"
            title={
              fetchedAt !== null
                ? `${totalStatusPrefix(failed, isLiveApi, isStale)} ${cardCount} items · updated ${formatRelativeTime(fetchedAt)}`
                : failed
                  ? 'Unable to load radar data'
                  : 'Syncing radar data'
            }
          >
            <span className="status-dot" aria-hidden="true" />
            <FeedStatusText
              cardCount={cardCount}
              fetchedAt={fetchedAt}
              failed={failed}
              isLiveApi={isLiveApi}
              isStale={isStale}
              isMarketTab={isMarketTab}
            />
          </div>

          <div className="top-actions">
            <button
              type="button"
              className="ctrl-btn"
              onClick={onRefresh}
              disabled={loading}
              aria-label="Refresh feeds"
              title="Refresh feeds"
            >
              <RefreshCwIcon size={15} className={loading ? 'spin' : undefined} />
              <span className="ctrl-label">Refresh</span>
            </button>

            <button
              type="button"
              className="ctrl-btn"
              onClick={onOpenProfile}
              aria-label="Configure agent profile"
              title="Configure agent environment profile"
            >
              <BotIcon size={15} />
              <span className="ctrl-label">Agent profile</span>
            </button>

            <button
              type="button"
              className="ctrl-btn"
              onClick={onOpenContribution}
              aria-label="Validate task contribution"
              title="Validate task run JSON contribution"
            >
              <ShieldCheckIcon size={15} />
              <span className="ctrl-label">Validate</span>
            </button>

            <button
              type="button"
              className="ctrl-btn"
              onClick={onToggleTheme}
              aria-label={themeAction}
              title={themeAction}
            >
              {resolvedTheme === 'dark' ? <SunIcon size={15} /> : <MoonIcon size={15} />}
              <span className="ctrl-label">{resolvedTheme === 'dark' ? 'Light' : 'Dark'}</span>
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
