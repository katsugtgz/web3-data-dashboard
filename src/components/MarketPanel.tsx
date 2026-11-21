import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { MarketSection, MarketSector } from '../../shared/types';
import { cmpCells, formatRelativeTime, hostnameLabel, isHttpUrl, sortVal } from '../lib/format';

interface Sort {
  col: number;
  dir: 1 | -1;
}

interface Props {
  section: MarketSection;
  sectors?: MarketSector[];
}

function SectorStrip({ sectors }: { sectors: MarketSector[] }) {
  if (sectors.length === 0) return null;
  return (
    <div className="sector-strip" aria-label="Top sector movers (24h)">
      <span className="note">24h Sector Movers:</span>
      <div className="chipline">
        {sectors.map(s => {
          const isUp = s.change24h.startsWith('+');
          return (
            <span key={s.name} className="countchip">
              <span>{s.name}</span>{' '}
              <strong className={`mono ${isUp ? 'up' : 'dn'}`}>{s.change24h}</strong>{' '}
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

  const chains = useMemo(() => {
    const unique = new Set<string>();
    for (const r of section.rows) {
      if (r.chain) unique.add(r.chain);
    }
    return [...unique];
  }, [section.rows]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = section.rows.filter(r => {
      if (chain !== 'All' && r.chain !== chain) return false;
      if (!q) return true;
      return r.cells.some(c => c.toLowerCase().includes(q));
    });
    if (sort.col < 0) return filtered;
    return filtered
      .slice()
      .sort((a, b) => sort.dir * cmpCells(a.cells[sort.col] ?? '', b.cells[sort.col] ?? ''));
  }, [section.rows, chain, query, sort]);

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

  return (
    <section role="tabpanel" id={`panel-${section.id}`} aria-labelledby={`tab-${section.id}`} className="demo-panel">
      <div className="panelhead">
        <div>
          <div className="paneltitle">
            <h2 className="section">{section.title}</h2>
            <a href={section.sourceUrl} target="_blank" rel="noopener noreferrer" className="badge badge-demo">
              {section.source}
              <span className="sr"> data source (opens in a new tab)</span>
            </a>
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
                aria-pressed={c === chain}
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
            placeholder={`Search ${section.title.toLowerCase()}…`}
            value={query}
            onChange={e => setQuery(e.target.value)}
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
                    aria-sort={on ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}
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
            {rows.map((row, ri) => (
              <tr key={`${row.cells[0]}-${ri}`}>
                {section.cols.map((col, ci) => {
                  const cell = row.cells[ci] ?? '';
                  if (ci === 0) {
                    return (
                      <th key={col} scope="row">
                        {row.href && isHttpUrl(row.href) ? (
                          <a href={row.href} target="_blank" rel="noopener noreferrer" className="table-link">
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
                  const trimmed = cell.trim();
                  const isUp = /^\+[\d$]/.test(trimmed);
                  const isDown = /^-[\d$]/.test(trimmed);
                  const isNum = sortVal(cell) !== null;
                  const classes = [isUp ? 'up' : isDown ? 'dn' : '', isNum ? 'mono' : ''].filter(Boolean).join(' ');
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
                  No rows match “{query}”.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
