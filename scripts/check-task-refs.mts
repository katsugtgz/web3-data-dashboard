// Integrity gate for data/tasks: the manifest, each reference it pins by hash,
// and the files that must stay in step with them. Run with `bun run check:tasks`.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PREFLIGHT_LINES } from '../src/lib/agentBrief';
import { parseManifest, parseRunReport, parseStrictJson, parseTaskRef, scanSecrets } from '../shared/taskContract';

export interface TaskRefsResult {
  ok: boolean;
  problems: string[];
  /** With `fix`: each manifest hash that was rewritten, as "<ref_path> -> <sha256>". */
  fixed: string[];
}

const MANIFEST = 'data/tasks/manifest.json';
const TASKS_DIR = 'data/tasks';
const GOLDEN_TASK = 'flop-testnet-voucher';
const GOLDEN_REPORT = `skills/web3-radar-task/tests/golden/${GOLDEN_TASK}.v1.blocked_not_active.json`;
const SKILL_MD = 'skills/web3-radar-task/SKILL.md';
const TASK_REGISTRY = 'src/lib/taskRegistry.ts';
// The largest limit contract.py applies to a task file.
const MAX_TASK_FILE_BYTES = 262144;
// Values that may hold a hash, a reviewed date, a URL, or prose that cites a block height.
const EXEMPT_PATHS = new Set([
  '$.tasks[*].ref_sha256',
  '$.review.reviewed_at',
  '$.steps[*].check.pins.*',
  '$.proof.pins.*',
  '$.checkpoints[*].action',
  '$.checkpoints[*].resume_when',
  '$.fixture.cases.*.page_origin',
]);

type Failure = { ok: false; error: string; path?: string };
type Loaded = { bytes: Buffer; text: string } | null;

const describeFailure = (failure: Failure): string => `${failure.error}${failure.path ? ` at ${failure.path}` : ''}`;

/** Reads one task file and reports anything that makes its bytes differ between checkouts. */
async function loadTaskFile(rootDir: string, relPath: string, problems: string[]): Promise<Loaded> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(rootDir, relPath));
  } catch {
    problems.push(`${relPath}: missing or unreadable`);
    return null;
  }
  if (bytes.includes(0x0d)) problems.push(`${relPath}: holds CR bytes; write it with LF line endings`);
  if (bytes.at(-1) !== 0x0a) problems.push(`${relPath}: does not end with a newline`);
  try {
    return { bytes, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    problems.push(`${relPath}: is not valid UTF-8`);
    return null;
  }
}

/**
 * Checks the task manifest and references under `rootDir`. With `fix`, a stale
 * `ref_sha256` in the manifest is rewritten from the file bytes, then the check
 * runs again; every other problem is reported, never repaired.
 */
export async function checkTaskRefs(options: { rootDir?: string; fix?: boolean } = {}): Promise<TaskRefsResult> {
  const rootDir = resolve(options.rootDir ?? '.');
  const problems: string[] = [];
  const manifestFile = await loadTaskFile(rootDir, MANIFEST, problems);
  if (!manifestFile) return { ok: false, problems, fixed: [] };
  const manifestJson = parseStrictJson(manifestFile.text, MAX_TASK_FILE_BYTES);
  const parsedManifest = manifestJson.ok ? parseManifest(manifestJson.value) : manifestJson;
  if (!parsedManifest.ok) {
    problems.push(`${MANIFEST}: ${describeFailure(parsedManifest)}`);
    return { ok: false, problems, fixed: [] };
  }
  const { manifest } = parsedManifest;
  const manifestFinding = scanSecrets(manifest, EXEMPT_PATHS);
  if (manifestFinding) problems.push(`${MANIFEST}: ${manifestFinding}`);

  const stale: [entry: (typeof manifest.tasks)[number], sha256: string][] = [];
  for (const entry of manifest.tasks) {
    const relPath = `${TASKS_DIR}/${entry.ref_path}`;
    const file = await loadTaskFile(rootDir, relPath, problems);
    if (!file) continue;
    const sha256 = createHash('sha256').update(file.bytes).digest('hex');
    if (sha256 !== entry.ref_sha256) {
      stale.push([entry, sha256]);
      if (!options.fix) problems.push(`${relPath}: ref_sha256 in the manifest does not match the file (actual ${sha256})`);
    }
    const refJson = parseStrictJson(file.text, MAX_TASK_FILE_BYTES);
    const parsedRef = refJson.ok ? parseTaskRef(refJson.value) : refJson;
    if (!parsedRef.ok) {
      problems.push(`${relPath}: ${describeFailure(parsedRef)}`);
      continue;
    }
    if (parsedRef.ref.mode === 'synthetic_fixture') {
      const bound = Object.entries(entry.bindings).filter(([, ids]) => ids.length > 0).map(([field]) => field);
      if (bound.length > 0) {
        problems.push(`${MANIFEST}: ${entry.task_id} is a synthetic fixture and must leave ${bound.join(', ')} empty`);
      }
    }
    const refFinding = scanSecrets(parsedRef.ref, EXEMPT_PATHS);
    if (refFinding) problems.push(`${relPath}: ${refFinding}`);
  }

  // The manifest itself is the one JSON file in data/tasks that is not a reference.
  const listed = new Set(['manifest.json', ...manifest.tasks.map((entry) => entry.ref_path)]);
  for (const name of await readdir(join(rootDir, TASKS_DIR)).catch(() => [])) {
    if (name.endsWith('.json') && !listed.has(name)) problems.push(`${TASKS_DIR}/${name}: not listed in ${MANIFEST}`);
  }

  const goldenFile = await loadTaskFile(rootDir, GOLDEN_REPORT, problems);
  if (goldenFile) {
    const goldenJson = parseStrictJson(goldenFile.text, MAX_TASK_FILE_BYTES);
    const parsedGolden = goldenJson.ok ? parseRunReport(goldenJson.value) : goldenJson;
    if (!parsedGolden.ok) problems.push(`${GOLDEN_REPORT}: ${describeFailure(parsedGolden)}`);
    else if (parsedGolden.report.ref_sha256 !== manifest.tasks.find((entry) => entry.task_id === GOLDEN_TASK)?.ref_sha256) {
      problems.push(`${GOLDEN_REPORT}: ref_sha256 is stale for ${GOLDEN_TASK}; regenerate it with scripts/run.py`);
    }
  }

  const skillLines = (await readFile(join(rootDir, SKILL_MD), 'utf8').catch(() => '')).split(/\r?\n/);
  PREFLIGHT_LINES.forEach((line, index) => {
    if (!skillLines.includes(line)) problems.push(`${SKILL_MD}: PREFLIGHT_LINES[${index}] is missing or changed`);
  });

  // The task registry bundles every reference by file name. It arrives in a later wave.
  const registryPath = join(rootDir, TASK_REGISTRY);
  if (existsSync(registryPath)) {
    const source = await readFile(registryPath, 'utf8');
    for (const entry of manifest.tasks) {
      const quoted = ["'", '"', '`'].some((mark) => source.includes(`${mark}${entry.ref_path}${mark}`));
      if (!quoted) problems.push(`${TASK_REGISTRY}: does not bundle ${entry.ref_path}`);
    }
  }

  if (options.fix && stale.length > 0) {
    for (const [entry, sha256] of stale) entry.ref_sha256 = sha256;
    await writeFile(join(rootDir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const fixed = stale.map(([entry]) => `${TASKS_DIR}/${entry.ref_path} -> ${entry.ref_sha256}`);
    return { ...(await checkTaskRefs({ rootDir })), fixed };
  }
  return { ok: problems.length === 0, problems, fixed: [] };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const [rootDir] = argv.filter((argument) => !argument.startsWith('--'));
  const result = await checkTaskRefs({ rootDir, fix: argv.includes('--fix') });
  for (const line of result.fixed) console.log(`Updated: ${line}`);
  if (!result.ok) {
    console.error(`ERROR: ${result.problems.length} task reference problem(s):`);
    for (const problem of result.problems) console.error(` - ${problem}`);
    process.exit(1);
  }
  console.log('OK: task manifest, references, golden report, and skill preflight agree.');
}
