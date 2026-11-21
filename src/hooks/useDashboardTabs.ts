import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { TABS } from '../../shared/constants';

interface DashboardTabsInput {
  searchRefs: {
    drops: RefObject<HTMLInputElement | null>;
    airdrops: RefObject<HTMLInputElement | null>;
  };
  /** "/" search focus is suppressed while a modal or the details dialog is up. */
  isModalOpen: () => boolean;
}

export interface DashboardTabs {
  tab: string;
  /** Tabs whose panels have been shown at least once (lazy-mount memory). */
  visitedTabs: Set<string>;
  tabRefs: RefObject<Record<string, HTMLButtonElement | null>>;
  tabbarRef: RefObject<HTMLDivElement | null>;
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
  const [tab, setTab] = useState<string>(() => findHashTab());
  const [visitedTabs, setVisitedTabs] = useState<Set<string>>(() => new Set([findHashTab()]));

  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const tabbarRef = useRef<HTMLDivElement | null>(null);

  const markVisited = useCallback((nextId: string) => {
    setVisitedTabs(prev => (prev.has(nextId) ? prev : new Set(prev).add(nextId)));
  }, []);

  const selectTab = useCallback(
    (nextId: string) => {
      if (!TABS.some(t => t.id === nextId)) return;
      setTab(nextId);
      markVisited(nextId);
      history.replaceState(null, '', `#${nextId}`);
      scrollToMainTop();
    },
    [markVisited],
  );

  useEffect(() => {
    const onHash = () => {
      const next = findHashTab();
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
      const targetRef = tab === 'drops' ? searchRefs.drops.current : tab === 'airdrops' ? searchRefs.airdrops.current : null;
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
      const cur = Math.max(0, ids.indexOf(focusedId));
      const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      const nextIdx =
        delta !== 0
          ? (cur + delta + ids.length) % ids.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? ids.length - 1
              : -1;
      if (nextIdx < 0) return;
      e.preventDefault();
      tabRefs.current[ids[nextIdx]]?.focus();
    },
    [tab],
  );

  return { tab, visitedTabs, tabRefs, tabbarRef, selectTab, onTabKey };
}

function findHashTab(): string {
  const raw = window.location.hash.replace(/^#/, '').split('?')[0];
  return TABS.some(t => t.id === raw) ? raw : TABS[0].id;
}

function scrollToMainTop(): void {
  const main = document.getElementById('main');
  const tabbar = document.querySelector('.tabbar');
  if (!main) return;
  const barHeight = tabbar instanceof HTMLElement ? tabbar.offsetHeight : 48;
  const mainTop = main.getBoundingClientRect().top + window.scrollY;
  if (window.scrollY > mainTop - barHeight) {
    window.scrollTo({ top: Math.max(0, mainTop - barHeight - 8), behavior: 'smooth' });
  }
}
