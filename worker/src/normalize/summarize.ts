import type { TaskType } from '../../../shared/types';
import { TASK_TYPES } from '../../../shared/constants';
import { DOUBLING_SCAM_RE, DRAINER_RE } from '../safety';
import { FORBIDDEN_CJK_RE, HAN_RE } from './i18n';

export const AI_MODEL = '@cf/meta/llama-3.1-8b-instruct';

export interface AiBindingLike {
  run(
    model: string,
    input: { messages: { role: 'system' | 'user'; content: string }[]; max_tokens?: number },
  ): Promise<unknown>;
}

// Single source of truth: shared/constants TASK_TYPES tuple.
const VALID_TASKS = new Set<TaskType>(TASK_TYPES);

const NON_LATIN_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Thai}]/u;

export interface AiSummaryPayload {
  summary: string;
  taskTypes: TaskType[];
  chains: string[];
}

export function extractAiTextResponse(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.response === 'string') return obj.response;
    const choices = obj.choices as { message?: { content?: unknown } }[] | undefined;
    const content = choices?.[0]?.message?.content;
    if (typeof content === 'string' && content) return content;
  }
  return null;
}

// Scam text defangs itself to slip past filters: zero-width chars split
// hosts, [.] / (.) / \u3002 (ideographic full stop) stand in for dots.
const DEFANG_CHARS_RE = /[\u200b-\u200f\u2060\ufeff]/g;
const DEV_FILE_SUFFIXES = new Set(['js', 'ts', 'py', 'rs', 'sol', 'json', 'md']);
const DOMAIN_LIKE_RE = /\b[\w-]+(?:\.[\w-]+)*\.([a-z]{2,24})\b/gi;
const RAW_IPV4_RE =
  /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:[:/]\S*)?(?![\d.])/;
const DANGEROUS_SCHEME_RE = /[a-z][a-z0-9+.-]*:\/\/|\b(?:javascript|data):/i;
const HANDLE_MENTION_RE = /(?:^|[\s([{"'])@[a-z0-9_]{3,}/i;
const AI_UNSAFE_PHRASE_RE =
  /\b(?:connect|visit|open|verify|approve|validate|confirm)\b[^.!?]{0,40}\bwallets?\b|\bconfirm\s+in\s+(?:your\s+)?wallets?\b|\b(?:seed\s+phrase|recovery\s+phrase|private\s+key|mnemonic)\b/i;

const CHAIN_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9 -]{0,29}$/;
const CHAIN_INJECTION_WORD_RE =
  /\b(?:ignore|ignored|prompt|system|instruction|override|wallet|connect|claim|airdrop|send|approve|verify|seed|private|key|click|visit|http|https|www)\b/i;
const KNOWN_LONG_UPPER_CHAINS = new Set([
  'ethereum', 'arbitrum', 'optimism', 'solana', 'polygon', 'avalanche', 'berachain',
  'starknet', 'celestia', 'injective', 'hyperevm', 'megaeth', 'abstract', 'movement',
  'bitcoin', 'cardano', 'polkadot', 'cosmos', 'fantom', 'gnosis', 'moonbeam', 'zksync',
  'mantle', 'scroll', 'initia', 'unichain', 'soneium', 'eclipse', 'hyperliquid',
]);

function hasUnsafeDomainToken(text: string): boolean {
  for (const match of text.matchAll(DOMAIN_LIKE_RE)) {
    const suffix = match[1]?.toLowerCase();
    if (suffix && !DEV_FILE_SUFFIXES.has(suffix)) return true;
  }
  return false;
}

function isCleanChainToken(chain: string): boolean {
  if (!chain || chain.length > 30) return false;
  if (HAN_RE.test(chain) || FORBIDDEN_CJK_RE.test(chain) || NON_LATIN_RE.test(chain)) return false;
  if (unsafeContentRe(chain)) return false;
  if (!CHAIN_TOKEN_RE.test(chain) || chain.includes('  ') || chain.endsWith('-')) return false;
  if (chain.split(' ').length > 3) return false;
  if (CHAIN_INJECTION_WORD_RE.test(chain)) return false;
  if (/^[A-Z0-9 -]{7,}$/.test(chain) && !KNOWN_LONG_UPPER_CHAINS.has(chain.toLowerCase())) return false;
  return true;
}

export function unsafeContentRe(s: string): boolean {
  const t = s.replace(DEFANG_CHARS_RE, '').replace(/\[\.\]|\(\.\)|\u3002/g, '.');
  return (
    DANGEROUS_SCHEME_RE.test(t) ||
    /www\./i.test(t) ||
    RAW_IPV4_RE.test(t) ||
    HANDLE_MENTION_RE.test(t) ||
    hasUnsafeDomainToken(t) ||
    // EVM address
    /0x[a-fA-F0-9]{6,}/.test(t) ||
    // Solana address: 32-44 chars base58 (alphabet excludes 0OIl)
    /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/.test(t)
  );
}

export function parseAndValidateAiJson(rawText: string): AiSummaryPayload | null {
  const start = rawText.indexOf('{');
  const end = rawText.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(rawText.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof parsed.summary !== 'string') return null;
    const summary = parsed.summary.replace(/\s+/g, ' ').trim();
    if (!summary || summary.length > 180) return null;
    if (HAN_RE.test(summary) || FORBIDDEN_CJK_RE.test(summary) || NON_LATIN_RE.test(summary)) return null;
    // The model sees untrusted post text. A crafted post can steer the summary
    // into links, wallet addresses, or drain instructions — never store those.
    if (unsafeContentRe(summary)) return null;
    if (DRAINER_RE.test(summary) || DOUBLING_SCAM_RE.test(summary) || AI_UNSAFE_PHRASE_RE.test(summary)) {
      return null;
    }

    const taskTypes = Array.isArray(parsed.taskTypes)
      ? parsed.taskTypes.filter((t): t is TaskType => typeof t === 'string' && VALID_TASKS.has(t as TaskType))
      : [];
    // Cap and strictly validate chain names: a steered model could emit unbounded junk or prompt injections here.
    const chains = Array.isArray(parsed.chains)
      ? parsed.chains
          .filter((c): c is string => typeof c === 'string')
          .map(c => c.trim())
          .filter(isCleanChainToken)
          .slice(0, 8)
      : [];

    return { summary, taskTypes, chains };
  } catch {
    return null;
  }
}

export const AI_MAX_ATTEMPTS = 3;

function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

const AI_RETRY_FIRST_MS = 6 * 3_600_000;
const AI_RETRY_NEXT_MS = 24 * 3_600_000;
const AI_LEASE_MS = 120_000;

async function recordAiAttemptFailure(
  db: D1Database,
  clusterId: string,
  nowMs: number,
  leaseUntil: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE clusters
       SET ai_attempts = ai_attempts + 1,
           ai_retry_after = CASE WHEN ai_attempts = 0 THEN ?2 ELSE ?3 END
       WHERE id = ?1 AND summary_source = 'rule' AND ai_retry_after = ?4`,
    )
    .bind(clusterId, nowMs + AI_RETRY_FIRST_MS, nowMs + AI_RETRY_NEXT_MS, leaseUntil)
    .run();
}

async function releaseAiLease(db: D1Database, clusterId: string, leaseUntil: number): Promise<void> {
  await db
    .prepare('UPDATE clusters SET ai_retry_after = 0 WHERE id = ?1 AND ai_retry_after = ?2')
    .bind(clusterId, leaseUntil)
    .run();
}

/** Pre-check whether today's AI call quota remains before querying backlog payloads. */
export async function hasAiQuotaRemaining(
  db: D1Database,
  dailyMax: number,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!(dailyMax > 0)) return false;
  const day = utcDayKey(nowMs);
  const row = await db
    .prepare('SELECT calls FROM ai_usage WHERE day = ?1')
    .bind(day)
    .first<{ calls: number }>();
  return (row?.calls ?? 0) < dailyMax;
}

export async function summarizeClusterWithAi(
  ai: AiBindingLike | undefined,
  db: D1Database,
  opts: {
    clusterId: string;
    project: string;
    rawTexts: string[];
    isNewCluster: boolean;
    isNonLatinSource: boolean;
    riskLevel: 'ok' | 'warn' | 'risk';
    dailyMax?: number;
    nowMs?: number;
    /** Injectable clock for lease acquisition; defaults to `Date.now`. */
    clock?: () => number;
  },
): Promise<AiSummaryPayload | null> {
  if (!ai) return null;
  if (opts.riskLevel === 'risk') return null;
  if (!opts.isNewCluster && !opts.isNonLatinSource) return null;

  const dailyMax = opts.dailyMax ?? 300;
  if (dailyMax <= 0) return null;

  // Claim a short per-cluster row lease before reserving daily quota or calling
  // Workers AI so overlapping */2 and */5 crons never double-run the same cluster.
  // Base lease expiry on the current acquisition clock rather than a caller's
  // potentially stale nowMs captured before slow source polling.
  const acquisitionNowMs = opts.clock ? opts.clock() : Math.max(opts.nowMs ?? 0, Date.now());
  const nowMs = opts.nowMs ?? acquisitionNowMs;
  const leaseCheckNowMs = opts.clock ? acquisitionNowMs : nowMs;
  const day = utcDayKey(nowMs);
  const leaseUntil = acquisitionNowMs + AI_LEASE_MS;
  const claimed = await db
    .prepare(
      `UPDATE clusters
       SET ai_retry_after = ?2
       WHERE id = ?1
         AND summary_source = 'rule'
         AND risk_level != 'risk'
         AND ai_attempts < ${AI_MAX_ATTEMPTS}
         AND ai_retry_after <= ?3
       RETURNING id`,
    )
    .bind(opts.clusterId, leaseUntil, leaseCheckNowMs)
    .first<{ id: string }>();
  if (!claimed) return null;

  let reserved: { calls: number } | null;
  try {
    reserved = await db
      .prepare(
        `INSERT INTO ai_usage (day, calls) VALUES (?1, 1)
         ON CONFLICT(day) DO UPDATE SET calls = ai_usage.calls + 1
         WHERE ai_usage.calls < ?2
         RETURNING calls`,
      )
      .bind(day, dailyMax)
      .first<{ calls: number }>();
  } catch (err) {
    await releaseAiLease(db, opts.clusterId, leaseUntil).catch(() => {});
    throw err;
  }

  if (!reserved || typeof reserved.calls !== 'number' || !Number.isFinite(reserved.calls)) {
    await releaseAiLease(db, opts.clusterId, leaseUntil);
    return null;
  }

  const excerpt = opts.rawTexts.join('\n---\n').slice(0, 1400);
  let rawOut: unknown;
  try {
    rawOut = await ai.run(AI_MODEL, {
      messages: [
        {
          role: 'system',
          content:
            'Translate and summarize Web3 airdrop/testnet/quest tasks into concise natural English (never Indonesian, Turkish, or CJK; no URLs, referral codes, or channel signatures). Reply with strict JSON only: {"summary":"<=180 chars English","taskTypes":[...],"chains":[...]}. Valid taskTypes: testnet,faucet,quest,waitlist,bridge,stake,mint,points,trade,social,node,other.',
        },
        {
          role: 'user',
          content: `Project: ${opts.project}\nPosts:\n${excerpt}`,
        },
      ],
      max_tokens: 180,
    });
  } catch (err) {
    console.error('ai-summary-error', opts.clusterId, err);
    await db
      .prepare('UPDATE ai_usage SET calls = MAX(0, calls - 1) WHERE day = ?1')
      .bind(day)
      .run();
    rawOut = null;
  }

  const text = extractAiTextResponse(rawOut);
  const validated = text ? parseAndValidateAiJson(text) : null;
  if (!validated) {
    await recordAiAttemptFailure(db, opts.clusterId, nowMs, leaseUntil);
    return null;
  }

  const persisted = await db
    .prepare(
      `UPDATE clusters
       SET summary = ?2,
           summary_source = 'ai',
           ai_attempts = 0,
           ai_retry_after = 0,
           chains = (
             SELECT json_group_array(value)
             FROM (
               SELECT DISTINCT value FROM json_each(clusters.chains)
               UNION
               SELECT DISTINCT value FROM json_each(?3)
               LIMIT 8
             )
           ),
           task_types = (
             SELECT CASE
                      WHEN COUNT(DISTINCT value) > 1
                      THEN json_group_array(value) FILTER (WHERE value != 'other')
                      ELSE json_group_array(DISTINCT value)
                    END
             FROM (
               SELECT value FROM json_each(clusters.task_types)
               UNION
               SELECT value FROM json_each(?4)
             )
           )
       WHERE id = ?1
         AND ai_retry_after = ?5
       RETURNING id`,
    )
    .bind(
      opts.clusterId,
      validated.summary,
      JSON.stringify(validated.chains),
      JSON.stringify(validated.taskTypes),
      leaseUntil,
    )
    .first<{ id: string }>();

  return persisted ? validated : null;
}
