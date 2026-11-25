import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FeedItem, TaskType } from '../../shared/types';
import { TASK_TYPES } from '../../shared/constants';
import { isDropsQueryHash, safeReplaceHash } from './useDashboardTabs';

export type DropsSort = 'score' | 'new';
export const DROPS_PAGE_STEP = 24;
const HASH_SYNC_DEBOUNCE_MS = 250;

interface ParsedHashParams {
  taskType: 'All' | TaskType;
  chain: string;
  hideRisk: boolean;
  minSources: number;
  sort: DropsSort;
  query: string;
}

const DEFAULT_FILTERS: ParsedHashParams = {
  taskType: 'All', chain: 'All', hideRisk: true, minSources: 1, sort: 'score', query: '',
};

const VALID_TASK_TYPES = new Set<string>(TASK_TYPES);

function readDropsHashParams(): ParsedHashParams {
  const hash = window.location.hash.replace(/^#/, '');
  const qIdx = hash.indexOf('?');
  const tab = qIdx >= 0 ? hash.slice(0, qIdx) : hash;
  if (tab && tab !== 'drops') return DEFAULT_FILTERS;
  const params = new URLSearchParams(qIdx >= 0 ? hash.slice(qIdx + 1) : '');
  const rawType = params.get('type') ?? 'All';
  const taskType = VALID_TASK_TYPES.has(rawType) ? (rawType as TaskType) : 'All';
  const chain = params.get('chain') || 'All';
  const hideRisk = params.get('risk') !== 'show';
  const minSources = Math.min(3, Math.max(1, Number.parseInt(params.get('min') ?? '1', 10) || 1));
  const sort: DropsSort = params.get('sort') === 'new' ? 'new' : 'score';
  const query = params.get('q') ?? '';
  return { taskType, chain, hideRisk, minSources, sort, query };
}

function writeDropsHashParams(state: ParsedHashParams): void {
  const currentTab = window.location.hash.replace(/^#/, '').split('?')[0];
  if (currentTab && currentTab !== 'drops' && currentTab !== 'main') return;
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
    safeReplaceHash(nextHash);
  }
}

export function useDropsFilters(items: FeedItem[]) {
  const [filters, setFilters] = useState(readDropsHashParams);
  const { taskType, chain, hideRisk, minSources, sort, query } = filters;
  const [limit, setLimit] = useState(DROPS_PAGE_STEP);
  const syncPendingRef = useRef(false);

  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash;
      if (hash === '') {
        syncPendingRef.current = false;
        setFilters(DEFAULT_FILTERS);
        setLimit(DROPS_PAGE_STEP);
        return;
      }
      if (!isDropsQueryHash(hash)) return;
      syncPendingRef.current = false;
      setFilters(readDropsHashParams());
      setLimit(DROPS_PAGE_STEP);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    if (!syncPendingRef.current) return;
    const id = setTimeout(() => {
      syncPendingRef.current = false;
      writeDropsHashParams(filters);
    }, HASH_SYNC_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [filters]);

  const updateFilters = useCallback((updater: (prev: ParsedHashParams) => ParsedHashParams) => {
    syncPendingRef.current = true;
    setFilters(updater);
    setLimit(DROPS_PAGE_STEP);
  }, []);

  const setTaskType = useCallback(
    (nextTaskType: ParsedHashParams['taskType']) => updateFilters(prev => ({ ...prev, taskType: nextTaskType })),
    [updateFilters],
  );
  const setChain = useCallback(
    (nextChain: string) => updateFilters(prev => ({ ...prev, chain: nextChain })),
    [updateFilters],
  );
  const toggleHideRisk = useCallback(
    () => updateFilters(prev => ({ ...prev, hideRisk: !prev.hideRisk })),
    [updateFilters],
  );
  const setMinSources = useCallback(
    (nextMinSources: number) => updateFilters(prev => ({ ...prev, minSources: nextMinSources })),
    [updateFilters],
  );
  const setSort = useCallback(
    (nextSort: DropsSort) => updateFilters(prev => ({ ...prev, sort: nextSort })),
    [updateFilters],
  );
  const setQuery = useCallback(
    (nextQuery: string) => updateFilters(prev => ({ ...prev, query: nextQuery })),
    [updateFilters],
  );
  const resetFilters = useCallback(() => updateFilters(() => DEFAULT_FILTERS), [updateFilters]);

  const chainOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      for (const c of item.chains) {
        counts.set(c, (counts.get(c) ?? 0) + 1);
      }
    }
    const options = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    if (chain !== 'All' && !options.some(([name]) => name === chain)) options.push([chain, counts.get(chain) ?? 0]);
    return options;
  }, [items, chain]);

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
    taskType !== 'All' || chain !== 'All' || !hideRisk || minSources > 1 || sort !== 'score' || query.trim() !== '';

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
