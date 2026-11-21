import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Card, Dashboard, FitKey, Grade } from '../shared/types';
import { DemoPanel } from './components/DemoPanel';
import { DetailDialog } from './components/DetailDialog';
import { ProjectCard } from './components/ProjectCard';
import { TgeCarousel } from './components/TgeCarousel';
import { useAirdropFeed } from './hooks/useAirdropFeed';
import { useDashboard } from './hooks/useDashboard';
import { useTheme } from './hooks/useTheme';
import { useWatchlist } from './hooks/useWatchlist';
import { formatClock, parseCost, parseFunding, parseUpdatedDays } from './lib/format';
import { GRADE_ORDER } from './lib/labels';

type StatusFilter = 'all' | 'pre' | 'launched' | 'saved';
type SortKey = 'rank' | 'funding' | 'heat' | 'updated' | 'cost';

const PAGE_STEP = 24;

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

  const [tab, setTab] = useState<string>(() => findHashTab(data.TABS) ?? data.TABS[0].id);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [type, setType] = useState('All');
  const [chain, setChain] = useState('All');
  const [grade, setGrade] = useState<'All' | Grade>('All');
  const [fitFilter, setFitFilter] = useState<'All' | FitKey>('All');
  const [freeOnly, setFreeOnly] = useState(false);
  const [sortBy, setSortBy] = useState<SortKey>('rank');
  const [query, setQuery] = useState('');
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [limit, setLimit] = useState(PAGE_STEP);
  const [detail, setDetail] = useState<Card | null>(null);

  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const searchRef = useRef<HTMLInputElement>(null);
  const tabbarRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);

  const selectTab = useCallback((nextId: string, scrollPanel = true) => {
    setTab(nextId);
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
  }, []);

  useEffect(() => {
    const onHash = () => {
      const next = findHashTab(data.TABS);
      if (next) setTab(next);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [data.TABS]);

  // Global `/` shortcut to jump to search on the Airdrops tab
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
      if (detail) return;
      if (tab === 'airdrops' && searchRef.current) {
        e.preventDefault();
        searchRef.current.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab, detail]);

  const counts = useMemo(() => {
    let pre = 0;
    let launched = 0;
    let sTier = 0;
    let savedMatch = 0;
    for (const c of cards) {
      if (c.b.includes('token')) launched++;
      else pre++;
      if (c.g === 'S') sTier++;
      if (saved.has(c.n)) savedMatch++;
    }
    return { total: cards.length, pre, launched, sTier, savedMatch };
  }, [cards, saved]);

  const chainCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of cards) {
      const list = c.chains?.length ? c.chains : c.chain ? [c.chain] : [];
      for (const ch of list) {
        map.set(ch, (map.get(ch) ?? 0) + 1);
      }
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [cards]);

  const activeChain = chain !== 'All' && chainCounts.some(([name]) => name === chain) ? chain : 'All';
  const topChains = useMemo(() => chainCounts.slice(0, 6), [chainCounts]);
  const extraChains = useMemo(() => chainCounts.slice(6), [chainCounts]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const group = type === 'All' ? null : new Set(data.TYPE_MAP[type] ?? []);

    const filtered = cards.filter(c => {
      if (status === 'pre' && c.b.includes('token')) return false;
      if (status === 'launched' && !c.b.includes('token')) return false;
      if (status === 'saved' && !saved.has(c.n)) return false;

      if (type !== 'All') {
        if (type === 'Stock tokens') {
          if (!c.isStockToken) return false;
        } else if (group) {
          const types = c.taskTypes?.length ? c.taskTypes : [c.best.ty];
          if (!types.some(t => group.has(t))) return false;
        }
      }

      if (activeChain !== 'All') {
        const list = c.chains?.length ? c.chains : c.chain ? [c.chain] : [];
        if (!list.includes(activeChain)) return false;
      }

      if (grade !== 'All' && c.g !== grade) return false;
      if (fitFilter !== 'All' && !c.fit.includes(fitFilter)) return false;
      if (freeOnly && parseCost(c.best.c, c.costNum) > 0 && !c.b.includes('zero')) return false;

      if (q) {
        const chainsText = (c.chains ?? (c.chain ? [c.chain] : [])).join(' ').toLowerCase();
        const hit =
          c.n.toLowerCase().includes(q) ||
          (c.t ?? '').toLowerCase().includes(q) ||
          c.best.n.toLowerCase().includes(q) ||
          chainsText.includes(q);
        if (!hit) return false;
      }
      return true;
    });

    if (sortBy === 'rank') return filtered;
    return filtered.slice().sort((a, b) => {
      if (sortBy === 'funding') return parseFunding(b.f, b.raiseNum) - parseFunding(a.f, a.raiseNum) || a.r - b.r;
      if (sortBy === 'heat') return b.h - a.h || a.r - b.r;
      if (sortBy === 'updated') return parseUpdatedDays(a.u, a.updatedTs) - parseUpdatedDays(b.u, b.updatedTs) || a.r - b.r;
      if (sortBy === 'cost') return parseCost(a.best.c, a.costNum) - parseCost(b.best.c, b.costNum) || a.r - b.r;
      return a.r - b.r;
    });
  }, [cards, status, saved, type, activeChain, grade, fitFilter, freeOnly, query, sortBy, data.TYPE_MAP]);

  // Reset pagination whenever filters/sort change
  useEffect(() => {
    setLimit(PAGE_STEP);
  }, [status, type, activeChain, grade, fitFilter, freeOnly, query, sortBy]);

  const activeAdvancedCount =
    (grade !== 'All' ? 1 : 0) + (activeChain !== 'All' ? 1 : 0) + (fitFilter !== 'All' ? 1 : 0);

  const hasAnyFilter =
    status !== 'all' ||
    type !== 'All' ||
    activeChain !== 'All' ||
    grade !== 'All' ||
    fitFilter !== 'All' ||
    freeOnly ||
    query.trim() !== '' ||
    sortBy !== 'rank';

  const resetFilters = () => {
    setStatus('all');
    setType('All');
    setChain('All');
    setGrade('All');
    setFitFilter('All');
    setFreeOnly(false);
    setSortBy('rank');
    setQuery('');
  };

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

  const renderedCards = visible.slice(0, limit);
  const remaining = visible.length - renderedCards.length;
  const airdropOn = tab === 'airdrops';
  const fitEntries = Object.entries(data.FIT) as [FitKey, string][];

  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>

      <header className="top">
        <div className="container top-inner">
          <div className="brand-block">
            <div className="titlerow">
              <img
                className="logo"
                src="https://import-command-query-8ca052.surf.computer/avatar-renji.png"
                alt=""
                width={40}
                height={40}
                onError={e => (e.currentTarget.style.display = 'none')}
              />
              <div>
                <h1 className="pagetitle">Import Command Query</h1>
                <p className="sub">
                  Web3 Data Dashboard · 18 sections ·{' '}
                  <a
                    href="https://x.com/ASSO7878/"
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Open @ASSO7878 on X (opens in a new tab)"
                  >
                    original by @ASSO7878
                  </a>
                </p>
              </div>
            </div>
          </div>

          <div className="top-controls">
            <div className={`feed-pill${isLive ? ' is-live' : ''}`} role="status" aria-live="polite">
              <span className="status-dot" aria-hidden="true" />
              {isLive ? (
                <span>
                  Live · <span className="mono">{cards.length}</span> synced{' '}
                  <span className="mono">{formatClock(feed.fetchedAt)}</span>
                </span>
              ) : failed ? (
                <span>
                  Snapshot fallback · <span className="mono">{cards.length}</span>
                </span>
              ) : (
                <span>Syncing live feed…</span>
              )}
            </div>

            <button
              type="button"
              className="ctrl-btn"
              onClick={refresh}
              disabled={loading}
              aria-label="Refresh live airdrop feed"
              title="Refresh live feed"
            >
              <svg
                className={loading ? 'spin' : undefined}
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
                <path d="M21 3v5h-5" />
              </svg>
              <span>Refresh</span>
            </button>

            <button
              type="button"
              className="ctrl-btn"
              onClick={theme.toggle}
              aria-label={theme.resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              title={theme.resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            >
              {theme.resolved === 'dark' ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
                </svg>
              )}
              <span>{theme.resolved === 'dark' ? 'Light' : 'Dark'}</span>
            </button>
          </div>
        </div>
      </header>

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
        <section role="tabpanel" id="panel-airdrops" aria-labelledby="tab-airdrops" hidden={!airdropOn}>
          <div className="kpi-strip" aria-label="Dashboard metrics overview">
            <button
              type="button"
              className={`kpi-card${status === 'all' && grade === 'All' ? ' is-active' : ''}`}
              onClick={() => {
                setStatus('all');
                setGrade('All');
              }}
            >
              <span className="kpi-label">Active Tracked</span>
              <strong className="kpi-val mono">{counts.total}</strong>
              <span className="kpi-sub">{isLive ? 'Live API feed' : 'Snapshot'}</span>
            </button>
            <button
              type="button"
              className={`kpi-card${status === 'pre' ? ' is-active' : ''}`}
              onClick={() => setStatus(s => (s === 'pre' ? 'all' : 'pre'))}
            >
              <span className="kpi-label">Pre-Token</span>
              <strong className="kpi-val mono">{counts.pre}</strong>
              <span className="kpi-sub">{Math.round((counts.pre / Math.max(1, counts.total)) * 100)}% unlaunched</span>
            </button>
            <button
              type="button"
              className={`kpi-card${grade === 'S' ? ' is-active' : ''}`}
              onClick={() => setGrade(g => (g === 'S' ? 'All' : 'S'))}
            >
              <span className="kpi-label">S-Tier Projects</span>
              <strong className="kpi-val mono">{counts.sTier}</strong>
              <span className="kpi-sub">Highest conviction</span>
            </button>
            <button
              type="button"
              className="kpi-card"
              onClick={() => document.getElementById('tge-heading')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            >
              <span className="kpi-label">Upcoming TGE</span>
              <strong className="kpi-val mono">{tgeItems.length}</strong>
              <span className="kpi-sub">Claim &amp; verify ↓</span>
            </button>
            <button
              type="button"
              className={`kpi-card${status === 'saved' ? ' is-active' : ''}`}
              onClick={() => setStatus(s => (s === 'saved' ? 'all' : 'saved'))}
            >
              <span className="kpi-label">Watchlist</span>
              <strong className="kpi-val mono">{counts.savedMatch}</strong>
              <span className="kpi-sub">Saved locally</span>
            </button>
          </div>

          <div className="section-head">
            <div>
              <h2 className="section">Airdrop Radar · Potential Ranking</h2>
              <p className="note">
                Ranked by funding, X score, and recency. Click any project to inspect all tasks and track progress locally.
              </p>
            </div>
          </div>

          <div className="filter-dock">
            <div className="dock-primary">
              <div className="seg-group" role="group" aria-label="Project token status">
                {(
                  [
                    ['all', 'All', counts.total],
                    ['pre', 'Pre-token', counts.pre],
                    ['launched', 'Token live', counts.launched],
                    ['saved', 'Saved', counts.savedMatch],
                  ] as const
                ).map(([key, lbl, count]) => (
                  <button
                    key={key}
                    type="button"
                    className="seg-btn"
                    aria-pressed={status === key}
                    onClick={() => setStatus(key)}
                  >
                    {lbl} <span className="chip-count mono">{count}</span>
                  </button>
                ))}
              </div>

              <div className="dock-right">
                <div className="search">
                  <label htmlFor="proj-q" className="sr">
                    Search projects
                  </label>
                  <input
                    ref={searchRef}
                    id="proj-q"
                    type="search"
                    placeholder="Search name, ticker, chain… (/)"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Escape' && query) {
                        e.stopPropagation();
                        setQuery('');
                      }
                    }}
                  />
                </div>

                <label className="sort-wrap">
                  <span className="sr">Sort projects by</span>
                  <select
                    id="proj-sort"
                    className="select"
                    value={sortBy}
                    onChange={e => setSortBy(e.target.value as SortKey)}
                  >
                    <option value="rank">Sort: Rank / Score</option>
                    <option value="funding">Sort: Funding ↓</option>
                    <option value="heat">Sort: Heat (X) ↓</option>
                    <option value="updated">Sort: Recently updated</option>
                    <option value="cost">Sort: Free / lowest cost</option>
                  </select>
                </label>

                <button
                  type="button"
                  className="chip"
                  aria-pressed={freeOnly}
                  onClick={() => setFreeOnly(v => !v)}
                >
                  $0 Free
                </button>

                <button
                  type="button"
                  className="chip"
                  aria-expanded={showMoreFilters}
                  aria-controls="more-filters"
                  aria-pressed={showMoreFilters || activeAdvancedCount > 0}
                  onClick={() => setShowMoreFilters(v => !v)}
                >
                  Filters{activeAdvancedCount > 0 ? ` (${activeAdvancedCount})` : ''}
                </button>
              </div>
            </div>

            <div className="chipline type-strip" role="group" aria-label="Project type filter">
              {['All', ...data.TYPES].map(t => (
                <button key={t} type="button" className="chip" aria-pressed={type === t} onClick={() => setType(t)}>
                  {t}
                </button>
              ))}
            </div>

            {showMoreFilters && (
              <div id="more-filters" className="advanced-filters">
                <div className="adv-row">
                  <span className="adv-label">Tier</span>
                  <div className="chipline" role="group" aria-label="Filter by grade">
                    {(['All', ...GRADE_ORDER] as const).map(g => (
                      <button
                        key={g}
                        type="button"
                        className="chip"
                        aria-pressed={grade === g}
                        onClick={() => setGrade(g)}
                      >
                        {g === 'All' ? 'All tiers' : `Tier ${g}`}
                      </button>
                    ))}
                  </div>
                </div>

                {chainCounts.length > 0 && (
                  <div className="adv-row">
                    <span className="adv-label">Chain</span>
                    <div className="chipline" role="group" aria-label="Filter by chain">
                      <button
                        type="button"
                        className="chip"
                        aria-pressed={activeChain === 'All'}
                        onClick={() => setChain('All')}
                      >
                        All chains
                      </button>
                      {topChains.map(([name, cnt]) => (
                        <button
                          key={name}
                          type="button"
                          className="chip"
                          aria-pressed={activeChain === name}
                          onClick={() => setChain(name)}
                        >
                          {name} <span className="chip-count mono">{cnt}</span>
                        </button>
                      ))}
                      {extraChains.length > 0 && (
                        <select
                          aria-label="More chains"
                          className="select select-compact"
                          value={extraChains.some(([n]) => n === activeChain) ? activeChain : ''}
                          onChange={e => setChain(e.target.value || 'All')}
                        >
                          <option value="">+{extraChains.length} more chains…</option>
                          {extraChains.map(([name, cnt]) => (
                            <option key={name} value={name}>
                              {name} ({cnt})
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  </div>
                )}

                <div className="adv-row">
                  <span className="adv-label">Best for</span>
                  <div className="chipline" role="group" aria-label="Filter by best-for profile">
                    <button
                      type="button"
                      className="chip"
                      aria-pressed={fitFilter === 'All'}
                      onClick={() => setFitFilter('All')}
                    >
                      Any profile
                    </button>
                    {fitEntries.map(([k, lbl]) => (
                      <button
                        key={k}
                        type="button"
                        className="chip"
                        aria-pressed={fitFilter === k}
                        onClick={() => setFitFilter(k)}
                      >
                        {lbl}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="results-bar">
            <p className="note" role="status">
              Showing <strong className="mono">{renderedCards.length}</strong>
              {renderedCards.length < visible.length ? ` of ${visible.length} matching` : ''} ({cards.length}{' '}
              {isLive ? 'live' : 'snapshot'} total)
            </p>
            {hasAnyFilter && (
              <button type="button" className="link-btn" onClick={resetFilters}>
                Reset filters
              </button>
            )}
          </div>

          {visible.length > 0 ? (
            <>
              <div className="grid">
                {renderedCards.map(c => (
                  <ProjectCard
                    key={`${c.r}-${c.n}`}
                    card={c}
                    fit={data.FIT}
                    icons={data.IMGS}
                    saved={saved.has(c.n)}
                    doneTasks={doneTasks}
                    onToggleSaved={toggleSaved}
                    onDetails={setDetail}
                  />
                ))}
              </div>
              {remaining > 0 && (
                <div className="loadmore-bar">
                  <button
                    type="button"
                    className="btn btn-subtle"
                    onClick={() => setLimit(l => l + PAGE_STEP)}
                  >
                    Show {Math.min(PAGE_STEP, remaining)} more ({remaining} left)
                  </button>
                  <button type="button" className="chip" onClick={() => setLimit(visible.length)}>
                    Show all {visible.length}
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="empty" role="status">
              <p>
                {status === 'saved' && counts.savedMatch === 0
                  ? 'No saved projects yet. Click the ★ icon on any project card to build your watchlist.'
                  : 'No projects match your current filters.'}
              </p>
              {hasAnyFilter && (
                <button type="button" className="btn" style={{ marginTop: 10 }} onClick={resetFilters}>
                  Reset filters
                </button>
              )}
            </div>
          )}

          <div className="tge-block">
            <div className="section-head">
              <div>
                <h2 id="tge-heading" className="section">
                  Upcoming TGE / Claimable
                </h2>
                <p className="note">
                  {tgeItems.length} TGE and verification events tracked ({isLive ? 'live feed' : 'snapshot'}).
                </p>
              </div>
            </div>
            <TgeCarousel items={tgeItems} />
          </div>

          <div className="categories-bar" aria-label="Airdrop categories">
            <span className="note">Ecosystem programs:</span>
            <div className="chipline">
              {data.CATEGORIES.map(c => (
                <span key={c} className="countchip">
                  {c}
                </span>
              ))}
            </div>
          </div>
        </section>

        {data.DEMO.map(d => (
          <div key={d.id} hidden={tab !== d.id}>
            <DemoPanel section={d} label={data.TABS.find(t => t.id === d.id)?.label ?? d.id} />
          </div>
        ))}
      </main>

      <footer>
        <div className="container footer-inner">
          <p>
            Data from CryptoRank · <span className="mono">{counts.pre}</span> pre-token projects tracked · Original
            dashboard by{' '}
            <a
              href="https://x.com/ASSO7878/"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open @ASSO7878 on X (opens in a new tab)"
            >
              @ASSO7878
            </a>
            . Snapshot sections are static reference data — not financial advice.
          </p>
        </div>
      </footer>

      <DetailDialog
        card={detail}
        fit={data.FIT}
        icons={data.IMGS}
        saved={detail ? saved.has(detail.n) : false}
        doneTasks={doneTasks}
        onToggleSaved={toggleSaved}
        onToggleTask={toggleTaskDone}
        onClose={() => setDetail(null)}
      />
    </>
  );
}
