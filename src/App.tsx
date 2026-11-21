import { lazy, Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Card, Dashboard } from '../shared/types';
import { AirdropPanel } from './components/AirdropPanel';
import { ChunkErrorBoundary } from './components/ChunkErrorBoundary';
import { DashboardHeader } from './components/DashboardHeader';
import { useAirdropFeed } from './hooks/useAirdropFeed';
import { useAirdropFilters } from './hooks/useAirdropFilters';
import { useDashboard } from './hooks/useDashboard';
import { useTheme } from './hooks/useTheme';
import { useWatchlist } from './hooks/useWatchlist';

const DemoPanel = lazy(() => import('./components/DemoPanel').then(m => ({ default: m.DemoPanel })));
const DetailDialog = lazy(() => import('./components/DetailDialog').then(m => ({ default: m.DetailDialog })));

function findHashTab(tabs: Dashboard['TABS']): string | null {
  const raw = window.location.hash.replace(/^#/, '');
  return tabs.some(t => t.id === raw) ? raw : null;
}

export default function App() {
  const { data, error } = useDashboard();
  if (error) {
    return (
      <div className="container" style={{ paddingTop: 48 }}>
        <p className="empty" role="alert">
          Failed to load dashboard: {error}
        </p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="container" style={{ paddingTop: 48 }}>
        <div className="loading-shell" role="status" aria-live="polite">
          <div className="loading-bar" />
          <p className="note">Loading Web3 Data Dashboard…</p>
        </div>
      </div>
    );
  }
  return <DashboardView data={data} />;
}

function DashboardView({ data }: { data: Dashboard }) {
  const { feed, loading, failed, refresh } = useAirdropFeed();
  const { saved, doneTasks, toggleSaved, toggleTaskDone } = useWatchlist();
  const theme = useTheme();

  const cards = feed?.cards ?? data.CARDS;
  const tgeItems = feed ? feed.tge : data.TGE;
  const isLive = feed !== null;
  const filters = useAirdropFilters(cards, saved, data.TYPE_MAP);

  const [tab, setTab] = useState<string>(() => findHashTab(data.TABS) ?? data.TABS[0].id);
  const [visitedTabs, setVisitedTabs] = useState<Set<string>>(
    () => new Set([findHashTab(data.TABS) ?? data.TABS[0].id]),
  );
  const [detail, setDetail] = useState<Card | null>(null);

  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const searchRef = useRef<HTMLInputElement>(null);
  const tabbarRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);

  const markVisited = useCallback((nextId: string) => {
    setVisitedTabs(prev => (prev.has(nextId) ? prev : new Set(prev).add(nextId)));
  }, []);

  const selectTab = useCallback(
    (nextId: string, scrollPanel = true) => {
      setTab(nextId);
      markVisited(nextId);
      if (window.location.hash !== `#${nextId}`) {
        window.history.replaceState(null, '', `#${nextId}`);
      }
      tabRefs.current[nextId]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      if (scrollPanel && mainRef.current && tabbarRef.current) {
        const mainTop = mainRef.current.getBoundingClientRect().top + window.scrollY;
        const barHeight = tabbarRef.current.offsetHeight;
        if (window.scrollY > mainTop - barHeight) {
          window.scrollTo({ top: Math.max(0, mainTop - barHeight - 8), behavior: 'smooth' });
        }
      }
    },
    [markVisited],
  );

  useEffect(() => {
    const onHash = () => {
      const next = findHashTab(data.TABS);
      if (next) {
        setTab(next);
        markVisited(next);
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [data.TABS, markVisited]);

  // Global `/` shortcut to jump to search on the Airdrops tab
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
    const ids = data.TABS.map(t => t.id);
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

  const mountedDemos = data.DEMO.filter(d => visitedTabs.has(d.id));

  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>

      <DashboardHeader
        cardCount={cards.length}
        fetchedAt={feed?.fetchedAt ?? null}
        loading={loading}
        failed={failed}
        resolvedTheme={theme.resolved}
        onRefresh={refresh}
        onToggleTheme={theme.toggle}
      />

      <div className="tabbar" ref={tabbarRef}>
        <nav className="container" aria-label="Dashboard sections">
          <div role="tablist" className="tabstrip" onKeyDown={onTabKey}>
            {data.TABS.map(t => (
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
          <AirdropPanel
            data={data}
            filters={filters}
            cardCount={cards.length}
            tgeItems={tgeItems}
            isLive={isLive}
            saved={saved}
            doneTasks={doneTasks}
            searchRef={searchRef}
            onToggleSaved={toggleSaved}
            onSelectDetail={setDetail}
          />
        </div>

        {mountedDemos.map(d => {
          const label = data.TABS.find(t => t.id === d.id)?.label ?? d.id;
          return (
            <div key={d.id} hidden={tab !== d.id}>
              <ChunkErrorBoundary label={label}>
                <Suspense fallback={<p className="note" role="status">Loading {label}…</p>}>
                  <DemoPanel section={d} label={label} />
                </Suspense>
              </ChunkErrorBoundary>
            </div>
          );
        })}
      </main>

      <footer>
        <div className="container footer-inner">
          <p>
            Data from CryptoRank · <span className="mono">{filters.counts.pre}</span> pre-token projects tracked ·
            Original dashboard by{' '}
            <a href="https://x.com/ASSO7878/" target="_blank" rel="noopener noreferrer">
              @ASSO7878
              <span className="sr"> on X (opens in a new tab)</span>
            </a>
            . Snapshot sections are static reference data — not financial advice.
          </p>
        </div>
      </footer>

      {detail && (
        <ChunkErrorBoundary label="project details">
          <Suspense fallback={null}>
            <DetailDialog
              card={detail}
              fit={data.FIT}
              icons={data.IMGS}
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
