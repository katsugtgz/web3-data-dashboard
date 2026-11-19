import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Card, Dashboard } from '../shared/types';
import { DemoPanel } from './components/DemoPanel';
import { DetailDialog } from './components/DetailDialog';
import { ProjectCard } from './components/ProjectCard';
import { TgeCarousel } from './components/TgeCarousel';
import { useAirdropFeed } from './hooks/useAirdropFeed';
import { useDashboard } from './hooks/useDashboard';

type Status = 'active' | 'pre' | 'all';
const STATUS_ORDER: Status[] = ['active', 'pre', 'all'];

export default function App() {
  const { data, error } = useDashboard();
  if (error) return <p className="empty" role="alert">Failed to load dashboard: {error}</p>;
  if (!data) return <p className="note" role="status">Loading dashboard…</p>;
  return <Dashboard data={data} />;
}

function Dashboard({ data }: { data: Dashboard }) {
  const { cards: live, failed } = useAirdropFeed();
  const cards = live ?? data.CARDS;
  const [tab, setTab] = useState(data.TABS[0].id);
  const [status, setStatus] = useState<Status>('active');
  const [type, setType] = useState('All');
  const [chain, setChain] = useState('All');
  const [query, setQuery] = useState('');
  const [detail, setDetail] = useState<Card | null>(null);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const chainCounts = useMemo(() => {
    const counts = new Map<string, number>();
    cards.forEach(c => c.chain && counts.set(c.chain, (counts.get(c.chain) ?? 0) + 1));
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [cards]);

  const activeChain = chain !== 'All' && chainCounts.some(([name]) => name === chain) ? chain : 'All';

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const group = type === 'All' ? null : new Set(data.TYPE_MAP[type] ?? []);
    return cards.filter(
      c =>
        (!group || group.has(c.best.ty)) &&
        (activeChain === 'All' || c.chain === activeChain) &&
        (!q || c.n.toLowerCase().includes(q) || (c.t ?? '').toLowerCase().includes(q)),
    );
  }, [cards, type, activeChain, query, data.TYPE_MAP]);

  const onTabKey = (e: KeyboardEvent) => {
    const ids = data.TABS.map(t => t.id);
    let i = ids.indexOf(tab);
    if (e.key === 'ArrowRight') i = (i + 1) % ids.length;
    else if (e.key === 'ArrowLeft') i = (i - 1 + ids.length) % ids.length;
    else if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = ids.length - 1;
    else return;
    e.preventDefault();
    setTab(ids[i]);
    tabRefs.current[ids[i]]?.focus();
  };

  useEffect(() => {
    document.getElementById(`panel-${tab}`)?.scrollIntoView({ block: 'start' });
  }, [tab]);

  const airdropOn = tab === 'airdrops';

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>

      <header className="top">
        <div className="container">
          <div className="titlerow">
            <img className="logo" src="https://import-command-query-8ca052.surf.computer/avatar-renji.png" alt="Original site logo" width={36} height={36} onError={e => (e.currentTarget.style.display = 'none')} />
            <h1 className="pagetitle">Import Command Query</h1>
          </div>
          <p className="sub">
            Web3 Data Dashboard · 18 sections · English accessible edition ·{' '}
            <a href="https://x.com/ASSO7878/" target="_blank" rel="noopener noreferrer" aria-label="Open @ASSO7878 on X (opens in a new tab)">original by @ASSO7878</a>
          </p>
          <p className="note">The airdrop list polls the live source every 60 seconds and keeps the last loaded list if a poll fails. Other sections are a static snapshot.</p>
        </div>
      </header>

      <div className="tabbar">
        <nav className="container" aria-label="Dashboard sections">
          <div role="tablist" className="tabstrip" onKeyDown={onTabKey}>
            {data.TABS.map(t => (
              <button
                key={t.id}
                type="button"
                id={`tab-${t.id}`}
                role="tab"
                className="tab"
                aria-controls={`panel-${t.id}`}
                aria-selected={t.id === tab}
                tabIndex={t.id === tab ? 0 : -1}
                ref={el => { tabRefs.current[t.id] = el; }}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </nav>
      </div>

      <main id="main" className="container" tabIndex={-1}>
        <section role="tabpanel" id="panel-airdrops" aria-labelledby="tab-airdrops" hidden={!airdropOn}>
          <h2 className="section">Airdrop Radar · Potential Ranking</h2>
          <p className="note">
            Ranked by funding, X score and last update. {data.CARDS.length} projects captured from the source, which tracks {data.COUNTS.active} active ones.
          </p>

          <div className="toolbar" role="group" aria-label="Project status" style={{ marginTop: 8 }}>
            {STATUS_ORDER.map(s => {
              const label = s === 'active' ? `Active ${data.COUNTS.active}` : s === 'pre' ? `Pre-token ${data.COUNTS.preToken}` : `All ${data.COUNTS.active}`;
              return (
                <button key={s} type="button" className="chip" aria-pressed={status === s} onClick={() => setStatus(s)}>
                  {label}
                </button>
              );
            })}
          </div>
          <div className="chipline" role="group" aria-label="Project type filter" style={{ marginTop: 8 }}>
            {['All', ...data.TYPES].map(t => (
              <button key={t} type="button" className="chip" aria-pressed={type === t} onClick={() => setType(t)}>
                {t}
              </button>
            ))}
          </div>
          <div className="chipline" aria-label="Filter by chain" style={{ marginTop: 8 }}>
            <span className="note">Chains (from captured projects): </span>
            {['All', ...chainCounts.map(([n]) => n)].map(c => (
              <button key={c} type="button" className="chip" aria-pressed={c === activeChain} onClick={() => setChain(c)}>
                {c === 'All' ? c : `${c} ${chainCounts.find(([n]) => n === c)?.[1] ?? 0}`}
              </button>
            ))}
          </div>

          <div className="search" style={{ marginTop: 8 }}>
            <label htmlFor="proj-q">Search projects</label>
            <input id="proj-q" type="search" placeholder="Name or ticker…" value={query} onChange={e => setQuery(e.target.value)} />
          </div>

          <p className="note" role="status" style={{ margin: '12px 0 8px' }}>
            {status === 'pre'
              ? 'Pre-token view.'
              : `Showing ${visible.length} of ${data.CARDS.length} captured projects.`}
          </p>
          <p className="note" role="status" style={{ margin: '0 0 8px' }}>
            {failed ? 'Live airdrop feed unavailable; showing last loaded list.' : ''}
          </p>

          {status === 'pre' ? (
            <div className="empty" role="status">
              {data.COUNTS.preToken} pre-token projects are tracked on the live site. Their full list is not part of this snapshot.
            </div>
          ) : (
            <>
              <div className="grid">
                {visible.map(c => (
                  <ProjectCard key={c.r} card={c} fit={data.FIT} icons={data.IMGS} onDetails={setDetail} />
                ))}
              </div>
              {visible.length === 0 && <div className="empty" role="status">No captured projects match this filter.</div>}
            </>
          )}

          <h2 className="section" style={{ marginTop: 24, fontSize: 16 }}>Upcoming TGE / Claimable</h2>
          <TgeCarousel items={data.TGE} />
          <p className="note">The source tracks 19 upcoming TGEs; {data.TGE.length} were captured in this snapshot.</p>

          <div className="chipline" aria-label="Airdrop categories" style={{ marginTop: 8 }}>
            <span className="note">Categories: </span>
            {data.CATEGORIES.map(c => (
              <span key={c} className="countchip">{c}</span>
            ))}
          </div>
          <p className="note">No new listings in the last 14 days.</p>
        </section>

        {data.DEMO.map(d => (
          <div key={d.id} hidden={tab !== d.id}>
            <DemoPanel section={d} label={data.TABS.find(t => t.id === d.id)?.label ?? d.id} />
          </div>
        ))}
      </main>

      <footer>
        <div className="container">
          <p>
            Data from CryptoRank · <span>{data.COUNTS.preToken} projects yet to launch a token. </span>Original dashboard by{' '}
            <a href="https://x.com/ASSO7878/" target="_blank" rel="noopener noreferrer" aria-label="Open @ASSO7878 on X (opens in a new tab)">@ASSO7878</a>.
            Unofficial English snapshot for demo use.
          </p>
        </div>
      </footer>

      <DetailDialog card={detail} fit={data.FIT} onClose={() => setDetail(null)} />
    </>
  );
}
