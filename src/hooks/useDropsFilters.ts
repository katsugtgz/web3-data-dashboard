import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FeedItem, TaskType } from '../../shared/types';

export type DropsSort = 'score' | 'new';
export const DROPS_PAGE_STEP = 24;

interface ParsedHashParams {
  taskType: 'All' | TaskType;
  chain: string;
  hideRisk: boolean;
  minSources: number;
  sort: DropsSort;
  query: string;
}

const VALID_TASK_TYPES = new Set<string>([
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
]);

function readDropsHashParams(): ParsedHashParams {
  const hash = window.location.hash.replace(/^#/, '');
  const qIdx = hash.indexOf('?');
  const tab = qIdx >= 0 ? hash.slice(0, qIdx) : hash;
  if (tab && tab !== 'drops') {
    return { taskType: 'All', chain: 'All', hideRisk: true, minSources: 1, sort: 'score', query: '' };
  }
  const params = new URLSearchParams(qIdx >= 0 ? hash.slice(qIdx + 1) : '');
  const rawType = params.get('type') ?? 'All';
  const taskType = VALID_TASK_TYPES.has(rawType) ? (rawType as TaskType) : 'All';
  const chain = params.get('chain') || 'All';
  const hideRisk = params.get('risk') !== 'show';
  const minSources = Math.max(1, Number.parseInt(params.get('min') ?? '1', 10) || 1);
  const sort: DropsSort = params.get('sort') === 'new' ? 'new' : 'score';
  const query = params.get('q') ?? '';
  return { taskType, chain, hideRisk, minSources, sort, query };
}

function writeDropsHashParams(state: ParsedHashParams): void {
  const currentTab = window.location.hash.replace(/^#/, '').split('?')[0];
  if (currentTab && currentTab !== 'drops') return;
  const params = new URLSearchParams();
  if (state.taskType !== 'All') params.set('type', state.taskType);
  if (state.chain !== 'All') params.set('chain', state.chain);
  if (!state.hideRisk) params.set('risk', 'show');
  if (state.minSources > 1) params.set('min', String(state.minSources));
  if (state.sort !== 'score') params.set('sort', state.sort);
  if (state.query.trim()) params.set('q', state.query.trim());
  const qs = params.toString();
  const nextHash = qs ? `#drops?${qs}` : '#drops';
  if (window.location.hash !== nextHash) {
    history.replaceState(null, '', nextHash);
  }
}

export function useDropsFilters(items: FeedItem[], isDropsTab: boolean) {
  const initial = useMemo(() => readDropsHashParams(), []);
  const [taskType, setTaskTypeState] = useState<'All' | TaskType>(initial.taskType);
  const [chain, setChainState] = useState<string>(initial.chain);
  const [hideRisk, setHideRiskState] = useState<boolean>(initial.hideRisk);
  const [minSources, setMinSourcesState] = useState<number>(initial.minSources);
  const [sort, setSortState] = useState<DropsSort>(initial.sort);
  const [query, setQueryState] = useState<string>(initial.query);
  const [limit, setLimit] = useState<number>(DROPS_PAGE_STEP);

  useEffect(() => {
    if (!isDropsTab) return;
    writeDropsHashParams({ taskType, chain, hideRisk, minSources, sort, query });
  }, [isDropsTab, taskType, chain, hideRisk, minSources, sort, query]);

  const setTaskType = useCallback((next: 'All' | TaskType) => {
    setTaskTypeState(next);
    setLimit(DROPS_PAGE_STEP);
  }, []);

  const setChain = useCallback((next: string) => {
    setChainState(next);
    setLimit(DROPS_PAGE_STEP);
  }, []);

  const toggleHideRisk = useCallback(() => {
    setHideRiskState(v => !v);
    setLimit(DROPS_PAGE_STEP);
  }, []);

  const setMinSources = useCallback((next: number) => {
    setMinSourcesState(next);
    setLimit(DROPS_PAGE_STEP);
  }, []);

  const setSort = useCallback((next: DropsSort) => {
    setSortState(next);
    setLimit(DROPS_PAGE_STEP);
  }, []);

  const setQuery = useCallback((next: string) => {
    setQueryState(next);
    setLimit(DROPS_PAGE_STEP);
  }, []);

  const resetFilters = useCallback(() => {
    setTaskTypeState('All');
    setChainState('All');
    setHideRiskState(true);
    setMinSourcesState(1);
    setSortState('score');
    setQueryState('');
    setLimit(DROPS_PAGE_STEP);
  }, []);

  const chainOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      for (const c of item.chains) {
        counts.set(c, (counts.get(c) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  }, [items]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = items.filter(it => {
      if (hideRisk && it.risk.level === 'risk') return false;
      if (it.sourceCount < minSources) return false;
      if (taskType !== 'All' && !it.taskTypes.includes(taskType)) return false;
      if (chain !== 'All' && !it.chains.includes(chain)) return false;
      if (!q) return true;
      return (
        it.project.toLowerCase().includes(q) ||
        (it.ticker?.toLowerCase().includes(q) ?? false) ||
        (it.domain?.toLowerCase().includes(q) ?? false) ||
        it.summary.toLowerCase().includes(q) ||
        it.chains.some(c => c.toLowerCase().includes(q))
      );
    });
    return filtered.slice().sort((a, b) => {
      if (sort === 'new') return b.lastSeen - a.lastSeen || b.score - a.score;
      return b.score - a.score || b.lastSeen - a.lastSeen;
    });
  }, [items, hideRisk, minSources, taskType, chain, query, sort]);

  const rendered = useMemo(() => visible.slice(0, limit), [visible, limit]);
  const remaining = Math.max(0, visible.length - rendered.length);
  const hasAnyFilter =
    taskType !== 'All' || chain !== 'All' || !hideRisk || minSources > 1 || query.trim() !== '';

  return {
    taskType,
    chain,
    hideRisk,
    minSources,
    sort,
    query,
    chainOptions,
    visible,
    rendered,
    remaining,
    hasAnyFilter,
    setTaskType,
    setChain,
    toggleHideRisk,
    setMinSources,
    setSort,
    setQuery,
    resetFilters,
    showMore: () => setLimit(l => l + DROPS_PAGE_STEP),
    showAll: () => setLimit(visible.length),
  };
}

export type DropsFiltersState = ReturnType<typeof useDropsFilters>;
