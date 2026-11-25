import { lazy, Suspense, useCallback, useEffect, useRef } from 'react';
import { FIT, TYPE_MAP } from '../shared/constants';
import type { Card } from '../shared/types';
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

const DetailDialog = lazy(() => import('./components/DetailDialog').then(m => ({ default: m.DetailDialog })));
const EMPTY_CARDS: Card[] = [];

export default function App() {
  const reconcileCardsRef = useRef<((nextCards: readonly Card[]) => void) | null>(null);
  const handleAirdropCardsChange = useCallback((nextCards: readonly Card[]) => {
    reconcileCardsRef.current?.(nextCards);
  }, []);

  const drops = useFeed();
  const airdrops = useAirdropFeed(handleAirdropCardsChange);
  const cards = airdrops.feed?.cards ?? EMPTY_CARDS;
  const {
    markets,
    loading: marketsLoading,
    failed: marketsFailed,
    isLiveApi: marketsIsLiveApi,
    refresh: refreshMarkets,
  } = useMarkets();
  const { sources, loading: sourcesLoading, isLiveApi: sourcesIsLiveApi, failed: sourcesFailed, refresh: refreshSources } = useSourcesHealth();
  const { saved, doneTasks, toggleSaved, toggleTaskDone } = useWatchlist(cards);
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

  const tgeItems = airdrops.feed?.tge ?? [];
  const { detail, handleSelectDetail, handleCloseDetail, reconcileCards } = useDetailSelection(cards, clearCopyStatus);

  useEffect(() => {
    reconcileCardsRef.current = reconcileCards;
  }, [reconcileCards]);

  const dropsSearchRef = useRef<HTMLInputElement>(null);
  const airdropSearchRef = useRef<HTMLInputElement>(null);
  const marketSearchRef = useRef<HTMLInputElement>(null);

  const { tab, visitedTabs, tabRefs, tabbarRef, selectTab, onTabKey } = useDashboardTabs({
    searchRefs: { drops: dropsSearchRef, airdrops: airdropSearchRef, markets: marketSearchRef },
    isModalOpen: () => Boolean(detail) || copyFlow.profileOpen,
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
              searchRef: dropsSearchRef,
              onApplyPending: drops.applyPending,
              onCopyBrief: handleCopyBrief,
            }}
            airdropsProps={{
              filters: airdropFilters,
              cardCount: cards.length,
              tgeItems,
              fetchedAt: airdrops.feed?.fetchedAt ?? null,
              hasFeed: airdrops.feed !== null,
              loading: airdrops.loading,
              failed: airdrops.failed,
              isLive: airdrops.isLiveApi,
              saved,
              doneTasks,
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
