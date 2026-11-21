import { lazy, Suspense, type RefObject } from 'react';
import { TABS } from '../../shared/constants';
import type { Card, MarketSection, MarketSector, Tge } from '../../shared/types';
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
        <div role="tablist" className="tabstrip" onKeyDown={onTabKey}>
          {TABS.map(t => (
            <button
              key={t.id}
              type="button"
              id={`tab-${t.id}`}
              role="tab"
              className="tab"
              aria-selected={t.id === tab}
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
    loading: boolean;
    failed: boolean;
    searchRef: RefObject<HTMLInputElement | null>;
    onApplyPending: () => void;
  };
  airdropsProps: {
    filters: AirdropFiltersState;
    cardCount: number;
    tgeItems: Tge[];
    isLive: boolean;
    saved: Set<string>;
    doneTasks: Set<string>;
    searchRef: RefObject<HTMLInputElement | null>;
    onToggleSaved: (name: string) => void;
    onSelectDetail: (card: Card) => void;
  };
  mountedMarkets: MarketSection[];
  sectors?: MarketSector[];
}

export function MainPanels({
  tab,
  visitedTabs,
  mainRef,
  dropsProps,
  airdropsProps,
  mountedMarkets,
  sectors,
}: MainContentProps) {
  const showMarketLoading =
    tab !== 'drops' && tab !== 'airdrops' && !mountedMarkets.some(s => s.id === tab);

  return (
    <main id="main" ref={mainRef} className="container" tabIndex={-1}>
      <div hidden={tab !== 'drops'}>
        <DropsPanel {...dropsProps} />
      </div>

      {visitedTabs.has('airdrops') && (
        <div hidden={tab !== 'airdrops'}>
          <ChunkErrorBoundary label="Airdrops">
            <Suspense fallback={<p className="note" role="status">Loading Airdrops…</p>}>
              <LazyAirdropPanel {...airdropsProps} />
            </Suspense>
          </ChunkErrorBoundary>
        </div>
      )}

      {mountedMarkets.map(section => (
        <div key={section.id} hidden={tab !== section.id}>
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

      {showMarketLoading && (
        <div className="loading-shell" role="status" aria-live="polite">
          <div className="loading-bar" />
          <p className="note">Loading market data…</p>
        </div>
      )}
    </main>
  );
}
