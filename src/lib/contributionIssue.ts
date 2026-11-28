import { CONTRIBUTION_REPO } from '../../shared/constants';
import { contributionIdMarker, type ContributionPreview } from '../../shared/contribution';
import { SHA256_RE } from '../../shared/taskContract';

export const CONTRIBUTION_STORAGE_KEY = 'radar.contributions.v1';
export const MAX_RECORDED_CONTRIBUTIONS = 50;
/** GitHub rejects very long links. Past this length the dialog offers the issue body to copy instead. */
export const MAX_ISSUE_URL_LENGTH = 8000;
const ISSUE_TEMPLATE = 'task-contribution.md';
const ISSUE_LABELS = 'task-contribution,needs-review';

/**
 * Lowercase SHA-256 hex of the canonical report. The result is empty where the browser withholds
 * SubtleCrypto (a plain HTTP origin), and the issue body then leaves the marker out.
 */
export async function contributionId(canonical: string): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return '';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export interface ContributionIssue {
  /** The prefilled GitHub form, or null when it would be too long. */
  url: string | null;
  title: string;
  body: string;
  tooLong: boolean;
}

/** One Markdown table cell. Reviewed text may hold a pipe, which would open a new cell. */
const cell = (value: string): string => value.replace(/\|/g, '\\|');

/** The form with no fields filled in, for a contributor who pastes the body by hand. */
export const blankIssueUrl = (repo: string = CONTRIBUTION_REPO): string =>
  `https://github.com/${repo}/issues/new?template=${ISSUE_TEMPLATE}`;

/**
 * Builds the prefilled GitHub issue link for one validated report. Every value comes from the
 * preview, which the validator filled from the reviewed ref, or from the canonical JSON.
 */
export function buildIssueUrl(
  preview: ContributionPreview,
  canonical: string,
  id: string,
  repo: string = CONTRIBUTION_REPO,
): ContributionIssue {
  const title = `[contribution] ${preview.task_id} v${preview.revision} (${preview.status})`;
  const checkpoint = preview.checkpoint;
  const body = [
    'Read-only task run offered for maintainer review. A maintainer reviews it by hand.',
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Task | ${cell(preview.title)} |`,
    `| Task ID | ${preview.task_id} |`,
    `| Revision | ${preview.revision} |`,
    `| Status | ${preview.status} |`,
    `| Ref SHA-256 | ${preview.ref_sha256} |`,
    `| Evidence | ${Object.entries(preview.evidence)
      .map(([key, value]) => `${key}: ${value}`)
      .join(', ')} |`,
    `| Attempted steps | ${
      preview.attempted_steps.map(step => `${cell(step.title)} (${step.outcome})`).join('; ') || 'none'
    } |`,
    `| Checkpoint | ${
      checkpoint
        ? `${checkpoint.id} (${checkpoint.type}). ${cell(checkpoint.action)} Resume when: ${cell(checkpoint.resume_when)}`
        : 'none'
    } |`,
    '',
    '```json',
    canonical,
    '```',
    '',
    '## Reviewer checklist',
    '',
    '- [ ] Valid schema v1 & matching revision/ref_sha256',
    '- [ ] No secrets, PII, or unreviewed URLs',
    '- [ ] Official sources verified',
    '- [ ] Fixture report not submitted live claim',
    ...(id ? ['', contributionIdMarker(id)] : []),
  ].join('\n');
  const url = `https://github.com/${repo}/issues/new?${new URLSearchParams({ template: ISSUE_TEMPLATE, labels: ISSUE_LABELS, title, body })}`;
  const tooLong = url.length > MAX_ISSUE_URL_LENGTH;
  return { url: tooLong ? null : url, title, body, tooLong };
}

/** Ids this browser opened an issue for. Advisory only: blocked storage reads as none. */
export function loadRecordedContributionIds(): string[] {
  try {
    const raw = localStorage.getItem(CONTRIBUTION_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string' && SHA256_RE.test(id)) : [];
  } catch {
    return [];
  }
}

export function recordContributionId(id: string): void {
  try {
    const others = loadRecordedContributionIds().filter(stored => stored !== id);
    localStorage.setItem(CONTRIBUTION_STORAGE_KEY, JSON.stringify([...others, id].slice(-MAX_RECORDED_CONTRIBUTIONS)));
  } catch {
    // Blocked storage only costs the duplicate hint.
  }
}
