import { describe, expect, test } from 'bun:test';
import {
  ACTIVATION_STATES,
  ADAPTERS,
  CAPABILITIES,
  CHECKPOINT_TYPES,
  EVIDENCE_ENUMS,
  ERROR_CODES,
  ErrorCode,
  ID_RE,
  RUN_STATUSES,
  SHA256_RE,
  SOURCE_KINDS,
  STEP_OUTCOMES,
  TASK_MODES,
  TASK_SCHEMA_VERSION,
  RunReportV1,
  RunStatus,
  TaskManifestV1,
  TaskRefV1,
  canonicalJson,
  containsUrl,
  parseManifest,
  parseRunReport,
  parseStrictJson,
  parseTaskRef,
  scanSecrets,
} from './taskContract';

function parseOk(text: string, maxBytes = 4096): unknown {
  const result = parseStrictJson(text, maxBytes);
  if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
  return result.value;
}

function parseError(text: string, maxBytes = 4096): string {
  const result = parseStrictJson(text, maxBytes);
  if (result.ok) throw new Error('expected a failure');
  return result.error;
}

describe('contract constants', () => {
  test('match the frozen v1 spec', () => {
    expect(TASK_SCHEMA_VERSION).toBe(1);
    expect(RUN_STATUSES).toEqual([
      'invalid_input',
      'blocked_not_active',
      'blocked_missing_capability',
      'ineligible',
      'needs_user',
      'verified_fixture',
      'verified_live',
    ]);
    expect(TASK_MODES).toEqual(['synthetic_fixture', 'live_read_only']);
    expect(ADAPTERS).toEqual({
      fixture_voucher: 'synthetic_fixture',
      fixture_browser_email: 'synthetic_fixture',
      http_read_only: 'live_read_only',
    });
    expect(CAPABILITIES).toEqual(['network_read', 'browser', 'email_inbox', 'wallet_human']);
    expect(CHECKPOINT_TYPES).toEqual([
      'await_activation',
      'batch_inputs',
      'login',
      'email_verification',
      'captcha',
      'kyc',
      'wallet_signature',
      'form_submit',
    ]);
    expect(SOURCE_KINDS).toEqual(['official_documentation', 'public_read_only_endpoint', 'official_app']);
    expect(STEP_OUTCOMES).toEqual(['pass', 'fail', 'blocked', 'needs_user', 'skipped']);
    expect(ACTIVATION_STATES).toEqual(['active', 'not_active', 'unknown']);
    expect(EVIDENCE_ENUMS).toEqual({
      activation: ['active', 'not_active', 'unknown'],
      network: ['matched', 'mismatched', 'not_checked'],
      eligibility: ['eligible', 'ineligible', 'not_checked'],
      receipt: ['matched', 'missing', 'mismatched', 'failed', 'not_finalized', 'not_checked'],
      account_status: ['verified', 'pending', 'unverified', 'origin_mismatch', 'not_checked'],
    });
    expect(ERROR_CODES).toEqual([
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
    ]);
  });

  test('ID_RE accepts 1..64 char lowercase ids and nothing else', () => {
    for (const id of ['a', '0', 'a-b_c9', `${'a'.repeat(62)}z`, `${'a'.repeat(63)}z`]) {
      expect(ID_RE.test(id)).toBe(true);
    }
    for (const id of ['', '-a', 'a-', '_a', 'a_', 'A', 'a.b', 'a b', `${'a'.repeat(64)}z`]) {
      expect(ID_RE.test(id)).toBe(false);
    }
  });

  test('SHA256_RE accepts exactly 64 lowercase hex chars', () => {
    expect(SHA256_RE.test('ab'.repeat(32))).toBe(true);
    expect(SHA256_RE.test('AB'.repeat(32))).toBe(false);
    expect(SHA256_RE.test('a'.repeat(63))).toBe(false);
    expect(SHA256_RE.test('a'.repeat(65))).toBe(false);
    expect(SHA256_RE.test(`0x${'a'.repeat(64)}`)).toBe(false);
  });
});

describe('parseStrictJson', () => {
  test('returns values identical to the platform JSON parser', () => {
    const text =
      ' {"s":"a\\"b\\\\c\\/d\\b\\f\\n\\r\\t\\u0041\\ud83d\\ude00","n":[-0,0.5,-12.34,1e5,1E+5,1e-5,123],' +
      '"l":[true,false,null],"o":{"k":[]},"e":{}}\r\n\t';
    expect(JSON.stringify(parseOk(text))).toBe(JSON.stringify(JSON.parse(text)));
    expect(Object.is(parseOk('-0'), -0)).toBe(true);
    expect(parseOk('1e5')).toBe(100000);
    expect(parseOk('"\\u00e9"')).toBe(String.fromCodePoint(0xe9));
    expect(parseOk('"\\ud83d\\ude00"')).toBe(String.fromCodePoint(0x1f600));
    expect(parseOk('"\\u007f"')).toBe(String.fromCodePoint(0x7f));
    expect(JSON.stringify(parseOk('{"a\\nb":1}'))).toBe(JSON.stringify(JSON.parse('{"a\\nb":1}')));
  });

  test('accepts top-level scalars and empty containers', () => {
    expect(parseOk('1')).toBe(1);
    expect(parseOk('"x"')).toBe('x');
    expect(parseOk(' null ')).toBeNull();
    expect(parseOk('true')).toBe(true);
    expect(JSON.stringify(parseOk('{}'))).toBe('{}');
    expect(JSON.stringify(parseOk('[]'))).toBe('[]');
    expect(JSON.stringify(parseOk('[[],{}]'))).toBe('[[],{}]');
  });

  test('allows the same key in sibling objects', () => {
    expect(JSON.stringify(parseOk('{"a":{"x":1},"b":{"x":2}}'))).toBe('{"a":{"x":1},"b":{"x":2}}');
  });

  test('keeps an own __proto__ key without polluting Object.prototype', () => {
    const parsed = parseOk('{"__proto__":{"polluted":1},"a":2}') as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['__proto__', 'a']);
    expect(JSON.stringify(parsed)).toBe('{"__proto__":{"polluted":1},"a":2}');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('allows 32 nesting levels and rejects 33', () => {
    const nest = (levels: number): string => '['.repeat(levels) + '1' + ']'.repeat(levels);
    expect(JSON.stringify(parseOk(nest(32)))).toBe(nest(32));
    expect(JSON.stringify(parseOk(`{"a":${nest(31)}}`))).toBe(`{"a":${nest(31)}}`);
    expect(parseError(nest(33))).toBe('malformed_json');
    expect(parseError(`{"a":${nest(32)}}`)).toBe('malformed_json');
  });

  test('rejects input over the UTF-8 byte budget before parsing', () => {
    expect(parseError('{"a":1}', 6)).toBe('input_too_large');
    expect(parseStrictJson('{"a":1}', 7).ok).toBe(true);
    const multibyte = `"${String.fromCodePoint(0xe9, 0xe9, 0xe9)}"`;
    expect(parseStrictJson(multibyte, 8).ok).toBe(true);
    expect(parseError(multibyte, 7)).toBe('input_too_large');
    expect(parseError('{', 0)).toBe('input_too_large');
  });

  test('rejects duplicate keys at any depth, including escaped spellings', () => {
    expect(parseError('{"a":1,"a":2}')).toBe('duplicate_json_field');
    expect(parseError('{"x":{"a":1,"b":2,"a":3}}')).toBe('duplicate_json_field');
    expect(parseError('{"a":1,"\\u0061":2}')).toBe('duplicate_json_field');
    expect(parseError('{"a":1,"a":2,')).toBe('duplicate_json_field');
  });

  test('rejects malformed JSON', () => {
    const malformed: [string, string][] = [
      ['empty input', ''],
      ['truncated object', '{"a":1'],
      ['truncated array', '[1, 2'],
      ['trailing comma in array', '[1,]'],
      ['trailing comma in object', '{"a":1,}'],
      ['line comment', '{// nope}'],
      ['block comment', '{/* nope */}'],
      ['NaN literal', '[NaN]'],
      ['Infinity literal', '[Infinity]'],
      ['-Infinity literal', '[-Infinity]'],
      ['trailing token after object', '{} {}'],
      ['trailing token after scalar', '1 2'],
      ['garbage suffix', '{"a":1}x'],
      ['missing value', '{"a":}'],
      ['unquoted key', '{a:1}'],
      ['single quotes', "{'a':1}"],
      ['leading zero', '01'],
      ['bare dot', '.5'],
      ['trailing dot', '1.'],
      ['plus sign', '+1'],
      ['bare minus', '-'],
      ['double minus', '--1'],
      ['exponent without digits', '1e'],
      ['exponent sign without digits', '1e+'],
      ['hex literal', '0x10'],
      ['unterminated string', '"abc'],
      ['raw newline in string', '"a\nb"'],
      ['raw tab in string', '"a\tb"'],
      ['raw control char in string', '"a\u0001b"'],
      ['vertical tab whitespace', '\v{}'],
      ['form feed whitespace', '\f{}'],
      ['non-breaking space whitespace', '\u00a0{}'],
      ['byte order mark', '\ufeff{}'],
      ['unknown escape', '"a\\qb"'],
      ['escaped single quote', '"a\\\'"'],
      ['hex escape', '"a\\x41b"'],
      ['short unicode escape', '"a\\u12b"'],
      ['bad unicode escape', '"a\\u00G1b"'],
      ['code point escape', '"a\\u{41}b"'],
      ['lone high surrogate escape', '"\\ud800"'],
      ['lone low surrogate escape', '"\\udc00"'],
      ['high surrogate escape then plain escape', '"\\ud800\\u0041"'],
      ['high surrogate escape then text', '"\\ud800a"'],
      ['lone raw high surrogate', '"\ud800"'],
      ['lone raw low surrogate', '"\udc00"'],
      ['number beyond double range', '1e999'],
    ];
    for (const [name, text] of malformed) {
      const error = parseError(text);
      if (error !== 'malformed_json') throw new Error(`${name}: expected malformed_json, got ${error}`);
    }
    // Guards the loop above against an empty or skipped table.
    expect(malformed.length).toBeGreaterThan(40);
  });
});

describe('canonicalJson', () => {
  test('sorts object keys recursively and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, 1, { z: 1, y: 2 }] } })).toBe('{"a":{"c":[3,1,{"y":2,"z":1}],"d":2},"b":1}');
  });

  test('sorts integer-like keys lexicographically', () => {
    const value = JSON.parse('{"b":1,"10":"x","9":"y","a":2}');
    expect(canonicalJson(value)).toBe('{"10":"x","9":"y","a":2,"b":1}');
  });

  test('does not depend on input key order', () => {
    const first = JSON.parse('{"z":1,"a":{"y":2,"b":3}}');
    const second = JSON.parse('{"a":{"b":3,"y":2},"z":1}');
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(canonicalJson(first)).toBe('{"a":{"b":3,"y":2},"z":1}');
  });

  test('serializes scalars like JSON.stringify', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(1.5)).toBe('1.5');
    expect(canonicalJson(1e21)).toBe('1e+21');
    expect(canonicalJson('a"b\nc')).toBe('"a\\"b\\nc"');
    expect(canonicalJson(String.fromCodePoint(0xe9))).toBe(JSON.stringify(String.fromCodePoint(0xe9)));
    expect(canonicalJson([])).toBe('[]');
    expect(canonicalJson({})).toBe('{}');
  });

  test('normalizes -0 to 0', () => {
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson({ a: -0, b: [-0] })).toBe('{"a":0,"b":[0]}');
  });

  test('keeps an own __proto__ key', () => {
    expect(canonicalJson(JSON.parse('{"__proto__":1,"a":2}'))).toBe('{"__proto__":1,"a":2}');
  });

  test('round-trips through JSON.parse', () => {
    const doc = { z: [1, 'two', null, { b: false, a: 'x' }], a: 'last', n: 3.25 };
    expect(JSON.parse(canonicalJson(doc))).toEqual(doc);
  });

  test('delegates to toJSON like JSON.stringify', () => {
    expect(canonicalJson(new Date(0))).toBe(JSON.stringify(new Date(0)));
  });

  test('throws on values JSON cannot represent instead of dropping them', () => {
    for (const value of [undefined, NaN, Infinity, -Infinity, { a: undefined }, [undefined], () => 1, Symbol('x')]) {
      expect(() => canonicalJson(value)).toThrow(TypeError);
    }
    expect(() => canonicalJson(1n)).toThrow(TypeError);
  });
});

// Sensitive samples are assembled from fragments so secret scanners do not flag this file.
const HEX64 = 'ab'.repeat(32);
const JWT_SAMPLE = ['ey', 'JhbGciOiJIUzI1NiJ9', '.ey', 'JzdWIiOiIxMjM0NTY3ODkwIn0.', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'].join('');
const EMAIL_SAMPLE = ['someone', '@', 'example', '.', 'org'].join('');
const seedWords = (count: number): string[] => [...Array(count - 1).fill('abandon'), 'about'];

describe('scanSecrets', () => {
  test('flags secret-shaped string values', () => {
    const samples: [string, string][] = [
      ['JWT', JWT_SAMPLE],
      ['bearer header', ['Bea', 'rer abcdefghijklmnop'].join('')],
      ['set-cookie header', ['Set-Coo', 'kie: sid=abcdefgh'].join('')],
      ['host-prefixed cookie', ['__Host-sess', 'ion=abc'].join('')],
      ['secure-prefixed cookie', ['__Secure-to', 'ken=abc'].join('')],
      ['express session cookie', ['connect', '.sid=abc'].join('')],
      ['php session cookie', ['PHPSESS', 'ID=abc'].join('')],
      ['session id cookie', ['session', 'id=abc'].join('')],
      ['bare 64 hex', HEX64],
      ['0x-prefixed 64 hex', `0x${HEX64}`],
      ['64 hex inside a sentence', `hash ${HEX64} end`],
      ['12 word seed phrase', seedWords(12).join(' ')],
      ['24 word seed phrase', seedWords(24).join(' ')],
      ['seed phrase after a short lead-in', `now ${seedWords(12).join(' ')}`],
      ['standalone 4 digit code', 'code 1234'],
      ['standalone 8 digit code', 'ref 12345678'],
    ];
    for (const [name, text] of samples) {
      const finding = scanSecrets({ note: text });
      if (finding !== 'secret_detected') throw new Error(`${name}: expected secret_detected, got ${finding}`);
    }
    expect(samples.length).toBeGreaterThan(15);
  });

  test('flags an email address as PII', () => {
    expect(scanSecrets({ contact: `write to ${EMAIL_SAMPLE} for help` })).toBe('pii_detected');
  });

  test('leaves ordinary task text alone', () => {
    for (const text of [
      'Claim tokens on the demo app.',
      'block 190000000',
      '2026-01-15T09:30:00Z',
      'cd'.repeat(20),
      'version 1.2.3',
      'abc123456',
      '123456789',
      seedWords(11).join(' '),
      `${seedWords(11).join(' ')} the ${seedWords(11).join(' ')}`,
    ]) {
      expect(scanSecrets({ note: text })).toBeNull();
    }
  });

  test('flags sensitive key names whatever the value', () => {
    const keys = [
      'token',
      'api_key',
      'apiKey',
      'auth-token',
      'sessionId',
      'one-time-password',
      'passwd',
      'otp_code',
      'OTP',
      'mnemonic',
      'authorization',
      'bearer',
      'seed',
      'secret',
      'privateKey',
      'cookies',
      'Set-Cookie',
    ];
    for (const key of keys) {
      expect(scanSecrets({ [key]: 'x' })).toBe('secret_detected');
    }
    expect(scanSecrets({ nested: { password: null } })).toBe('secret_detected');
  });

  test('flags PII key names', () => {
    for (const key of ['email', 'phone', 'phoneNumber', 'contact_email', 'phone_number', 'E_MAIL']) {
      expect(scanSecrets({ [key]: 1 })).toBe('pii_detected');
    }
  });

  test('ignores keys that only contain a sensitive word as a substring', () => {
    for (const key of ['tokenized', 'sessions', 'seeded', 'heading', 'required_capabilities', 'account_status', 'checkpoint_id']) {
      expect(scanSecrets({ [key]: 'x' })).toBeNull();
    }
  });

  test('normalizes keys and values before matching', () => {
    expect(scanSecrets({ 'pa\u200bssword': 'x' })).toBe('secret_detected');
    expect(scanSecrets({ 'to\u00adken': 'x' })).toBe('secret_detected');
    expect(scanSecrets({ '\uff54\uff4f\uff4b\uff45\uff4e': 'x' })).toBe('secret_detected');
    expect(scanSecrets({ note: ['ey', '\u200b', 'JhbGciOiJIUzI1NiJ9.ey', 'JzdWIiOiIxMjM0NTY3ODkwIn0.abcdefgh'].join('') })).toBe('secret_detected');
  });

  test('flags 4 to 8 digit integers outside schema_version and revision', () => {
    for (const amount of [1000, 123456, 99999999]) {
      expect(scanSecrets({ amount })).toBe('secret_detected');
    }
    for (const amount of [999, 100000000, 12.5, 0, -1]) {
      expect(scanSecrets({ amount })).toBeNull();
    }
    expect(scanSecrets({ schema_version: 12345 })).toBeNull();
    expect(scanSecrets({ revision: 12345 })).toBeNull();
    expect(scanSecrets({ nested: { revision: 12345 } })).toBe('secret_detected');
    expect(scanSecrets({ items: [12345] })).toBe('secret_detected');
  });

  test('reports a secret ahead of PII regardless of key order', () => {
    expect(scanSecrets({ email_token: 'x' })).toBe('secret_detected');
    expect(scanSecrets({ a: EMAIL_SAMPLE, b: { token: 'x' } })).toBe('secret_detected');
    expect(scanSecrets({ b: { token: 'x' }, a: EMAIL_SAMPLE })).toBe('secret_detected');
  });

  test('exempts only the named paths', () => {
    expect(scanSecrets({ ref_sha256: HEX64 })).toBe('secret_detected');
    expect(scanSecrets({ ref_sha256: HEX64 }, new Set(['$.ref_sha256']))).toBeNull();
    expect(scanSecrets([HEX64], new Set(['$[*]']))).toBeNull();
    expect(scanSecrets({ steps: [{ check: { pins: { chain: HEX64 } } }] }, new Set(['$.steps[*].check.pins.*']))).toBeNull();
    expect(scanSecrets({ proof: { pins: { contract: '12345678' } } }, new Set(['$.proof.pins.*']))).toBeNull();
    expect(scanSecrets({ checkpoint: { action: 'Enter code 123456' } }, new Set(['$.checkpoint.action']))).toBeNull();
  });

  test('does not extend a wildcard exemption to grandchildren, siblings, or key names', () => {
    const pins = new Set(['$.steps[*].check.pins.*']);
    expect(scanSecrets({ steps: [{ check: { pins: { deep: { chain: HEX64 } } } }] }, pins)).toBe('secret_detected');
    expect(scanSecrets({ steps: [{ title: HEX64, check: { pins: { chain: HEX64 } } }] }, pins)).toBe('secret_detected');
    expect(scanSecrets({ steps: [{ check: { pins: { token: 'abc' } } }] }, pins)).toBe('secret_detected');
  });
});

describe('containsUrl', () => {
  test('detects http, https, and www. in string values at any depth', () => {
    const link = ['ht', 'tps://app.demo.test/claim'].join('');
    expect(containsUrl({ a: link })).toBe(true);
    expect(containsUrl({ a: ['plain', `see ${link}`] })).toBe(true);
    expect(containsUrl('www.demo.test')).toBe(true);
    expect(containsUrl(['HT', 'TP://demo.test'].join(''))).toBe(true);
  });

  test('ignores keys, non-strings, and exempt paths', () => {
    const link = ['ht', 'tps://app.demo.test'].join('');
    expect(containsUrl({ [link]: 1, n: 42, b: null, c: true })).toBe(false);
    expect(containsUrl({ a: link }, new Set(['$.a']))).toBe(false);
    expect(containsUrl({ a: link, b: link }, new Set(['$.a']))).toBe(true);
    expect(containsUrl({ official_sources: [{ url: link }] }, new Set(['$.official_sources[*].url']))).toBe(false);
    expect(containsUrl(null)).toBe(false);
  });

  test('normalizes before matching', () => {
    expect(containsUrl({ a: ['ht', '\u200b', 'tps://demo.test'].join('') })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseTaskRef
// ---------------------------------------------------------------------------

type Mutable = Record<string, any>;
type Parsed = { ok: true } | { ok: false; error: ErrorCode; path: string };
type Acceptance = [name: string, change: (doc: Mutable) => void];
type Rejection = [name: string, change: (doc: Mutable) => void, error: ErrorCode, path: string];

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
];

const REVIEW = { reviewed_by: 'reviewer-one', reviewed_at: '2026-01-15T09:30:00Z' };

function liveRef(): TaskRefV1 {
  return {
    schema_version: 1,
    kind: 'task_ref',
    task_id: 'demo-claim',
    revision: 1,
    title: 'Demo claim',
    summary: 'Claim tokens on the demo app.',
    mode: 'live_read_only',
    adapter: 'http_read_only',
    review: { ...REVIEW },
    networks: ['demo-chain'],
    activation: { state: 'active', source_ids: ['docs'] },
    required_capabilities: ['network_read'],
    official_sources: [
      { id: 'docs', kind: 'official_documentation', url: 'https://docs.demo.test/claim' },
      { id: 'api', kind: 'public_read_only_endpoint', url: 'https://api.demo.test/v1/status' },
    ],
    steps: [
      {
        id: 'check-status',
        title: 'Check the status endpoint',
        actor: 'agent',
        depends_on: [],
        source_ids: ['api'],
        check: { type: 'http_json_pins', source_id: 'api', pins: { active: 'true' } },
        checkpoint_id: null,
      },
      {
        id: 'confirm',
        title: 'Confirm the result',
        actor: 'agent',
        depends_on: ['check-status'],
        source_ids: [],
        check: { type: 'reviewed_activation' },
        checkpoint_id: null,
      },
    ],
    checkpoints: [],
    proof: {
      kind: 'onchain_receipt',
      pins: { chain: 'demo-chain', contract: 'c1', event: 'Claimed', recipient: 'r1', voucher_id: 'v1' },
    },
    fixture: null,
  };
}

const VOUCHER_RECEIPT = {
  chain: 'demo-chain',
  contract: 'c1',
  event: 'Claimed',
  recipient: 'r1',
  voucher_id: 'v1',
  success: true,
  finalized: true,
};

function voucherRef(): TaskRefV1 {
  return {
    schema_version: 1,
    kind: 'task_ref',
    task_id: 'demo-voucher',
    revision: 3,
    title: 'Voucher check',
    summary: 'Run the voucher fixture.',
    mode: 'synthetic_fixture',
    adapter: 'fixture_voucher',
    review: { ...REVIEW },
    networks: ['demo-chain'],
    activation: { state: 'unknown', source_ids: ['docs'] },
    required_capabilities: [],
    official_sources: [{ id: 'docs', kind: 'official_documentation', url: 'https://docs.demo.test/voucher' }],
    steps: [
      {
        id: 'wait',
        title: 'Wait for activation',
        actor: 'human',
        depends_on: [],
        source_ids: [],
        check: null,
        checkpoint_id: 'activation',
      },
      {
        id: 'eligibility',
        title: 'Check fixture eligibility',
        actor: 'agent',
        depends_on: ['wait'],
        source_ids: [],
        check: { type: 'fixture_eligibility' },
        checkpoint_id: null,
      },
      {
        id: 'receipt',
        title: 'Check fixture receipt',
        actor: 'agent',
        depends_on: ['eligibility'],
        source_ids: [],
        check: { type: 'fixture_receipt' },
        checkpoint_id: null,
      },
    ],
    checkpoints: [
      {
        id: 'activation',
        type: 'await_activation',
        action: 'Tell the agent when the campaign is active.',
        resume_when: 'The campaign is active.',
      },
    ],
    proof: { kind: 'unknown_until_active' },
    fixture: {
      cases: {
        eligible_final: { eligible: true, receipt: { ...VOUCHER_RECEIPT } },
        eligible_missing: { eligible: true, receipt: null },
        ineligible: { eligible: false, receipt: null },
      },
    },
  };
}

function browserRef(): TaskRefV1 {
  const origin = 'https://app.demo.test';
  return {
    schema_version: 1,
    kind: 'task_ref',
    task_id: 'demo-mail',
    revision: 2,
    title: 'Account status check',
    summary: 'Run the browser and email fixture.',
    mode: 'synthetic_fixture',
    adapter: 'fixture_browser_email',
    review: { ...REVIEW },
    networks: [],
    activation: { state: 'not_active', source_ids: [] },
    required_capabilities: ['browser', 'email_inbox'],
    official_sources: [],
    steps: [
      {
        id: 'status',
        title: 'Check the account status',
        actor: 'agent',
        depends_on: [],
        source_ids: [],
        check: { type: 'fixture_account_status' },
        checkpoint_id: null,
      },
    ],
    checkpoints: [
      { id: 'activation', type: 'await_activation', action: 'Wait for the campaign.', resume_when: 'Later.' },
    ],
    proof: { kind: 'unknown_until_active' },
    fixture: {
      cases: {
        verified: { page_origin: origin, account_status: 'verified', inputs_ready: true },
        pending: { page_origin: origin, account_status: 'pending', inputs_ready: false },
      },
    },
  };
}

function mutate(base: () => unknown, change: (doc: Mutable) => void): Mutable {
  // A JSON round trip mimics a document that arrived from disk or the network.
  const doc = JSON.parse(JSON.stringify(base())) as Mutable;
  change(doc);
  return doc;
}

function expectRejections(parse: (value: unknown) => Parsed, base: () => unknown, rejections: Rejection[]): void {
  for (const [name, change, error, path] of rejections) {
    const result = parse(mutate(base, change));
    if (result.ok) throw new Error(`${name}: expected ${error} at ${path}, got ok`);
    expect({ name, error: result.error, path: result.path }).toEqual({ name, error, path });
  }
}

function expectRootRejection(parse: (value: unknown) => Parsed, error: ErrorCode): void {
  for (const root of [null, undefined, 1, 'x', [], true]) {
    const result = parse(root);
    expect({ error: result.ok ? null : result.error, path: result.ok ? null : result.path }).toEqual({ error, path: '$' });
  }
}

describe('parseTaskRef', () => {
  test('accepts valid refs for every adapter and returns the same document', () => {
    for (const build of [liveRef, voucherRef, browserRef]) {
      const ref = build();
      const result = parseTaskRef(ref);
      if (!result.ok) throw new Error(`${result.error} at ${result.path}`);
      expect(result.ref).toBe(ref);
    }
    expect(Object.keys(liveRef())).toEqual(TASK_REF_KEYS);
  });

  test('accepts refs that came out of parseStrictJson', () => {
    for (const build of [liveRef, voucherRef, browserRef]) {
      const result = parseTaskRef(parseOk(JSON.stringify(build())));
      expect(result.ok).toBe(true);
    }
  });

  test('accepts every proof kind and check placement the spec allows', () => {
    const appSource = { id: 'app', kind: 'official_app', url: 'https://app.demo.test' };
    const waiting = [
      { id: 'activation', type: 'await_activation', action: 'Wait for the campaign.', resume_when: 'Later.' },
    ];
    const okCases: Acceptance[] = [
      ['account_status proof', (r) => {
        r.official_sources.push(appSource);
        r.proof = { kind: 'account_status', source_id: 'app', required_status: 'verified' };
      }],
      ['unknown_until_active proof on a not active task', (r) => {
        r.activation.state = 'not_active';
        r.checkpoints = waiting;
        r.proof = { kind: 'unknown_until_active' };
      }],
      ['human step tied to a checkpoint', (r) => {
        r.checkpoints = [{ id: 'login', type: 'login', action: 'Sign in.', resume_when: 'Signed in.' }];
        r.steps[1].actor = 'human';
        r.steps[1].checkpoint_id = 'login';
      }],
      ['reviewed text at the 400 char limit', (r) => {
        r.title = 'a'.repeat(400);
        r.summary = 'Use "quotes" and <angles.';
      }],
      ['reviewed_activation check on an http adapter', (r) => {
        r.steps[0].check = { type: 'reviewed_activation' };
      }],
    ];
    for (const [name, change] of okCases) {
      const result = parseTaskRef(mutate(liveRef, change));
      if (!result.ok) throw new Error(`${name}: ${result.error} at ${result.path}`);
      expect(result.ok).toBe(true);
    }
  });

  test('rejects roots that are not objects', () => {
    expectRootRejection(parseTaskRef, 'invalid_field_value');
  });

  test('rejects invalid fields and broken cross-field rules', () => {
    const checkpoint = { id: 'login', type: 'login', action: 'Sign in.', resume_when: 'Signed in.' };
    expectRejections(parseTaskRef, liveRef, [
      ['unknown top-level field', (r) => { r.extra = 1; }, 'unknown_field', '$.extra'],
      ['missing title', (r) => { delete r.title; }, 'invalid_field_value', '$.title'],
      ['title is not a string', (r) => { r.title = 7; }, 'invalid_field_value', '$.title'],
      ['wrong schema_version', (r) => { r.schema_version = 2; }, 'invalid_field_value', '$.schema_version'],
      ['wrong kind', (r) => { r.kind = 'task'; }, 'invalid_field_value', '$.kind'],
      ['uppercase task_id', (r) => { r.task_id = 'Demo'; }, 'invalid_field_value', '$.task_id'],
      ['zero revision', (r) => { r.revision = 0; }, 'invalid_field_value', '$.revision'],
      ['fractional revision', (r) => { r.revision = 1.5; }, 'invalid_field_value', '$.revision'],
      ['revision as a string', (r) => { r.revision = '1'; }, 'invalid_field_value', '$.revision'],
      ['unknown mode', (r) => { r.mode = 'live_write'; }, 'invalid_field_value', '$.mode'],
      ['unknown adapter', (r) => { r.adapter = 'playwright'; }, 'adapter_not_allowed', '$.adapter'],
      ['adapter named after an Object.prototype member', (r) => { r.adapter = 'toString'; }, 'adapter_not_allowed', '$.adapter'],
      ['adapter is not a string', (r) => { r.adapter = 7; }, 'invalid_field_value', '$.adapter'],
      ['adapter and mode disagree', (r) => { r.mode = 'synthetic_fixture'; }, 'mode_not_allowed', '$.mode'],
      ['fixture on a live task', (r) => { r.fixture = { cases: {} }; }, 'invalid_field_value', '$.fixture'],
      ['review extra field', (r) => { r.review.notes = 'x'; }, 'unknown_field', '$.review.notes'],
      ['review missing reviewed_at', (r) => { delete r.review.reviewed_at; }, 'invalid_field_value', '$.review.reviewed_at'],
      ['reviewed_at with a URL', (r) => { r.review.reviewed_at = 'see www.demo.test'; }, 'invalid_field_value', '$.review.reviewed_at'],
      ['networks is not an array', (r) => { r.networks = 'demo-chain'; }, 'invalid_field_value', '$.networks'],
      ['empty network name', (r) => { r.networks = ['']; }, 'invalid_field_value', '$.networks[0]'],
      ['unknown activation state', (r) => { r.activation.state = 'maybe'; }, 'invalid_field_value', '$.activation.state'],
      ['activation extra field', (r) => { r.activation.note = 'x'; }, 'unknown_field', '$.activation.note'],
      ['activation source does not resolve', (r) => { r.activation.source_ids = ['ghost']; }, 'invalid_reference', '$.activation.source_ids[0]'],
      ['not active without an await_activation checkpoint', (r) => { r.activation.state = 'not_active'; }, 'invalid_field_value', '$.checkpoints'],
      ['unknown state without an await_activation checkpoint', (r) => { r.activation.state = 'unknown'; }, 'invalid_field_value', '$.checkpoints'],
      ['unknown checkpoint type', (r) => { r.checkpoints = [{ ...checkpoint, type: 'wait' }]; }, 'invalid_field_value', '$.checkpoints[0].type'],
      ['checkpoint with a URL in action', (r) => { r.checkpoints = [{ ...checkpoint, action: 'Open https://app.demo.test.' }]; }, 'invalid_field_value', '$.checkpoints[0].action'],
      ['checkpoint with a backtick in resume_when', (r) => { r.checkpoints = [{ ...checkpoint, resume_when: 'Type `yes`.' }]; }, 'invalid_field_value', '$.checkpoints[0].resume_when'],
      ['checkpoint missing action', (r) => { r.checkpoints = [{ id: 'login', type: 'login', resume_when: 'Signed in.' }]; }, 'invalid_field_value', '$.checkpoints[0].action'],
      ['unknown capability', (r) => { r.required_capabilities = ['gpu']; }, 'invalid_field_value', '$.required_capabilities[0]'],
      ['duplicate source ids', (r) => { r.official_sources[1].id = 'docs'; }, 'invalid_field_value', '$.official_sources[1].id'],
      ['source with unknown kind', (r) => { r.official_sources[0].kind = 'blog'; }, 'invalid_field_value', '$.official_sources[0].kind'],
      ['source with an http URL', (r) => { r.official_sources[0].url = 'http://docs.demo.test/claim'; }, 'invalid_field_value', '$.official_sources[0].url'],
      ['source URL with credentials', (r) => { r.official_sources[0].url = 'https://user:pw@docs.demo.test/claim'; }, 'invalid_field_value', '$.official_sources[0].url'],
      ['source URL without a host', (r) => { r.official_sources[0].url = 'https://'; }, 'invalid_field_value', '$.official_sources[0].url'],
      ['source URL with a newline', (r) => { r.official_sources[0].url = 'https://docs.demo.test/claim\n'; }, 'invalid_field_value', '$.official_sources[0].url'],
      ['source extra field', (r) => { r.official_sources[0].method = 'GET'; }, 'unknown_field', '$.official_sources[0].method'],
      ['live task without sources', (r) => { r.official_sources = []; }, 'invalid_field_value', '$.official_sources'],
      ['duplicate step ids', (r) => { r.steps[1].id = 'check-status'; }, 'invalid_field_value', '$.steps[1].id'],
      ['step extra field', (r) => { r.steps[0].notes = 'x'; }, 'unknown_field', '$.steps[0].notes'],
      ['step depends on a later step', (r) => { r.steps[0].depends_on = ['confirm']; }, 'invalid_reference', '$.steps[0].depends_on[0]'],
      ['step depends on itself', (r) => { r.steps[0].depends_on = ['check-status']; }, 'invalid_reference', '$.steps[0].depends_on[0]'],
      ['step depends on an unknown step', (r) => { r.steps[1].depends_on = ['ghost']; }, 'invalid_reference', '$.steps[1].depends_on[0]'],
      ['step source does not resolve', (r) => { r.steps[1].source_ids = ['ghost']; }, 'invalid_reference', '$.steps[1].source_ids[0]'],
      ['human step without a checkpoint', (r) => { r.steps[1].actor = 'human'; }, 'invalid_field_value', '$.steps[1].actor'],
      ['agent step with a checkpoint', (r) => { r.steps[1].checkpoint_id = 'login'; }, 'invalid_field_value', '$.steps[1].checkpoint_id'],
      ['step checkpoint does not resolve', (r) => { r.steps[1].actor = 'human'; r.steps[1].checkpoint_id = 'ghost'; }, 'invalid_reference', '$.steps[1].checkpoint_id'],
      ['unknown step actor', (r) => { r.steps[1].actor = 'robot'; }, 'invalid_field_value', '$.steps[1].actor'],
      ['unknown check type', (r) => { r.steps[0].check = { type: 'screenshot' }; }, 'invalid_field_value', '$.steps[0].check.type'],
      ['check extra field', (r) => { r.steps[0].check.timeout = 5; }, 'unknown_field', '$.steps[0].check.timeout'],
      ['http_json_pins on a documentation source', (r) => { r.steps[0].check.source_id = 'docs'; }, 'invalid_reference', '$.steps[0].check.source_id'],
      ['http_json_pins with empty pins', (r) => { r.steps[0].check.pins = {}; }, 'invalid_field_value', '$.steps[0].check.pins'],
      ['http_json_pins with an empty pin value', (r) => { r.steps[0].check.pins = { active: '' }; }, 'invalid_field_value', '$.steps[0].check.pins.active'],
      ['http_json_pins with a non-ASCII pin value', (r) => { r.steps[0].check.pins = { active: 'caf\u00e9' }; }, 'invalid_field_value', '$.steps[0].check.pins.active'],
      ['http_json_pins on a fixture adapter', (r) => { r.mode = 'synthetic_fixture'; r.adapter = 'fixture_voucher'; r.fixture = voucherRef().fixture; r.steps[0].check = { type: 'fixture_eligibility' }; r.steps[1].check = { type: 'http_json_pins', source_id: 'docs', pins: { a: 'b' } }; }, 'invalid_field_value', '$.steps[1].check.type'],
      ['fixture checks on the http adapter', (r) => { r.steps[0].check = { type: 'fixture_receipt' }; }, 'invalid_field_value', '$.steps[0].check.type'],
      ['fixture_account_status on the voucher adapter', (r) => { r.mode = 'synthetic_fixture'; r.adapter = 'fixture_browser_email'; r.fixture = browserRef().fixture; r.steps[0].check = { type: 'fixture_account_status' }; r.steps[1].check = { type: 'fixture_eligibility' }; }, 'invalid_field_value', '$.steps[1].check.type'],
      ['unknown proof kind', (r) => { r.proof = { kind: 'email' }; }, 'invalid_field_value', '$.proof.kind'],
      ['unknown_until_active proof on an active task', (r) => { r.proof = { kind: 'unknown_until_active' }; }, 'invalid_field_value', '$.proof'],
      ['proof extra field', (r) => { r.proof.note = 'x'; }, 'unknown_field', '$.proof.note'],
      ['onchain proof missing a pin', (r) => { delete r.proof.pins.recipient; }, 'invalid_field_value', '$.proof.pins.recipient'],
      ['onchain proof with an empty pin', (r) => { r.proof.pins.voucher_id = ''; }, 'invalid_field_value', '$.proof.pins.voucher_id'],
      ['account_status proof without an official_app source', (r) => { r.proof = { kind: 'account_status', source_id: 'docs', required_status: 'verified' }; }, 'invalid_reference', '$.proof.source_id'],
      ['account_status proof with another status', (r) => {
        r.official_sources.push({ id: 'app', kind: 'official_app', url: 'https://app.demo.test' });
        r.proof = { kind: 'account_status', source_id: 'app', required_status: 'pending' };
      }, 'invalid_field_value', '$.proof.required_status'],
      ['title with a URL', (r) => { r.title = 'See www.demo.test'; }, 'invalid_field_value', '$.title'],
      ['summary with a backtick', (r) => { r.summary = 'Run `npm install` first.'; }, 'invalid_field_value', '$.summary'],
      ['title with an angle bracket', (r) => { r.title = 'a > b'; }, 'invalid_field_value', '$.title'],
      ['title with a tab', (r) => { r.title = 'a\tb'; }, 'invalid_field_value', '$.title'],
      ['non-ASCII title', (r) => { r.title = 'caf\u00e9'; }, 'invalid_field_value', '$.title'],
      ['empty title', (r) => { r.title = ''; }, 'invalid_field_value', '$.title'],
      ['title over 400 chars', (r) => { r.title = 'a'.repeat(401); }, 'invalid_field_value', '$.title'],
      ['step title over 400 chars', (r) => { r.steps[0].title = 'a'.repeat(401); }, 'invalid_field_value', '$.steps[0].title'],
    ]);
  });

  test('rejects invalid voucher fixtures', () => {
    expectRejections(parseTaskRef, voucherRef, [
      ['fixture missing on a synthetic task', (r) => { r.fixture = null; }, 'invalid_field_value', '$.fixture'],
      ['fixture extra field', (r) => { r.fixture.seed = 1; }, 'unknown_field', '$.fixture.seed'],
      ['fixture without cases', (r) => { r.fixture.cases = {}; }, 'invalid_field_value', '$.fixture.cases'],
      ['case key is not an id', (r) => { r.fixture.cases.UPPER = r.fixture.cases.ineligible; }, 'invalid_field_value', '$.fixture.cases.UPPER'],
      ['case is not an object', (r) => { r.fixture.cases.shortcut = 1; }, 'invalid_field_value', '$.fixture.cases.shortcut'],
      ['case extra field', (r) => { r.fixture.cases.eligible_final.note = 'x'; }, 'unknown_field', '$.fixture.cases.eligible_final.note'],
      ['case missing eligible', (r) => { delete r.fixture.cases.ineligible.eligible; }, 'invalid_field_value', '$.fixture.cases.ineligible.eligible'],
      ['receipt on an ineligible case', (r) => { r.fixture.cases.ineligible.receipt = { ...VOUCHER_RECEIPT }; }, 'receipt_conflicts_with_ineligible', '$.fixture.cases.ineligible.receipt'],
      ['receipt missing finalized', (r) => { delete r.fixture.cases.eligible_final.receipt.finalized; }, 'invalid_field_value', '$.fixture.cases.eligible_final.receipt.finalized'],
      ['receipt extra field', (r) => { r.fixture.cases.eligible_final.receipt.block = 1; }, 'unknown_field', '$.fixture.cases.eligible_final.receipt.block'],
      ['receipt success is not a boolean', (r) => { r.fixture.cases.eligible_final.receipt.success = 'yes'; }, 'invalid_field_value', '$.fixture.cases.eligible_final.receipt.success'],
      ['receipt with an empty chain', (r) => { r.fixture.cases.eligible_final.receipt.chain = ''; }, 'invalid_field_value', '$.fixture.cases.eligible_final.receipt.chain'],
      ['browser observation in a voucher fixture', (r) => { r.fixture.cases.mail = { page_origin: 'https://app.demo.test', account_status: 'verified', inputs_ready: true }; }, 'unknown_field', '$.fixture.cases.mail.page_origin'],
    ]);
  });

  test('rejects invalid browser and email fixtures', () => {
    expectRejections(parseTaskRef, browserRef, [
      ['case extra field', (r) => { r.fixture.cases.verified.note = 'x'; }, 'unknown_field', '$.fixture.cases.verified.note'],
      ['page_origin over http', (r) => { r.fixture.cases.verified.page_origin = 'http://app.demo.test'; }, 'invalid_field_value', '$.fixture.cases.verified.page_origin'],
      ['page_origin with credentials', (r) => { r.fixture.cases.verified.page_origin = 'https://user:pw@app.demo.test'; }, 'invalid_field_value', '$.fixture.cases.verified.page_origin'],
      ['account_status outside the fixture enum', (r) => { r.fixture.cases.verified.account_status = 'origin_mismatch'; }, 'invalid_field_value', '$.fixture.cases.verified.account_status'],
      ['inputs_ready is not a boolean', (r) => { r.fixture.cases.verified.inputs_ready = 'yes'; }, 'invalid_field_value', '$.fixture.cases.verified.inputs_ready'],
      ['voucher observation in a browser fixture', (r) => { r.fixture.cases.voucher = { eligible: true, receipt: null }; }, 'unknown_field', '$.fixture.cases.voucher.eligible'],
    ]);
  });

  test('valid refs scrub clean once URLs are confined to their allowed paths', () => {
    // Fixture case names must be spelled out: the matcher only knows `[*]` and a trailing `.*`.
    const urlPaths = new Set([
      '$.official_sources[*].url',
      '$.fixture.cases.verified.page_origin',
      '$.fixture.cases.pending.page_origin',
    ]);
    for (const build of [liveRef, voucherRef, browserRef]) {
      expect(scanSecrets(build())).toBeNull();
      expect(containsUrl(build())).toBe(true);
      expect(containsUrl(build(), urlPaths)).toBe(false);
    }
    const withNumericVoucher = mutate(voucherRef, (r) => { r.fixture.cases.eligible_final.receipt.voucher_id = '12345678'; });
    expect(scanSecrets(withNumericVoucher)).toBe('secret_detected');
    expect(scanSecrets(withNumericVoucher, new Set(['$.fixture.cases.eligible_final.receipt.*']))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseManifest
// ---------------------------------------------------------------------------

const CARD_ID = '021766f0-3b1d-488f-9c0c-0a4c37a92a52';
const FEED_ID = '061935f4699517a79253b2c6dea931b6e1307bf9';

function manifest(): TaskManifestV1 {
  return {
    schema_version: 1,
    kind: 'task_manifest',
    tasks: [
      {
        task_id: 'demo-claim',
        revision: 1,
        ref_path: 'demo-claim.v1.json',
        ref_sha256: 'ab'.repeat(32),
        bindings: { card_ids: [CARD_ID], feed_ids: [FEED_ID], domains: ['demo.test'] },
      },
      {
        task_id: 'demo-voucher',
        revision: 3,
        ref_path: 'demo-voucher.v3.json',
        ref_sha256: 'cd'.repeat(32),
        bindings: { card_ids: [], feed_ids: [], domains: ['voucher.demo.test', 'docs.demo.test'] },
      },
    ],
  };
}

describe('parseManifest', () => {
  test('accepts a valid manifest and returns the same document', () => {
    const doc = manifest();
    const result = parseManifest(doc);
    if (!result.ok) throw new Error(`${result.error} at ${result.path}`);
    expect(result.manifest).toBe(doc);
    expect(Object.keys(doc)).toEqual(['schema_version', 'kind', 'tasks']);
    expect(Object.keys(doc.tasks[0])).toEqual(['task_id', 'revision', 'ref_path', 'ref_sha256', 'bindings']);
    expect(Object.keys(doc.tasks[0].bindings)).toEqual(['card_ids', 'feed_ids', 'domains']);
  });

  test('accepts an empty task list and plain hostnames', () => {
    const doc = mutate(manifest, (m) => {
      m.tasks = m.tasks.slice(0, 1);
      m.tasks[0].bindings.domains = ['xn--mnchen-3ya.de', '192.168.0.1', 'a.b.c.d', 'e2e-demo.test'];
    });
    expect(parseManifest(doc).ok).toBe(true);
    expect(parseManifest(mutate(manifest, (m) => { m.tasks = []; })).ok).toBe(true);
  });

  test('rejects roots that are not objects', () => {
    expectRootRejection(parseManifest, 'invalid_manifest');
  });

  test('rejects invalid manifests', () => {
    expectRejections(parseManifest, manifest, [
      ['unknown top-level field', (m) => { m.version = 1; }, 'unknown_field', '$.version'],
      ['missing tasks', (m) => { delete m.tasks; }, 'invalid_field_value', '$.tasks'],
      ['tasks is not an array', (m) => { m.tasks = {}; }, 'invalid_manifest', '$.tasks'],
      ['wrong schema_version', (m) => { m.schema_version = 2; }, 'invalid_manifest', '$.schema_version'],
      ['wrong kind', (m) => { m.kind = 'task_list'; }, 'invalid_manifest', '$.kind'],
      ['entry is not an object', (m) => { m.tasks[0] = 'x'; }, 'invalid_manifest', '$.tasks[0]'],
      ['entry extra field', (m) => { m.tasks[0].title = 'x'; }, 'unknown_field', '$.tasks[0].title'],
      ['entry missing ref_path', (m) => { delete m.tasks[0].ref_path; }, 'invalid_field_value', '$.tasks[0].ref_path'],
      ['task_id is not an id', (m) => { m.tasks[0].task_id = 'Demo Claim'; }, 'invalid_field_value', '$.tasks[0].task_id'],
      ['revision is zero', (m) => { m.tasks[0].revision = 0; }, 'invalid_field_value', '$.tasks[0].revision'],
      ['ref_path names another revision', (m) => { m.tasks[0].ref_path = 'demo-claim.v2.json'; }, 'invalid_reference', '$.tasks[0].ref_path'],
      ['ref_path inside a directory', (m) => { m.tasks[0].ref_path = 'tasks/demo-claim.v1.json'; }, 'invalid_reference', '$.tasks[0].ref_path'],
      ['ref_sha256 is uppercase', (m) => { m.tasks[0].ref_sha256 = 'AB'.repeat(32); }, 'invalid_field_value', '$.tasks[0].ref_sha256'],
      ['ref_sha256 is too short', (m) => { m.tasks[0].ref_sha256 = 'ab'.repeat(31); }, 'invalid_field_value', '$.tasks[0].ref_sha256'],
      ['bindings is not an object', (m) => { m.tasks[0].bindings = []; }, 'invalid_field_value', '$.tasks[0].bindings'],
      ['bindings extra field', (m) => { m.tasks[0].bindings.slugs = []; }, 'unknown_field', '$.tasks[0].bindings.slugs'],
      ['bindings missing domains', (m) => { delete m.tasks[0].bindings.domains; }, 'invalid_field_value', '$.tasks[0].bindings.domains'],
      ['card_ids is not an array', (m) => { m.tasks[0].bindings.card_ids = 'x'; }, 'invalid_field_value', '$.tasks[0].bindings.card_ids'],
      ['empty card id', (m) => { m.tasks[0].bindings.card_ids = ['']; }, 'invalid_field_value', '$.tasks[0].bindings.card_ids[0]'],
      ['card id with a space', (m) => { m.tasks[0].bindings.card_ids = ['a b']; }, 'invalid_field_value', '$.tasks[0].bindings.card_ids[0]'],
      ['card id bound twice in one task', (m) => { m.tasks[0].bindings.card_ids = ['c1', 'c1']; }, 'invalid_manifest', '$.tasks[0].bindings.card_ids[1]'],
      ['card id bound by two tasks', (m) => { m.tasks[1].bindings.card_ids = [CARD_ID]; }, 'invalid_manifest', '$.tasks[1].bindings.card_ids[0]'],
      ['feed id bound by two tasks', (m) => { m.tasks[1].bindings.feed_ids = [FEED_ID]; }, 'invalid_manifest', '$.tasks[1].bindings.feed_ids[0]'],
      ['domain bound by two tasks', (m) => { m.tasks[1].bindings.domains = ['demo.test']; }, 'invalid_manifest', '$.tasks[1].bindings.domains[0]'],
      ['duplicate task_id', (m) => { m.tasks[1].task_id = 'demo-claim'; }, 'invalid_manifest', '$.tasks[1].task_id'],
      ['domain without a dot', (m) => { m.tasks[0].bindings.domains = ['localhost']; }, 'invalid_field_value', '$.tasks[0].bindings.domains[0]'],
      ['uppercase domain', (m) => { m.tasks[0].bindings.domains = ['Demo.test']; }, 'invalid_field_value', '$.tasks[0].bindings.domains[0]'],
      ['domain with a scheme', (m) => { m.tasks[0].bindings.domains = ['https://demo.test']; }, 'invalid_field_value', '$.tasks[0].bindings.domains[0]'],
      ['domain with a path', (m) => { m.tasks[0].bindings.domains = ['demo.test/claim']; }, 'invalid_field_value', '$.tasks[0].bindings.domains[0]'],
      ['domain with a port', (m) => { m.tasks[0].bindings.domains = ['demo.test:443']; }, 'invalid_field_value', '$.tasks[0].bindings.domains[0]'],
      ['wildcard domain', (m) => { m.tasks[0].bindings.domains = ['*.demo.test']; }, 'invalid_field_value', '$.tasks[0].bindings.domains[0]'],
      ['domain with a leading hyphen', (m) => { m.tasks[0].bindings.domains = ['-demo.test']; }, 'invalid_field_value', '$.tasks[0].bindings.domains[0]'],
      ['domain with a trailing dot', (m) => { m.tasks[0].bindings.domains = ['demo.test.']; }, 'invalid_field_value', '$.tasks[0].bindings.domains[0]'],
      ['domain with a space', (m) => { m.tasks[0].bindings.domains = ['demo .test']; }, 'invalid_field_value', '$.tasks[0].bindings.domains[0]'],
      ['empty domain', (m) => { m.tasks[0].bindings.domains = ['']; }, 'invalid_field_value', '$.tasks[0].bindings.domains[0]'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// parseRunReport
// ---------------------------------------------------------------------------

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
];

const CHECKPOINT = { id: 'login', type: 'login', human_action_required_now: true, action: 'Sign in.', resume_when: 'Signed in.' };

function report(status: RunStatus = 'verified_live'): RunReportV1 {
  return {
    schema_version: 1,
    kind: 'run_report',
    task_id: 'demo-claim',
    revision: 1,
    ref_sha256: 'ab'.repeat(32),
    mode: 'live_read_only',
    status,
    attempted_steps: [{ id: 'check-status', outcome: 'pass', source_ids: ['api'] }],
    evidence: {
      activation: 'active',
      network: 'matched',
      eligibility: 'eligible',
      receipt: 'matched',
      account_status: 'verified',
    },
    missing_capabilities: [],
    checkpoint: null,
    error: null,
  };
}

describe('parseRunReport', () => {
  test('accepts a valid report for every status and its checkpoint rules', () => {
    const waiting = {
      id: 'activation',
      type: 'await_activation',
      human_action_required_now: false,
      action: 'Wait for the campaign.',
      resume_when: 'The campaign is active.',
    };
    const okCases: Acceptance[] = [
      ['verified_live', () => {}],
      ['verified_fixture', (r) => { r.mode = 'synthetic_fixture'; r.status = 'verified_fixture'; }],
      ['ineligible', (r) => { r.status = 'ineligible'; r.evidence.eligibility = 'ineligible'; r.evidence.receipt = 'missing'; }],
      ['blocked_missing_capability', (r) => { r.status = 'blocked_missing_capability'; r.missing_capabilities = ['browser']; }],
      ['blocked_not_active without a checkpoint', (r) => { r.status = 'blocked_not_active'; }],
      ['blocked_not_active with an await_activation checkpoint', (r) => { r.status = 'blocked_not_active'; r.checkpoint = waiting; }],
      ['needs_user with a checkpoint', (r) => { r.status = 'needs_user'; r.checkpoint = CHECKPOINT; }],
      ['invalid_input before the task is known', (r) => {
        r.status = 'invalid_input';
        r.error = 'malformed_json';
        r.task_id = null;
        r.revision = null;
        r.ref_sha256 = null;
        r.mode = null;
        r.attempted_steps = [];
        r.evidence = { activation: 'unknown', network: 'not_checked', eligibility: 'not_checked', receipt: 'not_checked', account_status: 'not_checked' };
      }],
      ['invalid_input after the task is known', (r) => { r.status = 'invalid_input'; r.error = 'secret_detected'; }],
    ];
    for (const [name, change] of okCases) {
      const result = parseRunReport(mutate(report, change));
      if (!result.ok) throw new Error(`${name}: ${result.error} at ${result.path}`);
      expect(result.ok).toBe(true);
    }
    expect(Object.keys(report())).toEqual(RUN_REPORT_KEYS);
  });

  test('rejects roots that are not objects', () => {
    expectRootRejection(parseRunReport, 'invalid_field_value');
  });

  test('rejects invalid run reports', () => {
    const needsUser = (r: Mutable, checkpoint: Record<string, unknown>) => {
      r.status = 'needs_user';
      r.checkpoint = checkpoint;
    };
    expectRejections(parseRunReport, report, [
      ['unknown field', (r) => { r.note = 'x'; }, 'unknown_field', '$.note'],
      ['missing evidence', (r) => { delete r.evidence; }, 'invalid_field_value', '$.evidence'],
      ['wrong schema_version', (r) => { r.schema_version = 2; }, 'invalid_field_value', '$.schema_version'],
      ['wrong kind', (r) => { r.kind = 'task_ref'; }, 'invalid_field_value', '$.kind'],
      ['unknown status', (r) => { r.status = 'done'; }, 'invalid_field_value', '$.status'],
      ['error set on a successful run', (r) => { r.error = 'malformed_json'; }, 'invalid_field_value', '$.error'],
      ['invalid_input without an error', (r) => { r.status = 'invalid_input'; }, 'invalid_field_value', '$.error'],
      ['error outside the enum', (r) => { r.status = 'invalid_input'; r.error = 'oops'; }, 'invalid_field_value', '$.error'],
      ['missing task_id', (r) => { r.task_id = null; }, 'invalid_field_value', '$.task_id'],
      ['missing revision', (r) => { r.revision = null; }, 'invalid_field_value', '$.revision'],
      ['missing ref_sha256', (r) => { r.ref_sha256 = null; }, 'invalid_field_value', '$.ref_sha256'],
      ['missing mode', (r) => { r.mode = null; }, 'invalid_field_value', '$.mode'],
      ['task_id is not an id', (r) => { r.task_id = 'Demo'; }, 'invalid_field_value', '$.task_id'],
      ['revision is zero', (r) => { r.revision = 0; }, 'invalid_field_value', '$.revision'],
      ['ref_sha256 is uppercase', (r) => { r.ref_sha256 = 'AB'.repeat(32); }, 'invalid_field_value', '$.ref_sha256'],
      ['mode is unknown', (r) => { r.mode = 'live_write'; }, 'invalid_field_value', '$.mode'],
      ['invalid report with a malformed task_id', (r) => { r.status = 'invalid_input'; r.error = 'malformed_json'; r.task_id = 'Demo'; }, 'invalid_field_value', '$.task_id'],
      ['attempted_steps is not an array', (r) => { r.attempted_steps = {}; }, 'invalid_field_value', '$.attempted_steps'],
      ['step is not an object', (r) => { r.attempted_steps = ['check-status']; }, 'invalid_field_value', '$.attempted_steps[0]'],
      ['step extra field', (r) => { r.attempted_steps[0].title = 'x'; }, 'unknown_field', '$.attempted_steps[0].title'],
      ['step missing outcome', (r) => { delete r.attempted_steps[0].outcome; }, 'invalid_field_value', '$.attempted_steps[0].outcome'],
      ['step outcome outside the enum', (r) => { r.attempted_steps[0].outcome = 'done'; }, 'invalid_field_value', '$.attempted_steps[0].outcome'],
      ['step id is not an id', (r) => { r.attempted_steps[0].id = 'Check Status'; }, 'invalid_field_value', '$.attempted_steps[0].id'],
      ['step source id is not an id', (r) => { r.attempted_steps[0].source_ids = ['API']; }, 'invalid_field_value', '$.attempted_steps[0].source_ids[0]'],
      ['evidence missing a key', (r) => { delete r.evidence.receipt; }, 'invalid_field_value', '$.evidence.receipt'],
      ['evidence extra key', (r) => { r.evidence.proof = 'x'; }, 'unknown_field', '$.evidence.proof'],
      ['evidence value outside its enum', (r) => { r.evidence.network = 'ok'; }, 'invalid_field_value', '$.evidence.network'],
      ['evidence value from another field', (r) => { r.evidence.network = 'eligible'; }, 'invalid_field_value', '$.evidence.network'],
      ['missing capability outside the enum', (r) => { r.missing_capabilities = ['gpu']; }, 'invalid_field_value', '$.missing_capabilities[0]'],
      ['checkpoint on a verified run', (r) => { r.checkpoint = CHECKPOINT; }, 'invalid_field_value', '$.checkpoint'],
      ['needs_user without a checkpoint', (r) => { r.status = 'needs_user'; }, 'invalid_field_value', '$.checkpoint'],
      ['needs_user with no action required now', (r) => { needsUser(r, { ...CHECKPOINT, human_action_required_now: false }); }, 'invalid_field_value', '$.checkpoint.human_action_required_now'],
      ['needs_user with a checkpoint that is not an object', (r) => { needsUser(r, 'x' as unknown as Record<string, unknown>); }, 'invalid_field_value', '$.checkpoint'],
      ['blocked_not_active with a login checkpoint', (r) => { r.status = 'blocked_not_active'; r.checkpoint = CHECKPOINT; }, 'invalid_field_value', '$.checkpoint'],
      ['blocked_not_active with an action required now', (r) => {
        r.status = 'blocked_not_active';
        r.checkpoint = { ...CHECKPOINT, type: 'await_activation' };
      }, 'invalid_field_value', '$.checkpoint'],
      ['checkpoint extra field', (r) => { needsUser(r, { ...CHECKPOINT, delay: 5 }); }, 'unknown_field', '$.checkpoint.delay'],
      ['checkpoint missing resume_when', (r) => { const { resume_when: _dropped, ...rest } = CHECKPOINT; needsUser(r, rest); }, 'invalid_field_value', '$.checkpoint.resume_when'],
      ['checkpoint id is not an id', (r) => { needsUser(r, { ...CHECKPOINT, id: 'Log In' }); }, 'invalid_field_value', '$.checkpoint.id'],
      ['checkpoint type outside the enum', (r) => { needsUser(r, { ...CHECKPOINT, type: 'wait' }); }, 'invalid_field_value', '$.checkpoint.type'],
      ['checkpoint with a URL in action', (r) => { needsUser(r, { ...CHECKPOINT, action: 'Open www.demo.test.' }); }, 'invalid_field_value', '$.checkpoint.action'],
    ]);
  });
});
