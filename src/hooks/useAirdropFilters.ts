import { useCallback, useMemo, useState } from 'react';
import { isCardSaved } from './useWatchlist';
import type { Card, FitKey, Grade } from '../../shared/types';
import { parseCost, parseFunding, parseUpdatedDays } from '../lib/format';

export type StatusFilter = 'all' | 'pre' | 'launched' | 'saved';
export type SortKey = 'rank' | 'funding' | 'heat' | 'updated' | 'cost';

export const PAGE_STEP = 24;

interface FilterCriteria {
  status: StatusFilter;
  saved: Set<string>;
  type: string;
  group: Set<string> | null;
  activeChain: string;
  grade: 'All' | Grade;
  fitFilter: 'All' | FitKey;
  freeOnly: boolean;
  query: string;
}

function getCardChains(c: Card): string[] {
  if (c.chains?.length) return c.chains;
  return c.chain ? [c.chain] : [];
}

function matchesStatus(c: Card, status: StatusFilter, saved: Set<string>): boolean {
  if (status === 'pre') return !c.b.includes('token');
  if (status === 'launched') return c.b.includes('token');
  if (status === 'saved') return isCardSaved(saved, c);
  return true;
}

function matchesType(c: Card, type: string, group: Set<string> | null): boolean {
  if (type === 'All') return true;
  if (type === 'Stock tokens') return Boolean(c.isStockToken);
  if (!group) return true;
  const types = c.taskTypes?.length ? c.taskTypes : [c.best.ty];
  return types.some(t => group.has(t));
}

function matchesQuery(c: Card, q: string): boolean {
  if (!q) return true;
  const chainsText = getCardChains(c).join(' ').toLowerCase();
  return (
    c.n.toLowerCase().includes(q) ||
    (c.t ?? '').toLowerCase().includes(q) ||
    c.best.n.toLowerCase().includes(q) ||
    chainsText.includes(q)
  );
}

function matchesCardFilter(c: Card, f: FilterCriteria): boolean {
  if (!matchesStatus(c, f.status, f.saved)) return false;
  if (!matchesType(c, f.type, f.group)) return false;
  if (f.activeChain !== 'All' && !getCardChains(c).includes(f.activeChain)) return false;
  if (f.grade !== 'All' && c.g !== f.grade) return false;
  if (f.fitFilter !== 'All' && !c.fit.includes(f.fitFilter)) return false;
  if (f.freeOnly && parseCost(c.best.c, c.costNum) > 0 && !c.b.includes('zero')) return false;
  return matchesQuery(c, f.query);
}

function compareCards(a: Card, b: Card, sortBy: SortKey): number {
  if (sortBy === 'funding') return parseFunding(b.f, b.raiseNum) - parseFunding(a.f, a.raiseNum) || a.r - b.r;
  if (sortBy === 'heat') return b.h - a.h || a.r - b.r;
  if (sortBy === 'updated') return parseUpdatedDays(a.u, a.updatedTs) - parseUpdatedDays(b.u, b.updatedTs) || a.r - b.r;
  if (sortBy === 'cost') return parseCost(a.best.c, a.costNum) - parseCost(b.best.c, b.costNum) || a.r - b.r;
  return a.r - b.r;
}

export function useAirdropFilters(cards: Card[], saved: Set<string>, typeMap: Record<string, string[]>) {
  const [status, setStatusState] = useState<StatusFilter>('all');
  const [type, setTypeState] = useState('All');
  const [chain, setChainState] = useState('All');
  const [grade, setGradeState] = useState<'All' | Grade>('All');
  const [fitFilter, setFitFilterState] = useState<'All' | FitKey>('All');
  const [freeOnly, setFreeOnlyState] = useState(false);
  const [sortBy, setSortByState] = useState<SortKey>('rank');
  const [query, setQueryState] = useState('');
  const [limit, setLimit] = useState(PAGE_STEP);

  const setStatus = useCallback((next: StatusFilter | ((prev: StatusFilter) => StatusFilter)) => {
    setStatusState(next);
    setLimit(PAGE_STEP);
  }, []);

  const setType = useCallback((next: string) => {
    setTypeState(next);
    setLimit(PAGE_STEP);
  }, []);

  const setChain = useCallback((next: string) => {
    setChainState(next);
    setLimit(PAGE_STEP);
  }, []);

  const setGrade = useCallback((next: 'All' | Grade | ((prev: 'All' | Grade) => 'All' | Grade)) => {
    setGradeState(next);
    setLimit(PAGE_STEP);
  }, []);

  const setFitFilter = useCallback((next: 'All' | FitKey) => {
    setFitFilterState(next);
    setLimit(PAGE_STEP);
  }, []);

  const toggleFreeOnly = useCallback(() => {
    setFreeOnlyState(v => !v);
    setLimit(PAGE_STEP);
  }, []);

  const setSortBy = useCallback((next: SortKey) => {
    setSortByState(next);
    setLimit(PAGE_STEP);
  }, []);

  const setQuery = useCallback((next: string) => {
    setQueryState(next);
    setLimit(PAGE_STEP);
  }, []);

  const resetFilters = useCallback(() => {
    setStatusState('all');
    setTypeState('All');
    setChainState('All');
    setGradeState('All');
    setFitFilterState('All');
    setFreeOnlyState(false);
    setSortByState('rank');
    setQueryState('');
    setLimit(PAGE_STEP);
  }, []);

  const counts = useMemo(() => {
    let pre = 0;
    let launched = 0;
    let sTier = 0;
    let savedMatch = 0;
    for (const c of cards) {
      if (c.b.includes('token')) launched++;
      else pre++;
      if (c.g === 'S') sTier++;
      if (isCardSaved(saved, c)) savedMatch++;
    }
    return { total: cards.length, pre, launched, sTier, savedMatch };
  }, [cards, saved]);

  const chainCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of cards) {
      for (const ch of getCardChains(c)) {
        map.set(ch, (map.get(ch) ?? 0) + 1);
      }
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [cards]);

  const activeChain = chain !== 'All' && chainCounts.some(([name]) => name === chain) ? chain : 'All';
  const topChains = useMemo(() => chainCounts.slice(0, 6), [chainCounts]);
  const extraChains = useMemo(() => chainCounts.slice(6), [chainCounts]);

  const visible = useMemo(() => {
    const criteria: FilterCriteria = {
      status,
      saved,
      type,
      group: type === 'All' ? null : new Set(typeMap[type] ?? []),
      activeChain,
      grade,
      fitFilter,
      freeOnly,
      query: query.trim().toLowerCase(),
    };
    const filtered = cards.filter(c => matchesCardFilter(c, criteria));
    if (sortBy === 'rank') return filtered;
    return filtered.slice().sort((a, b) => compareCards(a, b, sortBy));
  }, [cards, status, saved, type, activeChain, grade, fitFilter, freeOnly, query, sortBy, typeMap]);

  const renderedCards = visible.slice(0, limit);
  const remaining = visible.length - renderedCards.length;
  const activeAdvancedCount =
    (grade !== 'All' ? 1 : 0) + (activeChain !== 'All' ? 1 : 0) + (fitFilter !== 'All' ? 1 : 0);

  const hasAnyFilter =
    status !== 'all' ||
    type !== 'All' ||
    activeChain !== 'All' ||
    grade !== 'All' ||
    fitFilter !== 'All' ||
    freeOnly ||
    query.trim() !== '' ||
    sortBy !== 'rank';

  const showMore = useCallback(() => setLimit(l => l + PAGE_STEP), []);
  const showAll = useCallback(() => setLimit(visible.length), [visible.length]);

  return {
    status,
    type,
    activeChain,
    grade,
    fitFilter,
    freeOnly,
    sortBy,
    query,
    counts,
    chainCounts,
    topChains,
    extraChains,
    visible,
    renderedCards,
    remaining,
    activeAdvancedCount,
    hasAnyFilter,
    setStatus,
    setType,
    setChain,
    setGrade,
    setFitFilter,
    toggleFreeOnly,
    setSortBy,
    setQuery,
    resetFilters,
    showMore,
    showAll,
  };
}

export type AirdropFiltersState = ReturnType<typeof useAirdropFilters>;
