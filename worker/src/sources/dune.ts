import { FETCH_TIMEOUT_MS, USER_AGENT } from '../lib/format';
import { stripOrTranslateCjk } from '../normalize/i18n';

export const DEFAULT_DUNE_AIRDROP_QUERY_IDS = [3921616, 4408238, 5203170, 4851338] as const;

export interface DuneAirdropSummary {
  queryId: number;
  rowCount: number;
  executionEndedAt?: string;
  rows: Record<string, unknown>[];
}

export interface DuneAirdropsSnapshot {
  fetchedAt: number;
  queries: DuneAirdropSummary[];
}

interface DuneQueryResponse {
  execution_ended_at?: string;
  result?: {
    rows?: Record<string, unknown>[];
  };
}

function sanitizeRow(row: unknown): Record<string, unknown> | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const out: Record<string, unknown> = {};
  const entries = Object.entries(row as Record<string, unknown>);
  for (let idx = 0; idx < entries.length; idx++) {
    const [k, v] = entries[idx];
    let cleanKey = stripOrTranslateCjk(k) || `col_${idx + 1}`;
    if (Object.hasOwn(out, cleanKey)) {
      cleanKey = `${cleanKey}_${idx + 1}`;
    }
    if (typeof v === 'string') {
      out[cleanKey] = stripOrTranslateCjk(v);
    } else if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
      out[cleanKey] = v;
    }
  }
  return out;
}

export function normalizeDuneRows(rawRows: unknown, maxRows = 50): Record<string, unknown>[] {
  if (!Array.isArray(rawRows)) return [];
  const out: Record<string, unknown>[] = [];
  for (const row of rawRows) {
    if (out.length >= maxRows) break;
    const sanitized = sanitizeRow(row);
    if (sanitized) out.push(sanitized);
  }
  return out;
}

/**
 * Optional Dune Analytics fetcher used ONLY when `DUNE_API_KEY` is provided in
 * `scripts/ingest-heavy.mts`. Default runtime remains 100% keyless ($0).
 */
export async function fetchDuneAirdrops(
  apiKey: string,
  queryIds: readonly number[] = DEFAULT_DUNE_AIRDROP_QUERY_IDS,
  nowMs = Date.now(),
): Promise<DuneAirdropsSnapshot> {
  const key = apiKey.trim();
  if (!key) {
    throw new Error('DUNE_API_KEY is required to fetch Dune airdrop queries');
  }

  const settled = await Promise.allSettled(
    queryIds.map(async queryId => {
      const url = `https://api.dune.com/api/v1/query/${queryId}/results?limit=100`;
      const res = await fetch(url, {
        headers: {
          'X-Dune-API-Key': key,
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Dune query ${queryId} HTTP ${res.status}`);
      const json = (await res.json()) as DuneQueryResponse;
      const rawRows = Array.isArray(json.result?.rows) ? json.result.rows : [];
      const rows = normalizeDuneRows(rawRows, 50);
      return {
        queryId,
        rowCount: rawRows.length,
        executionEndedAt: json.execution_ended_at,
        rows,
      } satisfies DuneAirdropSummary;
    }),
  );

  const queries: DuneAirdropSummary[] = [];
  const failures: string[] = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === 'fulfilled') {
      queries.push(r.value);
    } else {
      const queryId = queryIds[i];
      const rawMsg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      const safeMsg = rawMsg.split(key).join('[REDACTED]');
      console.warn(`dune-query-failed:${queryId}`, safeMsg);
      failures.push(`${queryId}: ${safeMsg}`);
    }
  }

  if (queries.length === 0) {
    throw new Error(`All Dune airdrop queries failed (${failures.join('; ')})`);
  }

  return { fetchedAt: nowMs, queries };
}
