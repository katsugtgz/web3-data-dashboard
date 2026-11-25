import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { MarketRow, MarketSection, MarketSector } from '../../shared/types';
import { changeToneClass, formatRelativeTime, hostnameLabel, isHttpUrl, sortVal } from '../lib/format';
import { cmpRows, rowKey } from '../lib/marketSort';

interface Sort {
  col: number;
  dir: 1 | -1;
}

interface Props {
  section: MarketSection;
  sectors?: MarketSector[];
}

function rowChains(r: MarketRow): string[] {
  if (r.chains?.length) return r.chains;
  return r.chain ? [r.chain] : [];
}

function SectorStrip({ sectors }: { sectors: MarketSector[] }) {
  if (sectors.length === 0) return null;
  return (
    <div className="sector-strip" role="region" aria-label="Top sector movers (24h)">
      <span className="note">24h Sector Movers:</span>
      <div className="chipline">
        {sectors.map(s => {
          const tone = changeToneClass(s.change24h);
          return (
            <span key={s.name} className="countchip">
              <span>{s.name}</span>{' '}
              <strong className={tone ? `mono ${tone}` : 'mono'}>{s.change24h}</strong>{' '}
              <span className="mono note">({s.marketCap})</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function MarketPanel({ section, sectors }: Props) {
  const [chain, setChain] = useState('All');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>({ col: -1, dir: 1 });
  const [announcedCount, setAnnouncedCount] = useState<number | null>(null);
  const prevCountRef = useRef(section.rows.length);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchId = useId();
  const captionId = useId();

  const { chains, chainSet, rowChainSets } = useMemo(() => {
    const unique = new Set<string>();
    const map = new Map<MarketRow, Set<string>>();
    for (const r of section.rows) {
      const list = rowChains(r);
      map.set(r, new Set(list));
      for (const c of list) unique.add(c);
    }
    return { chains: [...unique], chainSet: unique, rowChainSets: map };
  }, [section.rows]);

  const activeChain = chain !== 'All' && chainSet.has(chain) ? chain : 'All';

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = section.rows.filter(r => {
      if (activeChain !== 'All' && !rowChainSets.get(r)?.has(activeChain)) return false;
      if (!q) return true;
      return r.cells.some(c => c.toLowerCase().includes(q));
    });
    if (sort.col < 0) return filtered;
    return filtered
      .slice()
      .sort((a, b) => cmpRows(a, b, sort.col, sort.dir));
  }, [section.rows, rowChainSets, activeChain, query, sort]);

  // Duplicate source ids use identity fields, not live prices or volumes.
  const rowKeys = useMemo(() => {
    const ids = new Set<string>();
    const duplicates = new Set<string>();
    for (const r of section.rows) {
      const id = rowKey(r, section.id);
      if (ids.has(id)) duplicates.add(id);
      ids.add(id);
    }
    const keys = new Map<MarketRow, string>();
    const seen = new Map<string, number>();
    for (const r of section.rows) {
      const id = rowKey(r, section.id);
      const base = duplicates.has(id) ? JSON.stringify([id, r.chain, r.href, r.cells[0]]) : id;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      keys.set(r, n === 0 ? base : `${base}#${n}`);
    }
    return keys;
  }, [section.rows, section.id]);

  useEffect(() => {
    if (rows.length === prevCountRef.current) return;
    const id = setTimeout(() => {
      prevCountRef.current = rows.length;
      setAnnouncedCount(rows.length);
    }, 300);
    return () => clearTimeout(id);
  }, [rows.length]);

  const toggleSort = (col: number) =>
    setSort(s => ({ col, dir: s.col === col ? (-s.dir as 1 | -1) : 1 }));

  const safeSourceUrl = isHttpUrl(section.sourceUrl) ? section.sourceUrl.trim() : null;

  return (
    <section role="tabpanel" id={`panel-${section.id}`} aria-labelledby={`tab-${section.id}`} className="demo-panel">
      <div className="panelhead">
        <div>
          <div className="paneltitle">
            <h2 className="section">{section.title}</h2>
            {safeSourceUrl ? (
              <a href={safeSourceUrl} target="_blank" rel="noopener noreferrer" className="badge badge-demo">
                {section.source}
                <span className="sr"> data source (opens in a new tab)</span>
              </a>
            ) : (
              <span className="badge badge-demo">{section.source}</span>
            )}
            <span className="countchip mono">
              Updated {formatRelativeTime(section.fetchedAt)}
            </span>
            {section.stale && <span className="badge badge-risk">Stale</span>}
            <span className="countchip mono">
              {rows.length} / {section.rows.length} rows
            </span>
            <span className="sr" role="status" aria-live="polite">
              {announcedCount !== null ? `${announcedCount} of ${section.rows.length} rows` : ''}
            </span>
          </div>
          <p className="panel-blurb">{section.blurb}</p>
        </div>
      </div>

      {section.id === 'crypto' && sectors && sectors.length > 0 && <SectorStrip sectors={sectors} />}

      <div className="demo-controls">
        {chains.length > 1 && (
          <div className="chipline chain-filter" role="group" aria-label="Filter by chain">
            {['All', ...chains].map(c => (
              <button
                type="button"
                key={c}
                className="chip"
                data-chain={c}
                aria-pressed={c === activeChain}
                onClick={() => setChain(c)}
              >
                {c}
              </button>
            ))}
          </div>
        )}
        <div className="search">
          <label htmlFor={searchId} className="sr">
            Filter {section.title}
          </label>
          <input
            ref={searchInputRef}
            id={searchId}
            type="search"
            placeholder={`Search ${section.title.toLowerCase()}… (/)`}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation();
                setQuery('');
              }
            }}
          />
          {query && (
            <button
              type="button"
              className="chip"
              onClick={() => {
                setQuery('');
                searchInputRef.current?.focus();
              }}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <div tabIndex={0} role="region" aria-labelledby={captionId} className="table-wrap">
        <table className="demo">
          <caption id={captionId}>
            Live rows for {section.title} from {section.source} — click any column header to sort.
          </caption>
          <thead>
            <tr>
              {section.cols.map((col, idx) => {
                const on = sort.col === idx;
                return (
                  <th
                    key={col}
                    scope="col"
                    aria-sort={on ? (sort.dir > 0 ? 'ascending' : 'descending') : undefined}
                  >
                    <button type="button" className="sort" onClick={() => toggleSort(idx)}>
                      {col}
                      <span className="arr" aria-hidden="true">
                        {on ? (sort.dir > 0 ? '↑' : '↓') : '↕'}
                      </span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={rowKeys.get(row) ?? rowKey(row, section.id)}>
                {section.cols.map((col, ci) => {
                  const cell = row.cells[ci] ?? '';
                  if (ci === 0) {
                    const safeRowHref = row.href && isHttpUrl(row.href) ? row.href.trim() : null;
                    return (
                      <th key={col} scope="row">
                        {safeRowHref ? (
                          <a href={safeRowHref} target="_blank" rel="noopener noreferrer" className="table-link">
                            {cell || '—'}
                            <span className="sr"> (opens in a new tab)</span>
                          </a>
                        ) : (
                          cell || '—'
                        )}
                      </th>
                    );
                  }
                  if (isHttpUrl(cell)) {
                    return (
                      <td key={col}>
                        <a href={cell.trim()} target="_blank" rel="noopener noreferrer" className="table-link">
                          {hostnameLabel(cell)}
                          <span className="sr"> — {row.cells[0]} link (opens in a new tab)</span>
                          <span aria-hidden="true"> ↗</span>
                        </a>
                      </td>
                    );
                  }
                  const tone = changeToneClass(cell);
                  const isNum = sortVal(cell) !== null;
                  const classes = [tone, isNum ? 'mono' : ''].filter(Boolean).join(' ');
                  return (
                    <td key={col} className={classes || undefined}>
                      {cell || '—'}
                    </td>
                  );
                })}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={section.cols.length} className="table-empty">
                  {query ? `No rows match “${query}”.` : 'No rows match the active filter.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
