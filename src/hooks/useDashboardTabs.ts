import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { TABS } from '../../shared/constants';

export type NavGroup = 'RADAR' | 'MARKETS';

export interface TabGroupMeta {
  id: string;
  label: string;
  group: NavGroup;
}

const RADAR_TAB_IDS = new Set(['drops', 'airdrops']);

/** Maps a tab id to its display label and sidebar section group. */
export function getTabGroupMeta(tabId: string): TabGroupMeta {
  const found = TABS.find(t => t.id === tabId) ?? TABS[0];
  return {
    id: found.id,
    label: found.label,
    group: RADAR_TAB_IDS.has(found.id) ? 'RADAR' : 'MARKETS',
  };
}

/**
 * Computes the next tab index for roving-tabindex navigation across both
 * vertical sidebar and horizontal tabstrip layouts.
 */
export function computeNextTabIndex(ids: readonly string[], currentId: string, key: string): number {
  if (ids.length === 0) return -1;
  const cur = Math.max(0, ids.indexOf(currentId));
  if (key === 'ArrowRight' || key === 'ArrowDown') {
    return (cur + 1) % ids.length;
  }
  if (key === 'ArrowLeft' || key === 'ArrowUp') {
    return (cur - 1 + ids.length) % ids.length;
  }
  if (key === 'Home') return 0;
  if (key === 'End') return ids.length - 1;
  return -1;
}

interface DashboardTabsInput {
  searchRefs: {
    drops: RefObject<HTMLInputElement | null>;
    airdrops: RefObject<HTMLInputElement | null>;
    markets?: RefObject<HTMLInputElement | null>;
  };
  /** "/" search focus is suppressed while a modal or the details dialog is up. */
  isModalOpen: () => boolean;
}

export interface DashboardTabs {
  tab: string;
  /** Tabs whose panels have been shown at least once (lazy-mount memory). */
  visitedTabs: Set<string>;
  tabRefs: RefObject<Record<string, HTMLButtonElement | null>>;
  tabbarRef: RefObject<HTMLElement | null>;
  selectTab: (id: string) => void;
  onTabKey: (e: KeyboardEvent) => void;
}

/**
 * Dashboard tab state and keyboard model: roving-tabindex tablist with manual
 * activation. Arrow/Home/End only MOVE focus (no hash/render/scroll change);
 * Enter/Space activate natively via the button click. Arrows key off the
 * FOCUSED tab, so after focus re-enters on the selected tab it behaves
 * correctly from there.
 */
export function useDashboardTabs({ searchRefs, isModalOpen }: DashboardTabsInput): DashboardTabs {
  const [tab, setTab] = useState(() => findHashTab() ?? TABS[0].id);
  const [visitedTabs, setVisitedTabs] = useState(() => new Set([tab]));
  const dropsHash = useRef('#drops');

  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const tabbarRef = useRef<HTMLElement | null>(null);

  const markVisited = useCallback((nextId: string) => {
    setVisitedTabs(prev => (prev.has(nextId) ? prev : new Set(prev).add(nextId)));
  }, []);

  const selectTab = useCallback(
    (nextId: string) => {
      if (!TABS.some(t => t.id === nextId)) return;
      setTab(nextId);
      markVisited(nextId);
      const nextHash = nextId === 'drops' ? dropsHash.current : `#${nextId}`;
      if (findHashTab() !== nextId) {
        if (findHashTab() === 'drops') dropsHash.current = window.location.hash;
        history.replaceState(history.state, '', nextHash);
      }
      scrollToMainTop();
    },
    [markVisited],
  );

  useEffect(() => {
    const onHash = (event: HashChangeEvent) => {
      const oldHash = new URL(event.oldURL).hash;
      if (findHashTab(oldHash) === 'drops') dropsHash.current = oldHash;
      const hash = window.location.hash;
      if (!hash) dropsHash.current = '#drops';
      const next = hash ? findHashTab(hash) : TABS[0].id;
      if (!next) return;
      setTab(next);
      markVisited(next);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [markVisited]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || isModalOpen()) return;
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
      const targetRef =
        tab === 'drops'
          ? searchRefs.drops.current
          : tab === 'airdrops'
            ? searchRefs.airdrops.current
            : (searchRefs.markets?.current ?? null);
      if (targetRef) {
        e.preventDefault();
        targetRef.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab, searchRefs, isModalOpen]);

  const onTabKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.altKey || e.metaKey || e.ctrlKey) return;
      const ids = TABS.map(t => t.id);
      const focusTarget = document.activeElement as HTMLElement | null;
      const focusedId =
        focusTarget?.getAttribute('role') === 'tab' ? focusTarget.id.replace(/^tab-/, '') : tab;
      const nextIdx = computeNextTabIndex(ids, focusedId, e.key);
      if (nextIdx < 0) return;
      e.preventDefault();
      tabRefs.current[ids[nextIdx]]?.focus();
    },
    [tab],
  );

  return { tab, visitedTabs, tabRefs, tabbarRef, selectTab, onTabKey };
}

function findHashTab(hash = window.location.hash): string | undefined {
  const raw = hash.slice(1).split('?')[0];
  if (raw === '' && hash.includes('?')) return 'drops';
  return TABS.some(t => t.id === raw) ? raw : undefined;
}

/** True when this hash targets the Drops tab: `#drops`, `#drops?…`, or an empty segment with query (`#?type=…`). */
export function isDropsQueryHash(hash: string): boolean {
  return findHashTab(hash) === 'drops';
}

function scrollToMainTop(): void {
  const main = document.getElementById('main');
  if (!main) return;
  const topBar = document.querySelector('.top');
  const tabBar = document.querySelector('.tabbar');
  const topHeight = topBar instanceof HTMLElement ? topBar.offsetHeight : 52;
  const barHeight =
    window.innerWidth >= 1024
      ? topHeight
      : topHeight + (tabBar instanceof HTMLElement ? tabBar.offsetHeight : 44);
  const mainTop = main.getBoundingClientRect().top + window.scrollY;
  if (window.scrollY > mainTop - barHeight) {
    window.scrollTo({ top: Math.max(0, mainTop - barHeight - 8), behavior: 'smooth' });
  }
}
