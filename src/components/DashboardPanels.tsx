import { lazy, Suspense, type ComponentType, type RefObject } from 'react';
import { TABS } from '../../shared/constants';
import type { Card, FeedItem, MarketSection, MarketSector, Tge } from '../../shared/types';
import type { AirdropFiltersState } from '../hooks/useAirdropFilters';
import type { DropsFiltersState } from '../hooks/useDropsFilters';
import type { ProjectLogoIndex } from '../lib/visualAssets';
import { ChunkErrorBoundary } from './ChunkErrorBoundary';
import { DropsPanel } from './DropsPanel';
import {
  CoinsIcon,
  GitBranchIcon,
  LayersIcon,
  PercentIcon,
  SparklesIcon,
  TargetIcon,
  TrendingUpIcon,
  ZapIcon,
  type IconProps,
} from './Icons';

const LazyAirdropPanel = lazy(() => import('./AirdropPanel').then(m => ({ default: m.AirdropPanel })));
const LazyMarketPanel = lazy(() => import('./MarketPanel').then(m => ({ default: m.MarketPanel })));

const RADAR_IDS = new Set(['drops', 'airdrops']);
const RADAR_TABS = TABS.filter(t => RADAR_IDS.has(t.id));
const MARKET_TABS = TABS.filter(t => !RADAR_IDS.has(t.id));

const TAB_ICON: Record<string, ComponentType<IconProps>> = {
  drops: ZapIcon,
  airdrops: SparklesIcon,
  crypto: CoinsIcon,
  defi: LayersIcon,
  yields: PercentIcon,
  predictions: TargetIcon,
  trending: TrendingUpIcon,
  github: GitBranchIcon,
};

interface SidebarNavProps {
  tab: string;
  counts: { drops: number; airdrops: number };
  tabRefs: RefObject<Record<string, HTMLButtonElement | null>>;
  tabbarRef: RefObject<HTMLElement | null>;
  onSelectTab: (id: string) => void;
  onTabKey: (e: React.KeyboardEvent) => void;
}

function SidebarTabButton({
  id,
  label,
  selected,
  count,
  tabRefs,
  onSelectTab,
}: {
  id: string;
  label: string;
  selected: boolean;
  count?: number;
  tabRefs: RefObject<Record<string, HTMLButtonElement | null>>;
  onSelectTab: (id: string) => void;
}) {
  const Icon = TAB_ICON[id];
  return (
    <button
      type="button"
      id={`tab-${id}`}
      role="tab"
      className="tab"
      aria-selected={selected}
      aria-controls={`panel-${id}`}
      tabIndex={selected ? 0 : -1}
      ref={el => {
        tabRefs.current[id] = el;
      }}
      onClick={() => onSelectTab(id)}
    >
      {Icon && <Icon size={16} className="tab-icon" />}
      <span className="tab-label">{label}</span>
      {count !== undefined && count > 0 && <span className="tab-count mono">{count}</span>}
    </button>
  );
}

export function AppSidebarNav({
  tab,
  counts,
  tabRefs,
  tabbarRef,
  onSelectTab,
  onTabKey,
}: SidebarNavProps) {
  return (
    <aside className="app-sidebar tabbar" ref={tabbarRef}>
      <div className="sidenav-brand">
        <img
          className="logo"
          src={`${import.meta.env.BASE_URL}icon.svg`}
          alt=""
          width={34}
          height={34}
          decoding="async"
        />
        <div className="sidenav-brand-text">
          <span className="sidenav-brand-name">Web3 Radar</span>
          <span className="sidenav-brand-sub">Airdrop &amp; Market Intel</span>
        </div>
      </div>

      <nav className="sidenav-nav" aria-label="Dashboard sections">
        <div
          role="tablist"
          aria-label="Dashboard sections"
          className="tabstrip"
          onKeyDown={onTabKey}
        >
          <span className="nav-group-label" role="presentation" aria-hidden="true">
            RADAR
          </span>
          {RADAR_TABS.map(t => (
            <SidebarTabButton
              key={t.id}
              id={t.id}
              label={t.label}
              selected={t.id === tab}
              count={t.id === 'drops' ? counts.drops : counts.airdrops}
              tabRefs={tabRefs}
              onSelectTab={onSelectTab}
            />
          ))}

          <span className="nav-group-label" role="presentation" aria-hidden="true">
            MARKETS
          </span>
          {MARKET_TABS.map(t => (
            <SidebarTabButton
              key={t.id}
              id={t.id}
              label={t.label}
              selected={t.id === tab}
              tabRefs={tabRefs}
              onSelectTab={onSelectTab}
            />
          ))}
        </div>
      </nav>

      <div className="sidenav-footer" aria-hidden="true">
        <span className="sidenav-shortcut">
          <kbd className="kbd-hint">/</kbd>
          <span>Search</span>
        </span>
        <span className="sidenav-shortcut">
          <kbd className="kbd-hint">↑↓</kbd>
          <span>Tabs</span>
        </span>
      </div>
    </aside>
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
    logoIndex?: ProjectLogoIndex;
    searchRef: RefObject<HTMLInputElement | null>;
    onApplyPending: () => void;
    onCopyBrief: (item: FeedItem) => void;
  };
  airdropsProps: {
    filters: AirdropFiltersState;
    cardCount: number;
    tgeItems: Tge[];
    fetchedAt: number | null;
    hasFeed: boolean;
    loading: boolean;
    failed: boolean;
    isLive: boolean;
    saved: Set<string>;
    doneTasks: Set<string>;
    logoIndex?: ProjectLogoIndex;
    searchRef: RefObject<HTMLInputElement | null>;
    onToggleSaved: (name: string, legacyKey?: string) => void;
    onSelectDetail: (card: Card) => void;
    onCopyBrief: (card: Card) => void;
  };
  mountedMarkets: MarketSection[];
  marketsLoading: boolean;
  marketsFailed: boolean;
  marketSearchRef?: RefObject<HTMLInputElement | null>;
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
  marketSearchRef,
  sectors,
}: MainContentProps) {
  const missingMarketSection =
    tab !== 'drops' && tab !== 'airdrops' && !mountedMarkets.some(s => s.id === tab);

  return (
    <main id="main" ref={mainRef} className="app-content" tabIndex={-1}>
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
                searchRef={section.id === tab ? marketSearchRef : undefined}
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
