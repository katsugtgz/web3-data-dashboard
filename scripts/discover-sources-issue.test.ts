import { describe, expect, test } from 'bun:test';
import {
  inferCandidateLang,
  parseCliArgs,
  renderCandidatesIssueBody,
  upsertGithubIssue,
} from './discover-sources-issue.mts';

describe('discover-sources-issue CLI parsing', () => {
  test('parses --dry-run and --input value in any order', () => {
    expect(parseCliArgs(['--dry-run', '--input', 'candidates.json'])).toEqual({
      dryRun: true,
      inputPath: 'candidates.json',
    });
    expect(parseCliArgs(['--input=candidates.json'])).toEqual({
      dryRun: false,
      inputPath: 'candidates.json',
    });
  });

  test('rejects missing --input path instead of treating --dry-run as a filename', () => {
    expect(() => parseCliArgs(['--input', '--dry-run'])).toThrow(/--input/);
    expect(() => parseCliArgs(['--input'])).toThrow(/--input/);
    expect(() => parseCliArgs(['--input='])).toThrow(/--input/);
  });
});

describe('discover-sources-issue Markdown rendering & safety', () => {
  test('wraps handles in backticks to avoid GitHub @mentions while retaining @handle', () => {
    const md = renderCandidatesIssueBody([
      {
        handle: 'cand_two',
        mentions: 3,
        firstSeen: 1_795_240_000_000,
        lastSeen: 1_795_240_000_000,
        fromSources: ['telegram:airdropfind', 'telegram:airdropalphs'],
      },
    ]);
    expect(md).toContain('| `@cand_two` |');
    expect(md).toContain('@cand_two');
  });

  test('escapes Markdown table and fenced code-block breakout sequences cleanly', () => {
    const maliciousHandle = 'bad|col\n```md\n# injected\n```';
    const md = renderCandidatesIssueBody([
      {
        handle: maliciousHandle,
        mentions: 2,
        firstSeen: 1_795_240_000_000,
        lastSeen: 1_795_240_000_000,
        fromSources: ['telegram:ch1|pipe\r\nbreak', 'telegram:ch2`tick'],
      },
    ]);

    const tableLines = md.split('\n').filter(l => l.startsWith('|'));
    // Header + separator + exactly 1 data row (no newline breakout into extra rows)
    expect(tableLines.length).toBe(3);
    // Data row must not contain unescaped pipes inside cells (exactly 5 unescaped pipes)
    const unescapedPipes = tableLines[2].replace(/\\\|/g, '').match(/\|/g) ?? [];
    expect(unescapedPipes.length).toBe(5);

    // Fenced JSON block must remain intact and valid JSON (no triple-backtick breakout)
    const fences = md.match(/^```/gm) ?? [];
    expect(fences.length).toBe(2);
    const jsonMatch = md.match(/```json\n([\s\S]*?)\n```/);
    expect(jsonMatch).not.toBeNull();
    const parsed = JSON.parse(jsonMatch![1]) as { handle: string }[];
    expect(parsed[0].handle).toBe(maliciousHandle);
  });

  test('infers lang from worker/sources.json when all fromSources share a language', () => {
    expect(inferCandidateLang(['telegram:HappyCuanAirdrop', 'telegram:AirdropJacks'])).toBe('id');
    expect(inferCandidateLang(['telegram:CG_yangmaoqianxian', 'telegram:pk_oa'])).toBe('zh');
    expect(inferCandidateLang(['telegram:HappyCuanAirdrop', 'telegram:airdropfind'])).toBe('en');
    expect(inferCandidateLang(['telegram:unknown_src_a', 'telegram:unknown_src_b'])).toBe('en');

    const md = renderCandidatesIssueBody([
      {
        handle: 'indo_alpha',
        mentions: 4,
        firstSeen: 1_795_240_000_000,
        lastSeen: 1_795_240_000_000,
        fromSources: ['telegram:HappyCuanAirdrop', 'telegram:AirdropJacks'],
      },
    ]);
    expect(md).toContain('"lang": "id"');
  });

  test('guards invalid or non-finite lastSeen timestamps against RangeError', () => {
    const md = renderCandidatesIssueBody([
      {
        handle: 'nan_ts',
        mentions: 2,
        firstSeen: 0,
        lastSeen: Number.NaN,
        fromSources: ['telegram:ch1', 'telegram:ch2'],
      },
      {
        handle: 'overflow_ts',
        mentions: 2,
        firstSeen: 0,
        lastSeen: 9e20,
        fromSources: ['telegram:ch1', 'telegram:ch2'],
      },
    ]);
    expect(md).toContain('| `@nan_ts` | 2 | 2 (telegram:ch1, telegram:ch2) | unknown |');
    expect(md).toContain('| `@overflow_ts` | 2 | 2 (telegram:ch1, telegram:ch2) | unknown |');
  });
});

describe('upsertGithubIssue', () => {
  test('ignores pull_request items, paginates beyond 10 pages, and sends required headers + timeout signal', async () => {
    const calls: { url: string; method: string; headers: Record<string, string>; hasSignal: boolean }[] = [];

    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, method, headers, hasSignal: Boolean(init?.signal) });

      if (method === 'GET') {
        const page = Number(new URL(url).searchParams.get('page') ?? '1');
        if (page === 1) {
          // Page 1 has a PR with the same title (must be skipped!) plus 99 filler issues
          const items = [
            { number: 999, title: 'Source candidates', pull_request: { url: 'https://api.github.com/pulls/999' } },
            ...Array.from({ length: 99 }, (_, i) => ({ number: i + 1, title: `Other ${page}-${i}` })),
          ];
          return new Response(JSON.stringify(items), {
            status: 200,
            headers: { Link: `<https://api.github.com/repos/o/r/issues?state=open&labels=source-discovery&per_page=100&page=2>; rel="next"` },
          });
        }
        if (page <= 11) {
          const items = Array.from({ length: 100 }, (_, i) => ({ number: page * 100 + i, title: `Other ${page}-${i}` }));
          return new Response(JSON.stringify(items), {
            status: 200,
            headers: {
              Link: `<https://api.github.com/repos/o/r/issues?state=open&labels=source-discovery&per_page=100&page=${page + 1}>; rel="next"`,
            },
          });
        }
        // Page 12 has the real open issue!
        return new Response(JSON.stringify([{ number: 1201, title: 'Source candidates' }]), {
          status: 200,
        });
      }

      // PATCH update
      return new Response(JSON.stringify({ number: 1201 }), { status: 200 });
    }) as typeof fetch;

    const result = await upsertGithubIssue('Source candidates', 'issue body', {
      repo: 'owner/repo',
      token: 'ghp_test',
      fetchImpl,
    });

    expect(result).toEqual({ action: 'updated', number: 1201 });
    const patchCall = calls.find(c => c.method === 'PATCH');
    expect(patchCall?.url).toBe('https://api.github.com/repos/owner/repo/issues/1201');
    for (const c of calls) {
      expect(c.headers['User-Agent']).toBeTruthy();
      expect(c.headers.Accept).toBe('application/vnd.github+json');
      expect(c.hasSignal).toBe(true);
    }
    expect(calls.filter(c => c.method === 'GET').length).toBe(12);
  });

  test('throws without creating a duplicate when maxPages is reached with nextUrl still set, and creates when pagination is exhausted', async () => {
    // 1. Reaches maxPages while Link rel="next" remains -> must throw before POST.
    const cappedCalls: string[] = [];
    const cappedFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      cappedCalls.push(method);
      const items = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, title: `Other ${i}` }));
      return new Response(JSON.stringify(items), {
        status: 200,
        headers: {
          Link: '<https://api.github.com/repos/owner/repo/issues?state=open&labels=source-discovery&per_page=100&page=2>; rel="next"',
        },
      });
    }) as typeof fetch;

    await expect(
      upsertGithubIssue('Source candidates', 'body', {
        repo: 'owner/repo',
        token: 'ghp_test',
        fetchImpl: cappedFetch,
        maxPages: 1,
      }),
    ).rejects.toThrow(/maxPages|pagination/i);
    expect(cappedCalls).toEqual(['GET']);

    // 2. Reaches maxPages with 100 items and no Link header (still leaves nextUrl set) -> must throw before POST.
    const fullPageCalls: string[] = [];
    const fullPageFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      fullPageCalls.push(init?.method ?? 'GET');
      const items = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, title: `Other ${i}` }));
      return new Response(JSON.stringify(items), { status: 200 });
    }) as typeof fetch;

    await expect(
      upsertGithubIssue('Source candidates', 'body', {
        repo: 'owner/repo',
        token: 'ghp_test',
        fetchImpl: fullPageFetch,
        maxPages: 1,
      }),
    ).rejects.toThrow(/maxPages|pagination/i);
    expect(fullPageCalls).toEqual(['GET']);

    // 3. Exhausts pagination (< 100 items, no Link rel="next") -> creates issue via POST.
    const createCalls: string[] = [];
    const exhaustedFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      createCalls.push(method);
      if (method === 'GET') {
        return new Response(JSON.stringify([{ number: 1, title: 'Other issue' }]), { status: 200 });
      }
      return new Response(JSON.stringify({ number: 2 }), { status: 201 });
    }) as typeof fetch;

    const created = await upsertGithubIssue('Source candidates', 'body', {
      repo: 'owner/repo',
      token: 'ghp_test',
      fetchImpl: exhaustedFetch,
      maxPages: 1,
    });
    expect(created).toEqual({ action: 'created' });
    expect(createCalls).toEqual(['GET', 'POST']);
  });
});
