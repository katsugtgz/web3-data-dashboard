import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentProfile, Card, FeedItem } from '../../shared/types';
import { buildBrief, describeBrief, isFeedItem } from '../lib/agentBrief';
import { copyText } from '../lib/clipboard';
import { formatProjectTitle } from '../lib/feedDisplay';
import type { TaskRegistry } from '../lib/taskRegistry';

export type CopyRegion = 'page' | 'detail' | 'profile';

export interface CopyStatus {
  target: CopyRegion;
  message: string;
  tone: 'ok' | 'warn';
}

export type ToastState = { message: string; tone: 'ok' | 'warn' };

interface CopyControllerInput {
  hasConfigured: boolean;
  profile: AgentProfile;
  saveProfile: (next: AgentProfile) => { profile: AgentProfile; persisted: boolean };
  /** Freshness source for first-copy: validate risk against the CURRENT feed. */
  getVisibleItems: () => FeedItem[];
  /** Freshness source for curated Cards: validate live RISK state and presence. */
  getVisibleCards: () => Card[];
}

export interface CopyController {
  /** Page-level toast state (only used for region 'page' outcomes). */
  toast: ToastState | null;
  dismissToast: () => void;
  /** Region-scoped copy outcome; null when nothing is showing. */
  copyStatus: CopyStatus | null;
  /** Clears dialog-scoped copy status and invalidates in-flight copy callbacks. */
  clearCopyStatus: () => void;
  /** Entry point for every "Copy agent brief" button. */
  handleCopyBrief: (target: FeedItem | Card, region?: CopyRegion) => void;
  /** Profile dialog props. */
  profileOpen: boolean;
  pendingCopyName: string | null;
  openProfile: () => void;
  closeProfile: () => void;
  handleSaveProfile: (next: AgentProfile) => void;
  copyPendingNow: () => void;
}

const COPY_STATUS_MS = 4500;
const SESSION_PROFILE_MESSAGE = 'Profile saved for this session only. Browser storage is unavailable.';

const nameOf = (target: FeedItem | Card): string =>
  isFeedItem(target) ? formatProjectTitle(target.project) : target.n;

/**
 * Resolves a copy target against the latest live FeedItems or Cards so
 * background polls (e.g. a newly applied RISK flag or removal) take effect
 * before a brief is generated.
 */
export function resolveLiveBriefTarget(
  target: FeedItem | Card,
  visibleItems: readonly FeedItem[],
  visibleCards: readonly Card[],
): FeedItem | Card | null {
  if (isFeedItem(target)) {
    return visibleItems.find(it => it.id === target.id) ?? null;
  }
  if (target.id) {
    return visibleCards.find(c => c.id === target.id) ?? null;
  }
  return visibleCards.find(c => c.n === target.n) ?? null;
}

export function formatCopyBlockedMessage(target: FeedItem | Card, region: CopyRegion): string {
  if (region === 'page' || isFeedItem(target)) {
    return 'Clipboard blocked — use your browser clipboard permissions and retry.';
  }
  return 'Clipboard blocked — open Preview in details to copy.';
}

/** Base URL the bundled reference files are served from, or undefined where there is no page. */
export function getRefBaseUrl(): string | undefined {
  if (typeof window === 'undefined' || !window.location?.href) return undefined;
  try {
    // Vite replaces BASE_URL at build time; outside a Vite build it is undefined.
    return new URL(`${import.meta.env.BASE_URL ?? '/'}data/tasks/`, window.location.href).href;
  } catch {
    return undefined;
  }
}

/** What to tell the user after a brief reaches the clipboard: the reviewed playbook, or a brief built from item data. */
export function briefCopiedMessage(target: FeedItem | Card, label: string, isWarn: boolean, registry?: TaskRegistry): string {
  const { verified, revision } = describeBrief(target, registry);
  if (!verified) {
    return isWarn ? `Copied ${label} brief (WARN item: verify links before running).` : `Copied ${label} agent brief to clipboard.`;
  }
  return isWarn
    ? `Copied ${label} verified playbook v${revision} (WARN item: brief holds the reviewed playbook only).`
    : `Copied ${label} verified playbook v${revision} to clipboard.`;
}

/**
 * Owns the entire copy-agent-brief flow: clipboard execution, region-scoped
 * outcome reporting (page toast vs. visible banner inside the active modal),
 * the first-copy profile gate, and risk revalidation against the live feed at
 * save time. App renders; this decides where messages land.
 */
export function useCopyBriefController(input: CopyControllerInput): CopyController {
  const { hasConfigured, profile, saveProfile, getVisibleItems, getVisibleCards } = input;

  const [toast, setToast] = useState<ToastState | null>(null);
  const [copyStatus, setCopyStatus] = useState<CopyStatus | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [pendingCopyName, setPendingCopyName] = useState<FeedItem | Card | null>(null);

  const pendingCopyTargetRef = useRef<{ target: FeedItem | Card; region: CopyRegion } | null>(null);
  const copySeqRef = useRef(0);
  const toastTimerRef = useRef<number | undefined>(undefined);
  const copyStatusTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      clearTimeout(toastTimerRef.current);
      clearTimeout(copyStatusTimerRef.current);
    };
  }, []);

  const showToast = useCallback((message: string, tone: ToastState['tone'] = 'ok') => {
    clearTimeout(toastTimerRef.current);
    setToast({ message, tone });
    toastTimerRef.current = Number(setTimeout(() => setToast(null), COPY_STATUS_MS));
  }, []);

  const showCopyStatus = useCallback((target: CopyRegion, message: string, tone: ToastState['tone']) => {
    clearTimeout(copyStatusTimerRef.current);
    setCopyStatus({ target, message, tone });
    copyStatusTimerRef.current = Number(setTimeout(() => setCopyStatus(null), COPY_STATUS_MS));
  }, []);

  const clearCopyStatus = useCallback(() => {
    copySeqRef.current += 1;
    clearTimeout(copyStatusTimerRef.current);
    setCopyStatus(null);
  }, []);

  const reportOutcome = useCallback(
    (region: CopyRegion, message: string, tone: ToastState['tone']) => {
      if (region === 'page') showToast(message, tone);
      else showCopyStatus(region, message, tone);
    },
    [showCopyStatus, showToast],
  );

  const executeCopyBrief = useCallback(
    (target: FeedItem | Card, activeProfile: AgentProfile, region: CopyRegion, notice = '') => {
      const seq = ++copySeqRef.current;
      const md = buildBrief(target, activeProfile, { refBaseUrl: getRefBaseUrl() });
      if (!md) {
        reportOutcome(region, `Brief unavailable for RISK items.${notice}`, 'warn');
        return;
      }
      void copyText(md).then(ok => {
        if (copySeqRef.current !== seq) return;
        const isWarn = isFeedItem(target) && target.risk.level === 'warn';
        const message = !ok ? formatCopyBlockedMessage(target, region) : briefCopiedMessage(target, nameOf(target), isWarn);
        reportOutcome(region, `${message}${notice}`, !ok || isWarn || notice ? 'warn' : 'ok');
      });
    },
    [reportOutcome],
  );

  const copyCurrent = useCallback(
    (target: FeedItem | Card, activeProfile: AgentProfile, region: CopyRegion, notice = '') => {
      const current = resolveLiveBriefTarget(target, getVisibleItems(), getVisibleCards());
      if (!current) {
        copySeqRef.current += 1;
        reportOutcome(
          region,
          `Brief unavailable. This ${isFeedItem(target) ? 'drop' : 'project'} is no longer in the feed.${notice}`,
          'warn',
        );
        return;
      }
      executeCopyBrief(current, activeProfile, region, notice);
    },
    [executeCopyBrief, getVisibleCards, getVisibleItems, reportOutcome],
  );

  const handleCopyBrief = useCallback(
    (target: FeedItem | Card, region: CopyRegion = 'page') => {
      if (!hasConfigured) {
        pendingCopyTargetRef.current = { target, region };
        setPendingCopyName(target);
        setProfileOpen(true);
        return;
      }
      copyCurrent(target, profile, region);
    },
    [hasConfigured, profile, copyCurrent],
  );

  const copyPendingNow = useCallback(() => {
    const pending = pendingCopyTargetRef.current;
    if (!pending) return;
    // Copying without saving: clear the first-copy gate so the "Will copy
    // after you save" prompt never resurfaces and a later save cannot double-copy.
    pendingCopyTargetRef.current = null;
    setPendingCopyName(null);
    copyCurrent(pending.target, profile, 'profile', ' Brief used placeholder environment values.');
  }, [profile, copyCurrent]);

  const handleSaveProfile = useCallback(
    (next: AgentProfile) => {
      const { profile: savedProfile, persisted } = saveProfile(next);
      const pending = pendingCopyTargetRef.current;
      pendingCopyTargetRef.current = null;
      setPendingCopyName(null);
      if (pending) {
        setProfileOpen(false);
        copyCurrent(pending.target, savedProfile, pending.region, persisted ? '' : ` ${SESSION_PROFILE_MESSAGE}`);
        return;
      }
      showToast(persisted ? 'Agent environment profile saved locally.' : SESSION_PROFILE_MESSAGE, persisted ? 'ok' : 'warn');
      setProfileOpen(false);
    },
    [saveProfile, copyCurrent, showToast],
  );

  const openProfile = useCallback(() => {
    clearCopyStatus();
    pendingCopyTargetRef.current = null;
    setPendingCopyName(null);
    setProfileOpen(true);
  }, [clearCopyStatus]);

  const closeProfile = useCallback(() => {
    clearCopyStatus();
    pendingCopyTargetRef.current = null;
    setPendingCopyName(null);
    setProfileOpen(false);
  }, [clearCopyStatus]);

  const dismissToast = useCallback(() => setToast(null), []);

  return {
    toast,
    dismissToast,
    copyStatus,
    clearCopyStatus,
    handleCopyBrief,
    profileOpen,
    pendingCopyName: pendingCopyName ? nameOf(pendingCopyName) : null,
    openProfile,
    closeProfile,
    handleSaveProfile,
    copyPendingNow,
  };
}
