import type { TaskType } from '../../../shared/types';
import { HAN_RE } from './i18n';

export const AI_MODEL = '@cf/meta/llama-3.1-8b-instruct';

export interface AiBindingLike {
  run(
    model: string,
    input: { messages: { role: 'system' | 'user'; content: string }[]; max_tokens?: number },
  ): Promise<unknown>;
}

const VALID_TASKS = new Set<TaskType>([
  'testnet',
  'faucet',
  'quest',
  'waitlist',
  'bridge',
  'stake',
  'mint',
  'points',
  'trade',
  'social',
  'node',
  'other',
]);

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
    const choices = obj.choices as { message?: { content?: string } }[] | undefined;
    if (choices?.[0]?.message?.content) return choices[0].message.content;
  }
  return null;
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

    const taskTypes = Array.isArray(parsed.taskTypes)
      ? parsed.taskTypes.filter((t): t is TaskType => typeof t === 'string' && VALID_TASKS.has(t as TaskType))
      : [];
    const chains = Array.isArray(parsed.chains)
      ? parsed.chains
          .filter((c): c is string => typeof c === 'string')
          .map(c => c.trim())
          .filter(c => c.length > 0 && !HAN_RE.test(c) && !NON_LATIN_RE.test(c))
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

  const usageRow = await db
    .prepare('SELECT calls FROM ai_usage WHERE day = ?1')
    .bind(day)
    .first<{ calls: number }>();

  if ((usageRow?.calls ?? 0) >= dailyMax) {
    return null;
  }

  await db
    .prepare(
      `INSERT INTO ai_usage (day, calls) VALUES (?1, 1)
       ON CONFLICT(day) DO UPDATE SET calls = calls + 1`,
    )
    .bind(day)
    .run();

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

  const prevChains = existing ? (JSON.parse(existing.chains) as string[]) : [];
  const prevTasks = existing ? (JSON.parse(existing.task_types) as TaskType[]) : [];
  const mergedChains = [...new Set([...prevChains, ...validated.chains])];
  const mergedTasksRaw = [...new Set([...prevTasks, ...validated.taskTypes])];
  const mergedTasks = mergedTasksRaw.length > 1 ? mergedTasksRaw.filter(t => t !== 'other') : mergedTasksRaw;

  await db
    .prepare(
      `UPDATE clusters
       SET summary = ?2, summary_source = 'ai', chains = ?3, task_types = ?4
       WHERE id = ?1`,
    )
    .bind(opts.clusterId, validated.summary, JSON.stringify(mergedChains), JSON.stringify(mergedTasks))
    .run();

  return validated;
}
