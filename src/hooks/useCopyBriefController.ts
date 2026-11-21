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
  saveProfile: (next: AgentProfile) => AgentProfile;
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
/** How long the profile dialog lingers after the copy banner appears, so users see it. */
const PROFILE_CLOSE_DELAY_MS = 600;

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
  const profileCloseTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      clearTimeout(toastTimerRef.current);
      clearTimeout(copyStatusTimerRef.current);
      clearTimeout(profileCloseTimerRef.current);
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
    (target: FeedItem | Card, activeProfile: AgentProfile, region: CopyRegion): Promise<void> => {
      const md = buildBrief(target, activeProfile);
      if (!md) {
        reportOutcome(region, 'Brief unavailable for RISK items.', 'warn');
        return Promise.resolve();
      }
      return copyText(md).then(ok => {
        const isWarn = isFeedItem(target) ? target.risk.level === 'warn' : target.b.includes('risk');
        const label = nameOf(target);
        if (ok) {
          reportOutcome(
            region,
            isWarn
              ? `Copied ${label} brief (WARN item — verify links before running).`
              : `Copied ${label} agent brief to clipboard.`,
            isWarn ? 'warn' : 'ok',
          );
        } else {
          reportOutcome(region, 'Clipboard blocked — open Preview in details to copy.', 'warn');
        }
      });
    },
    [reportOutcome],
  );

  /** Risk may have changed since the first-copy request: always re-look-up by id. */
  const freshenTarget = useCallback(
    (target: FeedItem | Card): FeedItem | Card => {
      if (!isFeedItem(target)) return target;
      const current = getVisibleItems().find(it => it.id === target.id);
      return current ?? target;
    },
    [getVisibleItems],
  );

  const handleCopyBrief = useCallback(
    (target: FeedItem | Card, region: CopyRegion = 'page') => {
      if (!hasConfigured) {
        pendingCopyTargetRef.current = { target, region };
        setPendingCopyName(target);
        setProfileOpen(true);
        return;
      }
      void executeCopyBrief(target, profile, region);
    },
    [hasConfigured, profile, executeCopyBrief],
  );

  const copyPendingNow = useCallback(() => {
    const pending = pendingCopyTargetRef.current;
    if (!pending || !hasConfigured) return;
    void executeCopyBrief(freshenTarget(pending.target), profile, 'profile');
  }, [hasConfigured, profile, executeCopyBrief, freshenTarget]);

  const handleSaveProfile = useCallback(
    (next: AgentProfile) => {
      const savedProfile = saveProfile(next);
      const pending = pendingCopyTargetRef.current;
      pendingCopyTargetRef.current = null;
      setPendingCopyName(null);
      if (pending) {
        // Keep the dialog open until the outcome banner is up; the page is
        // inert behind showModal(), so the banner inside the dialog is the
        // only channel the user (and screen readers) can perceive.
        executeCopyBrief(freshenTarget(pending.target), savedProfile, 'profile').finally(() => {
          clearTimeout(profileCloseTimerRef.current);
          profileCloseTimerRef.current = Number(setTimeout(() => setProfileOpen(false), PROFILE_CLOSE_DELAY_MS));
        });
        return;
      }
      showToast('Agent environment profile saved locally.');
      setProfileOpen(false);
    },
    [saveProfile, executeCopyBrief, showToast, freshenTarget],
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
