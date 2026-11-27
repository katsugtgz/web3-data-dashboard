import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import type { MarketRow, MarketSection, MarketSectionId, MarketSector } from '../../shared/types';
import { formatRelativeTime, hostnameLabel, isHttpUrl, sortVal } from '../lib/format';
import { cmpRows, rowKey } from '../lib/marketSort';
import { changeMagnitude, momentumPercent, scaleDeltaColumns, sectorIntensity } from '../lib/viz';
import {
  classifyDeltaCell,
  detectNumericColumns,
  formatDeltaCell,
  formatProtocolSlugLabel,
  getLanguageVisual,
  parseChainCell,
  parseTrendingEntityCell,
  resolveColumnKind,
  resolveEntityCellMeta,
  type MarketColumnKind,
} from '../lib/marketTable';
import { ChainBadge, CryptoTickerPill, EntityAvatar, PlatformBadge } from './EntityVisual';
import {
  ChevronDownIcon,
  ChevronUpIcon,
  ExternalLinkIcon,
  GlobeIcon,
  LayersIcon,
  SearchIcon,
  TrendingUpIcon,
  XIcon,
} from './Icons';

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
const STALE_THRESHOLD_MS = 86_400_000;

const DEFAULT_SORT_TARGETS: Record<MarketSectionId, readonly string[]> = {
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

function rowChains(r: MarketRow): string[] {
  if (r.chains?.length) return r.chains;
  return r.chain ? [r.chain] : [];
}

function SectorStrip({ sectors }: { sectors: MarketSector[] }) {
  if (sectors.length === 0) return null;
  // The widest bar belongs to the biggest mover, so bar lengths compare across chips.
  const peak = Math.max(0, ...sectors.map(s => changeMagnitude(s.change24h)));

  return (
    <div className="sector-strip" role="region" aria-label="Top sector movers (24h)">
      <span className="sector-strip-label">
        <TrendingUpIcon size={13} className="sector-strip-icon" />
        <span>24h Sector Movers</span>
      </span>
      <div className="chipline">
        {sectors.map(s => {
          const displayChange = formatDeltaCell(s.change24h);
          const delta = classifyDeltaCell(displayChange);
          const tone = delta.tone === 'up' || delta.tone === 'down' ? delta.tone : 'neutral';
          const magnitude = changeMagnitude(s.change24h);
          return (
            <span key={s.name} className={`sector-pill is-${tone}-${sectorIntensity(magnitude)}`}>
              <span className="sector-pill-name">{s.name}</span>
              <span className="sector-pill-bar" aria-hidden="true">
                <span style={{ width: `${momentumPercent(magnitude, peak)}%` }} />
              </span>
              <span className="sector-pill-delta">
                {delta.tone === 'up' && <ChevronUpIcon size={12} className="sector-delta-icon" />}
                {delta.tone === 'down' && <ChevronDownIcon size={12} className="sector-delta-icon" />}
                <span>{displayChange}</span>
              </span>
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
  colKind: MarketColumnKind;
  maxAbs: number;
}

function MarketChainCell({ cell }: { cell: string }) {
  const parsed = parseChainCell(cell);
  if (parsed.chains.length === 0) {
    return <td className="td-chain">—</td>;
  }
  return (
    <td className="td-chain">
      <div className="market-chain-list">
        {parsed.chains.map(ch => (
          <ChainBadge key={ch} chain={ch} size={13} />
        ))}
        {parsed.overflow && <span className="market-chain-overflow mono">{parsed.overflow}</span>}
      </div>
    </td>
  );
}

function MarketProjectCell({ cell }: { cell: string }) {
  return (
    <td className="td-project">
      <span className="market-project-label" title={cell.trim() || undefined}>
        {formatProtocolSlugLabel(cell)}
      </span>
    </td>
  );
}

function MarketLanguageCell({ cell }: { cell: string }) {
  const lang = getLanguageVisual(cell);
  return (
    <td className="td-lang">
      <span className={`market-lang-pill${lang.isUnknown ? ' is-unknown' : ''}`}>
        <span className="market-lang-dot" style={{ backgroundColor: lang.color }} aria-hidden="true" />
        <span>{lang.label}</span>
      </span>
    </td>
  );
}

function MarketIlRiskCell({ cell }: { cell: string }) {
  const trimmed = cell.trim();
  if (!trimmed || trimmed === '—') {
    return <td className="td-nowrap">—</td>;
  }
  const lower = trimmed.toLowerCase();
  const toneClass = lower === 'yes' ? 'is-warn' : lower === 'no' ? 'is-ok' : 'is-neutral';
  return (
    <td className="td-nowrap">
      <span className={`market-risk-pill ${toneClass}`}>{trimmed}</span>
    </td>
  );
}

interface ValueCellProps {
  cell: string;
  rowLabel: string;
  isNumCol: boolean;
  /** Largest absolute change in this column, or 0 when unknown. Sizes the momentum bar. */
  maxAbs: number;
}

function MarketValueCell({ cell, rowLabel, isNumCol, maxAbs }: ValueCellProps) {
  if (isHttpUrl(cell)) {
    return (
      <td className="td-nowrap">
        <a href={cell.trim()} target="_blank" rel="noopener noreferrer" className="table-link">
          <GlobeIcon size={12} className="table-link-globe" />
          <span>{hostnameLabel(cell)}</span>
          <ExternalLinkIcon size={12} className="table-link-icon" />
          <span className="sr"> — {rowLabel} link (opens in a new tab)</span>
        </a>
      </td>
    );
  }

  const displayCell = formatDeltaCell(cell);
  const delta = classifyDeltaCell(displayCell);
  if (delta.isPercentOrSigned && delta.tone !== 'neutral') {
    const toneClass = delta.tone === 'up' ? 'delta-up' : 'delta-dn';
    const width = `${momentumPercent(changeMagnitude(displayCell), maxAbs)}%`;
    return (
      <td className={isNumCol ? 'td-num' : undefined}>
        <span className={`delta-momentum ${toneClass}`}>
          {/* Decorative: length repeats the printed number, so it stays hidden from assistive tech. */}
          <span className="delta-momentum-track" aria-hidden="true">
            <span className="delta-momentum-fill" style={{ width }} />
          </span>
          <span>{displayCell}</span>
        </span>
      </td>
    );
  }

  const trimmed = displayCell.trim();
  const isDate = ISO_DATE_RE.test(trimmed);
  const isMono = sortVal(displayCell) !== null || delta.isPercentOrSigned || isDate;
  const classes = [isNumCol ? 'td-num' : '', isMono ? 'mono' : '', isDate ? 'td-nowrap' : '']
    .filter(Boolean)
    .join(' ');
  return <td className={classes || undefined}>{displayCell || '—'}</td>;
}

function MarketDataCell({ cell, rowLabel, isNumCol, colKind, maxAbs }: MarketCellProps) {
  switch (colKind) {
    case 'chain':
      return <MarketChainCell cell={cell} />;
    case 'project':
      return <MarketProjectCell cell={cell} />;
    case 'language':
      return <MarketLanguageCell cell={cell} />;
    case 'ilRisk':
      return <MarketIlRiskCell cell={cell} />;
    default:
      return <MarketValueCell cell={cell} rowLabel={rowLabel} isNumCol={isNumCol} maxAbs={maxAbs} />;
  }
}

interface EntityCellProps {
  rank: number;
  row: MarketRow;
  sectionId: MarketSectionId;
  source: string;
}

function TrendingEntityCell({ rank, row, source }: Omit<EntityCellProps, 'sectionId'>) {
  const rawCell = row.cells[0] ?? '';
  const safeRowHref = row.href && isHttpUrl(row.href) ? row.href.trim() : null;
  const parsed = parseTrendingEntityCell(rawCell);
  const avatarName = parsed.ticker ?? parsed.description ?? parsed.shortAddr ?? rawCell;

  const content = (
    <span className="market-trending-content">
      <span className="market-trending-top">
        {parsed.shortAddr && <span className="market-addr-pill mono">{parsed.shortAddr}</span>}
        {parsed.ticker && <CryptoTickerPill ticker={parsed.ticker} size={13} className="market-entity-ticker" />}
        {safeRowHref && <ExternalLinkIcon size={12} className="table-link-icon" />}
      </span>
      {parsed.description && (
        <span className="market-trending-desc" title={rawCell}>
          {parsed.description}
        </span>
      )}
    </span>
  );

  return (
    <div className="market-entity-cell market-entity-cell-top">
      <span className="market-rank mono" aria-hidden="true">
        {rank}
      </span>
      <EntityAvatar
        name={avatarName}
        ticker={parsed.ticker}
        id={row.id}
        icon={row.icon}
        chain={row.chain}
        url={row.href}
        source={source}
        sectionId="trending"
        size={26}
        shape="circle"
        className="market-row-avatar"
      />
      {safeRowHref ? (
        <a href={safeRowHref} target="_blank" rel="noopener noreferrer" className="table-link table-entity-link">
          {content}
          <span className="sr"> (opens in a new tab)</span>
        </a>
      ) : (
        <span className="table-entity-plain">{content}</span>
      )}
    </div>
  );
}

function StandardEntityCell({ rank, row, sectionId, source }: EntityCellProps) {
  const meta = resolveEntityCellMeta(row, sectionId);
  const safeRowHref = row.href && isHttpUrl(row.href) ? row.href.trim() : null;

  const labelNode = meta.repoParts ? (
    <span className="table-entity-label market-repo-label" title={meta.rawCell}>
      <span className="market-repo-owner">{meta.repoParts.owner}/</span>
      <wbr />
      <span className="market-repo-name">{meta.repoParts.repo}</span>
    </span>
  ) : (
    <span className="table-entity-label" title={meta.rawCell}>
      {meta.displayName}
    </span>
  );

  const entityBody = (
    <span className="market-entity-text">
      {labelNode}
      {meta.displayTicker && (
        <CryptoTickerPill ticker={meta.displayTicker} size={13} className="market-entity-ticker" />
      )}
      {safeRowHref && <ExternalLinkIcon size={12} className="table-link-icon" />}
    </span>
  );

  return (
    <div className="market-entity-cell">
      <span className="market-rank mono" aria-hidden="true">
        {rank}
      </span>
      <EntityAvatar
        name={meta.displayName}
        ticker={meta.avatarTicker}
        symbol={meta.avatarTicker}
        id={row.id}
        protocolSlug={meta.protocolSlug}
        icon={row.icon}
        chain={row.chain}
        url={row.href}
        source={source}
        sectionId={sectionId}
        size={26}
        shape={meta.avatarShape}
        className="market-row-avatar"
      />
      {safeRowHref ? (
        <a href={safeRowHref} target="_blank" rel="noopener noreferrer" className="table-link table-entity-link">
          {entityBody}
          <span className="sr"> (opens in a new tab)</span>
        </a>
      ) : (
        <span className="table-entity-plain">{entityBody}</span>
      )}
    </div>
  );
}

function MarketEntityCell({ rank, row, sectionId, source }: EntityCellProps) {
  if (sectionId === 'trending') {
    return <TrendingEntityCell rank={rank} row={row} source={source} />;
  }
  return <StandardEntityCell rank={rank} row={row} sectionId={sectionId} source={source} />;
}

function buildRowKeys(rows: readonly MarketRow[], sectionId: MarketSectionId): Map<MarketRow, string> {
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
              <PlatformBadge source={section.source} label={section.source} size={13} className="market-source-platform" />
              <ExternalLinkIcon size={12} />
              <span className="sr"> data source (opens in a new tab)</span>
            </a>
          ) : (
            <span className="badge badge-demo market-source-badge">
              <PlatformBadge source={section.source} label={section.source} size={13} className="market-source-platform" />
            </span>
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
              {c === 'All' ? (
                <>
                  <LayersIcon size={13} className="market-chain-all-icon" />
                  <span>All</span>
                </>
              ) : (
                <ChainBadge chain={c} size={13} className="market-chain-chip-badge" />
              )}
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
  colKinds,
  deltaScales,
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
  colKinds: readonly MarketColumnKind[];
  deltaScales: readonly number[];
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
                      <MarketEntityCell
                        rank={rowIndex + 1}
                        row={row}
                        sectionId={section.id}
                        source={section.source}
                      />
                    </th>
                  );
                }
                return (
                  <MarketDataCell
                    key={col}
                    cell={cell}
                    rowLabel={row.cells[0] ?? section.title}
                    isNumCol={numericCols[ci] ?? false}
                    colKind={colKinds[ci] ?? 'data'}
                    maxAbs={deltaScales[ci] ?? 0}
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

  const colKinds = useMemo(
    () => section.cols.map((col, idx) => resolveColumnKind(section.id, col, idx)),
    [section.id, section.cols],
  );

  const deltaScales = useMemo(() => scaleDeltaColumns(section), [section]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = section.rows.filter(r => {
      if (activeChain !== 'All' && !rowChainSets.get(r)?.has(activeChain)) return false;
      if (!q) return true;
      if (r.cells.some(c => c.toLowerCase().includes(q))) return true;
      if (section.id === 'yields' && r.cells[1]) {
        return formatProtocolSlugLabel(r.cells[1]).toLowerCase().includes(q);
      }
      return false;
    });
    if (sort.col < 0) return filtered;
    return filtered.slice().sort((a, b) => cmpRows(a, b, sort.col, sort.dir));
  }, [section.id, section.rows, rowChainSets, activeChain, query, sort]);

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
        colKinds={colKinds}
        deltaScales={deltaScales}
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
