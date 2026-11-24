import type { FitKey } from '../../../shared/types';

export const HAN_RE = /\p{Script=Han}/u;

// Exact CI gate (scripts/check-no-cjk.sh): every script and range that is
// forbidden in output. Exported so rule-summary builders enforce the exact
// same contract as CI.
export const FORBIDDEN_CJK_RE =
  /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|\p{Script=Bopomofo}|[\u3000-\u303F\uFF01-\uFF9F]/u;

// CJK airdrop/drop action keywords live strictly here (the sole file exempted
// from scripts/check-no-cjk.sh) so the drop relevance gate can accept genuine
// Chinese airdrop channels (CG_yangmaoqianxian, pk_oa) without leaking CJK
// literals into other worker/src modules.
const CJK_DROP_SIGNAL_RE =
  /空投|测试网|领水|交互|白名单|积分|签到|质押|铸造|节点|申领|盲盒|任务|资格查询|奖励池/;

export function hasCjkDropSignal(value: string): boolean {
  return CJK_DROP_SIGNAL_RE.test(value);
}

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
  // Unknown statuses must stay neutral: labelling e.g. 已结束 (ended) as
  // 'Upcoming' would misinform. Empty input is the only 'Upcoming'.
  return stripOrTranslateCjk(trimmed) || 'Unknown';
}

export function stripOrTranslateCjk(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (Object.hasOwn(TGE_STATUS_MAP, trimmed)) return TGE_STATUS_MAP[trimmed];
  if (Object.hasOwn(TAG_LABEL_MAP, trimmed)) return TAG_LABEL_MAP[trimmed];
  if (Object.hasOwn(RISK_ITEM_MAP, trimmed)) return RISK_ITEM_MAP[trimmed];
  if (FORBIDDEN_CJK_RE.test(trimmed)) {
    console.warn('i18n-miss', trimmed);
    // Keep the Latin remainder of mixed labels instead of dropping the whole
    // value: callers fall back to the raw CJK string when this returns '',
    // which defeats the zero-CJK contract. The gate mirrors check-no-cjk.sh
    // exactly (Han/Kana/Hangul/Bopomofo + U+3000-303F + U+FF01-FF9F), so
    // anything CI would reject enters this strip; if nothing ASCII-safe
    // remains, return '' so CALLERS apply their own fallbacks
    // ('Unknown project', '—') instead of a hardcoded global placeholder.
    const stripped = trimmed
      // Fullwidth digits are content, not decoration: fold to ASCII first —
      // U+FF10-FF19 sit inside the U+FF01-FF9F range below — so edge digits
      // survive. Fullwidth Latin (ABC) is decoration and collapses away.
      .replace(/[\uFF10-\uFF19]/gu, d => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
      .replace(/\p{Script=Han}+/gu, ' ')
      .replace(/\p{Script=Hiragana}+/gu, ' ')
      .replace(/\p{Script=Katakana}+/gu, ' ')
      .replace(/\p{Script=Hangul}+/gu, ' ')
      .replace(/\p{Script=Bopomofo}+/gu, ' ')
      // Each CJK run swaps to a space, not '': deleting would fuse adjacent
      // Latin tokens (Galxe任务Zealy -> 'GalxeZealy'). Punctuation/fullwidth
      // forms swap to spaces globally — single pass, no edge-only regexes —
      // so mixed labels keep token boundaries; trailing trim cleans the edges.
      .replace(/[\u3000-\u303F\uFF01-\uFF9F]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (stripped) return stripped;
    return '';
  }
  return trimmed;
}
