import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { stripOrTranslateCjk, translateRiskItem, translateTagLabel, translateTgeStatus } from '../src/normalize/i18n';
import { fetchSurfAirdrops, normalizeExternalUrl, normalizeSurf } from '../src/sources/surf';
import { FORBIDDEN_CJK_RE } from './helpers';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/surf-airdrops.json', import.meta.url), 'utf8'));

describe('surf normalizer + i18n', () => {
  test('treats fullwidth digits as content: normalized after Han strip', () => {
    // U+FF10–FF19 → ASCII runs after Han stripping, so the digits survive.
    expect(stripOrTranslateCjk('２０２５年')).toBe('2025');
    expect(stripOrTranslateCjk('铭文１２３')).toBe('123');
  });

  test('strips forbidden CJK punctuation globally, not only at edges', () => {
    // Cubic PRRT_kwDOV0YtbM66Wygn: mixed labels must not leak 。 mid-string.
    expect(stripOrTranslateCjk('中foo。bar文')).toBe('foo bar');
    // Fullwidth letter/punctuation range U+FF21–U+FF60 is decoration in this
    // vocabulary (CI forbids FF01–FF9F in output); only digits fold to ASCII.
    expect(stripOrTranslateCjk('铭文ＡＢＣ')).toBe('');
  });

  test('CJK-only task types fall back to other, not empty', () => {
    // Cubic PRRT_kwDOV0YtbM66Wygz: normalizeTaskType must keep filter entries
    // non-empty when stripOrTranslateCjk yields '' for unmapped CJK.
    const feed = normalizeSurf(
      {
        active: [{ project_name: 'Proj', tasks: [{ title: 'T', type: '类型', status: 'OPEN' }], task_summary: { types: ['类型'] } }],
        tge: [],
      },
      1_700_000_000_000,
    );
    expect(feed.cards[0].tasks?.[0].type).toBe('other');
    expect(feed.cards[0].taskTypes).toContain('other');
  });

  test('normalizes full surf fixture with zero CJK output', () => {
    const feed = normalizeSurf(fixture, 1_700_000_000_000);
    expect(feed.cards.length).toBe(fixture.active.length);
    expect(feed.tge.length).toBe(fixture.tge.length);
    expect(feed.counts.active).toBe(fixture.counts.active_total);

    const serialized = JSON.stringify(feed);
    // Full CI gate (scripts/check-no-cjk.sh), not just Han: Kana, Hangul,
    // Bopomofo, CJK punctuation and fullwidth forms must all be rejected.
    expect(FORBIDDEN_CJK_RE.test(serialized)).toBe(false);
    expect(serialized).not.toContain('surf.computer');

    // Stable identity: each card carries its upstream project_id so storage
    // keys stay unique even when CJK stripping collapses distinct names.
    const withId = feed.cards.filter(c => c.id);
    expect(withId.length).toBeGreaterThan(0);
    expect(new Set(withId.map(c => c.id)).size).toBe(withId.length);
    const first = fixture.active[0];
    expect(feed.cards[0].id).toBe(first.project_id);
  });

  test('translates closed risk/tag/TGE vocab and strips unknown CJK', () => {
    expect(translateRiskItem('3 项高成本任务')).toBe('3 high-cost tasks');
    expect(translateRiskItem('1 项高成本任务')).toBe('1 high-cost task');
    expect(translateRiskItem('非币奖励')).toBe('Non-token reward');
    expect(translateRiskItem('融资偏低')).toBe('Low funding');
    expect(translateTagLabel('1 风险')).toBe('1 risk flag');
    expect(translateTagLabel('2 风险')).toBe('2 risk flags');
    expect(translateTgeStatus('可领取 TGE')).toBe('Claimable TGE');
    expect(translateTgeStatus('资格核验')).toBe('Eligibility check');

    const originalWarn = console.warn;
    const warnings: unknown[] = [];
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      // Unmapped pure-CJK yields '' so the CALLER's fallback applies
      // (surf.ts: 'Unknown project'); mixed names keep their Latin remainder.
      expect(stripOrTranslateCjk('未知中文字符串')).toBe('');
      expect(stripOrTranslateCjk('KiteAI 铭文')).toBe('KiteAI');
      expect(warnings.length).toBe(2);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('normalizeExternalUrl and logo sanitization enforce strict http(s) URLs without userinfo or whitespace', () => {
    expect(normalizeExternalUrl('t.me/DoodlesUP_bot')).toBe('https://t.me/DoodlesUP_bot');
    expect(normalizeExternalUrl('https://galxe.com/quest')).toBe('https://galxe.com/quest');
    expect(normalizeExternalUrl('https://example.com /evil')).toBeNull();
    expect(normalizeExternalUrl('t.me/a b')).toBeNull();
    expect(normalizeExternalUrl('https://good.com@evil.com/claim')).toBeNull();
    expect(normalizeExternalUrl('https://user:pass@evil.com/claim')).toBeNull();
    expect(normalizeExternalUrl('good.com@evil.com/claim')).toBeNull();
    expect(normalizeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeExternalUrl('data:text/html,hi')).toBeNull();
    expect(normalizeExternalUrl('ftp://files.example.com/a')).toBeNull();

    const feed = normalizeSurf(
      {
        active: [
          { project_name: 'GoodLogo', logo_url: 'https://cdn.example.com/logo.png' },
          { project_name: 'HttpLogo', logo_url: 'http://cdn.example.com/logo.png' },
          { project_name: 'SurfHost', logo_url: 'https://cdn.surf.computer/logo.png' },
          { project_name: 'SurfRoot', logo_url: 'https://surf.computer/logo.png' },
          { project_name: 'JsLogo', logo_url: 'javascript:alert(1)' },
          { project_name: 'UserinfoLogo', logo_url: 'https://good.com@evil.com/a.png' },
          { project_name: 'SpaceLogo', logo_url: 'https://cdn.example.com/a b.png' },
        ],
        tge: [
          { project_name: 'BadTgeLogo', logo_url: 'data:image/svg+xml,<svg/>', reward_date: 1e16 },
          { project_name: 'ValidTge', logo_url: 'https://cdn.example.com/tge.png', reward_date: 1763683200 },
        ],
      },
      1_700_000_000_000,
    );

    expect(feed.cards.map(c => c.img)).toEqual([
      'https://cdn.example.com/logo.png',
      '',
      '',
      '',
      '',
      '',
      '',
    ]);
    expect(feed.tge[0].logo).toBeNull();
    expect(feed.tge[0].d).toBe('TBA');
    expect(feed.tge[1].logo).toBe('https://cdn.example.com/tge.png');
    expect(feed.tge[1].d).toBe('2025-11-21');
  });

  test('mapTasks deduplicates verbatim tasks case-insensitively while preserving order', () => {
    const feed = normalizeSurf(
      {
        active: [
          {
            project_name: 'DedupProj',
            tasks: [
              { title: 'Bridge ETH', type: 'bridge', external_link: 'https://app.example.com/bridge' },
              { title: 'bridge eth', type: 'BRIDGE', external_link: 'https://app.example.com/bridge' },
              { title: 'Swap USDC', type: 'swap', external_link: 'https://app.example.com/swap' },
              { title: 'Bridge ETH', type: 'bridge', external_link: 'https://app.example.com/bridge-v2' },
              { title: 'No Link Task', type: 'quest', external_link: null },
              { title: 'no link task', type: 'quest', external_link: '' },
            ],
          },
        ],
        tge: [],
      },
      1_700_000_000_000,
    );

    expect(feed.cards[0].tasks?.map(t => ({ title: t.title, type: t.type, url: t.url }))).toEqual([
      { title: 'Bridge ETH', type: 'bridge', url: 'https://app.example.com/bridge' },
      { title: 'Swap USDC', type: 'swap', url: 'https://app.example.com/swap' },
      { title: 'Bridge ETH', type: 'bridge', url: 'https://app.example.com/bridge-v2' },
      { title: 'No Link Task', type: 'quest', url: null },
    ]);
  });

  test('mapTasks preserves tasks with same title/type/url when status, cost, timeMinutes, or isExclusive differs', () => {
    const feed = normalizeSurf(
      {
        active: [
          {
            project_name: 'MultiStateProj',
            tasks: [
              { title: 'Bridge ETH', type: 'bridge', status: 'CLOSED', cost: 0, time_minutes: 5, is_exclusive: false, external_link: 'https://app.example.com/bridge' },
              { title: 'Bridge ETH', type: 'bridge', status: 'OPEN', cost: 0, time_minutes: 5, is_exclusive: false, external_link: 'https://app.example.com/bridge' },
              { title: 'bridge eth', type: 'BRIDGE', status: 'open', cost: 0, time_minutes: 5, is_exclusive: false, external_link: 'https://app.example.com/bridge' },
              { title: 'Bridge ETH', type: 'bridge', status: 'OPEN', cost: 25, time_minutes: 5, is_exclusive: false, external_link: 'https://app.example.com/bridge' },
              { title: 'Bridge ETH', type: 'bridge', status: 'OPEN', cost: 0, time_minutes: 15, is_exclusive: false, external_link: 'https://app.example.com/bridge' },
              { title: 'Bridge ETH', type: 'bridge', status: 'OPEN', cost: 0, time_minutes: 5, is_exclusive: true, external_link: 'https://app.example.com/bridge' },
            ],
          },
        ],
        tge: [],
      },
      1_700_000_000_000,
    );

    expect(feed.cards[0].tasks).toEqual([
      { title: 'Bridge ETH', type: 'bridge', status: 'CLOSED', cost: 0, timeMinutes: 5, url: 'https://app.example.com/bridge', isExclusive: false },
      { title: 'Bridge ETH', type: 'bridge', status: 'OPEN', cost: 0, timeMinutes: 5, url: 'https://app.example.com/bridge', isExclusive: false },
      { title: 'Bridge ETH', type: 'bridge', status: 'OPEN', cost: 25, timeMinutes: 5, url: 'https://app.example.com/bridge', isExclusive: false },
      { title: 'Bridge ETH', type: 'bridge', status: 'OPEN', cost: 0, timeMinutes: 15, url: 'https://app.example.com/bridge', isExclusive: false },
      { title: 'Bridge ETH', type: 'bridge', status: 'OPEN', cost: 0, timeMinutes: 5, url: 'https://app.example.com/bridge', isExclusive: true },
    ]);
  });

  test('fetchSurfAirdrops cancels non-ok response bodies and retries once on 5xx or abort/network failure', async () => {
    const prevFetch = globalThis.fetch;
    const validPayload = JSON.stringify({ active: [{ project_name: 'Alpha' }], tge: [] });
    const makeTrackedResponse = (status: number, body: string) => {
      let cancelled = false;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
        cancel() {
          cancelled = true;
        },
      });
      return {
        res: new Response(stream, { status }),
        wasCancelled: () => cancelled,
      };
    };

    try {
      // 1. 5xx retries once, cancelling the failed response body, and succeeds on 2nd try.
      const first502 = makeTrackedResponse(502, 'bad gateway');
      let calls5xx = 0;
      globalThis.fetch = (async () => {
        calls5xx++;
        if (calls5xx === 1) return first502.res;
        return new Response(validPayload, { status: 200 });
      }) as unknown as typeof fetch;

      const recovered5xx = await fetchSurfAirdrops('https://surf.test/api', 1_700_000_000_000);
      expect(calls5xx).toBe(2);
      expect(first502.wasCancelled()).toBe(true);
      expect(recovered5xx.cards[0].n).toBe('Alpha');

      // 2. Network/abort error retries once and succeeds on 2nd try.
      let callsAbort = 0;
      globalThis.fetch = (async () => {
        callsAbort++;
        if (callsAbort === 1) throw new DOMException('timed out', 'TimeoutError');
        return new Response(validPayload, { status: 200 });
      }) as unknown as typeof fetch;

      const recoveredAbort = await fetchSurfAirdrops('https://surf.test/api', 1_700_000_000_000);
      expect(callsAbort).toBe(2);
      expect(recoveredAbort.cards[0].n).toBe('Alpha');

      // 3. 4xx does NOT retry and cancels body before throwing.
      const err403 = makeTrackedResponse(403, 'forbidden');
      let calls4xx = 0;
      globalThis.fetch = (async () => {
        calls4xx++;
        return err403.res;
      }) as unknown as typeof fetch;

      await expect(fetchSurfAirdrops('https://surf.test/api', 1_700_000_000_000)).rejects.toThrow('Surf HTTP 403');
      expect(calls4xx).toBe(1);
      expect(err403.wasCancelled()).toBe(true);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  test('fetchSurfAirdrops bounds Surf to one 4000ms deadline shared by both attempts (overridable via timeoutMs)', async () => {
    const prevFetch = globalThis.fetch;
    const prevTimeout = AbortSignal.timeout;
    const budgets: number[] = [];
    const createdSignals: AbortSignal[] = [];
    const usedSignals: (AbortSignal | undefined | null)[] = [];
    AbortSignal.timeout = ((ms: number) => {
      budgets.push(ms);
      const signal = prevTimeout(ms);
      createdSignals.push(signal);
      return signal;
    }) as typeof AbortSignal.timeout;

    try {
      const validPayload = JSON.stringify({ active: [{ project_name: 'Alpha' }], tge: [] });
      let calls = 0;
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls++;
        usedSignals.push(init?.signal);
        return calls === 1 ? new Response('bad gateway', { status: 502 }) : new Response(validPayload, { status: 200 });
      }) as unknown as typeof fetch;

      const feed = await fetchSurfAirdrops('https://surf.test/api', 1_700_000_000_000);
      expect(feed.cards[0].n).toBe('Alpha');
      expect(calls).toBe(2);
      // Default is 4000ms and a 5xx retry reuses the same deadline instead of starting a second 15s window.
      expect(budgets).toEqual([4000]);
      expect(usedSignals).toEqual([createdSignals[0], createdSignals[0]]);

      budgets.length = 0;
      calls = 0;
      await fetchSurfAirdrops('https://surf.test/api', 1_700_000_000_000, 250);
      expect(budgets).toEqual([250]);
    } finally {
      AbortSignal.timeout = prevTimeout;
      globalThis.fetch = prevFetch;
    }
  });

  test('a hanging Surf upstream costs at most timeoutMs in total, not timeoutMs per attempt', async () => {
    const prevFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      attempts++;
      return new Promise<Response>((_resolve, reject) => {
        // Real fetch rejects immediately when handed an already-aborted signal.
        if (init?.signal?.aborted) {
          reject(init.signal.reason);
          return;
        }
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }) as unknown as typeof fetch;

    try {
      const started = Date.now();
      await expect(fetchSurfAirdrops('https://surf.test/api', 1_700_000_000_000, 40)).rejects.toThrow();
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(30);
      expect(elapsed).toBeLessThan(1_000);
      // The retry still runs, but against the same expired deadline.
      expect(attempts).toBe(2);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });
});
