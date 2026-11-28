/**
 * Canonical task contract v1.
 *
 * Strict JSON parsing, secret and PII scrubbing, and structural validation for
 * task refs, task manifests, and run reports. Dependency-free so the CLI,
 * server, and worker bundles share one implementation.
 */

export const TASK_SCHEMA_VERSION = 1 as const;

export const RUN_STATUSES = [
  'invalid_input',
  'blocked_not_active',
  'blocked_missing_capability',
  'ineligible',
  'needs_user',
  'verified_fixture',
  'verified_live',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const TASK_MODES = ['synthetic_fixture', 'live_read_only'] as const;

export type TaskMode = (typeof TASK_MODES)[number];

export const ADAPTERS = {
  fixture_voucher: 'synthetic_fixture',
  fixture_browser_email: 'synthetic_fixture',
  http_read_only: 'live_read_only',
} as const satisfies Record<string, TaskMode>;

export type TaskAdapter = keyof typeof ADAPTERS;

export const CAPABILITIES = ['network_read', 'browser', 'email_inbox', 'wallet_human'] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const CHECKPOINT_TYPES = [
  'await_activation',
  'batch_inputs',
  'login',
  'email_verification',
  'captcha',
  'kyc',
  'wallet_signature',
  'form_submit',
] as const;

export type CheckpointType = (typeof CHECKPOINT_TYPES)[number];

export const SOURCE_KINDS = ['official_documentation', 'public_read_only_endpoint', 'official_app'] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];

export const STEP_OUTCOMES = ['pass', 'fail', 'blocked', 'needs_user', 'skipped'] as const;

export type StepOutcome = (typeof STEP_OUTCOMES)[number];

export const ACTIVATION_STATES = ['active', 'not_active', 'unknown'] as const;

export type ActivationState = (typeof ACTIVATION_STATES)[number];

export const EVIDENCE_ENUMS = {
  activation: ['active', 'not_active', 'unknown'],
  network: ['matched', 'mismatched', 'not_checked'],
  eligibility: ['eligible', 'ineligible', 'not_checked'],
  receipt: ['matched', 'missing', 'mismatched', 'failed', 'not_finalized', 'not_checked'],
  account_status: ['verified', 'pending', 'unverified', 'origin_mismatch', 'not_checked'],
} as const satisfies Record<string, readonly string[]>;

export type RunEvidence = { [K in keyof typeof EVIDENCE_ENUMS]: (typeof EVIDENCE_ENUMS)[K][number] };

export const ERROR_CODES = [
  'invalid_cli_arguments',
  'malformed_json',
  'duplicate_json_field',
  'input_too_large',
  'unknown_field',
  'invalid_field_value',
  'unsupported_task',
  'stale_revision',
  'unknown_revision',
  'invalid_manifest',
  'invalid_reference',
  'ref_sha256_mismatch',
  'expect_sha256_mismatch',
  'adapter_not_allowed',
  'mode_not_allowed',
  'secret_detected',
  'pii_detected',
  'receipt_conflicts_with_ineligible',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

export const SHA256_RE = /^[0-9a-f]{64}$/;

export interface OfficialSource {
  id: string;
  kind: SourceKind;
  url: string;
}

export type StepCheck =
  | { type: 'reviewed_activation' }
  | { type: 'http_json_pins'; source_id: string; pins: Record<string, string> }
  | { type: 'fixture_eligibility' }
  | { type: 'fixture_receipt' }
  | { type: 'fixture_account_status' };

export interface TaskStep {
  id: string;
  title: string;
  actor: 'agent' | 'human';
  depends_on: string[];
  source_ids: string[];
  check: StepCheck | null;
  checkpoint_id: string | null;
}

export interface TaskCheckpoint {
  id: string;
  type: CheckpointType;
  action: string;
  resume_when: string;
}

export type TaskProof =
  | {
      kind: 'onchain_receipt';
      pins: { chain: string; contract: string; event: string; recipient: string; voucher_id: string };
    }
  | { kind: 'account_status'; source_id: string; required_status: 'verified' }
  | { kind: 'unknown_until_active' };

export interface VoucherObservation {
  eligible: boolean;
  receipt: null | {
    chain: string;
    contract: string;
    event: string;
    recipient: string;
    voucher_id: string;
    success: boolean;
    finalized: boolean;
  };
}

export interface BrowserEmailObservation {
  page_origin: string;
  account_status: 'verified' | 'pending' | 'unverified';
  inputs_ready: boolean;
}

export interface TaskRefV1 {
  schema_version: 1;
  kind: 'task_ref';
  task_id: string;
  revision: number;
  title: string;
  summary: string;
  mode: TaskMode;
  adapter: TaskAdapter;
  review: { reviewed_by: string; reviewed_at: string };
  networks: string[];
  activation: { state: ActivationState; source_ids: string[] };
  required_capabilities: Capability[];
  official_sources: OfficialSource[];
  steps: TaskStep[];
  checkpoints: TaskCheckpoint[];
  proof: TaskProof;
  fixture: null | { cases: Record<string, VoucherObservation | BrowserEmailObservation> };
}

export interface TaskBindings {
  card_ids: string[];
  feed_ids: string[];
  domains: string[];
}

export interface ManifestEntryV1 {
  task_id: string;
  revision: number;
  ref_path: string;
  ref_sha256: string;
  bindings: TaskBindings;
}

export interface TaskManifestV1 {
  schema_version: 1;
  kind: 'task_manifest';
  tasks: ManifestEntryV1[];
}

export interface RunReportV1 {
  schema_version: 1;
  kind: 'run_report';
  task_id: string | null;
  revision: number | null;
  ref_sha256: string | null;
  mode: TaskMode | null;
  status: RunStatus;
  attempted_steps: { id: string; outcome: StepOutcome; source_ids: string[] }[];
  evidence: RunEvidence;
  missing_capabilities: Capability[];
  checkpoint: null | {
    id: string;
    type: CheckpointType;
    human_action_required_now: boolean;
    action: string;
    resume_when: string;
  };
  error: ErrorCode | null;
}

type Fail = { ok: false; error: ErrorCode; path: string };

function fail(error: ErrorCode, path: string): Fail {
  return { ok: false, error, path };
}

const MALFORMED = Symbol('malformed_json');
const DUPLICATE = Symbol('duplicate_json_field');
const MAX_JSON_DEPTH = 32;
const NUMBER_RE = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

/**
 * Recursive-descent JSON parser. Throws MALFORMED or DUPLICATE; both sentinels
 * are caught by parseStrictJson and anything else propagates.
 */
class JsonParser {
  private i = 0;

  private constructor(private readonly s: string) {}

  static parse(text: string): unknown {
    return new JsonParser(text).document();
  }

  private document(): unknown {
    this.ws();
    const value = this.value(1);
    this.ws();
    if (this.i !== this.s.length) throw MALFORMED;
    return value;
  }

  /** JSON whitespace only: space, tab, line feed, carriage return. */
  private ws(): void {
    while (this.i < this.s.length) {
      const code = this.s.charCodeAt(this.i);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return;
      this.i++;
    }
  }

  private value(depth: number): unknown {
    switch (this.s[this.i]) {
      case '{':
        return this.object(depth);
      case '[':
        return this.array(depth);
      case '"':
        return this.string();
      case 't':
        return this.literal('true', true);
      case 'f':
        return this.literal('false', false);
      case 'n':
        return this.literal('null', null);
      default:
        return this.number();
    }
  }

  private literal(word: string, value: unknown): unknown {
    if (!this.s.startsWith(word, this.i)) throw MALFORMED;
    this.i += word.length;
    return value;
  }

  /** `depth` counts enclosing containers plus one, so the root container sits at 1. */
  private object(depth: number): Record<string, unknown> {
    if (depth > MAX_JSON_DEPTH) throw MALFORMED;
    // A null prototype keeps an own "__proto__" key from touching the prototype chain.
    const out: Record<string, unknown> = Object.create(null);
    const seen = new Set<string>();
    this.i++;
    this.ws();
    if (this.s[this.i] === '}') {
      this.i++;
      return out;
    }
    for (;;) {
      this.ws();
      if (this.s[this.i] !== '"') throw MALFORMED;
      const key = this.string();
      if (seen.has(key)) throw DUPLICATE;
      seen.add(key);
      this.ws();
      if (this.s[this.i] !== ':') throw MALFORMED;
      this.i++;
      this.ws();
      out[key] = this.value(depth + 1);
      this.ws();
      const closer = this.s[this.i];
      this.i++;
      if (closer === '}') return out;
      if (closer !== ',') throw MALFORMED;
    }
  }

  private array(depth: number): unknown[] {
    if (depth > MAX_JSON_DEPTH) throw MALFORMED;
    const out: unknown[] = [];
    this.i++;
    this.ws();
    if (this.s[this.i] === ']') {
      this.i++;
      return out;
    }
    for (;;) {
      out.push(this.value(depth + 1));
      this.ws();
      const closer = this.s[this.i];
      this.i++;
      if (closer === ']') return out;
      if (closer !== ',') throw MALFORMED;
      this.ws();
    }
  }

  private string(): string {
    const s = this.s;
    let out = '';
    let chunkStart = ++this.i;
    for (;;) {
      if (this.i >= s.length) throw MALFORMED;
      const code = s.charCodeAt(this.i);
      if (code === 0x22) {
        out += s.slice(chunkStart, this.i);
        this.i++;
        return out;
      }
      if (code === 0x5c) {
        out += s.slice(chunkStart, this.i);
        out += this.escape();
        chunkStart = this.i;
      } else if (code < 0x20) {
        throw MALFORMED;
      } else if (code >= 0xd800 && code <= 0xdbff) {
        // A raw high surrogate must pair with a raw low surrogate.
        const next = s.charCodeAt(this.i + 1);
        if (next < 0xdc00 || next > 0xdfff) throw MALFORMED;
        this.i += 2;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        throw MALFORMED;
      } else {
        this.i++;
      }
    }
  }

  /** Consumes a backslash plus its escape and returns the decoded text. */
  private escape(): string {
    const c = this.s[this.i + 1];
    this.i += 2;
    switch (c) {
      case '"':
      case '\\':
      case '/':
        return c;
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'u':
        return this.unicodeEscape();
      default:
        throw MALFORMED;
    }
  }

  private hex4(): number {
    const hex = this.s.slice(this.i, this.i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw MALFORMED;
    this.i += 4;
    return parseInt(hex, 16);
  }

  private unicodeEscape(): string {
    const unit = this.hex4();
    if (unit < 0xd800 || unit > 0xdfff) return String.fromCharCode(unit);
    // Escaped surrogates must appear as a high escape directly followed by a low escape.
    if (unit > 0xdbff || this.s[this.i] !== '\\' || this.s[this.i + 1] !== 'u') throw MALFORMED;
    this.i += 2;
    const low = this.hex4();
    if (low < 0xdc00 || low > 0xdfff) throw MALFORMED;
    return String.fromCharCode(unit, low);
  }

  private number(): number {
    NUMBER_RE.lastIndex = this.i;
    const match = NUMBER_RE.exec(this.s);
    if (!match) throw MALFORMED;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw MALFORMED;
    this.i = NUMBER_RE.lastIndex;
    return value;
  }
}

/**
 * Parses one JSON document under the JSON grammar with no extensions.
 * Rejects duplicate keys, non-finite results, lone surrogates, and nesting deeper than 32.
 */
export function parseStrictJson(text: string, maxBytes: number): { ok: true; value: unknown } | { ok: false; error: ErrorCode } {
  if (new TextEncoder().encode(text).byteLength > maxBytes) return { ok: false, error: 'input_too_large' };
  try {
    return { ok: true, value: JsonParser.parse(text) };
  } catch (error) {
    if (error === DUPLICATE) return { ok: false, error: 'duplicate_json_field' };
    if (error === MALFORMED) return { ok: false, error: 'malformed_json' };
    throw error;
  }
}

/**
 * Serializes a JSON value with object keys sorted lexicographically (UTF-16 code unit order).
 * Arrays keep their order and -0 becomes 0. Throws TypeError on values JSON cannot represent.
 */
export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: numbers must be finite');
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object': {
      if (Array.isArray(value)) return `[${Array.from(value, canonicalize).join(',')}]`;
      const record = value as Record<string, unknown>;
      if (typeof record.toJSON === 'function') return canonicalize(record.toJSON());
      // Building the text by hand keeps integer-like keys in sorted order, which JSON.stringify would reorder.
      const body = Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
        .join(',');
      return `{${body}}`;
    }
    default:
      throw new TypeError(`canonicalJson: cannot serialize ${typeof value}`);
  }
}

// ---------------------------------------------------------------------------
// Scrubbing
// ---------------------------------------------------------------------------

type Finding = 'secret_detected' | 'pii_detected';

const NO_EXEMPTIONS: ReadonlySet<string> = new Set();
const INVISIBLES_RE = /[\u00ad\u200b-\u200f\u2060\ufeff]/g;

/** NFKC-normalizes and strips zero-width characters so lookalikes cannot hide a payload. */
function normalizeText(text: string): string {
  return text.normalize('NFKC').replace(INVISIBLES_RE, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Depth-first walk in key order. The visitor sees every node with its path
 * (`$`, then `.key` or `[*]`) and its key name, or null for the root and array items.
 * Returning true stops the walk.
 *
 * ponytail: a key that contains a dot is ambiguous in this path syntax. Move to
 * segment arrays if pin or case keys ever need dots.
 */
function walk(
  value: unknown,
  path: string,
  key: string | null,
  visit: (node: unknown, path: string, key: string | null) => boolean,
): boolean {
  if (visit(value, path, key)) return true;
  if (Array.isArray(value)) {
    const itemPath = `${path}[*]`;
    for (const item of value) {
      if (walk(item, itemPath, null, visit)) return true;
    }
  } else if (isRecord(value)) {
    for (const childKey of Object.keys(value)) {
      if (walk(value[childKey], `${path}.${childKey}`, childKey, visit)) return true;
    }
  }
  return false;
}

/** Exact match, or a `.*` pattern covering the direct children of that object. */
function isExempt(path: string, patterns: ReadonlySet<string>): boolean {
  for (const pattern of patterns) {
    if (pattern === path) return true;
    if (pattern.endsWith('.*') && path.startsWith(pattern.slice(0, -1)) && !path.includes('.', pattern.length - 1)) {
      return true;
    }
  }
  return false;
}

const SECRET_KEY_TOKENS = new Set([
  'cookie',
  'cookies',
  'session',
  'sessionid',
  'token',
  'secret',
  'password',
  'passwd',
  'otp',
  'mnemonic',
  'seed',
  'private',
  'apikey',
  'authorization',
  'bearer',
]);
const SECRET_KEY_RE = /(?:api_?key|private_?key|auth_?token|set_?cookie|session_?id)/;
const PII_KEY_TOKENS = new Set(['email', 'phone', 'phonenumber']);
const PII_KEY_RE = /(?:phone_?number|e_?mail)/;

function keyFinding(key: string): Finding | null {
  const kl = normalizeText(key).toLowerCase();
  const tokens = kl.split(/[^a-z0-9]+/);
  if (tokens.some((token) => SECRET_KEY_TOKENS.has(token)) || SECRET_KEY_RE.test(kl)) return 'secret_detected';
  if (tokens.some((token) => PII_KEY_TOKENS.has(token)) || PII_KEY_RE.test(kl)) return 'pii_detected';
  return null;
}

const JWT_RE = /\beyj[a-z0-9_-]{4,}\.eyj[a-z0-9_-]{4,}\.[a-z0-9_-]{4,}\b/;
const BEARER_RE = /(?:^|[^a-z0-9_])bearer\s+[a-z0-9._~+/=-]{8,}/;
const COOKIE_RE = /(?:^|[^a-z0-9_])(?:set-cookie\s*:|__(?:secure|host)-[a-z0-9_.-]+=|sessionid=|connect\.sid=|phpsessid=)/;
const HEX64_RE = /(?:^|[^0-9a-f])(?:0x)?[0-9a-f]{64}(?:$|[^0-9a-f])/;
const OTP_RE = /(?:^|[^0-9a-z_-])[0-9]{4,8}(?:$|[^0-9a-z_-])/;
const EMAIL_RE = /[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,24}/;
const SEED_WORD_RE = /^[a-z]{3,8}$/;
const SEED_STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'with', 'this', 'from', 'your', 'is', 'are', 'was', 'were', 'have', 'has', 'not',
  'to', 'of', 'in', 'on', 'at', 'by', 'as', 'or', 'if', 'it', 'please', 'check', 'report', 'user', 'task',
  'step', 'official', 'voucher',
]);

/** A run of 12 or more clean words contains a 12, 15, 18, 21, or 24 word phrase. Stopwords break a run. */
function looksLikeSeedPhrase(norm: string): boolean {
  let run = 0;
  for (const token of norm.split(/\s+/)) {
    if (SEED_WORD_RE.test(token) && !SEED_STOPWORDS.has(token)) {
      if (++run >= 12) return true;
    } else {
      run = 0;
    }
  }
  return false;
}

function stringFinding(norm: string): Finding | null {
  const low = norm.toLowerCase();
  if (
    JWT_RE.test(low) ||
    BEARER_RE.test(low) ||
    COOKIE_RE.test(low) ||
    HEX64_RE.test(low) ||
    looksLikeSeedPhrase(norm) ||
    OTP_RE.test(low)
  ) {
    return 'secret_detected';
  }
  return EMAIL_RE.test(low) ? 'pii_detected' : null;
}

function valueFinding(node: unknown, path: string, exemptPaths: ReadonlySet<string>): Finding | null {
  if (isExempt(path, exemptPaths)) return null;
  if (typeof node === 'string') return stringFinding(normalizeText(node));
  if (typeof node === 'number' && path !== '$.schema_version' && path !== '$.revision') {
    return Number.isInteger(node) && node >= 1000 && node <= 99999999 ? 'secret_detected' : null;
  }
  return null;
}

/**
 * Reports secret_detected or pii_detected for the first severity class present.
 * Key names are always checked. Exemptions in `exemptPaths` apply to values only,
 * and a secret outranks PII wherever either appears.
 */
export function scanSecrets(value: unknown, exemptPaths: ReadonlySet<string> = NO_EXEMPTIONS): Finding | null {
  let piiSeen = false;
  const secretSeen = walk(value, '$', null, (node, path, key) => {
    const finding = (key === null ? null : keyFinding(key)) ?? valueFinding(node, path, exemptPaths);
    if (finding === 'secret_detected') return true;
    if (finding === 'pii_detected') piiSeen = true;
    return false;
  });
  return secretSeen ? 'secret_detected' : piiSeen ? 'pii_detected' : null;
}

const URL_RE = /(?:https?:\/\/|www\.)/i;

/** True when any non-exempt string value holds an http, https, or www. URL. */
export function containsUrl(value: unknown, exemptPaths: ReadonlySet<string> = NO_EXEMPTIONS): boolean {
  return walk(value, '$', null, (node, path, _key) => {
    return typeof node === 'string' && !isExempt(path, exemptPaths) && URL_RE.test(normalizeText(node));
  });
}

// ---------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------

const ASCII_RE = /^[\x20-\x7e]+$/;
const ASCII_TOKEN_RE = /^[\x21-\x7e]+$/;
const REVIEWED_TEXT_RE = /^[\x20-\x7e]{1,400}$/;
const REVIEWED_TEXT_FORBIDDEN_RE = /[\u00ab\u00bb`>]|https?:\/\/|www\./i;

function isOneOf<T extends string>(options: readonly T[], value: unknown): value is T {
  return options.includes(value as T);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

function isPositiveInt(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/** Non-empty printable ASCII. */
function isAscii(value: unknown): boolean {
  return typeof value === 'string' && ASCII_RE.test(value);
}

/** Reviewed prose: printable ASCII, 1..400 chars, no markup or URLs. */
function isReviewedText(value: unknown): boolean {
  return typeof value === 'string' && REVIEWED_TEXT_RE.test(value) && !REVIEWED_TEXT_FORBIDDEN_RE.test(value);
}

/** An https URL with a host and no embedded credentials. */
function isCleanHttpsUrl(value: unknown): boolean {
  if (typeof value !== 'string' || !ASCII_TOKEN_RE.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

/** Rejects the first unknown key, then the first missing key. */
function checkKeys(record: Record<string, unknown>, allowed: readonly string[], path: string): Fail | null {
  const present = new Set(Object.keys(record));
  for (const key of present) {
    if (!allowed.includes(key)) return fail('unknown_field', `${path}.${key}`);
  }
  for (const key of allowed) {
    if (!present.has(key)) return fail('invalid_field_value', `${path}.${key}`);
  }
  return null;
}

function checkArray(value: unknown, path: string, isItem: (item: unknown) => boolean): Fail | null {
  if (!Array.isArray(value)) return fail('invalid_field_value', path);
  for (let i = 0; i < value.length; i++) {
    if (!isItem(value[i])) return fail('invalid_field_value', `${path}[${i}]`);
  }
  return null;
}

const TASK_REF_KEYS = [
  'schema_version',
  'kind',
  'task_id',
  'revision',
  'title',
  'summary',
  'mode',
  'adapter',
  'review',
  'networks',
  'activation',
  'required_capabilities',
  'official_sources',
  'steps',
  'checkpoints',
  'proof',
  'fixture',
] as const;
const STEP_KEYS = ['id', 'title', 'actor', 'depends_on', 'source_ids', 'check', 'checkpoint_id'] as const;
const CHECKPOINT_KEYS = ['id', 'type', 'action', 'resume_when'] as const;
const PROOF_PIN_KEYS = ['chain', 'contract', 'event', 'recipient', 'voucher_id'] as const;
const RECEIPT_KEYS = ['chain', 'contract', 'event', 'recipient', 'voucher_id', 'success', 'finalized'] as const;
const BROWSER_KEYS = ['page_origin', 'account_status', 'inputs_ready'] as const;

type SourceKinds = ReadonlyMap<string, SourceKind>;

function checkCheckpoint(value: unknown, path: string): Fail | null {
  if (!isRecord(value)) return fail('invalid_field_value', path);
  const badKeys = checkKeys(value, CHECKPOINT_KEYS, path);
  if (badKeys) return badKeys;
  if (!isId(value.id)) return fail('invalid_field_value', `${path}.id`);
  if (!isOneOf(CHECKPOINT_TYPES, value.type)) return fail('invalid_field_value', `${path}.type`);
  if (!isReviewedText(value.action)) return fail('invalid_field_value', `${path}.action`);
  if (!isReviewedText(value.resume_when)) return fail('invalid_field_value', `${path}.resume_when`);
  return null;
}

function checkStepShape(value: unknown, path: string): Fail | null {
  if (!isRecord(value)) return fail('invalid_field_value', path);
  const badKeys = checkKeys(value, STEP_KEYS, path);
  if (badKeys) return badKeys;
  if (!isId(value.id)) return fail('invalid_field_value', `${path}.id`);
  if (!isReviewedText(value.title)) return fail('invalid_field_value', `${path}.title`);
  if (value.actor !== 'agent' && value.actor !== 'human') return fail('invalid_field_value', `${path}.actor`);
  const badDeps = checkArray(value.depends_on, `${path}.depends_on`, isId);
  if (badDeps) return badDeps;
  const badSources = checkArray(value.source_ids, `${path}.source_ids`, isId);
  if (badSources) return badSources;
  if (value.checkpoint_id !== null && !isId(value.checkpoint_id)) return fail('invalid_field_value', `${path}.checkpoint_id`);
  return null;
}

/** A step check must be one the adapter supports and must point at a source of the right kind. */
function checkStepCheck(value: unknown, path: string, adapter: TaskAdapter, sourceKinds: SourceKinds): Fail | null {
  if (value === null) return null;
  if (!isRecord(value)) return fail('invalid_field_value', path);
  switch (value.type) {
    case 'reviewed_activation':
      return checkKeys(value, ['type'], path);
    case 'fixture_eligibility':
    case 'fixture_receipt':
      return adapter !== 'fixture_voucher' ? fail('invalid_field_value', `${path}.type`) : checkKeys(value, ['type'], path);
    case 'fixture_account_status':
      return adapter !== 'fixture_browser_email' ? fail('invalid_field_value', `${path}.type`) : checkKeys(value, ['type'], path);
    case 'http_json_pins': {
      if (adapter !== 'http_read_only') return fail('invalid_field_value', `${path}.type`);
      const badKeys = checkKeys(value, ['type', 'source_id', 'pins'], path);
      if (badKeys) return badKeys;
      if (!isId(value.source_id)) return fail('invalid_field_value', `${path}.source_id`);
      if (sourceKinds.get(value.source_id) !== 'public_read_only_endpoint') return fail('invalid_reference', `${path}.source_id`);
      if (!isRecord(value.pins) || Object.keys(value.pins).length === 0) return fail('invalid_field_value', `${path}.pins`);
      for (const key of Object.keys(value.pins)) {
        if (key.length === 0 || !isAscii(value.pins[key])) return fail('invalid_field_value', `${path}.pins.${key}`);
      }
      return null;
    }
    default:
      return fail('invalid_field_value', `${path}.type`);
  }
}

function checkProof(value: unknown, path: string, active: boolean, sourceKinds: SourceKinds): Fail | null {
  if (!isRecord(value)) return fail('invalid_field_value', path);
  switch (value.kind) {
    case 'unknown_until_active':
      return active ? fail('invalid_field_value', path) : checkKeys(value, ['kind'], path);
    case 'onchain_receipt': {
      const badKeys = checkKeys(value, ['kind', 'pins'], path);
      if (badKeys) return badKeys;
      const pins = value.pins;
      if (!isRecord(pins)) return fail('invalid_field_value', `${path}.pins`);
      const badPinKeys = checkKeys(pins, PROOF_PIN_KEYS, `${path}.pins`);
      if (badPinKeys) return badPinKeys;
      for (const key of PROOF_PIN_KEYS) {
        if (!isAscii(pins[key])) return fail('invalid_field_value', `${path}.pins.${key}`);
      }
      return null;
    }
    case 'account_status': {
      const badKeys = checkKeys(value, ['kind', 'source_id', 'required_status'], path);
      if (badKeys) return badKeys;
      if (!isId(value.source_id)) return fail('invalid_field_value', `${path}.source_id`);
      if (sourceKinds.get(value.source_id) !== 'official_app') return fail('invalid_reference', `${path}.source_id`);
      if (value.required_status !== 'verified') return fail('invalid_field_value', `${path}.required_status`);
      return null;
    }
    default:
      return fail('invalid_field_value', `${path}.kind`);
  }
}

function checkVoucherCase(value: unknown, path: string): Fail | null {
  if (!isRecord(value)) return fail('invalid_field_value', path);
  const badKeys = checkKeys(value, ['eligible', 'receipt'], path);
  if (badKeys) return badKeys;
  if (typeof value.eligible !== 'boolean') return fail('invalid_field_value', `${path}.eligible`);
  const receipt = value.receipt;
  if (receipt === null) return null;
  if (value.eligible === false) return fail('receipt_conflicts_with_ineligible', `${path}.receipt`);
  if (!isRecord(receipt)) return fail('invalid_field_value', `${path}.receipt`);
  const badReceiptKeys = checkKeys(receipt, RECEIPT_KEYS, `${path}.receipt`);
  if (badReceiptKeys) return badReceiptKeys;
  for (const key of RECEIPT_KEYS) {
    if (key === 'success' || key === 'finalized') {
      if (typeof receipt[key] !== 'boolean') return fail('invalid_field_value', `${path}.receipt.${key}`);
    } else if (!isAscii(receipt[key])) {
      return fail('invalid_field_value', `${path}.receipt.${key}`);
    }
  }
  return null;
}

function checkBrowserCase(value: unknown, path: string): Fail | null {
  if (!isRecord(value)) return fail('invalid_field_value', path);
  const badKeys = checkKeys(value, BROWSER_KEYS, path);
  if (badKeys) return badKeys;
  if (!isCleanHttpsUrl(value.page_origin)) return fail('invalid_field_value', `${path}.page_origin`);
  if (!isOneOf(['verified', 'pending', 'unverified'], value.account_status)) return fail('invalid_field_value', `${path}.account_status`);
  if (typeof value.inputs_ready !== 'boolean') return fail('invalid_field_value', `${path}.inputs_ready`);
  return null;
}

/**
 * Validates a task ref: exact keys, field types, and every cross-field rule of contract v1.
 * Returns the same object typed as TaskRefV1, or the first violation with its path.
 *
 * ponytail: the spec leaves `networks`, `review` fields, and fixture case names without a
 * format rule. They accept non-empty ASCII, reviewed text, and ID_RE names respectively.
 * Tighten if the spec names a format.
 */
export function parseTaskRef(value: unknown): { ok: true; ref: TaskRefV1 } | Fail {
  if (!isRecord(value)) return fail('invalid_field_value', '$');
  const badKeys = checkKeys(value, TASK_REF_KEYS, '$');
  if (badKeys) return badKeys;

  if (value.schema_version !== TASK_SCHEMA_VERSION) return fail('invalid_field_value', '$.schema_version');
  if (value.kind !== 'task_ref') return fail('invalid_field_value', '$.kind');
  if (!isId(value.task_id)) return fail('invalid_field_value', '$.task_id');
  if (!isPositiveInt(value.revision)) return fail('invalid_field_value', '$.revision');
  if (!isReviewedText(value.title)) return fail('invalid_field_value', '$.title');
  if (!isReviewedText(value.summary)) return fail('invalid_field_value', '$.summary');
  if (!isOneOf(TASK_MODES, value.mode)) return fail('invalid_field_value', '$.mode');
  if (typeof value.adapter !== 'string') return fail('invalid_field_value', '$.adapter');
  // Object.hasOwn, not `in`: "toString" must not pass as an adapter name.
  if (!Object.hasOwn(ADAPTERS, value.adapter)) return fail('adapter_not_allowed', '$.adapter');
  const adapter = value.adapter as TaskAdapter;
  const synthetic = value.mode === 'synthetic_fixture';
  if ((ADAPTERS[adapter] === 'synthetic_fixture') !== synthetic) return fail('mode_not_allowed', '$.mode');
  if (synthetic !== (value.fixture !== null)) return fail('invalid_field_value', '$.fixture');

  const review = value.review;
  if (!isRecord(review)) return fail('invalid_field_value', '$.review');
  const badReview = checkKeys(review, ['reviewed_by', 'reviewed_at'], '$.review');
  if (badReview) return badReview;
  if (!isReviewedText(review.reviewed_by)) return fail('invalid_field_value', '$.review.reviewed_by');
  if (!isReviewedText(review.reviewed_at)) return fail('invalid_field_value', '$.review.reviewed_at');

  const badNetworks = checkArray(value.networks, '$.networks', isAscii);
  if (badNetworks) return badNetworks;

  const activation = value.activation;
  if (!isRecord(activation)) return fail('invalid_field_value', '$.activation');
  const badActivation = checkKeys(activation, ['state', 'source_ids'], '$.activation');
  if (badActivation) return badActivation;
  if (!isOneOf(ACTIVATION_STATES, activation.state)) return fail('invalid_field_value', '$.activation.state');
  const activationSources = activation.source_ids;
  if (!Array.isArray(activationSources)) return fail('invalid_field_value', '$.activation.source_ids');
  const badActivationSources = checkArray(activationSources, '$.activation.source_ids', isId);
  if (badActivationSources) return badActivationSources;

  const badCapabilities = checkArray(value.required_capabilities, '$.required_capabilities', (item) => isOneOf(CAPABILITIES, item));
  if (badCapabilities) return badCapabilities;

  const sources = value.official_sources;
  if (!Array.isArray(sources)) return fail('invalid_field_value', '$.official_sources');
  const sourceKinds = new Map<string, SourceKind>();
  for (let i = 0; i < sources.length; i++) {
    const sourcePath = `$.official_sources[${i}]`;
    const source = sources[i];
    if (!isRecord(source)) return fail('invalid_field_value', sourcePath);
    const badSource = checkKeys(source, ['id', 'kind', 'url'], sourcePath);
    if (badSource) return badSource;
    if (!isId(source.id)) return fail('invalid_field_value', `${sourcePath}.id`);
    if (!isOneOf(SOURCE_KINDS, source.kind)) return fail('invalid_field_value', `${sourcePath}.kind`);
    if (!isCleanHttpsUrl(source.url)) return fail('invalid_field_value', `${sourcePath}.url`);
    if (sourceKinds.has(source.id)) return fail('invalid_field_value', `${sourcePath}.id`);
    sourceKinds.set(source.id, source.kind);
  }
  if (value.mode === 'live_read_only' && sourceKinds.size === 0) return fail('invalid_field_value', '$.official_sources');
  for (let i = 0; i < activationSources.length; i++) {
    if (!sourceKinds.has(activationSources[i])) return fail('invalid_reference', `$.activation.source_ids[${i}]`);
  }

  const active = activation.state === 'active';
  const checkpoints = value.checkpoints;
  if (!Array.isArray(checkpoints)) return fail('invalid_field_value', '$.checkpoints');
  const checkpointIds = new Set<string>();
  let awaitsActivation = false;
  for (let i = 0; i < checkpoints.length; i++) {
    const checkpointPath = `$.checkpoints[${i}]`;
    const badCheckpoint = checkCheckpoint(checkpoints[i], checkpointPath);
    if (badCheckpoint) return badCheckpoint;
    const checkpoint = checkpoints[i] as TaskCheckpoint;
    if (checkpointIds.has(checkpoint.id)) return fail('invalid_field_value', `${checkpointPath}.id`);
    checkpointIds.add(checkpoint.id);
    awaitsActivation ||= checkpoint.type === 'await_activation';
  }
  if (!active && !awaitsActivation) return fail('invalid_field_value', '$.checkpoints');

  const steps = value.steps;
  if (!Array.isArray(steps)) return fail('invalid_field_value', '$.steps');
  const stepIds = new Set<string>();
  for (let i = 0; i < steps.length; i++) {
    const stepPath = `$.steps[${i}]`;
    const badStep = checkStepShape(steps[i], stepPath);
    if (badStep) return badStep;
    const step = steps[i] as TaskStep;
    if (stepIds.has(step.id)) return fail('invalid_field_value', `${stepPath}.id`);
    // Only earlier steps are in stepIds here, so a forward or self reference cannot resolve.
    for (let j = 0; j < step.depends_on.length; j++) {
      if (!stepIds.has(step.depends_on[j])) return fail('invalid_reference', `${stepPath}.depends_on[${j}]`);
    }
    for (let j = 0; j < step.source_ids.length; j++) {
      if (!sourceKinds.has(step.source_ids[j])) return fail('invalid_reference', `${stepPath}.source_ids[${j}]`);
    }
    const human = step.actor === 'human';
    if (human !== (step.checkpoint_id !== null)) {
      return fail('invalid_field_value', human ? `${stepPath}.actor` : `${stepPath}.checkpoint_id`);
    }
    if (step.checkpoint_id !== null && !checkpointIds.has(step.checkpoint_id)) {
      return fail('invalid_reference', `${stepPath}.checkpoint_id`);
    }
    const badCheck = checkStepCheck(step.check, `${stepPath}.check`, adapter, sourceKinds);
    if (badCheck) return badCheck;
    stepIds.add(step.id);
  }

  const badProof = checkProof(value.proof, '$.proof', active, sourceKinds);
  if (badProof) return badProof;

  const fixture = value.fixture;
  if (fixture !== null) {
    if (!isRecord(fixture)) return fail('invalid_field_value', '$.fixture');
    const badFixture = checkKeys(fixture, ['cases'], '$.fixture');
    if (badFixture) return badFixture;
    const cases = fixture.cases;
    if (!isRecord(cases) || Object.keys(cases).length === 0) return fail('invalid_field_value', '$.fixture.cases');
    for (const name of Object.keys(cases)) {
      const casePath = `$.fixture.cases.${name}`;
      if (!isId(name)) return fail('invalid_field_value', casePath);
      const badCase = adapter === 'fixture_voucher' ? checkVoucherCase(cases[name], casePath) : checkBrowserCase(cases[name], casePath);
      if (badCase) return badCase;
    }
  }

  return { ok: true, ref: value as unknown as TaskRefV1 };
}

const MANIFEST_KEYS = ['schema_version', 'kind', 'tasks'] as const;
const MANIFEST_ENTRY_KEYS = ['task_id', 'revision', 'ref_path', 'ref_sha256', 'bindings'] as const;
const BINDING_KEYS = ['card_ids', 'feed_ids', 'domains'] as const;
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

function isAsciiToken(value: unknown): boolean {
  return typeof value === 'string' && ASCII_TOKEN_RE.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_RE.test(value);
}

/**
 * Validates a task manifest. Field-level faults report unknown_field or
 * invalid_field_value, a ref_path that disagrees with task_id and revision
 * reports invalid_reference, and document-level faults (shape, version, kind,
 * duplicate task_id, a binding claimed by more than one place) report invalid_manifest.
 */
export function parseManifest(value: unknown): { ok: true; manifest: TaskManifestV1 } | Fail {
  if (!isRecord(value)) return fail('invalid_manifest', '$');
  const badKeys = checkKeys(value, MANIFEST_KEYS, '$');
  if (badKeys) return badKeys;
  if (value.schema_version !== TASK_SCHEMA_VERSION) return fail('invalid_manifest', '$.schema_version');
  if (value.kind !== 'task_manifest') return fail('invalid_manifest', '$.kind');
  if (!Array.isArray(value.tasks)) return fail('invalid_manifest', '$.tasks');

  const taskIds = new Set<string>();
  const claimed = { card_ids: new Set<string>(), feed_ids: new Set<string>(), domains: new Set<string>() };
  for (let i = 0; i < value.tasks.length; i++) {
    const entryPath = `$.tasks[${i}]`;
    const entry = value.tasks[i];
    if (!isRecord(entry)) return fail('invalid_manifest', entryPath);
    const badEntry = checkKeys(entry, MANIFEST_ENTRY_KEYS, entryPath);
    if (badEntry) return badEntry;
    if (!isId(entry.task_id)) return fail('invalid_field_value', `${entryPath}.task_id`);
    if (taskIds.has(entry.task_id)) return fail('invalid_manifest', `${entryPath}.task_id`);
    taskIds.add(entry.task_id);
    if (!isPositiveInt(entry.revision)) return fail('invalid_field_value', `${entryPath}.revision`);
    if (entry.ref_path !== `${entry.task_id}.v${entry.revision}.json`) return fail('invalid_reference', `${entryPath}.ref_path`);
    if (!isSha256(entry.ref_sha256)) return fail('invalid_field_value', `${entryPath}.ref_sha256`);

    const bindings = entry.bindings;
    if (!isRecord(bindings)) return fail('invalid_field_value', `${entryPath}.bindings`);
    const badBindings = checkKeys(bindings, BINDING_KEYS, `${entryPath}.bindings`);
    if (badBindings) return badBindings;
    for (const field of BINDING_KEYS) {
      const list = bindings[field];
      const fieldPath = `${entryPath}.bindings.${field}`;
      if (!Array.isArray(list)) return fail('invalid_field_value', fieldPath);
      for (let j = 0; j < list.length; j++) {
        const itemPath = `${fieldPath}[${j}]`;
        const item = list[j];
        const wellFormed =
          field === 'domains' ? typeof item === 'string' && DOMAIN_RE.test(item) && item.includes('.') : isAsciiToken(item);
        if (!wellFormed) return fail('invalid_field_value', itemPath);
        if (claimed[field].has(item)) return fail('invalid_manifest', itemPath);
        claimed[field].add(item);
      }
    }
  }
  return { ok: true, manifest: value as unknown as TaskManifestV1 };
}

const RUN_REPORT_KEYS = [
  'schema_version',
  'kind',
  'task_id',
  'revision',
  'ref_sha256',
  'mode',
  'status',
  'attempted_steps',
  'evidence',
  'missing_capabilities',
  'checkpoint',
  'error',
] as const;

/**
 * Validates a run report: exact keys, enums, and the rules that tie error and
 * checkpoint to the run status. A report may drop task identity only when the
 * input itself was invalid.
 *
 * ponytail: the spec gives checkpoint action and resume_when no text rule. They
 * get the same reviewed-text rule as the task ref checkpoint they mirror.
 */
export function parseRunReport(value: unknown): { ok: true; report: RunReportV1 } | Fail {
  if (!isRecord(value)) return fail('invalid_field_value', '$');
  const badKeys = checkKeys(value, RUN_REPORT_KEYS, '$');
  if (badKeys) return badKeys;
  if (value.schema_version !== TASK_SCHEMA_VERSION) return fail('invalid_field_value', '$.schema_version');
  if (value.kind !== 'run_report') return fail('invalid_field_value', '$.kind');
  if (!isOneOf(RUN_STATUSES, value.status)) return fail('invalid_field_value', '$.status');
  const status = value.status;

  if (value.error !== null && !isOneOf(ERROR_CODES, value.error)) return fail('invalid_field_value', '$.error');
  if ((value.error !== null) !== (status === 'invalid_input')) return fail('invalid_field_value', '$.error');

  const identity: [key: string, isValid: (item: unknown) => boolean][] = [
    ['task_id', isId],
    ['revision', isPositiveInt],
    ['ref_sha256', isSha256],
    ['mode', (item) => isOneOf(TASK_MODES, item)],
  ];
  for (const [key, isValid] of identity) {
    if (value[key] === null) {
      if (status !== 'invalid_input') return fail('invalid_field_value', `$.${key}`);
    } else if (!isValid(value[key])) {
      return fail('invalid_field_value', `$.${key}`);
    }
  }

  const steps = value.attempted_steps;
  if (!Array.isArray(steps)) return fail('invalid_field_value', '$.attempted_steps');
  for (let i = 0; i < steps.length; i++) {
    const stepPath = `$.attempted_steps[${i}]`;
    const step = steps[i];
    if (!isRecord(step)) return fail('invalid_field_value', stepPath);
    const badStep = checkKeys(step, ['id', 'outcome', 'source_ids'], stepPath);
    if (badStep) return badStep;
    if (!isId(step.id)) return fail('invalid_field_value', `${stepPath}.id`);
    if (!isOneOf(STEP_OUTCOMES, step.outcome)) return fail('invalid_field_value', `${stepPath}.outcome`);
    const badSources = checkArray(step.source_ids, `${stepPath}.source_ids`, isId);
    if (badSources) return badSources;
  }

  const evidence = value.evidence;
  if (!isRecord(evidence)) return fail('invalid_field_value', '$.evidence');
  const evidenceKeys = Object.keys(EVIDENCE_ENUMS) as (keyof RunEvidence)[];
  const badEvidence = checkKeys(evidence, evidenceKeys, '$.evidence');
  if (badEvidence) return badEvidence;
  for (const key of evidenceKeys) {
    if (!isOneOf(EVIDENCE_ENUMS[key], evidence[key])) return fail('invalid_field_value', `$.evidence.${key}`);
  }

  const badCapabilities = checkArray(value.missing_capabilities, '$.missing_capabilities', (item) => isOneOf(CAPABILITIES, item));
  if (badCapabilities) return badCapabilities;

  const checkpoint = value.checkpoint;
  if (checkpoint === null) {
    if (status === 'needs_user') return fail('invalid_field_value', '$.checkpoint');
  } else {
    if (!isRecord(checkpoint)) return fail('invalid_field_value', '$.checkpoint');
    const badCheckpoint = checkKeys(checkpoint, ['id', 'type', 'human_action_required_now', 'action', 'resume_when'], '$.checkpoint');
    if (badCheckpoint) return badCheckpoint;
    if (!isId(checkpoint.id)) return fail('invalid_field_value', '$.checkpoint.id');
    if (!isOneOf(CHECKPOINT_TYPES, checkpoint.type)) return fail('invalid_field_value', '$.checkpoint.type');
    if (typeof checkpoint.human_action_required_now !== 'boolean') {
      return fail('invalid_field_value', '$.checkpoint.human_action_required_now');
    }
    if (!isReviewedText(checkpoint.action)) return fail('invalid_field_value', '$.checkpoint.action');
    if (!isReviewedText(checkpoint.resume_when)) return fail('invalid_field_value', '$.checkpoint.resume_when');
    const requiredNow = checkpoint.human_action_required_now;
    if (status === 'needs_user') {
      if (!requiredNow) return fail('invalid_field_value', '$.checkpoint.human_action_required_now');
    } else if (status === 'blocked_not_active') {
      if (checkpoint.type !== 'await_activation' || requiredNow) return fail('invalid_field_value', '$.checkpoint');
    } else {
      return fail('invalid_field_value', '$.checkpoint');
    }
  }
  return { ok: true, report: value as unknown as RunReportV1 };
}
