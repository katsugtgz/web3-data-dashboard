import { useState, type RefObject } from 'react';
import type { FitKey } from '../../shared/types';
import type { AirdropFiltersState, SortKey } from '../hooks/useAirdropFilters';
import { GRADE_ORDER } from '../lib/labels';

interface Props {
  filters: AirdropFiltersState;
  types: string[];
  fit: Record<FitKey, string>;
  searchRef: RefObject<HTMLInputElement | null>;
}

function AdvancedFilters({ filters, fit }: { filters: AirdropFiltersState; fit: Record<FitKey, string> }) {
  const fitEntries = Object.entries(fit) as [FitKey, string][];

  return (
    <div id="more-filters" className="advanced-filters">
      <div className="adv-row">
        <span className="adv-label">Tier</span>
        <div className="chipline" role="group" aria-label="Filter by grade">
          {(['All', ...GRADE_ORDER] as const).map(g => (
            <button
              key={g}
              type="button"
              className="chip"
              aria-pressed={filters.grade === g}
              onClick={() => filters.setGrade(g)}
            >
              {g === 'All' ? 'All tiers' : `Tier ${g}`}
            </button>
          ))}
        </div>
      </div>

      {filters.chainCounts.length > 0 && (
        <div className="adv-row">
          <span className="adv-label">Chain</span>
          <div className="chipline" role="group" aria-label="Filter by chain">
            <button
              type="button"
              className="chip"
              aria-pressed={filters.activeChain === 'All'}
              onClick={() => filters.setChain('All')}
            >
              All chains
            </button>
            {filters.topChains.map(([name, cnt]) => (
              <button
                key={name}
                type="button"
                className="chip"
                aria-pressed={filters.activeChain === name}
                onClick={() => filters.setChain(name)}
              >
                {name} <span className="chip-count mono">{cnt}</span>
              </button>
            ))}
            {filters.extraChains.length > 0 && (
              <select
                aria-label="More chains"
                className="select select-compact"
                value={filters.extraChains.some(([n]) => n === filters.activeChain) ? filters.activeChain : ''}
                onChange={e => filters.setChain(e.target.value || 'All')}
              >
                <option value="">+{filters.extraChains.length} more chains…</option>
                {filters.extraChains.map(([name, cnt]) => (
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
            aria-pressed={filters.fitFilter === 'All'}
            onClick={() => filters.setFitFilter('All')}
          >
            Any profile
          </button>
          {fitEntries.map(([k, lbl]) => (
            <button
              key={k}
              type="button"
              className="chip"
              aria-pressed={filters.fitFilter === k}
              onClick={() => filters.setFitFilter(k)}
            >
              {lbl}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function FilterDock({ filters, types, fit, searchRef }: Props) {
  const [showMoreFilters, setShowMoreFilters] = useState(false);

  const statusTabs = [
    ['all', 'All', filters.counts.total],
    ['pre', 'Pre-token', filters.counts.pre],
    ['launched', 'Token live', filters.counts.launched],
    ['saved', 'Saved', filters.counts.savedMatch],
  ] as const;

  return (
    <div className="filter-dock">
      <div className="dock-primary">
        <div className="seg-group" role="group" aria-label="Project token status">
          {statusTabs.map(([key, lbl, count]) => (
            <button
              key={key}
              type="button"
              className="seg-btn"
              aria-pressed={filters.status === key}
              onClick={() => filters.setStatus(key)}
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
              value={filters.query}
              onChange={e => filters.setQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape' && filters.query) {
                  e.stopPropagation();
                  filters.setQuery('');
                }
              }}
            />
          </div>

          <label className="sort-wrap" htmlFor="proj-sort">
            <span className="sr">Sort projects by</span>
            <select
              id="proj-sort"
              className="select"
              value={filters.sortBy}
              onChange={e => filters.setSortBy(e.target.value as SortKey)}
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
            aria-pressed={filters.freeOnly}
            onClick={filters.toggleFreeOnly}
          >
            $0 Free
          </button>

          <button
            type="button"
            className="chip"
            aria-expanded={showMoreFilters}
            aria-controls="more-filters"
            aria-pressed={showMoreFilters || filters.activeAdvancedCount > 0}
            onClick={() => setShowMoreFilters(v => !v)}
          >
            Filters{filters.activeAdvancedCount > 0 ? ` (${filters.activeAdvancedCount})` : ''}
          </button>
        </div>
      </div>

      <div className="chipline type-strip" role="group" aria-label="Project type filter">
        {['All', ...types].map(t => (
          <button
            key={t}
            type="button"
            className="chip"
            aria-pressed={filters.type === t}
            onClick={() => filters.setType(t)}
          >
            {t}
          </button>
        ))}
      </div>

      {showMoreFilters && <AdvancedFilters filters={filters} fit={fit} />}
    </div>
  );
}
