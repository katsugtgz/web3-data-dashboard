import type { Badge, Grade } from '../../shared/types';

export const BADGE_LABEL: Record<Badge, string> = {
  live: 'Live · announced',
  token: 'Token live',
  early: 'Early upside',
  zero: 'Zero-cost path',
  rerun: 'Re-run',
  risk: 'Risk flag',
};

export const GRADE_ORDER: Grade[] = ['S', 'A', 'B', 'C'];

export type TgeStatusKind = 'claimable' | 'verify' | 'other';

export interface TgeStatusInfo {
  label: string;
  kind: TgeStatusKind;
  claimable: boolean;
}

export const TGE_STATUS_MAP: Record<string, TgeStatusInfo> = {
  REWARD_AVAILABLE: { label: 'Claimable', kind: 'claimable', claimable: true },
  VERIFICATION: { label: 'Eligibility check', kind: 'verify', claimable: false },
  'Claimable TGE': { label: 'Claimable TGE', kind: 'claimable', claimable: true },
  Claimable: { label: 'Claimable', kind: 'claimable', claimable: true },
  'Eligibility check': { label: 'Eligibility check', kind: 'verify', claimable: false },
};

const NEGATED_CLAIM_RE =
  /\b(?:unclaimable|non[- ]?claimable|not|never|cannot|closed|ended|unavailable|disabled|pending|upcoming|soon|no\s+(?:longer|claim))\b|\b\w+n't\b/i;
const POSITIVE_CLAIM_RE = /\bclaim(?:able)?\b/i;
const VERIFY_RE = /\b(?:verif(?:y|ication)|eligib(?:le|ility)|check)\b/i;

export function formatTgeStatus(raw: string): TgeStatusInfo {
  const trimmed = raw.trim();
  if (!trimmed) return { label: 'Upcoming', kind: 'other', claimable: false };
  if (Object.hasOwn(TGE_STATUS_MAP, trimmed)) return TGE_STATUS_MAP[trimmed];
  if (!NEGATED_CLAIM_RE.test(trimmed) && POSITIVE_CLAIM_RE.test(trimmed)) {
    return { label: trimmed, kind: 'claimable', claimable: true };
  }
  if (VERIFY_RE.test(trimmed)) {
    return { label: trimmed, kind: 'verify', claimable: false };
  }
  return { label: trimmed, kind: 'other', claimable: false };
}
