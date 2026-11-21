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

export const TGE_STATUS_MAP: Record<string, { label: string; claimable: boolean }> = {
  REWARD_AVAILABLE: { label: 'Claimable', claimable: true },
  VERIFICATION: { label: 'Eligibility check', claimable: false },
  '可领取 TGE': { label: 'Claimable TGE', claimable: true },
  可领取: { label: 'Claimable', claimable: true },
  资格核验: { label: 'Eligibility check', claimable: false },
  Claimable: { label: 'Claimable', claimable: true },
};

export function formatTgeStatus(raw: string): { label: string; claimable: boolean } {
  const mapped = TGE_STATUS_MAP[raw.trim()];
  if (mapped) return mapped;
  return { label: raw || 'Upcoming', claimable: /claim|可领取/i.test(raw) };
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
  return DEMO_COL_LABELS[col] ?? col;
}
