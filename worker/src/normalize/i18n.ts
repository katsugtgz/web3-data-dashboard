import type { Badge, FitKey } from '../../../shared/types';

export const HAN_RE = /\p{Script=Han}/u;

// Exact CI gate (scripts/check-no-cjk.sh): every script and range that is
// forbidden in output. Exported so rule-summary builders enforce the exact
// same contract as CI.
export const FORBIDDEN_CJK_RE =
  /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|\p{Script=Bopomofo}|[\u3000-\u303F\u3200-\u32FF\uFE30-\uFE4F\uFF01-\uFFEF]/u;

const CYRILLIC_RE = /\p{Script=Cyrillic}/u;

// CJK airdrop/drop action keywords live strictly here (the sole file exempted
// from scripts/check-no-cjk.sh) so the drop relevance gate can accept genuine
// Chinese airdrop channels (CG_yangmaoqianxian, pk_oa) without leaking CJK
// literals into other worker/src modules.
const CJK_DROP_SIGNAL_RE =
  /空投|测试网|測試網|领水|領水|交互|白名单|白名單|积分|積分|签到|簽到|质押|質押|铸造|鑄造|节点|節點|申领|申領|盲盒|任务|任務|资格查询|資格查詢|奖励池|獎勵池/;

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

const NON_ASCII_RE = /[^\u0000-\u007f]/;
const FORBIDDEN_CJK_STRIP_RE =
  /(?:\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|\p{Script=Bopomofo}|\p{Script=Cyrillic}|[\u3000-\u303F\u3200-\u32FF\uFE30-\uFE4F\uFF01-\uFFEF])+/gu;

export function stripOrTranslateCjk(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (Object.hasOwn(TGE_STATUS_MAP, trimmed)) return TGE_STATUS_MAP[trimmed];
  // ASCII fast path: skips Unicode script regexes on pure-ASCII labels.
  if (!NON_ASCII_RE.test(trimmed)) return trimmed;
  if (Object.hasOwn(TAG_LABEL_MAP, trimmed)) return TAG_LABEL_MAP[trimmed];
  if (Object.hasOwn(RISK_ITEM_MAP, trimmed)) return RISK_ITEM_MAP[trimmed];
  const hasForbidden = FORBIDDEN_CJK_RE.test(trimmed);
  if (hasForbidden || CYRILLIC_RE.test(trimmed)) {
    if (hasForbidden) console.warn('i18n-miss', trimmed);
    // Keep the Latin remainder of mixed labels instead of dropping the whole
    // value: callers fall back to the raw CJK string when this returns '',
    // which defeats the zero-CJK contract. The gate mirrors check-no-cjk.sh
    // exactly (Han/Kana/Hangul/Bopomofo + CJK symbols/enclosed/compat/fullwidth),
    // plus Cyrillic so non-English scripts never leak into English UI fields;
    // if nothing ASCII-safe remains, return '' so CALLERS apply their own
    // fallbacks ('Unknown project', '—') instead of a hardcoded placeholder.
    const stripped = trimmed
      // Fullwidth digits are content, not decoration: fold to ASCII first —
      // U+FF10-FF19 sit inside the U+FF01-FFEF range below — so edge digits
      // survive. Fullwidth Latin (ABC) is decoration and collapses away.
      .replace(/[\uFF10-\uFF19]/gu, d => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
      // Single compiled pass across all forbidden scripts + Cyrillic + CJK/fullwidth
      // ranges: swapping each run to a space keeps adjacent Latin token boundaries
      // intact (Galxe任务Zealy -> 'Galxe Zealy') while staying within the Worker CPU budget.
      .replace(FORBIDDEN_CJK_STRIP_RE, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (stripped) return stripped;
    return '';
  }
  return trimmed;
}

// ============================================================================
// ASSO7878 Google Sheet CJK taxonomy, layout detection & value translators.
// All CJK literals for sheet parsing stay strictly inside this module so
// scripts/check-no-cjk.sh enforces zero CJK across every other source file.
// ============================================================================

export type AssoBannerKind = 'tge' | 'skip_bankrupt' | 'skip_abandoned';

export function classifyAssoBanner(rowText: string): AssoBannerKind | null {
  if (!rowText) return null;
  if (rowText.includes('已经发币')) return 'tge';
  if (rowText.includes('跑路的')) return 'skip_bankrupt';
  if (rowText.includes('已经放弃')) return 'skip_abandoned';
  return null;
}

export function isAssoHeaderRow(cols: readonly string[]): boolean {
  const c0 = (cols[0] ?? '').trim();
  const c2 = (cols[2] ?? '').trim();
  const c3 = (cols[3] ?? '').trim();
  return c0 === '分类' || (c2 === '项目名称' && c3.includes('融资'));
}

export function isAssoMetaBannerRow(cols: readonly string[]): boolean {
  const c2 = (cols[2] ?? '').trim();
  const c6 = (cols[6] ?? '').trim();
  return c2.startsWith('X：') || c2.startsWith('X:') || c6.includes('历史更新');
}

export function parseAssoUpdatedTimestamp(cols: readonly string[]): number | null {
  for (const cell of cols) {
    const m = (cell ?? '').match(/(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
    if (!m) continue;
    const year = Number(m[1]);
    const month = Number(m[2]) - 1;
    const day = Number(m[3]);
    const hour = m[4] ? Number(m[4]) : 0;
    const min = m[5] ? Number(m[5]) : 0;
    const sec = m[6] ? Number(m[6]) : 0;
    const ts = Date.UTC(year, month, day, hour, min, sec);
    if (Number.isFinite(ts)) return ts;
  }
  return null;
}

export interface AssoCategoryInfo {
  label: string;
  layout: 'standard' | 'ecosystem' | 'waitlist';
  skip?: 'cex' | 'abandoned';
}

const ASSO_CATEGORY_MAP: Record<string, AssoCategoryInfo> = {
  交易所: { label: 'Exchange', layout: 'standard', skip: 'cex' },
  放弃项目: { label: 'Abandoned', layout: 'standard', skip: 'abandoned' },
  主网生态: { label: 'Mainnet Ecosystem', layout: 'ecosystem' },
  测试网生态: { label: 'Testnet Ecosystem', layout: 'ecosystem' },
  候补: { label: 'Waitlist', layout: 'waitlist' },
  钱包: { label: 'Wallet', layout: 'standard' },
  交易类: { label: 'Trading', layout: 'standard' },
  预测市场: { label: 'Prediction Market', layout: 'standard' },
  'AI 机器人': { label: 'AI & Robotics', layout: 'standard' },
  AI机器人: { label: 'AI & Robotics', layout: 'standard' },
  挂机: { label: 'DePIN / Idle', layout: 'standard' },
  另类测试网: { label: 'Alt Testnet', layout: 'standard' },
  跨链桥: { label: 'Bridge', layout: 'standard' },
  嘴撸: { label: 'Social / InfoFi', layout: 'standard' },
  博彩: { label: 'Gaming / Betting', layout: 'standard' },
  存款: { label: 'Yield / Deposit', layout: 'standard' },
  模板项目: { label: 'Quest Template', layout: 'standard' },
  高频任务类: { label: 'Daily Tasks', layout: 'standard' },
  未分类: { label: 'Uncategorized', layout: 'standard' },
};

export function classifyAssoCategory(raw?: string): AssoCategoryInfo | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  if (Object.hasOwn(ASSO_CATEGORY_MAP, trimmed)) return ASSO_CATEGORY_MAP[trimmed];
  const fallback = stripOrTranslateCjk(trimmed);
  return fallback ? { label: fallback, layout: 'standard' } : null;
}

export function isAssoEcosystemStatusCell(raw?: string): boolean {
  const t = (raw ?? '').trim();
  return t === '主网' || t === '测试';
}

const ASSO_PROJECT_NAME_MAP: Record<string, string> = {
  Gate钱包: 'Gate Wallet',
  BG钱包: 'Bitget Wallet',
};

export function translateAssoProjectName(raw?: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  if (Object.hasOwn(ASSO_PROJECT_NAME_MAP, trimmed)) return ASSO_PROJECT_NAME_MAP[trimmed];
  return stripOrTranslateCjk(trimmed);
}

/**
 * Parses both CJK raise strings (`1000 万`, `2.25亿`) and English USD raise
 * strings (`$110M`, `~$4.5M (seed, reported)`, `$6.3M total (reported)`, `500K`).
 */
export function parseCjkRaiseUsd(raw?: string): number {
  const trimmed = (raw ?? '').trim();
  if (
    !trimmed ||
    trimmed === '/' ||
    trimmed === '-' ||
    trimmed === '未知' ||
    /^(?:tba|n\/a|unknown|undisclosed|none)$/i.test(trimmed)
  ) {
    return 0;
  }
  const cjkMatch = trimmed.match(
    /^(?:~|≈|>|<|约\s*)?\s*\$?\s*([\d.,]+)\s*(万|亿)(?:\s*(?:美元|美金|刀|usd|usdt|usdc|u))?(?:[\s+([（【,;/-]|$)/i,
  );
  if (cjkMatch) {
    const num = Number(cjkMatch[1].replace(/,/g, ''));
    const unit = CJK_UNITS[cjkMatch[2]] ?? 1;
    return Number.isFinite(num) && num > 0 ? Math.round(num * unit) : 0;
  }
  const suffixMatch = trimmed.match(
    /^(?:~|≈|>|<|approx\.?\s*|over\s+|up\s+to\s+)*\$?\s*([\d.,]+)\s*(billion|million|thousand|bn|mn|[kmb])(?:\b|[+\s([（,;/-]|$)/i,
  );
  if (suffixMatch) {
    const num = Number(suffixMatch[1].replace(/,/g, ''));
    if (!Number.isFinite(num) || num <= 0) return 0;
    const suffix = suffixMatch[2].toLowerCase();
    const mult =
      suffix === 'b' || suffix === 'bn' || suffix === 'billion'
        ? 1e9
        : suffix === 'm' || suffix === 'mn' || suffix === 'million'
          ? 1e6
          : 1e3;
    return Math.round(num * mult);
  }
  const plainUsdMatch = trimmed.match(
    /^(?:~|≈|>|<|approx\.?\s*)*\$\s*([\d,]+(?:\.\d+)?)(?:\s*(?:usd|usdt|usdc))?(?=$|[+\s([（,;/-])/i,
  );
  if (plainUsdMatch) {
    const num = Number(plainUsdMatch[1].replace(/,/g, ''));
    return Number.isFinite(num) && num > 0 ? Math.round(num) : 0;
  }
  const exactNumMatch = trimmed.match(/^([\d,]+(?:\.\d+)?)$/);
  if (exactNumMatch) {
    const num = Number(exactNumMatch[1].replace(/,/g, ''));
    return Number.isFinite(num) && num > 0 ? Math.round(num) : 0;
  }
  return 0;
}

const ASSO_INVESTOR_MAP: Record<string, string> = {
  红杉中国: 'HongShan (Sequoia China)',
};

export function translateAssoInvestor(raw?: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed || trimmed === '/') return '';
  const parts = trimmed
    .split(/[,，、/|]+/)
    .map(p => p.trim())
    .filter(p => p && p !== '/');
  const translated: string[] = [];
  for (const part of parts) {
    if (Object.hasOwn(ASSO_INVESTOR_MAP, part)) {
      translated.push(ASSO_INVESTOR_MAP[part]);
    } else {
      const clean = stripOrTranslateCjk(part);
      if (clean) translated.push(clean);
    }
  }
  return [...new Set(translated)].join(', ');
}

const ASSO_ECOSYSTEM_MAP: Record<string, string> = {
  预测: 'Prediction',
  永续: 'Perps',
  交易所: 'Exchange',
  社交: 'Social',
  链游: 'Gaming',
  钱包: 'Wallet',
  机器人: 'Robotics',
  区块链: 'Blockchain',
  基础设施: 'Infra',
  稳定币: 'Stablecoin',
  跨链桥: 'Bridge',
  股票代币: 'Stock Token',
  平台: 'Platform',
  打新: 'Launchpad',
  域名: 'Domain',
  营销: 'Marketing',
  彩票: 'Lottery',
  借贷: 'Lending',
  流动性: 'Liquidity',
  支付: 'Payments',
  代币发射: 'Token Launch',
  测试网: 'Testnet',
  隐私: 'Privacy',
  赌博: 'Betting',
  短剧: 'Media',
  身份验证: 'Identity',
  信誉: 'Reputation',
  年龄认证: 'Identity',
  AI医疗: 'AI Health',
  生态: 'Ecosystem',
  web3: 'Web3',
};

export function translateAssoEcosystem(raw?: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed || trimmed === '/') return '';
  if (Object.hasOwn(ASSO_ECOSYSTEM_MAP, trimmed)) return ASSO_ECOSYSTEM_MAP[trimmed];
  const parts = trimmed
    .split(/[/,，+、\s]+/)
    .map(p => p.trim())
    .filter(p => p && p !== '/');
  const out: string[] = [];
  for (const p of parts) {
    if (Object.hasOwn(ASSO_ECOSYSTEM_MAP, p)) out.push(ASSO_ECOSYSTEM_MAP[p]);
    else {
      const clean = stripOrTranslateCjk(p);
      if (clean) out.push(clean);
    }
  }
  return [...new Set(out)].join(' / ');
}

export interface AssoPotentialInfo {
  label: string;
  badge?: Badge;
  scoreBonus: number;
  isTokenLive?: boolean;
}

const ASSO_POTENTIAL_MAP: Record<string, AssoPotentialInfo> = {
  明确发币: { label: 'Confirmed', badge: 'live', scoreBonus: 18 },
  潜力大: { label: 'High', scoreBonus: 14 },
  潜力中: { label: 'Medium', scoreBonus: 8 },
  潜力小: { label: 'Low', scoreBonus: 3 },
  无计划: { label: 'No plan', scoreBonus: 0 },
  已发币: { label: 'Token live', badge: 'token', scoreBonus: 4, isTokenLive: true },
  新季度: { label: 'New season', badge: 'rerun', scoreBonus: 12 },
};

export function translateAssoPotential(raw?: string): AssoPotentialInfo {
  const trimmed = (raw ?? '').trim();
  if (trimmed && Object.hasOwn(ASSO_POTENTIAL_MAP, trimmed)) {
    return ASSO_POTENTIAL_MAP[trimmed];
  }
  return { label: stripOrTranslateCjk(trimmed) || 'Unknown', scoreBonus: 4 };
}

export function parseAssoBookmarkDate(raw?: string, defaultYear = 2026): { label: string; updatedTs?: number } {
  const trimmed = (raw ?? '').trim();
  if (!trimmed || trimmed === '/') return { label: '' };

  const yearOnly = trimmed.match(/^(\d{2})年$/);
  if (yearOnly) {
    const year = 2000 + Number(yearOnly[1]);
    return { label: String(year), updatedTs: Math.floor(Date.UTC(year, 0, 1) / 1000) };
  }

  const monthOnly = trimmed.match(/^(\d{1,2})月$/);
  if (monthOnly) {
    const month = Number(monthOnly[1]);
    if (month >= 1 && month <= 12) {
      const mm = String(month).padStart(2, '0');
      return { label: `${defaultYear}-${mm}`, updatedTs: Math.floor(Date.UTC(defaultYear, month - 1, 1) / 1000) };
    }
  }

  // Handle numeric M.DD with comma/space typos ("3,05", "3,15", "3.2 0")
  const normalized = trimmed.replace(/,/g, '.').replace(/\s+/g, '');
  const md = normalized.match(/^(\d{1,2})\.(\d{1,2})$/);
  if (md) {
    const month = Number(md[1]);
    const day = Number(md[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const utcDate = new Date(Date.UTC(defaultYear, month - 1, day));
      if (
        utcDate.getUTCFullYear() === defaultYear &&
        utcDate.getUTCMonth() === month - 1 &&
        utcDate.getUTCDate() === day
      ) {
        const mm = String(month).padStart(2, '0');
        const dd = String(day).padStart(2, '0');
        return {
          label: `${defaultYear}-${mm}-${dd}`,
          updatedTs: Math.floor(utcDate.getTime() / 1000),
        };
      }
    }
  }

  const clean = stripOrTranslateCjk(trimmed);
  return { label: clean };
}

export function parseAssoAttention(raw?: string): number {
  const trimmed = (raw ?? '').trim();
  if (!trimmed || trimmed === '不关注') return 0;
  const m = trimmed.match(/^([1-5])级关注$/);
  return m ? Number(m[1]) : 0;
}

export interface AssoParticipationInfo {
  label: string;
  isBankrupt?: boolean;
  isTge?: boolean;
}

const ASSO_PARTICIPATION_MAP: Record<string, AssoParticipationInfo> = {
  重点参与: { label: 'Priority' },
  多号参与: { label: 'Multi-account active' },
  在参与: { label: 'Active' },
  关注状态: { label: 'Watching' },
  观望等待: { label: 'Waitlist / Watching' },
  未参与: { label: 'Not started' },
  暂停: { label: 'Paused' },
  放弃: { label: 'Dropped' },
  拒绝参与: { label: 'Skipped' },
  已经发币: { label: 'TGE live', isTge: true },
  项目跑路: { label: 'Rug / Bankrupt', isBankrupt: true },
  签到: { label: 'Check-in' },
  无: { label: 'None' },
};

export function translateAssoParticipation(raw?: string): AssoParticipationInfo {
  const trimmed = (raw ?? '').trim();
  if (trimmed && Object.hasOwn(ASSO_PARTICIPATION_MAP, trimmed)) {
    return ASSO_PARTICIPATION_MAP[trimmed];
  }
  return { label: stripOrTranslateCjk(trimmed) || 'Active' };
}

export function isAssoDroppedOrRug(col13?: string, col23?: string): boolean {
  const c13 = (col13 ?? '').trim();
  const c23 = (col23 ?? '').trim();
  return c13.includes('放弃') || c13.includes('跑路') || c23.includes('跑路') || c23.includes('不让提币');
}

export interface AssoInteractionInfo {
  taskType: string;
  cardType: string;
  label: string;
  isRisk?: boolean;
}

const ASSO_INTERACTION_MAP: Record<string, AssoInteractionInfo> = {
  任务: { taskType: 'quest', cardType: 'bounty', label: 'Quest' },
  签到: { taskType: 'social', cardType: 'social', label: 'Daily check-in' },
  候补: { taskType: 'waitlist', cardType: 'form', label: 'Waitlist' },
  交易: { taskType: 'trade', cardType: 'trading', label: 'Trading' },
  交互: { taskType: 'testnet', cardType: 'testnet', label: 'On-chain interaction' },
  挂机: { taskType: 'node', cardType: 'depin', label: 'DePIN / Idle' },
  质押: { taskType: 'stake', cardType: 'staking', label: 'Staking' },
  无损: { taskType: 'stake', cardType: 'staking', label: 'Zero-loss staking' },
  存款: { taskType: 'stake', cardType: 'liquidity', label: 'Deposit / Liquidity' },
  领水: { taskType: 'faucet', cardType: 'testnet', label: 'Faucet' },
  游戏: { taskType: 'quest', cardType: 'game', label: 'Gaming' },
  挖矿: { taskType: 'node', cardType: 'depin', label: 'Mining' },
  等待: { taskType: 'waitlist', cardType: 'form', label: 'Waitlist' },
  博彩: { taskType: 'trade', cardType: 'predictions', label: 'Betting' },
  空投: { taskType: 'other', cardType: 'bounty', label: 'Airdrop' },
  发帖: { taskType: 'social', cardType: 'social', label: 'Social post' },
  反撸: { taskType: 'other', cardType: 'other', label: 'Sybil / Negative EV', isRisk: true },
};

const LIST_NUM_PREFIX_RE = /^[0-9]+[.\u3001)]\s*/;

export function translateAssoInteraction(raw?: string): AssoInteractionInfo {
  const trimmed = (raw ?? '').trim();
  if (!trimmed || trimmed === '/') {
    return { taskType: 'other', cardType: 'other', label: 'On-chain task' };
  }
  const normalized = trimmed.replace(LIST_NUM_PREFIX_RE, '').trim();
  if (!normalized || normalized === '/') {
    return { taskType: 'other', cardType: 'other', label: 'On-chain task' };
  }
  if (Object.hasOwn(ASSO_INTERACTION_MAP, normalized)) {
    return ASSO_INTERACTION_MAP[normalized];
  }
  // Layout-B numbered step-1 prefixes
  if (normalized.includes('跨链')) {
    return { taskType: 'bridge', cardType: 'mainnet', label: 'Cross-chain bridge' };
  }
  if (normalized.includes('领水')) {
    return { taskType: 'faucet', cardType: 'testnet', label: 'Claim faucet' };
  }
  if (normalized.includes('钱包注册') || normalized.includes('下载钱包')) {
    return { taskType: 'testnet', cardType: 'testnet', label: 'Wallet setup' };
  }
  const clean = stripOrTranslateCjk(normalized);
  return { taskType: 'other', cardType: 'other', label: clean || 'On-chain task' };
}

const STEP_TOKEN_ENTRIES: [string, string][] = [
  ['参与游戏获得积分', 'Play games for points'],
  ['每日领水完成交互', 'Claim daily faucet & interact'],
  ['领取测试币预测', 'Claim test tokens & predict'],
  ['领取测试币', 'Claim test tokens'],
  ['领取代币', 'Claim tokens'],
  ['完成社交任务', 'Complete social tasks'],
  ['完成答题任务', 'Complete quiz tasks'],
  ['完成贡献任务', 'Complete contributor tasks'],
  ['添加社交账号', 'Connect social accounts'],
  ['添加流动性', 'Add liquidity'],
  ['一键部署', 'One-click deploy'],
  ['部署合同', 'Deploy contract'],
  ['部署合约', 'Deploy contract'],
  ['部署代币', 'Deploy token'],
  ['部署nft', 'Deploy NFT'],
  ['工会任务', 'Guild quests'],
  ['铸造勋章', 'Mint badge'],
  ['注册域名', 'Register domain'],
  ['链上浏览', 'Browse on-chain'],
  ['刷链上活跃', 'On-chain activity'],
  ['参与交易', 'Trade'],
  ['执行交易', 'Execute trades'],
  ['完成交互', 'Complete interaction'],
  ['完成任务', 'Complete tasks'],
  ['钱包注册', 'Wallet setup'],
  ['下载钱包', 'Install wallet'],
  ['每日gm', 'Daily GM'],
  ['每日签到', 'Daily check-in'],
  ['跨链桥', 'Cross-chain bridge'],
  ['测试网', 'Testnet'],
  ['跨链', 'Bridge'],
  ['领水', 'Claim faucet'],
  ['部署', 'Deploy contract'],
  ['质押', 'Stake'],
  ['存款', 'Deposit'],
  ['总换', 'Swap'],
  ['兑换', 'Swap'],
  ['交易', 'Trade'],
  ['交互', 'On-chain interaction'],
  ['铸造', 'Mint'],
  ['勋章', 'Badge'],
  ['域名', 'Register domain'],
  ['签到', 'Check-in'],
  ['任务', 'Complete quests'],
  ['投票', 'Vote'],
  ['游戏', 'Play game'],
  ['预测', 'Predict'],
  ['教程', 'Guide'],
  ['测试', 'Testnet'],
  ['主网', 'Mainnet'],
  ['生态', 'Ecosystem'],
];

const STEP_TOKEN_MAP = new Map<string, string>(
  STEP_TOKEN_ENTRIES.map(([token, repl]) => [token.toLowerCase(), repl]),
);

const STEP_TOKEN_RE = new RegExp(
  [...STEP_TOKEN_ENTRIES]
    .sort((a, b) => b[0].length - a[0].length)
    .map(([token]) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|'),
  'gi',
);

export function translateAssoStep(raw?: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed || trimmed === '/') return '';
  let s = trimmed
    .replace(LIST_NUM_PREFIX_RE, '')
    .replace(/\uFE0F/g, '')
    .replace(/[\u27A8\u27A1\u2192]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  if (!NON_ASCII_RE.test(s)) {
    return s.includes('+') ? s.replace(/\s*\+\s*/g, ' + ').replace(/\s+/g, ' ').trim() : s;
  }
  s = s.replace(STEP_TOKEN_RE, match => {
    const repl = STEP_TOKEN_MAP.get(match.toLowerCase());
    return repl ? ` ${repl} ` : match;
  });
  s = s.replace(/\s*\+\s*/g, ' + ').replace(/\s+/g, ' ').trim();
  return stripOrTranslateCjk(s);
}

const ASSO_REWARD_MAP: Record<string, string> = {
  积分: 'Points',
  白名单: 'Whitelist',
  交互: 'On-chain activity',
  代币: 'Token',
  积分币: 'Points / Token',
  收益: 'Yield',
  空投: 'Airdrop',
  交易量: 'Volume reward',
  勋章: 'Badge',
  域名: 'Domain',
  奖池: 'Prize pool',
  角色: 'Role',
  任务: 'Quest',
  测试: 'Testnet',
  部署合约: 'Deploy contract',
  参与交易: 'Trading',
  教程: 'Guide',
  参与游戏获得积分: 'Game points',
  NFT: 'NFT',
};

export function translateAssoReward(raw?: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed || trimmed === '/') return '';
  if (Object.hasOwn(ASSO_REWARD_MAP, trimmed)) return ASSO_REWARD_MAP[trimmed];
  return stripOrTranslateCjk(trimmed);
}

export interface AssoStatusInfo {
  label: string;
  badge?: Badge;
  isEnded?: boolean;
  isRisk?: boolean;
}

const ASSO_STATUS_MAP: Record<string, AssoStatusInfo> = {
  持续: { label: 'Ongoing' },
  早期: { label: 'Early', badge: 'early' },
  测试: { label: 'Testnet' },
  主网: { label: 'Mainnet' },
  待开: { label: 'Upcoming' },
  中期: { label: 'Mid-stage' },
  后期: { label: 'Late-stage' },
  暂停: { label: 'Paused' },
  异常: { label: 'Issue / Risk', badge: 'risk', isRisk: true },
  结束: { label: 'Ended', isEnded: true },
};

export function translateAssoStatus(raw?: string): AssoStatusInfo {
  const trimmed = (raw ?? '').trim();
  if (trimmed && Object.hasOwn(ASSO_STATUS_MAP, trimmed)) {
    return ASSO_STATUS_MAP[trimmed];
  }
  return { label: stripOrTranslateCjk(trimmed) || 'Ongoing' };
}

export interface AssoMultiAccountInfo {
  label: string;
  fit?: FitKey;
}

const ASSO_MULTI_MAP: Record<string, AssoMultiAccountInfo> = {
  可多号: { label: 'Multi-account', fit: 'multi' },
  单独号: { label: 'Single account' },
  精品号: { label: 'Main / Quality account', fit: 'climber' },
  少量号: { label: 'Small multi-account', fit: 'small' },
};

export function translateAssoMultiAccount(raw?: string): AssoMultiAccountInfo {
  const trimmed = (raw ?? '').trim();
  if (trimmed && Object.hasOwn(ASSO_MULTI_MAP, trimmed)) {
    return ASSO_MULTI_MAP[trimmed];
  }
  return { label: stripOrTranslateCjk(trimmed) || 'Single account' };
}

export interface AssoCostInfo {
  label: string;
  costNum: number;
  isZero?: boolean;
  fit?: FitKey;
}

const ASSO_COST_MAP: Record<string, AssoCostInfo> = {
  无消耗: { label: 'Free', costNum: 0, isZero: true, fit: 'zero' },
  少量: { label: 'Low cost', costNum: 5, fit: 'small' },
  手续费: { label: 'Trading fees', costNum: 10, fit: 'small' },
  Gas: { label: 'Gas only', costNum: 2, fit: 'small' },
  gas: { label: 'Gas only', costNum: 2, fit: 'small' },
  存款: { label: 'Deposit required', costNum: 100 },
  大量: { label: 'High cost', costNum: 500, fit: 'climber' },
  赌博: { label: 'Betting stake', costNum: 20 },
};

export function translateAssoCost(raw?: string): AssoCostInfo {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    return { label: 'Free', costNum: 0, isZero: true };
  }
  if (Object.hasOwn(ASSO_COST_MAP, trimmed)) {
    return ASSO_COST_MAP[trimmed];
  }
  if (trimmed === '/') {
    return { label: 'Variable', costNum: 0, isZero: false };
  }
  return { label: stripOrTranslateCjk(trimmed) || 'Variable', costNum: 0, isZero: false };
}

const ASSO_TGE_IGNORE = new Set(['少量', '无消耗', '项目方不让提币', '项目跑路']);

export function translateAssoTge(raw?: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed || trimmed === '/' || ASSO_TGE_IGNORE.has(trimmed)) return 'TBA';
  if (trimmed === '无') return 'None';
  if (trimmed === '待定') return 'TBA';
  if (trimmed === '已发币') return 'Launched';
  return stripOrTranslateCjk(trimmed) || 'TBA';
}
