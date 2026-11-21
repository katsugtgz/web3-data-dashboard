import { lazy, Suspense, useCallback, useRef, useState } from 'react';
import { FIT, TYPE_MAP } from '../shared/constants';
import type { Card } from '../shared/types';
import { AgentProfileDialog } from './components/AgentProfileDialog';
import { ChunkErrorBoundary } from './components/ChunkErrorBoundary';
import { DashboardFooter } from './components/DashboardFooter';
import { DashboardHeader } from './components/DashboardHeader';
import { MainPanels, TabNav } from './components/DashboardPanels';
import { Toast } from './components/Toast';
import { useAgentProfile } from './hooks/useAgentProfile';
import { useAirdropFeed } from './hooks/useAirdropFeed';
import { useAirdropFilters } from './hooks/useAirdropFilters';
import { useCopyBriefController } from './hooks/useCopyBriefController';
import { useDashboardDerived } from './hooks/useDashboardDerived';
import { useDashboardTabs } from './hooks/useDashboardTabs';
import { useDropsFilters } from './hooks/useDropsFilters';
import { useFeed } from './hooks/useFeed';
import { useMarkets } from './hooks/useMarkets';
import { useSourcesHealth } from './hooks/useSourcesHealth';
import { useTheme } from './hooks/useTheme';
import { useWatchlist } from './hooks/useWatchlist';

const DetailDialog = lazy(() => import('./components/DetailDialog').then(m => ({ default: m.DetailDialog })));

export default function App() {
  const drops = useFeed();
  const airdrops = useAirdropFeed();
  const { markets, loading: marketsLoading, refresh: refreshMarkets } = useMarkets();
  const { sources, loading: sourcesLoading, refresh: refreshSources } = useSourcesHealth();
  const { saved, doneTasks, toggleSaved, toggleTaskDone } = useWatchlist();
  const { profile, hasConfigured, saveProfile } = useAgentProfile();
  const theme = useTheme();

  const [detail, setDetail] = useState<Card | null>(null);

  // Entire copy-agent-brief flow (region-scoped outcome reporting, first-copy
  // profile gate, risk revalidation vs. the live feed) lives in this hook.
  const copyFlow = useCopyBriefController({
    hasConfigured,
    profile,
    saveProfile,
    getVisibleItems: drops.getVisibleItems,
  });
  const { handleCopyBrief, copyStatus, toast, dismissToast } = copyFlow;

  const dropsSearchRef = useRef<HTMLInputElement>(null);
  const airdropSearchRef = useRef<HTMLInputElement>(null);

  const { tab, visitedTabs, tabRefs, tabbarRef, selectTab, onTabKey } = useDashboardTabs({
    searchRefs: { drops: dropsSearchRef, airdrops: airdropSearchRef },
    isModalOpen: () => Boolean(detail) || copyFlow.profileOpen,
  });

  const cards = airdrops.feed?.cards ?? [];
  const tgeItems = airdrops.feed?.tge ?? [];
  const airdropFilters = useAirdropFilters(cards, saved, TYPE_MAP);
  const dropsFilters = useDropsFilters(drops.items);

  const mainRef = useRef<HTMLElement>(null);

  const handleRefresh = useCallback(() => {
    drops.refresh();
    airdrops.refresh();
    refreshMarkets();
    refreshSources();
  }, [drops, airdrops, refreshMarkets, refreshSources]);

  const { xUnavailable, mountedMarkets, totalCount, headerFetchedAt } = useDashboardDerived({
    sources,
    marketSections: markets?.sections ?? null,
    visitedTabs,
    tab,
    dropsCount: drops.items.length,
    dropsGeneratedAt: drops.generatedAt,
    airdropsFetchedAt: airdrops.feed?.fetchedAt ?? null,
    cardsCount: cards.length,
  });

  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>

      <DashboardHeader
        cardCount={totalCount}
        fetchedAt={headerFetchedAt}
        loading={drops.loading || airdrops.loading || marketsLoading}
        failed={drops.failed && airdrops.failed}
        isLiveApi={airdrops.isLiveApi}
        resolvedTheme={theme.resolved}
        onRefresh={handleRefresh}
        onOpenProfile={copyFlow.openProfile}
        onToggleTheme={theme.toggle}
      />

      <TabNav
        tab={tab}
        tabRefs={tabRefs}
        tabbarRef={tabbarRef}
        onSelectTab={selectTab}
        onTabKey={onTabKey}
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
          isLive: airdrops.isLiveApi,
          saved,
          doneTasks,
          searchRef: airdropSearchRef,
          onToggleSaved: toggleSaved,
          onSelectDetail: setDetail,
          onCopyBrief: (card: Card) => handleCopyBrief(card, 'page'),
        }}
        mountedMarkets={mountedMarkets}
        sectors={markets?.sectors}
      />

      <DashboardFooter preCount={airdropFilters.counts.pre} dropsCount={drops.items.length} sources={sources} sourcesLoading={sourcesLoading} />


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
        <ChunkErrorBoundary label="project details">
          <Suspense fallback={null}>
            <DetailDialog
              card={detail}
              fit={FIT}
              profile={profile}
              saved={saved.has(detail.n)}
              doneTasks={doneTasks}
              onToggleSaved={toggleSaved}
              onToggleTask={toggleTaskDone}
              copyStatus={copyStatus?.target === 'detail' ? copyStatus : null}
              onCopyBrief={(card: Card) => handleCopyBrief(card, 'detail')}
              onClose={() => setDetail(null)}
            />
          </Suspense>
        </ChunkErrorBoundary>
      )}

      <Toast toast={toast} onDismiss={dismissToast} />
    </>
  );
}
