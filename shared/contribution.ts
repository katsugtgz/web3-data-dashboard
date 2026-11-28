/**
 * Read-only contribution validator. Decides whether a pasted run report may be
 * offered to maintainers, and what may be shown from it. Pure and synchronous so
 * the dialog, the CI issue checker, and their tests share one implementation.
 *
 * Every rejection carries fixed English text. No message repeats any part of the
 * pasted report, and the preview resolves titles and links from the reviewed task
 * ref only, never from the pasted JSON.
 */
import {
  canonicalJson,
  containsUrl,
  parseRunReport,
  parseStrictJson,
  scanSecrets,
  type ErrorCode,
  type OfficialSource,
  type RunEvidence,
  type RunReportV1,
  type RunStatus,
  type StepOutcome,
  type TaskManifestV1,
  type TaskRefV1,
} from './taskContract';

export const MAX_CONTRIBUTION_BYTES = 16384;

export type ContributionErrorCode =
  | 'input_too_large'
  | 'malformed_json'
  | 'duplicate_json_field'
  | 'secret_detected'
  | 'pii_detected'
  | 'url_not_allowed'
  | 'unknown_field'
  | 'invalid_field_value'
  | 'invalid_input_not_contributable'
  | 'error_must_be_null'
  | 'fixture_not_contributable'
  | 'live_proof_not_supported_v1'
  | 'unsupported_task'
  | 'stale_revision'
  | 'unknown_revision'
  | 'ref_sha256_mismatch'
  | 'unknown_step'
  | 'unknown_source'
  | 'step_order_violation'
  | 'checkpoint_mismatch';

/** Fixed text per code. Keep every entry free of values read from the report. */
const MESSAGES = {
  input_too_large: 'The report is larger than 16384 bytes.',
  malformed_json: 'The report is not one valid JSON document.',
  duplicate_json_field: 'The report repeats a JSON field.',
  secret_detected:
    'The report contains text that looks like a secret or a one-time code. Remove it and validate again.',
  pii_detected: 'The report contains text that looks like personal data. Remove it and validate again.',
  url_not_allowed: 'The report contains a link. Contributions may not carry links. Remove it and validate again.',
  unknown_field: 'The report has a field that the run report schema does not allow.',
  invalid_field_value: 'The report has a field value that the run report schema does not allow.',
  invalid_input_not_contributable: 'A report for invalid input cannot be contributed.',
  error_must_be_null:
    'A contribution must describe a run that finished without an error, so the error field must be null.',
  fixture_not_contributable: 'A fixture run is test data and cannot be contributed.',
  live_proof_not_supported_v1: 'Live proof is not accepted yet. Contribute a blocked or needs-user report.',
  unsupported_task: 'The report names a task that this dashboard does not list.',
  stale_revision: 'The report comes from an older task revision. Run the task again with the current files.',
  unknown_revision: 'The report names a task revision that this dashboard does not list.',
  ref_sha256_mismatch:
    'The report comes from task files that differ from the reviewed ones. Run the task again with the current files.',
  unknown_step: 'The report lists a step that the reviewed task does not define.',
  unknown_source: 'The report cites a source that the reviewed task does not list for that step.',
  step_order_violation:
    'The report repeats a step, lists steps out of order, or skips a step that another step depends on.',
  checkpoint_mismatch: 'The report checkpoint differs from the reviewed task checkpoint.',
} as const satisfies Record<ContributionErrorCode, string>;

const REF_SHA_EXEMPT: ReadonlySet<string> = new Set(['$.ref_sha256']);

/** Hidden marker that ties a published issue to its report id, so CI can spot a repeat submission. */
export const contributionIdMarker = (id: string): string => `<!-- contribution-id: ${id} -->`;

/** parseStrictJson and parseRunReport can only fail with codes that ContributionErrorCode also names. */
const contractCode = (code: ErrorCode): ContributionErrorCode => code as ContributionErrorCode;

const reject = (code: ContributionErrorCode): ContributionRejection => ({ ok: false, code, message: MESSAGES[code] });

export interface ContributionRejection {
  ok: false;
  code: ContributionErrorCode;
  message: string;
}

export interface ContributionPreview {
  task_id: string;
  title: string;
  revision: number;
  ref_sha256: string;
  mode: 'live_read_only';
  status: RunStatus;
  evidence: RunEvidence;
  attempted_steps: { id: string; title: string; outcome: StepOutcome; source_ids: string[] }[];
  checkpoint: RunReportV1['checkpoint'];
  sources: OfficialSource[];
}

export type ContributionResult =
  | { ok: true; report: RunReportV1; canonical: string; preview: ContributionPreview }
  | ContributionRejection;

/**
 * Validates one pasted run report against the manifest and the reviewed refs.
 * Order: size, strict JSON, links, secret and PII scrub, contribution rules,
 * schema, manifest pinning, then the ref's steps, sources, and checkpoint.
 */
export function validateContribution(
  text: string,
  manifest: TaskManifestV1,
  refs: ReadonlyMap<string, TaskRefV1>,
): ContributionResult {
  if (new TextEncoder().encode(text).byteLength > MAX_CONTRIBUTION_BYTES) return reject('input_too_large');
  const parsed = parseStrictJson(text, MAX_CONTRIBUTION_BYTES);
  if (!parsed.ok) return reject(contractCode(parsed.error));
  if (containsUrl(parsed.value)) return reject('url_not_allowed');

  // Scrub before any schema work. ref_sha256 is exempt because the manifest pins it.
  // A finding can then only sit in a field the schema, the ref cross-checks, or the checkpoint equality
  // rule refuses, so it outranks every code below. It is dropped only on the one path that accepts the
  // report, where the checkpoint has just been proven equal to the reviewed text.
  const scrub = scanSecrets(parsed.value, REF_SHA_EXEMPT);
  const fail = (code: ContributionErrorCode): ContributionRejection => reject(scrub ?? code);

  const root = (parsed.value ?? {}) as Record<string, unknown>;
  if (root.status === 'invalid_input') return fail('invalid_input_not_contributable');
  if (root.error !== null && root.error !== undefined) return fail('error_must_be_null');

  const parsedReport = parseRunReport(parsed.value);
  if (!parsedReport.ok) return fail(contractCode(parsedReport.error));
  const { report } = parsedReport;
  const { task_id: taskId, revision, ref_sha256: refSha256 } = report;
  // parseRunReport allows null identity only for invalid_input, which the rule above already refused.
  if (taskId === null || revision === null || refSha256 === null) return fail('invalid_field_value');
  if (report.mode !== 'live_read_only') return fail('fixture_not_contributable');
  if (report.status === 'verified_fixture') return fail('fixture_not_contributable');
  if (report.status === 'verified_live') return fail('live_proof_not_supported_v1');

  const entry = manifest.tasks.find(item => item.task_id === taskId);
  if (!entry) return fail('unsupported_task');
  if (revision < entry.revision) return fail('stale_revision');
  if (revision > entry.revision) return fail('unknown_revision');
  if (refSha256 !== entry.ref_sha256) return fail('ref_sha256_mismatch');
  const ref = refs.get(entry.task_id);
  if (!ref) return fail('unsupported_task');
  if (ref.mode !== 'live_read_only') return fail('fixture_not_contributable');

  const refStepById = new Map(ref.steps.map(step => [step.id, step]));
  const previewSteps: ContributionPreview['attempted_steps'] = [];
  const attempted = new Set<string>();
  let lastIndex = -1;
  for (const step of report.attempted_steps) {
    const refStep = refStepById.get(step.id);
    if (!refStep) return fail('unknown_step');
    // ref.steps is already in depends_on order, so a later ref step cannot come first here.
    const index = ref.steps.indexOf(refStep);
    if (index <= lastIndex || !refStep.depends_on.every(id => attempted.has(id))) return fail('step_order_violation');
    // Every ref step source is a ref official source, so this one check covers both rules.
    if (!step.source_ids.every(id => refStep.source_ids.includes(id))) return fail('unknown_source');
    lastIndex = index;
    attempted.add(refStep.id);
    previewSteps.push({ id: step.id, title: refStep.title, outcome: step.outcome, source_ids: [...step.source_ids] });
  }

  const checkpoint = report.checkpoint;
  if (checkpoint) {
    // parseRunReport already ties human_action_required_now to the status. What is left to prove is
    // that the text came from the reviewed ref. That is the only place a scrubber finding can sit in a
    // report that got this far, and the finding is dropped only when this check passes.
    const reviewed = ref.checkpoints.find(item => item.id === checkpoint.id);
    const sameText =
      reviewed !== undefined &&
      reviewed.type === checkpoint.type &&
      reviewed.action === checkpoint.action &&
      reviewed.resume_when === checkpoint.resume_when;
    if (!sameText) return fail('checkpoint_mismatch');
  }

  const cited = new Set(report.attempted_steps.flatMap(step => step.source_ids));
  return {
    ok: true,
    report,
    canonical: canonicalJson(parsed.value),
    preview: {
      task_id: taskId,
      title: ref.title,
      revision,
      ref_sha256: refSha256,
      mode: 'live_read_only',
      status: report.status,
      evidence: report.evidence,
      attempted_steps: previewSteps,
      checkpoint,
      sources: ref.official_sources.filter(source => cited.has(source.id)),
    },
  };
}
