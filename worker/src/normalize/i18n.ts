import type { FitKey } from '../../../shared/types';

export const HAN_RE = /\p{Script=Han}/u;

export const FIT_MAP: Record<string, FitKey> = {
  冲榜党: 'climber',
  多号党: 'multi',
  小资金党: 'small',
  技术党: 'technical',
  社区贡献党: 'community',
  零成本党: 'zero',
};

export const TGE_STATUS_MAP: Record<string, string> = {
  '可领取 TGE': 'Claimable TGE',
  可领取: 'Claimable',
  资格核验: 'Eligibility check',
  REWARD_AVAILABLE: 'Claimable',
  VERIFICATION: 'Eligibility check',
  CONFIRMED: 'Confirmed',
  POTENTIAL: 'Potential',
};

export const TAG_LABEL_MAP: Record<string, string> = {
  官宣进行中: 'Live · announced',
  重撸: 'Re-run',
  零成本路径: 'Zero-cost path',
  早期红利: 'Early upside',
  快照阶段: 'Snapshot phase',
  可领取: 'Claimable',
};

export const RISK_ITEM_MAP: Record<string, string> = {
  非币奖励: 'Non-token reward',
  融资偏低: 'Low funding',
};

export const CJK_UNITS: Record<string, number> = {
  万: 1e4,
  亿: 1e8,
};

export function hasCjk(value: string): boolean {
  return HAN_RE.test(value);
}

export function mapFitKey(raw: string): FitKey | null {
  if (Object.hasOwn(FIT_MAP, raw)) return FIT_MAP[raw];
  if (raw === 'zero' || raw === 'multi' || raw === 'small' || raw === 'climber' || raw === 'community' || raw === 'technical') {
    return raw;
  }
  if (hasCjk(raw)) console.warn('i18n-miss', raw);
  return null;
}

export function translateTagLabel(raw?: string): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (Object.hasOwn(TAG_LABEL_MAP, trimmed)) return TAG_LABEL_MAP[trimmed];
  const riskCount = trimmed.match(/^(\d+)\s*风险$/);
  if (riskCount) {
    const n = Number(riskCount[1]);
    return n === 1 ? '1 risk flag' : `${n} risk flags`;
  }
  return stripOrTranslateCjk(trimmed);
}

export function translateRiskItem(raw?: string): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (Object.hasOwn(RISK_ITEM_MAP, trimmed)) return RISK_ITEM_MAP[trimmed];
  const highCost = trimmed.match(/^(\d+)\s*项高成本任务$/);
  if (highCost) {
    const n = Number(highCost[1]);
    return n === 1 ? '1 high-cost task' : `${n} high-cost tasks`;
  }
  return stripOrTranslateCjk(trimmed);
}

export function translateTgeStatus(raw?: string): string {
  if (!raw) return 'Upcoming';
  const trimmed = raw.trim();
  if (!trimmed) return 'Upcoming';
  if (Object.hasOwn(TGE_STATUS_MAP, trimmed)) return TGE_STATUS_MAP[trimmed];
  const translated = stripOrTranslateCjk(trimmed);
  return translated || 'Upcoming';
}

export function stripOrTranslateCjk(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (Object.hasOwn(TGE_STATUS_MAP, trimmed)) return TGE_STATUS_MAP[trimmed];
  if (Object.hasOwn(TAG_LABEL_MAP, trimmed)) return TAG_LABEL_MAP[trimmed];
  if (Object.hasOwn(RISK_ITEM_MAP, trimmed)) return RISK_ITEM_MAP[trimmed];
  if (hasCjk(trimmed)) {
    console.warn('i18n-miss', trimmed);
    return '';
  }
  return trimmed;
}
