import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import type { MarketRow, MarketSection, MarketSector } from '../../shared/types';
import { formatRelativeTime, hostnameLabel, isHttpUrl, sortVal } from '../lib/format';
import { cmpRows, rowKey } from '../lib/marketSort';
import { classifyDeltaCell, detectNumericColumns } from '../lib/marketTable';
import { ExternalLinkIcon, SearchIcon, XIcon } from './Icons';

interface Sort {
  col: number;
  dir: 1 | -1;
}

interface Props {
  section: MarketSection;
  sectors?: MarketSector[];
  searchRef?: RefObject<HTMLInputElement | null>;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ENTITY_TICKER_RE = /^(.+?)\s+\(([A-Z0-9.$_-]{2,12})\)$/;
const STALE_THRESHOLD_MS = 86_400_000;

const DEFAULT_SORT_TARGETS: Record<MarketSection['id'], readonly string[]> = {
  crypto: ['market cap', '24h volume'],
  defi: ['tvl'],
  yields: ['tvl'],
  predictions: ['24h volume'],
  trending: ['boosts'],
  github: ['updated'],
};

function defaultSortForSection(section: MarketSection): Sort {
  if (!section.rows.some(r => r.sortValues !== undefined)) {
    return { col: -1, dir: 1 };
  }
  const targets = DEFAULT_SORT_TARGETS[section.id] ?? [];
  const lowerCols = section.cols.map(c => c.trim().toLowerCase());
  for (const target of targets) {
    const idx = lowerCols.indexOf(target);
    if (idx > 0) return { col: idx, dir: -1 };
  }
  return { col: -1, dir: 1 };
}

function splitEntityLabel(raw: string): { name: string; ticker: string | null } {
  const trimmed = raw.trim();
  const match = trimmed.match(ENTITY_TICKER_RE);
  if (!match) return { name: trimmed, ticker: null };
  return { name: match[1], ticker: match[2] };
}

function rowChains(r: MarketRow): string[] {
  if (r.chains?.length) return r.chains;
  return r.chain ? [r.chain] : [];
}

function SectorStrip({ sectors }: { sectors: MarketSector[] }) {
  if (sectors.length === 0) return null;
  return (
    <div className="sector-strip" role="region" aria-label="Top sector movers (24h)">
      <span className="sector-strip-label">24h Sector Movers</span>
      <div className="chipline">
        {sectors.map(s => {
          const delta = classifyDeltaCell(s.change24h);
          const pillClass =
            delta.tone === 'up'
              ? 'delta-up'
              : delta.tone === 'down'
                ? 'delta-dn'
                : 'delta-neutral';
          return (
            <span key={s.name} className="sector-pill">
              <span className="sector-pill-name">{s.name}</span>
              <span className={pillClass}>{s.change24h}</span>
              <span className="sector-pill-cap mono">({s.marketCap})</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

interface MarketCellProps {
  cell: string;
  rowLabel: string;
  isNumCol: boolean;
}

function MarketDataCell({ cell, rowLabel, isNumCol }: MarketCellProps) {
  if (isHttpUrl(cell)) {
    return (
      <td>
        <a href={cell.trim()} target="_blank" rel="noopener noreferrer" className="table-link">
          <span>{hostnameLabel(cell)}</span>
          <ExternalLinkIcon size={12} className="table-link-icon" />
          <span className="sr"> — {rowLabel} link (opens in a new tab)</span>
        </a>
      </td>
    );
  }

  const delta = classifyDeltaCell(cell);
  if (delta.isPercentOrSigned && delta.tone !== 'neutral') {
    return (
      <td className={isNumCol ? 'td-num' : undefined}>
        <span className={delta.tone === 'up' ? 'delta-up' : 'delta-dn'}>{cell}</span>
      </td>
    );
  }

  const trimmed = cell.trim();
  const isMono = sortVal(cell) !== null || delta.isPercentOrSigned || ISO_DATE_RE.test(trimmed);
  const classes = [isNumCol ? 'td-num' : '', isMono ? 'mono' : ''].filter(Boolean).join(' ');
  return <td className={classes || undefined}>{cell || '—'}</td>;
}

interface EntityCellProps {
  rank: number;
  rawCell: string;
  href?: string;
}

function MarketEntityCell({ rank, rawCell, href }: EntityCellProps) {
  const entity = splitEntityLabel(rawCell);
  const displayName = entity.name || '—';
  const safeRowHref = href && isHttpUrl(href) ? href.trim() : null;

  return (
    <div className="market-entity-cell">
      <span className="market-rank mono" aria-hidden="true">
        {rank}
      </span>
      {safeRowHref ? (
        <a href={safeRowHref} target="_blank" rel="noopener noreferrer" className="table-link table-entity-link">
          <span className="table-entity-label" title={rawCell}>
            {displayName}
          </span>
          {entity.ticker && <span className="market-ticker-badge mono">{entity.ticker}</span>}
          <ExternalLinkIcon size={12} className="table-link-icon" />
          <span className="sr"> (opens in a new tab)</span>
        </a>
      ) : (
        <span className="table-entity-plain">
          <span className="table-entity-label" title={rawCell}>
            {displayName}
          </span>
          {entity.ticker && <span className="market-ticker-badge mono">{entity.ticker}</span>}
        </span>
      )}
    </div>
  );
}

function buildRowKeys(rows: readonly MarketRow[], sectionId: MarketSection['id']): Map<MarketRow, string> {
  const ids = new Set<string>();
  const duplicates = new Set<string>();
  for (const r of rows) {
    const id = rowKey(r, sectionId);
    if (ids.has(id)) duplicates.add(id);
    ids.add(id);
  }
  const keys = new Map<MarketRow, string>();
  const seen = new Map<string, number>();
  for (const r of rows) {
    const id = rowKey(r, sectionId);
    const base = duplicates.has(id) ? JSON.stringify([id, r.chain, r.href, r.cells[0]]) : id;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    keys.set(r, n === 0 ? base : `${base}#${n}`);
  }
  return keys;
}

function emptyRowsMessage(query: string, chain: string): string {
  const trimmed = query.trim();
  if (trimmed) {
    return `No rows match “${trimmed}”${chain !== 'All' ? ` on ${chain}` : ''}.`;
  }
  if (chain !== 'All') {
    return `No rows available on ${chain}.`;
  }
  return 'No rows available right now.';
}

function MarketPanelHeader({
  section,
  rowCount,
  announcedCount,
  isStale,
}: {
  section: MarketSection;
  rowCount: number;
  announcedCount: number | null;
  isStale: boolean;
}) {
  const safeSourceUrl = isHttpUrl(section.sourceUrl) ? section.sourceUrl.trim() : null;

  return (
    <div className="panelhead">
      <div>
        <div className="paneltitle">
          <h2 className="section">{section.title}</h2>
          {safeSourceUrl ? (
            <a
              href={safeSourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="badge badge-demo market-source-badge"
            >
              <span>{section.source}</span>
              <ExternalLinkIcon size={12} />
              <span className="sr"> data source (opens in a new tab)</span>
            </a>
          ) : (
            <span className="badge badge-demo market-source-badge">{section.source}</span>
          )}
          {isStale ? (
            <span className="badge badge-warn market-stale-pill mono">
              <span className="status-dot status-dot-degraded" aria-hidden="true" />
              <span>Stale · {formatRelativeTime(section.fetchedAt)}</span>
            </span>
          ) : (
            <span className="countchip mono market-live-chip">
              <span className="status-dot status-dot-ok" aria-hidden="true" />
              <span>Updated {formatRelativeTime(section.fetchedAt)}</span>
            </span>
          )}
          <span className="countchip mono">
            {rowCount} / {section.rows.length} rows
          </span>
          <span className="sr" role="status" aria-live="polite">
            {announcedCount !== null ? `${announcedCount} of ${section.rows.length} rows` : ''}
          </span>
        </div>
        <p className="panel-blurb">{section.blurb}</p>
      </div>
    </div>
  );
}

function MarketControls({
  title,
  chains,
  chain,
  query,
  searchId,
  searchInputRef,
  onSelectChain,
  onChangeQuery,
  onClearQuery,
}: {
  title: string;
  chains: readonly string[];
  chain: string;
  query: string;
  searchId: string;
  searchInputRef: RefObject<HTMLInputElement | null>;
  onSelectChain: (chain: string) => void;
  onChangeQuery: (value: string) => void;
  onClearQuery: () => void;
}) {
  return (
    <div className="demo-controls">
      {chains.length > 1 && (
        <div className="chipline chain-filter" role="group" aria-label="Filter by chain">
          {['All', ...chains].map(c => (
            <button
              type="button"
              key={c}
              className="chip market-chain-chip"
              data-chain={c}
              aria-pressed={c === chain}
              onClick={() => onSelectChain(c)}
            >
              {c}
            </button>
          ))}
        </div>
      )}
      <div className="search-box market-search-box">
        <label htmlFor={searchId} className="sr">
          Filter {title}
        </label>
        <SearchIcon size={15} className="search-box-icon" />
        <input
          ref={searchInputRef}
          id={searchId}
          type="search"
          placeholder={`Search ${title.toLowerCase()}…`}
          value={query}
          onChange={e => onChangeQuery(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape' && query) {
              e.stopPropagation();
              onChangeQuery('');
            }
          }}
        />
        {query ? (
          <button
            type="button"
            className="search-clear"
            aria-label={`Clear ${title} search`}
            title="Clear search"
            onClick={onClearQuery}
          >
            <XIcon size={13} />
          </button>
        ) : (
          <kbd className="kbd-hint" aria-hidden="true">
            /
          </kbd>
        )}
      </div>
    </div>
  );
}

function MarketTable({
  section,
  rows,
  rowKeys,
  numericCols,
  sort,
  captionId,
  query,
  chain,
  hasFilters,
  onToggleSort,
  onClearFilters,
}: {
  section: MarketSection;
  rows: readonly MarketRow[];
  rowKeys: Map<MarketRow, string>;
  numericCols: readonly boolean[];
  sort: Sort;
  captionId: string;
  query: string;
  chain: string;
  hasFilters: boolean;
  onToggleSort: (col: number) => void;
  onClearFilters: () => void;
}) {
  return (
    <div tabIndex={0} role="region" aria-labelledby={captionId} className="table-wrap">
      <table className="demo">
        <caption id={captionId} className="sr">
          Market rows for {section.title} from {section.source} — click any column header to sort.
        </caption>
        <thead>
          <tr>
            {section.cols.map((col, idx) => {
              const on = sort.col === idx;
              const isNumCol = numericCols[idx] ?? false;
              const thClasses = [isNumCol ? 'th-num' : '', on ? 'is-sorted-col' : ''].filter(Boolean).join(' ');
              return (
                <th
                  key={col}
                  scope="col"
                  className={thClasses || undefined}
                  aria-sort={on ? (sort.dir > 0 ? 'ascending' : 'descending') : undefined}
                >
                  <button
                    type="button"
                    className={on ? 'sort th-sort is-sorted' : 'sort th-sort'}
                    onClick={() => onToggleSort(idx)}
                  >
                    <span>{col}</span>
                    <span className="arr" aria-hidden="true">
                      {on ? (sort.dir > 0 ? '▲' : '▼') : '↕'}
                    </span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowKeys.get(row) ?? rowKey(row, section.id)}>
              {section.cols.map((col, ci) => {
                const cell = row.cells[ci] ?? '';
                if (ci === 0) {
                  return (
                    <th key={col} scope="row">
                      <MarketEntityCell rank={rowIndex + 1} rawCell={cell} href={row.href} />
                    </th>
                  );
                }
                return (
                  <MarketDataCell
                    key={col}
                    cell={cell}
                    rowLabel={row.cells[0] ?? section.title}
                    isNumCol={numericCols[ci] ?? false}
                  />
                );
              })}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={section.cols.length} className="table-empty">
                <div className="table-empty-inner">
                  <p className="table-empty-msg">{emptyRowsMessage(query, chain)}</p>
                  {hasFilters && (
                    <button type="button" className="btn btn-subtle" onClick={onClearFilters}>
                      Clear filters
                    </button>
                  )}
                </div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function MarketPanel({ section, sectors, searchRef }: Props) {
  const [chain, setChain] = useState('All');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>(() => defaultSortForSection(section));
  const [announcedCount, setAnnouncedCount] = useState<number | null>(null);
  const prevCountRef = useRef(section.rows.length);
  const localSearchRef = useRef<HTMLInputElement>(null);
  const activeSearchRef = searchRef ?? localSearchRef;
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

  const numericCols = useMemo(
    () => detectNumericColumns(section.cols, section.rows),
    [section.cols, section.rows],
  );

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = section.rows.filter(r => {
      if (activeChain !== 'All' && !rowChainSets.get(r)?.has(activeChain)) return false;
      if (!q) return true;
      return r.cells.some(c => c.toLowerCase().includes(q));
    });
    if (sort.col < 0) return filtered;
    return filtered.slice().sort((a, b) => cmpRows(a, b, sort.col, sort.dir));
  }, [section.rows, rowChainSets, activeChain, query, sort]);

  const rowKeys = useMemo(() => buildRowKeys(section.rows, section.id), [section.rows, section.id]);

  useEffect(() => {
    if (rows.length === prevCountRef.current) return;
    const id = setTimeout(() => {
      prevCountRef.current = rows.length;
      setAnnouncedCount(rows.length);
    }, 300);
    return () => clearTimeout(id);
  }, [rows.length]);

  const toggleSort = (col: number) =>
    setSort(s => ({
      col,
      dir: s.col === col ? (-s.dir as 1 | -1) : numericCols[col] ? -1 : 1,
    }));

  const isStale =
    section.stale || (section.fetchedAt > 0 && Date.now() - section.fetchedAt > STALE_THRESHOLD_MS);
  const hasFilters = query.trim().length > 0 || activeChain !== 'All';
  const clearFilters = () => {
    setQuery('');
    setChain('All');
    activeSearchRef.current?.focus();
  };

  return (
    <section role="tabpanel" id={`panel-${section.id}`} aria-labelledby={`tab-${section.id}`} className="demo-panel">
      <MarketPanelHeader section={section} rowCount={rows.length} announcedCount={announcedCount} isStale={isStale} />

      {section.id === 'crypto' && sectors && sectors.length > 0 && <SectorStrip sectors={sectors} />}

      <MarketControls
        title={section.title}
        chains={chains}
        chain={activeChain}
        query={query}
        searchId={searchId}
        searchInputRef={activeSearchRef}
        onSelectChain={setChain}
        onChangeQuery={setQuery}
        onClearQuery={() => {
          setQuery('');
          activeSearchRef.current?.focus();
        }}
      />

      <MarketTable
        section={section}
        rows={rows}
        rowKeys={rowKeys}
        numericCols={numericCols}
        sort={sort}
        captionId={captionId}
        query={query}
        chain={activeChain}
        hasFilters={hasFilters}
        onToggleSort={toggleSort}
        onClearFilters={clearFilters}
      />
    </section>
  );
}
