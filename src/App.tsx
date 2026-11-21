import { lazy, Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { FIT, TABS, TYPE_MAP } from '../shared/constants';
import type { Card } from '../shared/types';
import { AirdropPanel } from './components/AirdropPanel';
import { ChunkErrorBoundary } from './components/ChunkErrorBoundary';
import { DashboardHeader } from './components/DashboardHeader';
import { useAirdropFeed } from './hooks/useAirdropFeed';
import { useAirdropFilters } from './hooks/useAirdropFilters';
import { useMarkets } from './hooks/useMarkets';
import { useTheme } from './hooks/useTheme';
import { useWatchlist } from './hooks/useWatchlist';

const MarketPanel = lazy(() => import('./components/MarketPanel').then(m => ({ default: m.MarketPanel })));
const DetailDialog = lazy(() => import('./components/DetailDialog').then(m => ({ default: m.DetailDialog })));

function findHashTab(): string {
  const raw = window.location.hash.replace(/^#/, '').split('?')[0];
  return TABS.some(t => t.id === raw) ? raw : TABS[0].id;
}

export default function App() {
  const { feed, loading: feedLoading, failed: feedFailed, isLiveApi, refresh: refreshFeed } = useAirdropFeed();
  const { markets, loading: marketsLoading, refresh: refreshMarkets } = useMarkets();
  const { saved, doneTasks, toggleSaved, toggleTaskDone } = useWatchlist();
  const theme = useTheme();

  const cards = feed?.cards ?? [];
  const tgeItems = feed?.tge ?? [];
  const filters = useAirdropFilters(cards, saved, TYPE_MAP);

  const [tab, setTab] = useState<string>(() => findHashTab());
  const [visitedTabs, setVisitedTabs] = useState<Set<string>>(() => new Set([findHashTab()]));
  const [detail, setDetail] = useState<Card | null>(null);

  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const searchRef = useRef<HTMLInputElement>(null);
  const tabbarRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);

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
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || detail || tab !== 'airdrops') return;
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
      if (searchRef.current) {
        e.preventDefault();
        searchRef.current.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab, detail]);

  const onTabKey = (e: KeyboardEvent) => {
    const ids = TABS.map(t => t.id);
    let i = ids.indexOf(tab);
    if (e.key === 'ArrowRight') i = (i + 1) % ids.length;
    else if (e.key === 'ArrowLeft') i = (i - 1 + ids.length) % ids.length;
    else if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = ids.length - 1;
    else return;
    e.preventDefault();
    selectTab(ids[i]);
    tabRefs.current[ids[i]]?.focus();
  };

  const handleRefresh = useCallback(() => {
    refreshFeed();
    refreshMarkets();
  }, [refreshFeed, refreshMarkets]);

  const mountedMarkets = (markets?.sections ?? []).filter(s => visitedTabs.has(s.id));

  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>

      <DashboardHeader
        cardCount={cards.length}
        fetchedAt={feed?.fetchedAt ?? null}
        loading={feedLoading || marketsLoading}
        failed={feedFailed}
        isLiveApi={isLiveApi}
        resolvedTheme={theme.resolved}
        onRefresh={handleRefresh}
        onToggleTheme={theme.toggle}
      />

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
                onClick={() => selectTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </nav>
      </div>

      <main id="main" ref={mainRef} className="container" tabIndex={-1}>
        <div hidden={tab !== 'airdrops'}>
          {!feed && feedLoading ? (
            <div className="loading-shell" role="status" aria-live="polite">
              <div className="loading-bar" />
              <p className="note">Loading airdrop radar…</p>
            </div>
          ) : !feed && feedFailed ? (
            <p className="empty" role="alert">
              Unable to load airdrop feed. Please refresh to retry.
            </p>
          ) : (
            <AirdropPanel
              filters={filters}
              cardCount={cards.length}
              tgeItems={tgeItems}
              isLive={isLiveApi}
              saved={saved}
              doneTasks={doneTasks}
              searchRef={searchRef}
              onToggleSaved={toggleSaved}
              onSelectDetail={setDetail}
            />
          )}
        </div>

        {mountedMarkets.map(section => (
          <div key={section.id} hidden={tab !== section.id}>
            <ChunkErrorBoundary label={section.title}>
              <Suspense fallback={<p className="note" role="status">Loading {section.title}…</p>}>
                <MarketPanel section={section} sectors={section.id === 'crypto' ? markets?.sectors : undefined} />
              </Suspense>
            </ChunkErrorBoundary>
          </div>
        ))}

        {tab !== 'airdrops' && !mountedMarkets.some(s => s.id === tab) && (
          <div className="loading-shell" role="status" aria-live="polite">
            <div className="loading-bar" />
            <p className="note">Loading market data…</p>
          </div>
        )}
      </main>

      <footer>
        <div className="container footer-inner">
          <p>
            Web3 Radar · <span className="mono">{filters.counts.pre}</span> pre-token projects tracked · Keyless data
            from{' '}
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
            , and{' '}
            <a href="https://dexscreener.com" target="_blank" rel="noopener noreferrer">
              DexScreener
              <span className="sr"> (opens in a new tab)</span>
            </a>
            . Not financial advice.
          </p>
        </div>
      </footer>

      {detail && (
        <ChunkErrorBoundary label="project details">
          <Suspense fallback={null}>
            <DetailDialog
              card={detail}
              fit={FIT}
              saved={saved.has(detail.n)}
              doneTasks={doneTasks}
              onToggleSaved={toggleSaved}
              onToggleTask={toggleTaskDone}
              onClose={() => setDetail(null)}
            />
          </Suspense>
        </ChunkErrorBoundary>
      )}
    </>
  );
}
