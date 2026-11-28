import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_CONTRIBUTION_BYTES, validateContribution, type ContributionErrorCode } from './contribution';
import {
  canonicalJson,
  parseManifest,
  parseStrictJson,
  parseTaskRef,
  type TaskManifestV1,
  type TaskRefV1,
} from './taskContract';

type Mutable = Record<string, any>;
interface Tasks {
  manifest: TaskManifestV1;
  refs: ReadonlyMap<string, TaskRefV1>;
}

const ROOT = join(import.meta.dir, '..');
const GOLDEN_PATH = 'skills/web3-radar-task/tests/golden/flop-testnet-voucher.v1.blocked_not_active.json';
const GOLDEN = readFileSync(join(ROOT, GOLDEN_PATH), 'utf8');
const FLOP = 'flop-testnet-voucher';
const MAX_FILE_BYTES = 1 << 20;

const ALL_CODES: ContributionErrorCode[] = [
  'input_too_large',
  'malformed_json',
  'duplicate_json_field',
  'secret_detected',
  'pii_detected',
  'url_not_allowed',
  'unknown_field',
  'invalid_field_value',
  'invalid_input_not_contributable',
  'error_must_be_null',
  'fixture_not_contributable',
  'live_proof_not_supported_v1',
  'unsupported_task',
  'stale_revision',
  'unknown_revision',
  'ref_sha256_mismatch',
  'unknown_step',
  'unknown_source',
  'step_order_violation',
  'checkpoint_mismatch',
];

// Sample payloads are joined from fragments so no secret scanner reads them as live secrets.
const SECRET = ['Bea', 'rer abcdefghijklmnop'].join('');
const SECRET_TAIL = ['abcdef', 'ghijklmnop'].join('');
const EMAIL = ['someone', '@', 'example', '.', 'org'].join('');
const EMAIL_TAIL = ['example', '.', 'org'].join('');
const LINK = ['ht', 'tps://app.demo.test/claim'].join('');
const OTP = ['12', '3456'].join('');

function parseFile(path: string): unknown {
  const json = parseStrictJson(readFileSync(join(ROOT, path), 'utf8'), MAX_FILE_BYTES);
  if (!json.ok) throw new Error(`${path}: ${json.error}`);
  return json.value;
}

function loadTasks(): Tasks {
  const parsedManifest = parseManifest(parseFile('data/tasks/manifest.json'));
  if (!parsedManifest.ok) throw new Error(`data/tasks/manifest.json: ${parsedManifest.error} at ${parsedManifest.path}`);
  const refs = new Map<string, TaskRefV1>();
  for (const entry of parsedManifest.manifest.tasks) {
    const parsedRef = parseTaskRef(parseFile(`data/tasks/${entry.ref_path}`));
    if (!parsedRef.ok) throw new Error(`data/tasks/${entry.ref_path}: ${parsedRef.error} at ${parsedRef.path}`);
    refs.set(entry.task_id, parsedRef.ref);
  }
  return { manifest: parsedManifest.manifest, refs };
}

const TASKS = loadTasks();
const FLOP_REF = TASKS.refs.get(FLOP)!;
const flopEntry = (manifest: Mutable): Mutable => manifest.tasks.find((entry: Mutable) => entry.task_id === FLOP);

/** A JSON round trip hands `change` a plain copy, as if the document came from the clipboard. */
function mutate<T>(base: T, change: (copy: Mutable) => void): T {
  const copy = JSON.parse(JSON.stringify(base)) as Mutable;
  change(copy);
  return copy as T;
}

const reportText = (change: (report: Mutable) => void = () => {}): string =>
  JSON.stringify(mutate(JSON.parse(GOLDEN), change));
const validate = (text: string, tasks: Tasks = TASKS) => validateContribution(text, tasks.manifest, tasks.refs);

const manifestAtRevision = (revision: number): TaskManifestV1 =>
  mutate(TASKS.manifest, manifest => {
    const entry = flopEntry(manifest);
    entry.revision = revision;
    entry.ref_path = `${FLOP}.v${revision}.json`;
  });
const refWithCheckpointAction = (action: string): Tasks =>
  ({ ...TASKS, refs: new Map(TASKS.refs).set(FLOP, mutate(FLOP_REF, ref => { ref.checkpoints[0].action = action; })) });

const REJECTIONS: [name: string, text: () => string, code: ContributionErrorCode, tasks?: () => Tasks][] = [
  ['oversized input', () => 'x'.repeat(MAX_CONTRIBUTION_BYTES + 1), 'input_too_large'],
  ['malformed JSON', () => `${GOLDEN}{`, 'malformed_json'],
  [
    'duplicate JSON field',
    () => `${GOLDEN.trimEnd().slice(0, -1)},\n  "kind": "run_report"\n}\n`,
    'duplicate_json_field',
  ],
  ['link in a field', () => reportText(report => { report.checkpoint.action = LINK; }), 'url_not_allowed'],
  ['link in an unknown field', () => reportText(report => { report.note = LINK; }), 'url_not_allowed'],
  ['secret in an unknown field', () => reportText(report => { report.note = SECRET; }), 'secret_detected'],
  ['one-time code in an unknown field', () => reportText(report => { report.note = OTP; }), 'secret_detected'],
  ['secret-like key name', () => reportText(report => { report.token = 'x'; }), 'secret_detected'],
  ['secret in a forged checkpoint', () => reportText(report => { report.checkpoint.action = SECRET; }), 'secret_detected'],
  ['personal data in an unknown field', () => reportText(report => { report.note = EMAIL; }), 'pii_detected'],
  ['personal-data key name', () => reportText(report => { report.email = 'x'; }), 'pii_detected'],
  ['personal data in a forged checkpoint', () => reportText(report => { report.checkpoint.action = EMAIL; }), 'pii_detected'],
  ['unknown field', () => reportText(report => { report.note = 'x'; }), 'unknown_field'],
  ['invalid field value', () => reportText(report => { report.status = 'done'; }), 'invalid_field_value'],
  [
    'invalid input report',
    () => reportText(report => { report.status = 'invalid_input'; report.error = 'malformed_json'; }),
    'invalid_input_not_contributable',
  ],
  ['error set on the report', () => reportText(report => { report.error = 'malformed_json'; }), 'error_must_be_null'],
  ['fixture mode', () => reportText(report => { report.mode = 'synthetic_fixture'; }), 'fixture_not_contributable'],
  [
    'fixture status',
    () => reportText(report => { report.status = 'verified_fixture'; report.checkpoint = null; }),
    'fixture_not_contributable',
  ],
  [
    'live proof',
    () => reportText(report => { report.status = 'verified_live'; report.checkpoint = null; }),
    'live_proof_not_supported_v1',
  ],
  ['task missing from the manifest', () => reportText(report => { report.task_id = 'no-such-task'; }), 'unsupported_task'],
  [
    'ref missing for a listed task',
    () => GOLDEN,
    'unsupported_task',
    () => ({ manifest: TASKS.manifest, refs: new Map() }),
  ],
  ['older revision', () => GOLDEN, 'stale_revision', () => ({ ...TASKS, manifest: manifestAtRevision(2) })],
  ['unknown revision', () => reportText(report => { report.revision = 2; }), 'unknown_revision'],
  ['other ref hash', () => reportText(report => { report.ref_sha256 = 'ab'.repeat(32); }), 'ref_sha256_mismatch'],
  ['unknown step', () => reportText(report => { report.attempted_steps[1].id = 'extra_step'; }), 'unknown_step'],
  [
    'source outside the ref',
    () => reportText(report => { report.attempted_steps[0].source_ids = ['extra_source']; }),
    'unknown_source',
  ],
  [
    'source borrowed from another step',
    () => reportText(report => { report.attempted_steps[0].source_ids = ['faucet_chain']; }),
    'unknown_source',
  ],
  [
    'repeated step',
    () => reportText(report => { report.attempted_steps[1].id = 'verify_voucher_window'; }),
    'step_order_violation',
  ],
  ['steps out of order', () => reportText(report => { report.attempted_steps.reverse(); }), 'step_order_violation'],
  [
    'prerequisite step missing',
    () => reportText(report => { report.attempted_steps = [report.attempted_steps[1]]; }),
    'step_order_violation',
  ],
  [
    'checkpoint text changed',
    () => reportText(report => { report.checkpoint.action = 'Do something else.'; }),
    'checkpoint_mismatch',
  ],
  [
    'checkpoint id changed',
    () => reportText(report => { report.checkpoint.id = 'other_checkpoint'; }),
    'checkpoint_mismatch',
  ],
  // human_action_required_now must follow the status: false for a blocked run, true for needs_user.
  [
    'blocked run that demands human action now',
    () => reportText(report => { report.checkpoint.human_action_required_now = true; }),
    'invalid_field_value',
  ],
  [
    'needs-user run that defers its human action',
    () => reportText(report => { report.status = 'needs_user'; }),
    'invalid_field_value',
  ],
  [
    'fixture task listed in the manifest',
    () => {
      const entry = TASKS.manifest.tasks.find(item => item.task_id === 'voucher-demo')!;
      return reportText(report => { report.task_id = entry.task_id; report.ref_sha256 = entry.ref_sha256; });
    },
    'fixture_not_contributable',
  ],
];

describe('validateContribution rejections', () => {
  test('rejects every case with its own code and one fixed message per code', () => {
    const messages = new Map<ContributionErrorCode, string>();
    for (const [name, text, code, tasks] of REJECTIONS) {
      const result = validate(text(), tasks ? tasks() : TASKS);
      if (result.ok) throw new Error(`${name}: expected ${code}, got ok`);
      expect({ name, code: result.code, message: result.message }).toEqual({
        name,
        code,
        message: messages.get(code) ?? result.message,
      });
      messages.set(code, result.message);
    }
    expect([...messages.keys()].sort()).toEqual([...ALL_CODES].sort());
    // One distinct string per code: no message is built from report values.
    expect(new Set(messages.values()).size).toBe(ALL_CODES.length);
  });

  test('never repeats report values in a rejection', () => {
    const marked = [SECRET, SECRET_TAIL, EMAIL, EMAIL_TAIL, LINK, OTP, 'app.demo.test'];
    const texts = [
      reportText(report => { report.checkpoint.action = SECRET; }),
      reportText(report => { report.checkpoint.resume_when = EMAIL; }),
      reportText(report => { report.note = LINK; }),
      reportText(report => { report.token = OTP; }),
      reportText(report => { report.task_id = 'wallet_drainer_step'; }),
      `${GOLDEN}{`,
    ];
    for (const text of texts) {
      const result = validate(text);
      expect(result.ok).toBe(false);
      const rejection = JSON.stringify(result);
      for (const marker of marked) expect(rejection).not.toContain(marker);
      expect(rejection).not.toContain('wallet_drainer_step');
      expect(Object.keys(result).sort()).toEqual(['code', 'message', 'ok']);
    }
  });

  test('measures the limit in UTF-8 bytes and rejects only above it', () => {
    expect(MAX_CONTRIBUTION_BYTES).toBe(16384);
    expect(validate(GOLDEN.padEnd(MAX_CONTRIBUTION_BYTES, ' ')).ok).toBe(true);
    expect(validate('x'.repeat(MAX_CONTRIBUTION_BYTES))).toMatchObject({ code: 'malformed_json' });
    expect(validate('x'.repeat(MAX_CONTRIBUTION_BYTES + 1))).toMatchObject({ code: 'input_too_large' });
    expect(validate('é'.repeat(MAX_CONTRIBUTION_BYTES / 2 + 1))).toMatchObject({ code: 'input_too_large' });
  });
});

describe('validateContribution acceptance', () => {
  test('accepts the Python-generated golden report against the files on disk', () => {
    const result = validate(GOLDEN);
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    const golden = JSON.parse(GOLDEN);

    expect(result.report).toEqual(golden);
    expect(result.canonical).toBe(canonicalJson(golden));
    const reparsed = parseStrictJson(result.canonical, MAX_FILE_BYTES);
    if (!reparsed.ok) throw new Error(`canonical report must parse: ${reparsed.error}`);
    expect(canonicalJson(reparsed.value)).toBe(result.canonical);

    expect(result.preview.task_id).toBe(FLOP);
    expect(result.preview.title).toBe(FLOP_REF.title);
    expect(result.preview.revision).toBe(FLOP_REF.revision);
    expect(result.preview.ref_sha256).toBe(flopEntry(TASKS.manifest).ref_sha256);
    expect(result.preview.mode).toBe('live_read_only');
    expect(result.preview.status).toBe('blocked_not_active');
    expect(result.preview.evidence).toEqual(golden.evidence);
    expect(result.preview.attempted_steps).toEqual([
      {
        id: 'verify_voucher_window',
        title: FLOP_REF.steps[0].title,
        outcome: 'blocked',
        source_ids: ['official_registry', 'official_timeline'],
      },
      { id: 'verify_network', title: FLOP_REF.steps[1].title, outcome: 'skipped', source_ids: ['faucet_chain'] },
    ]);
    expect(result.preview.checkpoint).toEqual(golden.checkpoint);
  });

  test('resolves titles and source links from the reviewed ref, never from the pasted JSON', () => {
    const result = validate(GOLDEN);
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    const refSources = FLOP_REF.official_sources;
    expect(result.preview.sources.map(source => source.id)).toEqual(refSources.map(source => source.id));
    for (const [index, source] of result.preview.sources.entries()) expect(source).toBe(refSources[index]);

    // An unused ref source is left out; a pasted source cannot add itself.
    const firstStepOnly = validate(reportText(report => { report.attempted_steps = report.attempted_steps.slice(0, 1); }));
    expect(firstStepOnly.ok && firstStepOnly.preview.sources.map(source => source.id)).toEqual([
      'official_registry',
      'official_timeline',
    ]);
    expect(validate(reportText(report => { report.sources = [{ id: 'extra_source', url: LINK }]; }))).toMatchObject({
      code: 'url_not_allowed',
    });
    expect(validate(reportText(report => { report.title = 'Pasted title'; }))).toMatchObject({ code: 'unknown_field' });
    expect(validate(reportText(report => { report.attempted_steps[0].title = 'Pasted title'; }))).toMatchObject({
      code: 'unknown_field',
    });
  });

  test('accepts other live read-only statuses and a blocked run without a checkpoint', () => {
    const blocked = validate(reportText(report => { report.checkpoint = null; }));
    expect(blocked.ok && blocked.preview.checkpoint).toBeNull();

    const needsUser = validate(
      reportText(report => {
        report.status = 'needs_user';
        report.checkpoint.human_action_required_now = true;
      }),
    );
    expect(needsUser.ok && needsUser.preview.checkpoint?.human_action_required_now).toBe(true);

    const missingCapability = validate(
      reportText(report => {
        report.status = 'blocked_missing_capability';
        report.checkpoint = null;
        report.missing_capabilities = ['network_read'];
      }),
    );
    expect(missingCapability.ok && missingCapability.preview.status).toBe('blocked_missing_capability');
  });

  test('exempts checkpoint text that trips the scrubber only while it equals the reviewed checkpoint', () => {
    // A reviewed checkpoint may cite a block height, which reads like a one-time code.
    const cited = 'Wait for block 1234567 to finalize.';
    const tasks = refWithCheckpointAction(cited);
    const same = validate(reportText(report => { report.checkpoint.action = cited; }), tasks);
    expect(same.ok && same.preview.checkpoint?.action).toBe(cited);

    const forged = validate(reportText(report => { report.checkpoint.action = 'Wait for block 1234568 to finalize.' }), tasks);
    expect(forged).toMatchObject({ ok: false, code: 'secret_detected' });
    expect(JSON.stringify(forged)).not.toContain('1234568');
  });

  test('keeps a scrubber finding elsewhere in the report ahead of a matching checkpoint', () => {
    // A reviewed checkpoint may cite a block height, which reads like a one-time code.
    const cited = 'Wait for block 1234567 to finalize.';
    const tasks = refWithCheckpointAction(cited);
    const secret = validate(
      reportText(report => {
        report.checkpoint.action = cited;
        report.note = SECRET;
      }),
      tasks,
    );
    expect(secret).toMatchObject({ ok: false, code: 'secret_detected' });
    // A secret outranks personal data, as it does in scanSecrets.
    const mixed = validate(
      reportText(report => {
        report.checkpoint.action = cited;
        report.email = 'x';
      }),
      tasks,
    );
    expect(mixed).toMatchObject({ ok: false, code: 'secret_detected' });
  });
});
