import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { CONTRIBUTION_REPO } from '../../shared/constants';
import { MAX_CONTRIBUTION_BYTES, validateContribution, type ContributionPreview } from '../../shared/contribution';
import { parseManifest, parseStrictJson, parseTaskRef, type TaskManifestV1, type TaskRefV1 } from '../../shared/taskContract';
import { MAX_ISSUE_URL_LENGTH, buildIssueUrl, contributionId } from '../lib/contributionIssue';
import { ContributionDialog, ContributionOutcome } from './ContributionDialog';

type Mutable = Record<string, any>;

const ROOT = join(import.meta.dir, '../..');
const GOLDEN_PATH = 'skills/web3-radar-task/tests/golden/flop-testnet-voucher.v1.blocked_not_active.json';
const GOLDEN = readFileSync(join(ROOT, GOLDEN_PATH), 'utf8');
const noop = () => {};
const render = (node: React.ReactElement) => renderToStaticMarkup(node);

// Sample payloads are joined from fragments so no secret scanner reads them as live secrets.
const SECRET = ['Bea', 'rer abcdefghijklmnop'].join('');
const SECRET_TAIL = ['abcdef', 'ghijklmnop'].join('');
const EMAIL = ['someone', '@', 'example', '.', 'org'].join('');
const EMAIL_TAIL = ['example', '.', 'org'].join('');

function parseFile(path: string): unknown {
  const json = parseStrictJson(readFileSync(join(ROOT, path), 'utf8'), 1 << 20);
  if (!json.ok) throw new Error(`${path}: ${json.error}`);
  return json.value;
}

const parsedManifest = parseManifest(parseFile('data/tasks/manifest.json'));
if (!parsedManifest.ok) throw new Error('manifest must parse');
const manifest: TaskManifestV1 = parsedManifest.manifest;
const refs = new Map<string, TaskRefV1>();
for (const entry of manifest.tasks) {
  const parsedRef = parseTaskRef(parseFile(`data/tasks/${entry.ref_path}`));
  if (!parsedRef.ok) throw new Error(`${entry.ref_path} must parse`);
  refs.set(entry.task_id, parsedRef.ref);
}
const FLOP_REF = refs.get('flop-testnet-voucher')!;

const accepted = validateContribution(GOLDEN, manifest, refs);
if (!accepted.ok) throw new Error(`golden report must validate: ${accepted.code}`);

/** A JSON round trip hands `change` a plain copy of the golden report. */
const reportText = (change: (report: Mutable) => void): string => {
  const report = JSON.parse(GOLDEN) as Mutable;
  change(report);
  return JSON.stringify(report);
};

const outcome = (extra: Partial<React.ComponentProps<typeof ContributionOutcome>> = {}): string =>
  render(
    <ContributionOutcome
      result={null}
      issue={null}
      duplicate={false}
      onCopyBody={noop}
      onOpenIssue={noop}
      {...extra}
    />,
  );
const anchorTags = (html: string): string[] => html.match(/<a [^>]*>/g) ?? [];

describe('ContributionDialog', () => {
  test('renders a bounded paste box and a Validate button, with nothing to submit', () => {
    const html = render(<ContributionDialog open manifest={manifest} refs={refs} onClose={noop} />);

    expect(html).toContain('id="contribution-dialog"');
    expect(html).toContain('aria-labelledby="contribution-title"');
    expect(html).toContain('Validate contribution');
    expect(html).toContain(`maxLength="${MAX_CONTRIBUTION_BYTES}"`);
    expect(html).toContain('aria-describedby="contribution-size"');
    expect(html).toContain('Validate</span></button>');
    expect(html).toContain(` / ${MAX_CONTRIBUTION_BYTES} bytes`);
    // Nothing is validated yet, so the dialog holds no link at all.
    expect(anchorTags(html)).toEqual([]);
    expect(html).not.toContain('<form');
    expect(render(<ContributionDialog open={false} manifest={manifest} refs={refs} onClose={noop} />)).not.toContain('<textarea');
  });

  test('shows ref-resolved official sources and a prefilled GitHub issue link for the golden report', async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      throw new Error('the contribution dialog must not touch the network');
    }) as unknown as typeof fetch;
    try {
      const id = await contributionId(accepted.canonical);
      const issue = { ...buildIssueUrl(accepted.preview, accepted.canonical, id), id };
      const html = outcome({ result: accepted, issue });

      expect(issue.tooLong).toBe(false);
      expect(issue.url!.length).toBeLessThanOrEqual(MAX_ISSUE_URL_LENGTH);

      // Every link opens in a new tab without leaking the opener or the referrer.
      const anchors = anchorTags(html);
      expect(anchors).toHaveLength(FLOP_REF.official_sources.length + 1);
      for (const anchor of anchors) {
        expect(anchor).toContain('target="_blank"');
        expect(anchor).toContain('rel="noopener noreferrer"');
      }
      for (const source of FLOP_REF.official_sources) expect(html).toContain(`href="${source.url}"`);
      expect(html).toContain(`href="https://github.com/${CONTRIBUTION_REPO}/issues/new?template=task-contribution.md`);
      expect(html).toContain('labels=task-contribution%2Cneeds-review');
      expect(html).toContain('Open GitHub issue');

      expect(html).toContain(FLOP_REF.title);
      expect(html).toContain(FLOP_REF.steps[0].title);
      expect(html).toContain(FLOP_REF.steps[1].title);
      expect(html).toContain('blocked_not_active');
      expect(html).toContain(accepted.preview.ref_sha256);
      expect(html).toContain(FLOP_REF.checkpoints[0].action);
      expect(html).not.toContain('already recorded an issue');
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('shows a fixed reason for a rejected report and repeats none of the report', () => {
    const cases: [text: string, reason: string][] = [
      [reportText(report => { report.mode = 'synthetic_fixture'; }), 'A fixture run is test data and cannot be contributed.'],
      [reportText(report => { report.checkpoint.action = SECRET; }), 'looks like a secret or a one-time code'],
      [reportText(report => { report.checkpoint.action = EMAIL; }), 'looks like personal data'],
    ];
    for (const [text, reason] of cases) {
      const result = validateContribution(text, manifest, refs);
      const html = outcome({ result, issue: null });
      expect(html).toContain('role="alert"');
      expect(html).toContain(reason);
      for (const marker of [SECRET, SECRET_TAIL, EMAIL, EMAIL_TAIL]) expect(html).not.toContain(marker);
      // A rejected report gets no summary and no way to open an issue.
      expect(anchorTags(html)).toEqual([]);
      expect(html).not.toContain('Open GitHub issue');
      expect(html).not.toContain('Valid report');
      expect(html).not.toContain(FLOP_REF.steps[0].title);
    }
  });

  test('adds an advisory local duplicate notice only for a report this browser recorded', async () => {
    const id = await contributionId(accepted.canonical);
    const issue = { ...buildIssueUrl(accepted.preview, accepted.canonical, id), id };
    const notice = 'This browser already recorded an issue for this exact report.';

    expect(outcome({ result: accepted, issue, duplicate: false })).not.toContain(notice);
    const html = outcome({ result: accepted, issue, duplicate: true });
    expect(html).toContain(notice);
    // The notice is advisory: the issue link stays available.
    expect(html).toContain('Open GitHub issue');
  });

  test('offers the issue body to copy when the link would be too long', async () => {
    const id = await contributionId(accepted.canonical);
    const wide: ContributionPreview = {
      ...accepted.preview,
      attempted_steps: Array.from({ length: 200 }, (_, index) => ({
        id: `step_${index}`,
        title: `Step ${index} ` + 'x'.repeat(300),
        outcome: 'pass' as const,
        source_ids: [] as string[],
      })),
    };
    const issue = { ...buildIssueUrl(wide, accepted.canonical, id), id };
    const html = outcome({ result: { ...accepted, preview: wide }, issue });

    expect(issue.tooLong).toBe(true);
    expect(html).toContain('Copy issue body');
    expect(html).toContain(`href="https://github.com/${CONTRIBUTION_REPO}/issues/new?template=task-contribution.md"`);
    expect(html).not.toContain('Open GitHub issue');
    expect(html).not.toContain('labels=task-contribution');
  });

  test('keeps the dialog free of network and form submission code', () => {
    const sources = ['ContributionDialog.tsx', '../lib/contributionIssue.ts'].map(file =>
      readFileSync(join(import.meta.dir, file), 'utf8'),
    );
    for (const source of sources) {
      expect(source).not.toContain('fetch(');
      expect(source).not.toContain('XMLHttpRequest');
      expect(source).not.toContain('sendBeacon');
      expect(source).not.toContain('<form');
    }
  });
});
