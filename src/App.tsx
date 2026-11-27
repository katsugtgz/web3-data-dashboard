import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FIT, TYPE_MAP } from '../shared/constants';
import type { Card, FeedItem, Tge } from '../shared/types';
import { AgentProfileDialog } from './components/AgentProfileDialog';
import { ChunkErrorBoundary } from './components/ChunkErrorBoundary';
import { DashboardFooter } from './components/DashboardFooter';
import { DashboardHeader } from './components/DashboardHeader';
import { AppSidebarNav, MainPanels } from './components/DashboardPanels';
import { Toast } from './components/Toast';
import { useAgentProfile } from './hooks/useAgentProfile';
import { useAirdropFeed } from './hooks/useAirdropFeed';
import { useAirdropFilters } from './hooks/useAirdropFilters';
import { useCopyBriefController } from './hooks/useCopyBriefController';
import { useDashboardDerived } from './hooks/useDashboardDerived';
import { getTabGroupMeta, useDashboardTabs } from './hooks/useDashboardTabs';
import { useDetailSelection } from './hooks/useDetailSelection';
import { useDropsFilters } from './hooks/useDropsFilters';
import { useFeed } from './hooks/useFeed';
import { useMarkets } from './hooks/useMarkets';
import { useSourcesHealth } from './hooks/useSourcesHealth';
import { useTheme } from './hooks/useTheme';
import { isCardSaved, useWatchlist } from './hooks/useWatchlist';
import { indexRadarCards } from './lib/feedDisplay';
import { buildProjectLogoIndex } from './lib/visualAssets';

const DetailDialog = lazy(() => import('./components/DetailDialog').then(m => ({ default: m.DetailDialog })));
const DropsDetailDialog = lazy(() =>
  import('./components/DropsDetailDialog').then(m => ({ default: m.DropsDetailDialog })),
);
const EMPTY_CARDS: Card[] = [];
const EMPTY_TGE: Tge[] = [];

/** The selected drop, looked up in the live feed. Null when nothing is selected or the drop left the feed. */
function resolveDropsDetail(items: readonly FeedItem[], id: string | null): FeedItem | null {
  if (id === null) return null;
  return items.find(item => item.id === id) ?? null;
}

export default function App() {
  const reconcileCardsRef = useRef<((nextCards: readonly Card[]) => void) | null>(null);
  const handleAirdropCardsChange = useCallback((nextCards: readonly Card[]) => {
    reconcileCardsRef.current?.(nextCards);
  }, []);

  const drops = useFeed();
  const airdrops = useAirdropFeed(handleAirdropCardsChange);
  const cards = airdrops.feed?.cards ?? EMPTY_CARDS;
  const radarIndex = useMemo(() => indexRadarCards(cards), [cards]);
  const [dropsDetailId, setDropsDetailId] = useState<string | null>(null);
  const {
    markets,
    loading: marketsLoading,
    failed: marketsFailed,
    isLiveApi: marketsIsLiveApi,
    refresh: refreshMarkets,
  } = useMarkets();
  const { sources, loading: sourcesLoading, isLiveApi: sourcesIsLiveApi, failed: sourcesFailed, refresh: refreshSources } = useSourcesHealth();
  const {
    saved,
    doneTasks,
    toggleSaved,
    toggleTaskDone,
    reconcileCards: reconcileWatchlistCards,
  } = useWatchlist(cards);
  const { profile, hasConfigured, saveProfile } = useAgentProfile();
  const theme = useTheme();

  // Entire copy-agent-brief flow (region-scoped outcome reporting, first-copy
  // profile gate, risk revalidation vs. the live feeds) lives in this hook.
  const copyFlow = useCopyBriefController({
    hasConfigured,
    profile,
    saveProfile,
    getVisibleItems: drops.getVisibleItems,
    getVisibleCards: airdrops.getVisibleCards,
  });
  const { handleCopyBrief, copyStatus, clearCopyStatus, toast, dismissToast } = copyFlow;

  // Resolved against the live feed on every render: a refresh updates the open drawer, a removal closes it.
  const dropsDetail = resolveDropsDetail(drops.items, dropsDetailId);
  const handleSelectDropsDetail = useCallback(
    (item: FeedItem) => {
      clearCopyStatus();
      setDropsDetailId(item.id);
    },
    [clearCopyStatus],
  );
  const handleCloseDropsDetail = useCallback(() => {
    clearCopyStatus();
    setDropsDetailId(null);
  }, [clearCopyStatus]);

  const tgeItems = airdrops.feed?.tge ?? EMPTY_TGE;
  const projectLogoIndex = useMemo(
    () =>
      buildProjectLogoIndex(cards, markets?.sections, {
        tge: tgeItems,
        feedItems: drops.items,
      }),
    [cards, markets?.sections, tgeItems, drops.items],
  );
  const {
    detail,
    handleSelectDetail,
    handleCloseDetail,
    reconcileCards: reconcileDetailCards,
  } = useDetailSelection(cards, clearCopyStatus);

  useEffect(() => {
    reconcileCardsRef.current = (nextCards: readonly Card[]) => {
      reconcileDetailCards(nextCards);
      reconcileWatchlistCards(nextCards);
    };
  }, [reconcileDetailCards, reconcileWatchlistCards]);

  const dropsSearchRef = useRef<HTMLInputElement>(null);
  const airdropSearchRef = useRef<HTMLInputElement>(null);
  const marketSearchRef = useRef<HTMLInputElement>(null);

  const { tab, visitedTabs, tabRefs, tabbarRef, selectTab, onTabKey } = useDashboardTabs({
    searchRefs: { drops: dropsSearchRef, airdrops: airdropSearchRef, markets: marketSearchRef },
    isModalOpen: () => Boolean(detail) || dropsDetail !== null || copyFlow.profileOpen,
  });

  const airdropFilters = useAirdropFilters(cards, saved, TYPE_MAP);
  const dropsFilters = useDropsFilters(drops.items, tab === 'drops');
  const { flushHashSync } = dropsFilters;

  const handleSelectTab = useCallback(
    (nextId: string) => {
      if (tab === 'drops' && nextId !== 'drops') {
        flushHashSync();
      }
      selectTab(nextId);
    },
    [flushHashSync, selectTab, tab],
  );

  const mainRef = useRef<HTMLElement>(null);

  const handleRefresh = useCallback(() => {
    drops.refresh();
    airdrops.refresh();
    refreshMarkets();
    refreshSources();
  }, [drops, airdrops, refreshMarkets, refreshSources]);

  /** Radar cross-link: leave the drawer, switch to the Airdrops tab, and open the matched curated card. */
  const handleOpenRadar = useCallback(
    (card: Card) => {
      setDropsDetailId(null);
      handleSelectTab('airdrops');
      handleSelectDetail(card);
    },
    [handleSelectTab, handleSelectDetail],
  );

  const {
    xUnavailable,
    mountedMarkets,
    totalCount,
    headerFetchedAt,
    headerFailed,
    headerIsLiveApi,
    headerStale,
    isMarketTab,
  } = useDashboardDerived({
    sources,
    marketSections: markets?.sections ?? null,
    marketsGeneratedAt: markets?.generatedAt ?? null,
    marketsFailed,
    marketsIsLiveApi,
    visitedTabs,
    tab,
    dropsCount: drops.items.length,
    dropsGeneratedAt: drops.generatedAt,
    dropsFailed: drops.failed,
    dropsIsLiveApi: drops.isLiveApi,
    airdropsFetchedAt: airdrops.feed?.fetchedAt ?? null,
    airdropsFailed: airdrops.failed,
    airdropsIsLiveApi: airdrops.isLiveApi,
    cardsCount: cards.length,
  });
  const activeTabMeta = getTabGroupMeta(tab);

  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>

      <div className="app-shell">
        <AppSidebarNav
          tab={tab}
          counts={{ drops: drops.items.length, airdrops: cards.length }}
          tabRefs={tabRefs}
          tabbarRef={tabbarRef}
          onSelectTab={handleSelectTab}
          onTabKey={onTabKey}
        />

        <div className="app-main-col">
          <DashboardHeader
            activeTabLabel={activeTabMeta.label}
            activeSectionGroup={activeTabMeta.group}
            cardCount={totalCount}
            fetchedAt={headerFetchedAt}
            loading={drops.loading || airdrops.loading || marketsLoading}
            failed={headerFailed}
            isLiveApi={headerIsLiveApi}
            isStale={headerStale}
            isMarketTab={isMarketTab}
            resolvedTheme={theme.resolved}
            onRefresh={handleRefresh}
            onOpenProfile={copyFlow.openProfile}
            onToggleTheme={theme.toggle}
          />

          <MainPanels
            tab={tab}
            visitedTabs={visitedTabs}
            mainRef={mainRef}
            dropsProps={{
              filters: dropsFilters,
              totalCount: drops.items.length,
              pendingCount: drops.pendingCount,
              generatedAt: drops.generatedAt,
              xUnavailable,
              loading: drops.loading,
              failed: drops.failed,
              logoIndex: projectLogoIndex,
              radarIndex,
              searchRef: dropsSearchRef,
              onApplyPending: drops.applyPending,
              onSelectDetail: handleSelectDropsDetail,
              onCopyBrief: handleCopyBrief,
              onOpenRadar: handleOpenRadar,
            }}
            airdropsProps={{
              filters: airdropFilters,
              cardCount: cards.length,
              cards,
              tgeItems,
              fetchedAt: airdrops.feed?.fetchedAt ?? null,
              hasFeed: airdrops.feed !== null,
              loading: airdrops.loading,
              failed: airdrops.failed,
              isLive: airdrops.isLiveApi,
              saved,
              doneTasks,
              logoIndex: projectLogoIndex,
              searchRef: airdropSearchRef,
              onToggleSaved: toggleSaved,
              onSelectDetail: handleSelectDetail,
              onCopyBrief: (card: Card) => handleCopyBrief(card, 'page'),
            }}
            mountedMarkets={mountedMarkets}
            marketsLoading={marketsLoading}
            marketsFailed={marketsFailed}
            marketSearchRef={marketSearchRef}
            sectors={markets?.sectors}
          />

          <DashboardFooter
            preCount={airdropFilters.counts.pre}
            dropsCount={drops.items.length}
            sources={sources}
            sourcesLoading={sourcesLoading}
            sourcesIsLiveApi={sourcesIsLiveApi}
            sourcesFailed={sourcesFailed}
          />
        </div>
      </div>

      <AgentProfileDialog
        open={copyFlow.profileOpen}
        profile={profile}
        onSave={copyFlow.handleSaveProfile}
        copyStatus={copyStatus?.target === 'profile' ? copyStatus : null}
        pendingCopyName={copyFlow.pendingCopyName}
        onCopyPending={copyFlow.copyPendingNow}
        onClose={copyFlow.closeProfile}
      />

      {dropsDetail && (
        <ChunkErrorBoundary label="drop details" onReset={handleCloseDropsDetail}>
          <Suspense fallback={null}>
            <DropsDetailDialog
              item={dropsDetail}
              radarIndex={radarIndex}
              profile={profile}
              logoIndex={projectLogoIndex}
              copyStatus={copyStatus}
              onCopyBrief={(item: FeedItem) => handleCopyBrief(item, 'detail')}
              onOpenRadar={handleOpenRadar}
              onClose={handleCloseDropsDetail}
            />
          </Suspense>
        </ChunkErrorBoundary>
      )}

      {detail && (
        <ChunkErrorBoundary label="project details" onReset={handleCloseDetail}>
          <Suspense fallback={null}>
            <DetailDialog
              card={detail}
              fit={FIT}
              profile={profile}
              saved={isCardSaved(saved, detail)}
              doneTasks={doneTasks}
              onToggleSaved={toggleSaved}
              onToggleTask={toggleTaskDone}
              copyStatus={copyStatus?.target === 'detail' ? copyStatus : null}
              onCopyBrief={(card: Card) => handleCopyBrief(card, 'detail')}
              onClose={handleCloseDetail}
            />
          </Suspense>
        </ChunkErrorBoundary>
      )}

      <Toast toast={toast} onDismiss={dismissToast} />
    </>
  );
}
