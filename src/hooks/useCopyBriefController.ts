import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentProfile, Card, FeedItem } from '../../shared/types';
import { buildBrief, isFeedItem } from '../lib/agentBrief';
import { copyText } from '../lib/clipboard';

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
}

export interface CopyController {
  /** Page-level toast state (only used for region 'page' outcomes). */
  toast: ToastState | null;
  dismissToast: () => void;
  /** Region-scoped copy outcome; null when nothing is showing. */
  copyStatus: CopyStatus | null;
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

const nameOf = (target: FeedItem | Card): string => (isFeedItem(target) ? target.project : target.n);

/**
 * Owns the entire copy-agent-brief flow: clipboard execution, region-scoped
 * outcome reporting (page toast vs. visible banner inside the active modal),
 * the first-copy profile gate, and risk revalidation against the live feed at
 * save time. App renders; this decides where messages land.
 */
export function useCopyBriefController(input: CopyControllerInput): CopyController {
  const { hasConfigured, profile, saveProfile, getVisibleItems } = input;

  const [toast, setToast] = useState<ToastState | null>(null);
  const [copyStatus, setCopyStatus] = useState<CopyStatus | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [pendingCopyName, setPendingCopyName] = useState<FeedItem | Card | null>(null);

  const pendingCopyTargetRef = useRef<{ target: FeedItem | Card; region: CopyRegion } | null>(null);
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

  const reportOutcome = useCallback(
    (region: CopyRegion, message: string, tone: ToastState['tone']) => {
      if (region === 'page') showToast(message, tone);
      else showCopyStatus(region, message, tone);
    },
    [showCopyStatus, showToast],
  );

  const executeCopyBrief = useCallback(
    (target: FeedItem | Card, activeProfile: AgentProfile, region: CopyRegion, notice = '') => {
      const md = buildBrief(target, activeProfile);
      if (!md) {
        reportOutcome(region, `Brief unavailable for RISK items.${notice}`, 'warn');
        return;
      }
      void copyText(md).then(ok => {
        const isWarn = isFeedItem(target) && target.risk.level === 'warn';
        const label = nameOf(target);
        const message = !ok
          ? 'Clipboard blocked — open Preview in details to copy.'
          : isWarn
            ? `Copied ${label} brief (WARN item: verify links before running).`
            : `Copied ${label} agent brief to clipboard.`;
        reportOutcome(region, `${message}${notice}`, !ok || isWarn || notice ? 'warn' : 'ok');
      });
    },
    [reportOutcome],
  );

  const copyCurrent = useCallback((target: FeedItem | Card, activeProfile: AgentProfile, region: CopyRegion, notice = '') => {
    const current = isFeedItem(target) ? getVisibleItems().find(it => it.id === target.id) : target;
    if (!current) {
      reportOutcome(region, `Brief unavailable. This drop is no longer in the feed.${notice}`, 'warn');
      return;
    }
    executeCopyBrief(current, activeProfile, region, notice);
  }, [executeCopyBrief, getVisibleItems, reportOutcome]);

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
    copyCurrent(pending.target, profile, 'profile');
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
    pendingCopyTargetRef.current = null;
    setPendingCopyName(null);
    setProfileOpen(true);
  }, []);

  const closeProfile = useCallback(() => {
    pendingCopyTargetRef.current = null;
    setPendingCopyName(null);
    setProfileOpen(false);
  }, []);

  const dismissToast = useCallback(() => setToast(null), []);

  return {
    toast,
    dismissToast,
    copyStatus,
    handleCopyBrief,
    profileOpen,
    pendingCopyName: pendingCopyName ? nameOf(pendingCopyName) : null,
    openProfile,
    closeProfile,
    handleSaveProfile,
    copyPendingNow,
  };
}
