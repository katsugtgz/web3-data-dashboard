import { useState, type RefObject } from 'react';
import { TASK_TYPES } from '../../shared/constants';
import type { DropsFiltersState, DropsSort } from '../hooks/useDropsFilters';
import { ChainBadge } from './EntityVisual';
import { SearchIcon, ShieldAlertIcon, ShieldCheckIcon, XIcon } from './Icons';

const MIN_SOURCE_OPTIONS = [1, 2, 3] as const;
const MAX_VISIBLE_CHAINS = 8;

interface Props {
  filters: DropsFiltersState;
  searchRef: RefObject<HTMLInputElement | null>;
}

function DropsChainStrip({ filters }: { filters: DropsFiltersState }) {
  const [showAllChains, setShowAllChains] = useState(false);

  if (filters.chainOptions.length === 0) return null;

  const hasOverflow = filters.chainOptions.length > MAX_VISIBLE_CHAINS;
  let visibleChains = filters.chainOptions;
  if (!showAllChains && hasOverflow) {
    const top = filters.chainOptions.slice(0, MAX_VISIBLE_CHAINS);
    const activeOutside =
      filters.chain !== 'All' && !top.some(([name]) => name === filters.chain)
        ? filters.chainOptions.find(([name]) => name === filters.chain)
        : undefined;
    visibleChains = activeOutside ? [...top, activeOutside] : top;
  }
  const hiddenCount = Math.max(0, filters.chainOptions.length - visibleChains.length);

  return (
    <div className="chipline chain-strip" role="group" aria-label="Filter by chain">
      <button
        type="button"
        className="chip"
        aria-pressed={filters.chain === 'All'}
        onClick={() => filters.setChain('All')}
      >
        All chains
      </button>
      {visibleChains.map(([name, cnt]) => (
        <button
          key={name}
          type="button"
          className="chip"
          aria-pressed={filters.chain === name}
          onClick={() => filters.setChain(name)}
        >
          <ChainBadge chain={name} size={13} className="chain-badge-bare" />
          <span className="chip-count mono">{cnt}</span>
        </button>
      ))}
      {hasOverflow && (
        <button
          type="button"
          className="chip chip-more"
          aria-expanded={showAllChains}
          onClick={() => setShowAllChains(v => !v)}
        >
          {showAllChains ? 'Show fewer' : `+${hiddenCount} more`}
        </button>
      )}
    </div>
  );
}

export function DropsFilterDock({ filters, searchRef }: Props) {
  const showingRisk = !filters.hideRisk;

  return (
    <div className="filter-dock drops-filter-dock">
      <div className="dock-primary">
        <div className="search-box search-wide">
          <SearchIcon size={15} className="search-icon" />
          <label htmlFor="drops-q" className="sr">
            Search live drops
          </label>
          <input
            ref={searchRef}
            id="drops-q"
            type="search"
            placeholder="Search project, ticker, domain, chain…"
            value={filters.query}
            onChange={e => filters.setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape' && filters.query) {
                e.stopPropagation();
                filters.setQuery('');
              }
            }}
          />
          {filters.query ? (
            <button
              type="button"
              className="search-clear"
              aria-label="Clear search"
              onClick={() => {
                filters.setQuery('');
                searchRef.current?.focus();
              }}
            >
              <XIcon size={13} />
            </button>
          ) : (
            <kbd className="kbd-hint" aria-hidden="true">
              /
            </kbd>
          )}
        </div>

        <div className="dock-right drops-dock-right">
          <label className="sort-wrap" htmlFor="drops-sort">
            <span className="sr">Sort drops by</span>
            <select
              id="drops-sort"
              className="select"
              value={filters.sort}
              onChange={e => filters.setSort(e.target.value as DropsSort)}
            >
              <option value="score">Sort: Top score</option>
              <option value="new">Sort: Newest</option>
            </select>
          </label>

          <button
            type="button"
            className="dock-toggle-btn risk-toggle-btn"
            aria-pressed={showingRisk}
            title={
              showingRisk
                ? 'High-risk items are currently shown. Click to hide RISK items.'
                : 'High-risk items are hidden. Click to inspect flagged RISK items.'
            }
            onClick={filters.toggleHideRisk}
          >
            {showingRisk ? (
              <ShieldAlertIcon size={14} />
            ) : (
              <ShieldCheckIcon size={14} className="risk-toggle-icon-ok" />
            )}
            <span>{showingRisk ? 'Risk: Shown' : 'Risk: Hidden'}</span>
          </button>

          <div className="dock-sources-wrap">
            <span className="seg-prefix" aria-hidden="true">
              Sources
            </span>
            <div className="seg-group drops-sources-seg" id="drops-min-sources" role="group" aria-label="Minimum sources">
              {MIN_SOURCE_OPTIONS.map(min => (
                <button
                  key={min}
                  type="button"
                  className="seg-btn mono"
                  aria-pressed={filters.minSources === min}
                  aria-label={`At least ${min} ${min === 1 ? 'source' : 'sources'}`}
                  title={`Show drops seen in ${min}+ ${min === 1 ? 'source' : 'sources'}`}
                  onClick={() => filters.setMinSources(min)}
                >
                  {min}+
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="chipline type-strip" role="group" aria-label="Filter by task type">
        <button
          type="button"
          className="chip"
          aria-pressed={filters.taskType === 'All'}
          onClick={() => filters.setTaskType('All')}
        >
          All tasks
        </button>
        {TASK_TYPES.map(t => (
          <button
            key={t}
            type="button"
            className="chip"
            aria-pressed={filters.taskType === t}
            onClick={() => filters.setTaskType(t)}
          >
            {t}
          </button>
        ))}
      </div>

      <DropsChainStrip filters={filters} />
    </div>
  );
}
