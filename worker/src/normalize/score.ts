import type { Grade, RiskLevel } from '../../../shared/types';

export const TIER_BONUS: Record<Grade, number> = {
  S: 0.5,
  A: 0.3,
  B: 0.15,
  C: 0,
};

export interface ScoreInput {
  trustMax: number;
  sourceCount: number;
  lastSeen: number;
  nowMs?: number;
  surfTier?: Grade | null;
  riskLevel: RiskLevel;
}

export function computeScore(input: ScoreInput): number {
  const nowMs = input.nowMs ?? Date.now();
  const ageHours = Math.max(0, (nowMs - input.lastSeen) / 3_600_000);
  const tierBonus = input.surfTier ? TIER_BONUS[input.surfTier] : 0;
  const raw =
    Math.max(0.1, input.trustMax) *
    Math.log(1 + Math.max(1, input.sourceCount)) *
    Math.exp(-ageHours / 48) *
    (1 + tierBonus);
  const adjusted = input.riskLevel === 'risk' ? raw * 0.2 : raw;
  return Number(adjusted.toFixed(4));
}

export async function decayClusterScores(db: D1Database, nowMs = Date.now()): Promise<void> {
  const res = await db
    .prepare(
      `SELECT c.id, c.source_count, c.last_seen, c.surf_tier, c.risk_level,
              COALESCE(MAX(s.trust), 0.5) AS trust_max
       FROM clusters c
       LEFT JOIN posts p ON p.cluster_id = c.id
       LEFT JOIN sources s ON s.id = p.source_id
       GROUP BY c.id
       ORDER BY c.last_seen DESC
       LIMIT 250`,
    )
    .all<{
      id: string;
      source_count: number;
      last_seen: number;
      surf_tier: Grade | null;
      risk_level: RiskLevel;
      trust_max: number;
    }>();

  const rows = res.results ?? [];
  if (rows.length === 0) return;

  const stmts = rows.map(r => {
    const nextScore = computeScore({
      trustMax: r.trust_max,
      sourceCount: r.source_count,
      lastSeen: r.last_seen,
      nowMs,
      surfTier: r.surf_tier,
      riskLevel: r.risk_level,
    });
    return db.prepare('UPDATE clusters SET score = ?2 WHERE id = ?1').bind(r.id, nextScore);
  });

  const chunks = [];
  for (let i = 0; i < stmts.length; i += 40) {
    chunks.push(db.batch(stmts.slice(i, i + 40)));
  }
  await Promise.all(chunks);
}
