import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { DemoSection } from '../../shared/types';
import { cmpCells, hostnameLabel, isHttpUrl, sortVal } from '../lib/format';
import { translateColumn } from '../lib/labels';

interface Sort {
  col: number;
  dir: 1 | -1;
}

export function DemoPanel({ section, label }: { section: DemoSection; label: string }) {
  const [chain, setChain] = useState('All');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>({ col: -1, dir: 1 });
  const [announcedCount, setAnnouncedCount] = useState<number | null>(null);
  const prevCountRef = useRef(section.rows.length);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchId = useId();
  const captionId = useId();

  const chains = useMemo(
    () => [...new Set(section.rows.map(r => r.chain))],
    [section.rows],
  );

  // Drop columns that are completely blank across all rows or redundant constant "section" columns
  const visibleColIndices = useMemo(() => {
    const indices: number[] = [];
    section.cols.forEach((col, i) => {
      const vals = section.rows.map(r => (r.cells[i] ?? '').trim());
      const nonEmpty = vals.filter(v => v !== '' && v !== '/' && v !== '—');
      if (nonEmpty.length === 0) return;
      if (col.toLowerCase() === 'section' && new Set(nonEmpty).size <= 1) return;
      indices.push(i);
    });
    return indices.length > 0 ? indices : section.cols.map((_, i) => i);
  }, [section.cols, section.rows]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = section.rows.filter(r => {
      if (chain !== 'All' && r.chain !== chain) return false;
      if (!q) return true;
      return visibleColIndices.some(i => (r.cells[i] ?? '').toLowerCase().includes(q));
    });
    if (sort.col < 0) return filtered;
    return filtered
      .slice()
      .sort((a, b) => sort.dir * cmpCells(a.cells[sort.col] ?? '', b.cells[sort.col] ?? ''));
  }, [section.rows, chain, query, sort, visibleColIndices]);

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
            <h2 className="section">{label}</h2>
            <span className="badge badge-demo">Snapshot</span>
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
            Filter {label}
          </label>
          <input
            ref={searchInputRef}
            id={searchId}
            type="search"
            placeholder={`Search ${label.toLowerCase()}…`}
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
            Snapshot rows for {label} — click any column header to sort.
          </caption>
          <thead>
            <tr>
              {visibleColIndices.map(origIdx => {
                const rawCol = section.cols[origIdx];
                const colLabel = translateColumn(rawCol);
                const on = origIdx === sort.col;
                return (
                  <th
                    key={`${rawCol}-${origIdx}`}
                    scope="col"
                    aria-sort={on ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}
                  >
                    <button type="button" className="sort" onClick={() => toggleSort(origIdx)}>
                      {colLabel}
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
                {visibleColIndices.map((origIdx, vi) => {
                  const cell = row.cells[origIdx] ?? '';
                  if (vi === 0) {
                    return (
                      <th key={origIdx} scope="row">
                        {cell || '—'}
                      </th>
                    );
                  }
                  if (isHttpUrl(cell)) {
                    return (
                      <td key={origIdx}>
                        <a href={cell.trim()} target="_blank" rel="noopener noreferrer" className="table-link">
                          {hostnameLabel(cell)} ↗
                        </a>
                      </td>
                    );
                  }
                  const isUp = /▲/.test(cell) || /^\+[\d$]/.test(cell.trim());
                  const isDown = /▼/.test(cell) || /^-[\d$]/.test(cell.trim());
                  const isNum = sortVal(cell) !== null;
                  const classes = [isUp ? 'up' : isDown ? 'dn' : '', isNum ? 'mono' : ''].filter(Boolean).join(' ');
                  return (
                    <td key={origIdx} className={classes || undefined}>
                      {cell || '—'}
                    </td>
                  );
                })}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={visibleColIndices.length} className="table-empty">
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
