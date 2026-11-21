import type { RefObject } from 'react';
import type { TaskType } from '../../shared/types';
import type { DropsFiltersState, DropsSort } from '../hooks/useDropsFilters';

const TASK_TYPES: TaskType[] = [
  'testnet',
  'faucet',
  'quest',
  'waitlist',
  'bridge',
  'stake',
  'mint',
  'points',
  'trade',
  'social',
  'node',
  'other',
];

interface Props {
  filters: DropsFiltersState;
  searchRef: RefObject<HTMLInputElement | null>;
}

export function DropsFilterDock({ filters, searchRef }: Props) {
  return (
    <div className="filter-dock">
      <div className="dock-primary">
        <div className="search">
          <label htmlFor="drops-q" className="sr">
            Search live drops
          </label>
          <input
            ref={searchRef}
            id="drops-q"
            type="search"
            placeholder="Search project, ticker, domain, chain… (/)"
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

        <div className="dock-right">
          <label className="sort-wrap">
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

          <label className="sort-wrap">
            <span className="sr">Minimum sources</span>
            <select
              id="drops-min-sources"
              className="select"
              value={filters.minSources}
              onChange={e => filters.setMinSources(Number(e.target.value))}
            >
              <option value={1}>1+ source</option>
              <option value={2}>2+ sources</option>
              <option value={3}>3+ sources</option>
            </select>
          </label>

          <button
            type="button"
            className="chip"
            aria-pressed={filters.hideRisk}
            onClick={filters.toggleHideRisk}
          >
            Hide RISK
          </button>
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

      {filters.chainOptions.length > 0 && (
        <div className="chipline chain-strip" role="group" aria-label="Filter by chain">
          <button
            type="button"
            className="chip"
            aria-pressed={filters.chain === 'All'}
            onClick={() => filters.setChain('All')}
          >
            All chains
          </button>
          {filters.chainOptions.map(([name, cnt]) => (
            <button
              key={name}
              type="button"
              className="chip"
              aria-pressed={filters.chain === name}
              onClick={() => filters.setChain(name)}
            >
              {name} <span className="chip-count mono">{cnt}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
