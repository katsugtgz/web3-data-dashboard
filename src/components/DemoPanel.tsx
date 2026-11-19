import { useMemo, useState } from 'react';
import type { DemoSection } from '../../shared/types';
import { cmpCells } from '../lib/format';

interface Sort {
  col: number;
  dir: 1 | -1;
}

export function DemoPanel({ section, label }: { section: DemoSection; label: string }) {
  const [chain, setChain] = useState('All');
  const [sort, setSort] = useState<Sort>({ col: -1, dir: 1 });

  const chains = useMemo(
    () => [...new Set(section.rows.map(r => r.chain))],
    [section.rows],
  );

  const rows = useMemo(() => {
    const filtered = section.rows.filter(r => chain === 'All' || r.chain === chain);
    if (sort.col < 0) return filtered;
    return filtered
      .slice()
      .sort((a, b) => sort.dir * cmpCells(a.cells[sort.col], b.cells[sort.col]));
  }, [section.rows, chain, sort]);

  const toggleSort = (col: number) =>
    setSort(s => ({ col, dir: s.col === col ? (-s.dir as 1 | -1) : 1 }));

  return (
    <section role="tabpanel" id={`panel-${section.id}`} aria-labelledby={`tab-${section.id}`}>
      <div className="paneltitle">
        <h2 className="section">{label}</h2>
        <span className="badge badge-demo">Demo data</span>
      </div>
      <p>{section.blurb}</p>
      <div className="chipline chain-filter" role="group" aria-label="Filter by chain" style={{ marginTop: 8 }}>
        {['All', ...chains].map(c => (
          <button type="button" key={c} className="chip" data-chain={c} aria-pressed={c === chain} onClick={() => setChain(c)}>
            {c}
          </button>
        ))}
      </div>
      <table className="demo">
        <caption>Sample rows only — the live feed is not part of this clone.</caption>
        <thead>
          <tr>
            {section.cols.map((col, i) => {
              const on = i === sort.col;
              return (
                <th key={col} scope="col" aria-sort={on ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}>
                  <button type="button" className="sort" onClick={() => toggleSort(i)}>
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
              {row.cells.map((cell, ci) => {
                if (ci === 0) return <th key={ci} scope="row">{cell}</th>;
                const cls = /▲/.test(cell) ? 'up' : /▼/.test(cell) ? 'dn' : undefined;
                return (
                  <td key={ci} className={cls}>
                    {cell}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
