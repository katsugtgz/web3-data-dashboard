import { lazy, Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { FIT, TABS, TYPE_MAP } from '../shared/constants';
import type { AgentProfile, Card, FeedItem } from '../shared/types';
import { AgentProfileDialog } from './components/AgentProfileDialog';
import { ChunkErrorBoundary } from './components/ChunkErrorBoundary';
import { DashboardHeader } from './components/DashboardHeader';
import { MainPanels, TabNav } from './components/DashboardPanels';
import { SourcesHealthPopover } from './components/SourcesHealthPopover';
import { Toast, type ToastState } from './components/Toast';
import { useAgentProfile } from './hooks/useAgentProfile';
import { useAirdropFeed } from './hooks/useAirdropFeed';
import { useAirdropFilters } from './hooks/useAirdropFilters';
import { useDropsFilters } from './hooks/useDropsFilters';
import { useFeed } from './hooks/useFeed';
import { useMarkets } from './hooks/useMarkets';
import { useSourcesHealth } from './hooks/useSourcesHealth';
import { useTheme } from './hooks/useTheme';
import { useWatchlist } from './hooks/useWatchlist';
import { buildBrief, isFeedItem } from './lib/agentBrief';
import { copyText } from './lib/clipboard';

const DetailDialog = lazy(() => import('./components/DetailDialog').then(m => ({ default: m.DetailDialog })));

function findHashTab(): string {
  const raw = window.location.hash.replace(/^#/, '').split('?')[0];
  return TABS.some(t => t.id === raw) ? raw : TABS[0].id;
}

export default function App() {
  const drops = useFeed();
  const airdrops = useAirdropFeed();
  const { markets, loading: marketsLoading, refresh: refreshMarkets } = useMarkets();
  const { sources, loading: sourcesLoading, refresh: refreshSources } = useSourcesHealth();
  const { saved, doneTasks, toggleSaved, toggleTaskDone } = useWatchlist();
  const { profile, hasConfigured, saveProfile } = useAgentProfile();
  const theme = useTheme();

  const [tab, setTab] = useState<string>(() => findHashTab());
  const [visitedTabs, setVisitedTabs] = useState<Set<string>>(() => new Set([findHashTab()]));
  const [detail, setDetail] = useState<Card | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);

  const pendingCopyTargetRef = useRef<FeedItem | Card | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cards = airdrops.feed?.cards ?? [];
  const tgeItems = airdrops.feed?.tge ?? [];
  const airdropFilters = useAirdropFilters(cards, saved, TYPE_MAP);
  const dropsFilters = useDropsFilters(drops.items, tab === 'drops');

  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const dropsSearchRef = useRef<HTMLInputElement>(null);
  const airdropSearchRef = useRef<HTMLInputElement>(null);
  const tabbarRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);

  const showToast = useCallback((message: string, tone: ToastState['tone'] = 'ok') => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ message, tone });
    toastTimerRef.current = setTimeout(() => setToast(null), 4500);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  const executeCopyBrief = useCallback(
    (target: FeedItem | Card, activeProfile: AgentProfile) => {
      const md = buildBrief(target, activeProfile);
      if (!md) {
        showToast('Brief unavailable for RISK items.', 'warn');
        return;
      }
      copyText(md).then(ok => {
        if (!ok) {
          showToast('Clipboard blocked — open Preview in details to copy.', 'warn');
          return;
        }
        const isWarn = isFeedItem(target) ? target.risk.level === 'warn' : target.b.includes('risk');
        const label = isFeedItem(target) ? target.project : target.n;
        showToast(
          isWarn
            ? `Copied ${label} brief (WARN item — verify links before running).`
            : `Copied ${label} agent brief to clipboard.`,
          isWarn ? 'warn' : 'ok',
        );
      });
    },
    [showToast],
  );

  const handleCopyBrief = useCallback(
    (target: FeedItem | Card) => {
      if (!hasConfigured) {
        pendingCopyTargetRef.current = target;
        setProfileOpen(true);
        return;
      }
      executeCopyBrief(target, profile);
    },
    [hasConfigured, profile, executeCopyBrief],
  );

  const handleSaveProfile = useCallback(
    (next: AgentProfile) => {
      const savedProfile = saveProfile(next);
      const target = pendingCopyTargetRef.current;
      if (target) {
        pendingCopyTargetRef.current = null;
        executeCopyBrief(target, savedProfile);
      } else {
        showToast('Agent environment profile saved locally.');
      }
    },
    [saveProfile, executeCopyBrief, showToast],
  );

  const markVisited = useCallback((nextId: string) => {
    setVisitedTabs(prev => (prev.has(nextId) ? prev : new Set(prev).add(nextId)));
  }, []);

  const selectTab = useCallback(
    (nextId: string) => {
      if (!TABS.some(t => t.id === nextId)) return;
      setTab(nextId);
      markVisited(nextId);
      history.replaceState(null, '', `#${nextId}`);
      if (mainRef.current) {
        const barHeight = tabbarRef.current?.offsetHeight ?? 48;
        const mainTop = mainRef.current.getBoundingClientRect().top + window.scrollY;
        if (window.scrollY > mainTop - barHeight) {
          window.scrollTo({ top: Math.max(0, mainTop - barHeight - 8), behavior: 'smooth' });
        }
      }
    },
    [markVisited],
  );

  useEffect(() => {
    const onHash = () => {
      const next = findHashTab();
      setTab(next);
      markVisited(next);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [markVisited]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || detail || profileOpen) return;
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
      const targetRef = tab === 'drops' ? dropsSearchRef.current : tab === 'airdrops' ? airdropSearchRef.current : null;
      if (targetRef) {
        e.preventDefault();
        targetRef.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab, detail, profileOpen]);

  const onTabKey = (e: KeyboardEvent) => {
    const ids = TABS.map(t => t.id);
    const cur = ids.indexOf(tab);
    const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const nextIdx =
      delta !== 0
        ? (cur + delta + ids.length) % ids.length
        : e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? ids.length - 1
            : -1;
    if (nextIdx < 0) return;
    e.preventDefault();
    selectTab(ids[nextIdx]);
    tabRefs.current[ids[nextIdx]]?.focus();
  };

  const handleRefresh = useCallback(() => {
    drops.refresh();
    airdrops.refresh();
    refreshMarkets();
    refreshSources();
  }, [drops, airdrops, refreshMarkets, refreshSources]);

  const xSources = sources.filter(s => s.platform === 'x');
  const xUnavailable = xSources.length > 0 && xSources.every(s => s.status === 'down');
  const mountedMarkets = (markets?.sections ?? []).filter(s => visitedTabs.has(s.id));
  const totalCount = tab === 'drops' ? drops.items.length : cards.length;
  const headerFetchedAt =
    tab === 'drops' ? (drops.generatedAt ?? airdrops.feed?.fetchedAt ?? null) : (airdrops.feed?.fetchedAt ?? null);

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
        onOpenProfile={() => {
          pendingCopyTargetRef.current = null;
          setProfileOpen(true);
        }}
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
          onCopyBrief: handleCopyBrief,
        }}
        mountedMarkets={mountedMarkets}
        sectors={markets?.sectors}
      />

      <footer>
        <div className="container footer-inner footer-row">
          <p>
            Web3 Radar · <span className="mono">{airdropFilters.counts.pre}</span> curated pre-token projects &amp;{' '}
            <span className="mono">{drops.items.length}</span> live drops · Keyless data from{' '}
            <a href="https://cryptorank.io" target="_blank" rel="noopener noreferrer">
              CryptoRank
              <span className="sr"> (opens in a new tab)</span>
            </a>
            ,{' '}
            <a href="https://www.coingecko.com" target="_blank" rel="noopener noreferrer">
              CoinGecko
              <span className="sr"> (opens in a new tab)</span>
            </a>
            ,{' '}
            <a href="https://defillama.com" target="_blank" rel="noopener noreferrer">
              DefiLlama
              <span className="sr"> (opens in a new tab)</span>
            </a>
            ,{' '}
            <a href="https://polymarket.com" target="_blank" rel="noopener noreferrer">
              Polymarket
              <span className="sr"> (opens in a new tab)</span>
            </a>
            , and public Telegram channels. Not financial advice.
          </p>
          <SourcesHealthPopover sources={sources} loading={sourcesLoading} />
        </div>
      </footer>

      <AgentProfileDialog
        open={profileOpen}
        profile={profile}
        onSave={handleSaveProfile}
        onClose={() => {
          pendingCopyTargetRef.current = null;
          setProfileOpen(false);
        }}
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
              onCopyBrief={handleCopyBrief}
              onClose={() => setDetail(null)}
            />
          </Suspense>
        </ChunkErrorBoundary>
      )}

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </>
  );
}
