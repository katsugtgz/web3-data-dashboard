import { describe, expect, test } from 'bun:test';
import { createTestD1 } from './helpers';
import { queryFeed } from '../src/normalize/cluster';

function createSqliteD1(): D1Database {
  return createTestD1().db;
}

async function seedCluster(db: D1Database, id: string, score: number, lastSeen: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO clusters (id, project, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen)
       VALUES (?1, ?2, '[]', '[]', ?2, 'rule', 'ok', '[]', ?3, 1, ?4, ?4)`,
    )
    .bind(id, `Project ${id}`, score, lastSeen)
    .run();
}

describe('feed response determinism', () => {
  test('empty feed keeps a constant generatedAt so ETags survive cache misses', async () => {
    const db = createSqliteD1();
    const a = await queryFeed(db, new Set());
    const b = await queryFeed(db, new Set());
    expect(a.items).toEqual([]);
    expect(a.generatedAt).toBe(b.generatedAt);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('contentTs seeds generatedAt on the empty branch and non-empty branch', async () => {
    const db = createSqliteD1();
    const empty = await queryFeed(db, new Set(), { contentTs: 12345 });
    expect(empty.generatedAt).toBe(12345);

    await seedCluster(db, 'c1', 0.5, 777);
    const nonEmpty = await queryFeed(db, new Set(), { contentTs: 999 });
    expect(nonEmpty.items.length).toBe(1);
    expect(nonEmpty.generatedAt).toBe(999);
  });

  test('score/last_seen ties order by id and repeated builds are byte-identical', async () => {
    const db = createSqliteD1();
    // Same score, same lastSeen: only the id tiebreak can stabilize order.
    for (const id of ['zeta', 'alpha', 'midway']) {
      await seedCluster(db, id, 0.5, 1000);
    }
    const first = await queryFeed(db, new Set());
    const second = await queryFeed(db, new Set());
    expect(first.items.map(i => i.id)).toEqual(['alpha', 'midway', 'zeta']);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test('sort=new ties also order by id', async () => {
    const db = createSqliteD1();
    for (const id of ['beta', 'delta', 'kappa']) {
      await seedCluster(db, id, 0.1, 2000);
    }
    const feed = await queryFeed(db, new Set(), { sort: 'new' });
    expect(feed.items.map(i => i.id)).toEqual(['beta', 'delta', 'kappa']);
  });
});
