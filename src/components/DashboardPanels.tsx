import { lazy, Suspense, type RefObject } from 'react';
import { TABS } from '../../shared/constants';
import type { Card, FeedItem, MarketSection, MarketSector, Tge } from '../../shared/types';
import type { AirdropFiltersState } from '../hooks/useAirdropFilters';
import type { DropsFiltersState } from '../hooks/useDropsFilters';
import { ChunkErrorBoundary } from './ChunkErrorBoundary';
import { DropsPanel } from './DropsPanel';

const LazyAirdropPanel = lazy(() => import('./AirdropPanel').then(m => ({ default: m.AirdropPanel })));
const LazyMarketPanel = lazy(() => import('./MarketPanel').then(m => ({ default: m.MarketPanel })));

export function TabNav({
  tab,
  tabRefs,
  tabbarRef,
  onSelectTab,
  onTabKey,
}: {
  tab: string;
  tabRefs: RefObject<Record<string, HTMLButtonElement | null>>;
  tabbarRef: RefObject<HTMLDivElement | null>;
  onSelectTab: (id: string) => void;
  onTabKey: (e: React.KeyboardEvent) => void;
}) {
  return (
    <div className="tabbar" ref={tabbarRef}>
      <nav className="container" aria-label="Dashboard sections">
        <div
          role="tablist"
          aria-label="Dashboard sections"
          className="tabstrip"
          onKeyDown={onTabKey}
        >
          {TABS.map(t => (
            <button
              key={t.id}
              type="button"
              id={`tab-${t.id}`}
              role="tab"
              className="tab"
              aria-selected={t.id === tab}
              aria-controls={`panel-${t.id}`}
              tabIndex={t.id === tab ? 0 : -1}
              ref={el => {
                tabRefs.current[t.id] = el;
              }}
              onClick={() => onSelectTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}

interface MainContentProps {
  tab: string;
  visitedTabs: Set<string>;
  mainRef: RefObject<HTMLElement | null>;
  dropsProps: {
    filters: DropsFiltersState;
    totalCount: number;
    pendingCount: number;
    generatedAt: number | null;
    xUnavailable: boolean;
    loading: boolean;
    failed: boolean;
    searchRef: RefObject<HTMLInputElement | null>;
    onApplyPending: () => void;
    onCopyBrief: (item: FeedItem) => void;
  };
  airdropsProps: {
    filters: AirdropFiltersState;
    cardCount: number;
    tgeItems: Tge[];
    hasFeed: boolean;
    loading: boolean;
    failed: boolean;
    isLive: boolean;
    saved: Set<string>;
    doneTasks: Set<string>;
    searchRef: RefObject<HTMLInputElement | null>;
    onToggleSaved: (name: string) => void;
    onSelectDetail: (card: Card) => void;
    onCopyBrief: (card: Card) => void;
  };
  mountedMarkets: MarketSection[];
  marketsLoading: boolean;
  marketsFailed: boolean;
  sectors?: MarketSector[];
}

export function MainPanels({
  tab,
  visitedTabs,
  mainRef,
  dropsProps,
  airdropsProps,
  mountedMarkets,
  marketsLoading,
  marketsFailed,
  sectors,
}: MainContentProps) {
  const missingMarketSection =
    tab !== 'drops' && tab !== 'airdrops' && !mountedMarkets.some(s => s.id === tab);

  return (
    <main id="main" ref={mainRef} className="container" tabIndex={-1}>
      <div hidden={tab !== 'drops'}>
        <DropsPanel {...dropsProps} />
      </div>

      {visitedTabs.has('airdrops') && (
        <div hidden={tab !== 'airdrops'}>
          {airdropsProps.hasFeed ? (
            <ChunkErrorBoundary label="Airdrops">
              <Suspense fallback={<p className="note" role="status">Loading Airdrops…</p>}>
                <LazyAirdropPanel {...airdropsProps} />
              </Suspense>
            </ChunkErrorBoundary>
          ) : (
            <section role="tabpanel" id="panel-airdrops" aria-labelledby="tab-airdrops">
              {airdropsProps.loading ? (
                <p className="note" role="status">Loading airdrop data…</p>
              ) : airdropsProps.failed ? (
                <p className="empty" role="alert">Unable to load airdrop data. Please refresh to retry.</p>
              ) : (
                <p className="empty" role="status">No airdrop data available.</p>
              )}
            </section>
          )}
        </div>
      )}

      {mountedMarkets.map(section => (
        <div key={section.id} hidden={tab !== section.id}>
          {marketsFailed && (
            <p className="note" role="status">Market refresh failed. Showing the last available data.</p>
          )}
          <ChunkErrorBoundary label={section.title}>
            <Suspense fallback={<p className="note" role="status">Loading {section.title}…</p>}>
              <LazyMarketPanel
                section={section}
                sectors={section.id === 'crypto' ? sectors : undefined}
              />
            </Suspense>
          </ChunkErrorBoundary>
        </div>
      ))}

      {missingMarketSection && (
        <section role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
          {marketsLoading ? (
            <div className="loading-shell" role="status">
              <div className="loading-bar" />
              <p className="note">Loading market data…</p>
            </div>
          ) : marketsFailed ? (
            <p className="empty" role="alert">Unable to load market data. Please refresh to retry.</p>
          ) : (
            <p className="empty" role="status">No market data available for this section.</p>
          )}
        </section>
      )}
    </main>
  );
}
