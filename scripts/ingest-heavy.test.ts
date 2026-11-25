import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createTestD1 } from '../worker/test/helpers';
import { runHeavyIngest } from './ingest-heavy.mts';

const SAMPLE_PROTOCOLS = [
  {
    name: 'Aave',
    symbol: 'AAVE',
    category: 'Lending',
    tvl: 12_000_000_000,
    change_1d: 2.5,
    change_7d: 5.1,
    chains: ['Ethereum', 'Arbitrum'],
    url: 'https://aave.com',
  },
];

const SAMPLE_YIELDS = {
  data: [
    {
      project: 'aave-v3',
      symbol: 'USDC',
      chain: 'Ethereum',
      tvlUsd: 500_000_000,
      apy: 5.4,
      apyBase: 5.4,
      apyReward: 0,
      stablecoin: true,
    },
  ],
};

describe('ingest-heavy independent settlement & D1 error telemetry', () => {
  test('writes both sections cleanly without BEGIN/COMMIT and cleans up mkdtemp dir', async () => {
    let executedSql = '';
    let capturedDir = '';
    const res = await runHeavyIngest({
      nowMs: 1_800_000_000_000,
      dryRun: false,
      fetchJson: async url => (url.includes('protocols') ? SAMPLE_PROTOCOLS : SAMPLE_YIELDS),
      executeSqlFile: async sqlPath => {
        capturedDir = dirname(sqlPath);
        executedSql = await readFile(sqlPath, 'utf8');
        expect(existsSync(sqlPath)).toBe(true);
      },
      log: () => {},
    });

    expect(res.okKeys).toEqual(['markets:defi', 'markets:yields']);
    expect(res.failedKeys).toEqual([]);
    expect(executedSql).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/i);
    expect(capturedDir).toContain('web3-radar-heavy-');
    expect(existsSync(capturedDir)).toBe(false);

    const { sqlite } = createTestD1();
    sqlite.exec(executedSql);
    const rows = sqlite.query('SELECT key, ok, error, fetched_at FROM snapshots ORDER BY key').all() as {
      key: string;
      ok: number;
      error: string | null;
      fetched_at: number;
    }[];
    expect(rows).toEqual([
      { key: 'markets:defi', ok: 1, error: null, fetched_at: 1_800_000_000_000 },
      { key: 'markets:yields', ok: 1, error: null, fetched_at: 1_800_000_000_000 },
    ]);
  });

  test('when one upstream fails, still writes the healthy section + preserves last-good body/etag/fetched_at on the failed key, then throws', async () => {
    const { sqlite } = createTestD1();
    sqlite.exec(
      `INSERT INTO snapshots (key, body, etag, fetched_at, ok, error)
       VALUES ('markets:yields', '{"id":"yields","rows":[{"id":"old"}]}', '"old-etag"', 1700000000000, 1, NULL);`,
    );

    let executedSql = '';
    await expect(
      runHeavyIngest({
        nowMs: 1_800_000_000_000,
        dryRun: false,
        fetchJson: async url => {
          if (url.includes('protocols')) return SAMPLE_PROTOCOLS;
          throw new Error("Upstream '502' gateway error");
        },
        executeSqlFile: async sqlPath => {
          executedSql = await readFile(sqlPath, 'utf8');
        },
        log: () => {},
      }),
    ).rejects.toThrow(/markets:yields/);

    expect(executedSql).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/i);
    sqlite.exec(executedSql);

    const defiRow = sqlite
      .query("SELECT key, ok, error, fetched_at FROM snapshots WHERE key = 'markets:defi'")
      .get() as { key: string; ok: number; error: string | null; fetched_at: number };
    expect(defiRow).toEqual({
      key: 'markets:defi',
      ok: 1,
      error: null,
      fetched_at: 1_800_000_000_000,
    });

    const yieldsRow = sqlite
      .query("SELECT key, body, etag, fetched_at, ok, error FROM snapshots WHERE key = 'markets:yields'")
      .get() as { key: string; body: string; etag: string; fetched_at: number; ok: number; error: string | null };
    expect(yieldsRow.body).toBe('{"id":"yields","rows":[{"id":"old"}]}');
    expect(yieldsRow.etag).toBe('"old-etag"');
    expect(yieldsRow.fetched_at).toBe(1_700_000_000_000);
    expect(yieldsRow.ok).toBe(0);
    expect(yieldsRow.error).toContain("Upstream '502' gateway error");
  });

  test('when a section returns 0 rows, emits error telemetry instead of overwriting with empty rows', async () => {
    const { sqlite } = createTestD1();
    let executedSql = '';

    await expect(
      runHeavyIngest({
        nowMs: 1_800_000_000_000,
        dryRun: false,
        fetchJson: async url => (url.includes('protocols') ? [] : SAMPLE_YIELDS),
        executeSqlFile: async sqlPath => {
          executedSql = await readFile(sqlPath, 'utf8');
        },
        log: () => {},
      }),
    ).rejects.toThrow(/markets:defi/);

    sqlite.exec(executedSql);
    const defiRow = sqlite
      .query("SELECT body, etag, fetched_at, ok, error FROM snapshots WHERE key = 'markets:defi'")
      .get() as { body: string; etag: string; fetched_at: number; ok: number; error: string | null };
    expect(defiRow.body).toBe('{}');
    expect(defiRow.etag).toBe('"empty"');
    expect(defiRow.fetched_at).toBe(0);
    expect(defiRow.ok).toBe(0);
    expect(defiRow.error).toMatch(/0 rows|empty/i);
  });

  test('dry-run prints plan without executing D1 write and still fails when both sections fail', async () => {
    let executed = false;
    const logs: string[] = [];

    await expect(
      runHeavyIngest({
        nowMs: 1_800_000_000_000,
        dryRun: true,
        fetchJson: async () => {
          throw new Error('network down');
        },
        executeSqlFile: async () => {
          executed = true;
        },
        log: msg => logs.push(msg),
      }),
    ).rejects.toThrow(/markets:defi.*markets:yields/);

    expect(executed).toBe(false);
    expect(logs.some(l => /dry-run/i.test(l))).toBe(true);
  });

  test('cleans up temporary directory even when executeSqlFile throws', async () => {
    let capturedDir = '';
    await expect(
      runHeavyIngest({
        nowMs: 1_800_000_000_000,
        dryRun: false,
        fetchJson: async url => (url.includes('protocols') ? SAMPLE_PROTOCOLS : SAMPLE_YIELDS),
        executeSqlFile: async sqlPath => {
          capturedDir = dirname(sqlPath);
          throw new Error('wrangler failed');
        },
        log: () => {},
      }),
    ).rejects.toThrow('wrangler failed');

    expect(capturedDir).toContain('web3-radar-heavy-');
    expect(existsSync(capturedDir)).toBe(false);
  });
});
