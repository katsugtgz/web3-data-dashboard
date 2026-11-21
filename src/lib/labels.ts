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
  '可领取 TGE': { label: 'Claimable TGE', kind: 'claimable', claimable: true },
  可领取: { label: 'Claimable', kind: 'claimable', claimable: true },
  资格核验: { label: 'Eligibility check', kind: 'verify', claimable: false },
  Claimable: { label: 'Claimable', kind: 'claimable', claimable: true },
  'Eligibility check': { label: 'Eligibility check', kind: 'verify', claimable: false },
};

const NEGATED_CLAIM_RE =
  /\b(?:unclaimable|non[- ]?claimable|not\s+(?:(?:\w+\s+){0,3})?claim(?:able)?|cannot\s+claim|can't\s+claim|no\s+longer\s+claim(?:able)?|claim\s+(?:closed|ended|unavailable|disabled))\b|不可领取|无法领取|暂不可领取|尚未开放领取/i;
const POSITIVE_CLAIM_RE = /\bclaim(?:able)?\b|可领取/i;
const VERIFY_RE = /\b(?:verif(?:y|ication)|eligib(?:le|ility)|check)\b|核验|资格/i;

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

export const DEMO_COL_LABELS: Record<string, string> = {
  // Stocks table (Chinese headers)
  '代码 / 名称': 'Ticker / Name',
  现价: 'Price',
  市值: 'Market Cap',
  振幅: 'Amplitude',
  '52周区间位置': '52W Range',
  成交量: 'Volume',
  主力净流入: 'Net Inflow',
  'AI 热度': 'AI Heat',
  '日线连阳/连阴': 'Streak',
  '24H 涨跌↓': '24h Change',
  // DOGE monitor table (Chinese headers)
  时间: 'Time',
  '输入 / 输出': 'Inputs / Outputs',
  '金额 (DOGE)': 'Amount (DOGE)',
  手续费: 'Fee',
  // Predictions / sheet schema (snake_case headers)
  section: 'Section',
  name: 'Project',
  raise: 'Raise',
  investors: 'Investors',
  ecosystem: 'Ecosystem',
  potential: 'Potential',
  date: 'Date',
  stars: 'Stars',
  heat_score: 'Heat',
  watch_level: 'Watch',
  description: 'Summary',
  status: 'Status',
  interaction_steps: 'Steps',
  reward_type: 'Reward',
  project_status: 'Stage',
  multi_account: 'Accounts',
  cost: 'Cost',
  link: 'Link',
  invite_code: 'Invite',
  tge_quarter: 'TGE',
};

export function translateColumn(col: string): string {
  return Object.hasOwn(DEMO_COL_LABELS, col) ? DEMO_COL_LABELS[col] : col;
}
