import type { TaskType } from '../../../shared/types';
import { TASK_TYPES } from '../../../shared/constants';
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
    const choices = obj.choices as { message?: { content?: string } }[] | undefined;
    if (choices?.[0]?.message?.content) return choices[0].message.content;
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
    if (HAN_RE.test(summary) || FORBIDDEN_CJK_RE.test(summary) || NON_LATIN_RE.test(summary)) return null;
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
          .filter(c => c.length > 0 && c.length <= 30 && !HAN_RE.test(c) && !FORBIDDEN_CJK_RE.test(c) && !NON_LATIN_RE.test(c))
          .filter(c => !unsafeContentRe(c))
          .slice(0, 8)
      : [];

    return { summary, taskTypes, chains };
  } catch {
    return null;
  }
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
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const dailyMax = opts.dailyMax ?? 300;

  if (dailyMax <= 0) return null;

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
            'Translate and summarize Web3 airdrop/testnet/quest tasks into concise natural English (never Indonesian, Turkish, or CJK; no URLs, referral codes, or channel signatures). Reply with strict JSON only: {"summary":"<=180 chars English","taskTypes":[...],"chains":[...]}. Valid taskTypes: testnet,faucet,quest,waitlist,bridge,stake,mint,points,trade,social,node,other.',
        },
        {
          role: 'user',
          content: `Project: ${opts.project}\nPosts:\n${excerpt}`,
        },
      ],
      max_tokens: 180,
    });
  } catch {
    return null;
  }

  const text = extractAiTextResponse(rawOut);
  if (!text) return null;
  const validated = parseAndValidateAiJson(text);
  if (!validated) return null;

  const existing = await db
    .prepare('SELECT chains, task_types FROM clusters WHERE id = ?1')
    .bind(opts.clusterId)
    .first<{ chains: string; task_types: string }>();

  const prevTasks = existing ? (JSON.parse(existing.task_types) as TaskType[]) : [];
  const mergedTasksRaw = [...new Set([...prevTasks, ...validated.taskTypes])];
  const mergedTasks = mergedTasksRaw.length > 1 ? mergedTasksRaw.filter(t => t !== 'other') : mergedTasksRaw;

  await db
    .prepare(
      `UPDATE clusters
       SET summary = ?2,
           summary_source = 'ai',
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
