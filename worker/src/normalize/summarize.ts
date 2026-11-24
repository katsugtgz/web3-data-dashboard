import type { TaskType } from '../../../shared/types';
import { TASK_TYPES } from '../../../shared/constants';
import { HAN_RE } from './i18n';

export const AI_MODEL = '@cf/meta/llama-3.1-8b-instruct';

export interface AiBindingLike {
  run(
    model: string,
    input: { messages: { role: 'system' | 'user'; content: string }[]; max_tokens?: number },
  ): Promise<unknown>;
}

// Single source of truth: shared/constants TASK_TYPES tuple.
const VALID_TASKS = new Set<TaskType>(TASK_TYPES);

const NON_LATIN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Thai}]/u;

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

export function unsafeContentRe(s: string): boolean {
  const t = s.replace(DEFANG_CHARS_RE, '').replace(/\[\.\]|\(\.\)|\u3002/g, '.');
  return (
    /https?:\/\//i.test(t) ||
    /www\./i.test(t) ||
    // Domain-like token: one or more labels ending in a TLD-ish suffix, so
    // example.com AND foo.bar.tld both match (case-insensitive).
    /\b[\w-]+(?:\.[\w-]+)*\.(?:[a-z]{2,24})\b/i.test(t) ||
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
    if (HAN_RE.test(summary) || NON_LATIN_RE.test(summary)) return null;
    // The model sees untrusted post text. A crafted post can steer the summary
    // into links, wallet addresses, or drain instructions — never store those.
    if (unsafeContentRe(summary)) return null;
    if (/\b(connect|visit|open)\b[^.]{0,40}\bwallet\b/i.test(summary) || /\bseed phrase\b|\bprivate key\b/i.test(summary)) {
      return null;
    }

    const taskTypes = Array.isArray(parsed.taskTypes)
      ? parsed.taskTypes.filter((t): t is TaskType => typeof t === 'string' && VALID_TASKS.has(t as TaskType))
      : [];
    // Cap chain names: a steered model could emit unbounded junk here.
    const chains = Array.isArray(parsed.chains)
      ? parsed.chains
          .filter((c): c is string => typeof c === 'string')
          .map(c => c.trim())
          .filter(c => c.length > 0 && c.length <= 30 && !HAN_RE.test(c) && !NON_LATIN_RE.test(c))
          // Chains render into feed + agent briefs: same unsafe-content bar
          // as the summary (no URLs, no addresses).
          .filter(c => !unsafeContentRe(c))
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

async function recordAiAttemptFailure(db: D1Database, clusterId: string, nowMs: number): Promise<void> {
  await db
    .prepare(
      `UPDATE clusters
       SET ai_attempts = ai_attempts + 1,
           ai_retry_after = CASE WHEN ai_attempts = 0 THEN ?2 ELSE ?3 END
       WHERE id = ?1 AND summary_source = 'rule'`,
    )
    .bind(clusterId, nowMs + AI_RETRY_FIRST_MS, nowMs + AI_RETRY_NEXT_MS)
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
  },
): Promise<AiSummaryPayload | null> {
  if (!ai) return null;
  if (opts.riskLevel === 'risk') return null;
  if (!opts.isNewCluster && !opts.isNonLatinSource) return null;

  const nowMs = opts.nowMs ?? Date.now();
  const day = utcDayKey(nowMs);
  const dailyMax = opts.dailyMax ?? 300;

  if (dailyMax <= 0) return null;

  // Atomically reserve one call. The conditional upsert commits the increment
  // only while the counter is strictly under the cap, so parallel callers
  // (6 concurrent summaries per cron tick) cannot exceed AI_DAILY_MAX. The
  // losing caller's guarded upsert matches zero rows and RETURNING yields
  // nothing → no AI call. The `dailyMax <= 0` check above closes the
  // first-insert-of-the-day path (the upsert's WHERE only guards conflicts).
  const reserved = await db
    .prepare(
      `INSERT INTO ai_usage (day, calls) VALUES (?1, 1)
       ON CONFLICT(day) DO UPDATE SET calls = ai_usage.calls + 1
       WHERE ai_usage.calls < ?2
       RETURNING calls`,
    )
    .bind(day, dailyMax)
    .first<{ calls: number }>();

  if (!reserved || typeof reserved.calls !== 'number' || !Number.isFinite(reserved.calls)) {
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
            'Summarize Web3 airdrop tasks in concise English. Reply with strict JSON only: {"summary":"<=180 chars English","taskTypes":[...],"chains":[...]}. Valid taskTypes: testnet,faucet,quest,waitlist,bridge,stake,mint,points,trade,social,node,other.',
        },
        {
          role: 'user',
          content: `Project: ${opts.project}\nPosts:\n${excerpt}`,
        },
      ],
      max_tokens: 180,
    });
  } catch {
    rawOut = null;
  }

  const text = extractAiTextResponse(rawOut);
  const validated = text ? parseAndValidateAiJson(text) : null;
  if (!validated) {
    await recordAiAttemptFailure(db, opts.clusterId, nowMs);
    return null;
  }

  const existing = await db
    .prepare('SELECT chains, task_types FROM clusters WHERE id = ?1')
    .bind(opts.clusterId)
    .first<{ chains: string; task_types: string }>();

  const prevTasks = existing ? (JSON.parse(existing.task_types) as TaskType[]) : [];
  const mergedTasksRaw = [...new Set([...prevTasks, ...validated.taskTypes])];
  const mergedTasks = mergedTasksRaw.length > 1 ? mergedTasksRaw.filter(t => t !== 'other') : mergedTasksRaw;

  // SQL-side merge against the CURRENT columns: a concurrent ingest may have
  // extended chains/tasks between our SELECT and this UPDATE — replacing the
  // arrays wholesale would drop those entries. Cap: same 8-entry bound the
  // model output gets, or steered merge lists grow unbounded.
  await db
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
       WHERE id = ?1`,
    )
    .bind(opts.clusterId, validated.summary, JSON.stringify(validated.chains), JSON.stringify(mergedTasks))
    .run();

  return validated;
}
