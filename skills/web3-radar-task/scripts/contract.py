"""Canonical task contract for the web3-radar-task runner. Standard library only.

Validators raise :class:`Invalid`. Its ``code`` comes from ``ERROR_CODES``, so a
caller can echo the code without leaking the rejected input.
"""
from __future__ import annotations

import json
import math
import re
import unicodedata
from typing import Any, Iterable, Optional, Sequence
from urllib.parse import urlsplit

TASK_SCHEMA_VERSION = 1
RUN_STATUSES = (
    "invalid_input",
    "blocked_not_active",
    "blocked_missing_capability",
    "ineligible",
    "needs_user",
    "verified_fixture",
    "verified_live",
)
TASK_MODES = ("synthetic_fixture", "live_read_only")
ADAPTERS = {
    "fixture_voucher": "synthetic_fixture",
    "fixture_browser_email": "synthetic_fixture",
    "http_read_only": "live_read_only",
}
CAPABILITIES = ("network_read", "browser", "email_inbox", "wallet_human")
CHECKPOINT_TYPES = (
    "await_activation",
    "batch_inputs",
    "login",
    "email_verification",
    "captcha",
    "kyc",
    "wallet_signature",
    "form_submit",
)
SOURCE_KINDS = ("official_documentation", "public_read_only_endpoint", "official_app")
STEP_OUTCOMES = ("pass", "fail", "blocked", "needs_user", "skipped")
ACTIVATION_STATES = ("active", "not_active", "unknown")
OBSERVED_ACCOUNT_STATUSES = ("verified", "pending", "unverified")
EVIDENCE_ENUMS = {
    "activation": ("active", "not_active", "unknown"),
    "network": ("matched", "mismatched", "not_checked"),
    "eligibility": ("eligible", "ineligible", "not_checked"),
    "receipt": ("matched", "missing", "mismatched", "failed", "not_finalized", "not_checked"),
    "account_status": ("verified", "pending", "unverified", "origin_mismatch", "not_checked"),
}
ERROR_CODES = (
    "invalid_cli_arguments",
    "malformed_json",
    "duplicate_json_field",
    "input_too_large",
    "unknown_field",
    "invalid_field_value",
    "unsupported_task",
    "stale_revision",
    "unknown_revision",
    "invalid_manifest",
    "invalid_reference",
    "ref_sha256_mismatch",
    "expect_sha256_mismatch",
    "adapter_not_allowed",
    "mode_not_allowed",
    "secret_detected",
    "pii_detected",
    "receipt_conflicts_with_ineligible",
)

# Agent step checks and the checks each adapter can evaluate. The browser and
# email adapter compares the page origin itself, against proof.source_id.
CHECK_TYPES = (
    "reviewed_activation",
    "http_json_pins",
    "fixture_eligibility",
    "fixture_receipt",
    "fixture_account_status",
)
ADAPTER_CHECKS = {
    "fixture_voucher": ("fixture_eligibility", "fixture_receipt"),
    "fixture_browser_email": ("fixture_account_status",),
    "http_read_only": ("reviewed_activation", "http_json_pins"),
}
RECEIPT_PINS = ("chain", "contract", "event", "recipient", "voucher_id")
PROOF_KINDS = ("onchain_receipt", "account_status", "unknown_until_active")

# Field order matches TaskRefV1, TaskManifestV1 and RunReportV1 in shared/taskContract.ts.
REF_FIELDS = (
    "schema_version",
    "kind",
    "task_id",
    "revision",
    "title",
    "summary",
    "mode",
    "adapter",
    "review",
    "networks",
    "activation",
    "required_capabilities",
    "official_sources",
    "steps",
    "checkpoints",
    "proof",
    "fixture",
)
REVIEW_FIELDS = ("reviewed_by", "reviewed_at")
MANIFEST_FIELDS = ("schema_version", "kind", "tasks")
ENTRY_FIELDS = ("task_id", "revision", "ref_path", "ref_sha256", "bindings")
BINDING_FIELDS = ("card_ids", "feed_ids", "domains")
ACTORS = ("agent", "human")
STEP_FIELDS = ("id", "title", "actor", "depends_on", "source_ids", "check", "checkpoint_id")
CHECKPOINT_FIELDS = ("id", "type", "action", "resume_when")
REPORT_FIELDS = (
    "schema_version",
    "kind",
    "task_id",
    "revision",
    "ref_sha256",
    "mode",
    "status",
    "attempted_steps",
    "evidence",
    "missing_capabilities",
    "checkpoint",
    "error",
)
STEP_REPORT_FIELDS = ("id", "outcome", "source_ids")
CHECKPOINT_REPORT_FIELDS = ("id", "type", "human_action_required_now", "action", "resume_when")

# String values a reviewed reference may hold without tripping the scanner:
# pinned hashes, a reviewed date, human text that can cite a block height, and
# page origins.
REF_EXEMPT_PATHS = (
    "$.review.reviewed_at",
    "$.steps[*].check.pins.*",
    "$.proof.pins.*",
    "$.checkpoints[*].action",
    "$.checkpoints[*].resume_when",
    "$.fixture.cases.*.page_origin",
)
MANIFEST_EXEMPT_PATHS = ("$.tasks[*].ref_sha256",)

MAX_OBSERVATION_BYTES = 8192
MAX_MANIFEST_BYTES = 65536
MAX_REF_BYTES = 262144
MAX_HTTP_BODY_BYTES = 65536

ID_RE = re.compile(r"^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
FEED_ID_RE = re.compile(r"^[0-9a-f]{40}$")
CARD_ID_RE = re.compile(r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$")
DOMAIN_RE = re.compile(r"^(?=.*\.)[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$")
NETWORK_RE = re.compile(r"^[a-z0-9][a-z0-9:._-]{0,127}$")
RECEIPT_VALUE_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
PIN_KEY_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")
_HOST_RE = re.compile(r"^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$")
_SAFE_KEY_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_REVIEWED_TEXT_FORBIDDEN_RE = re.compile("[%s`<>]" % "".join(chr(point) for point in (0xAB, 0xBB)))
_INVISIBLE_RE = re.compile(
    "[%s]" % "".join(chr(point) for point in (0xAD, 0x200B, 0x200C, 0x200D, 0x200E, 0x200F, 0x2060, 0xFEFF))
)
_URL_RE = re.compile(r"(?:https?://|www\.)", re.IGNORECASE)
_TOKEN_SPLIT_RE = re.compile(r"[^a-z0-9]+")
_SEPARATOR_RE = re.compile(r"[-\s]+")
_SECRET_KEY_RE = re.compile(r"(?:api_?key|private_?key|auth_?token|set_?cookie|session_?id)")
_PII_KEY_RE = re.compile(r"(?:phone_?number|e_?mail)")
_JWT_RE = re.compile(r"\beyj[a-z0-9_-]{4,}\.eyj[a-z0-9_-]{4,}\.[a-z0-9_-]{4,}\b")
_BEARER_RE = re.compile(r"(?:^|[^a-z0-9_])bearer\s+[a-z0-9._~+/=-]{8,}")
_COOKIE_RE = re.compile(
    r"(?:^|[^a-z0-9_])(?:set-cookie\s*:|__(?:secure|host)-[a-z0-9_.-]+=|sessionid=|connect\.sid=|phpsessid=)"
)
_HEX64_RE = re.compile(r"(?:^|[^0-9a-f])(?:0x)?[0-9a-f]{64}(?:$|[^0-9a-f])")
_OTP_RE = re.compile(r"(?:^|[^0-9a-z_-])[0-9]{4,8}(?:$|[^0-9a-z_-])")
_EMAIL_RE = re.compile(r"[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,24}")
_SEED_WORD_RE = re.compile(r"^[a-z]{3,8}$")
_SECRET_KEY_TOKENS = frozenset(
    "cookie cookies session sessionid token secret password passwd otp mnemonic "
    "seed private apikey authorization bearer".split()
)
_PII_KEY_TOKENS = frozenset(("email", "phone", "phonenumber"))
_SEED_STOPWORDS = frozenset(
    # fmt: off
    "the and for that with this from your is are was were have has not to of in on at "
    "by as or if it please check report user task step official voucher".split()
    # fmt: on
)
_MAX_JSON_DEPTH = 32
_INT_CHECK_EXEMPT_PATHS = ("$.schema_version", "$.revision")


class Invalid(ValueError):
    """A contract violation. ``code`` is one of ``ERROR_CODES`` and is safe to echo."""

    def __init__(self, code: str) -> None:
        if code not in ERROR_CODES:
            raise AssertionError("unknown error code")
        super().__init__(code)
        self.code = code


def _fail(code: str) -> None:
    raise Invalid(code)


def _require(condition: bool, code: str) -> None:
    if not condition:
        _fail(code)


def _is_id(value: Any) -> bool:
    return type(value) is str and ID_RE.fullmatch(value) is not None


def _is_printable(value: Any, low: int, high: int) -> bool:
    return type(value) is str and low <= len(value) <= high and all(0x20 <= ord(ch) <= 0x7E for ch in value)


def _is_enum(value: Any, allowed: Sequence[str]) -> bool:
    return type(value) is str and value in allowed


def _is_id_list(value: Any, nonempty: bool = False) -> bool:
    return (
        type(value) is list
        and (bool(value) or not nonempty)
        and all(_is_id(item) for item in value)
        and len(set(value)) == len(value)
    )


def _is_string_list(value: Any, pattern: "re.Pattern[str]", nonempty: bool = False) -> bool:
    return (
        type(value) is list
        and len(value) <= 256
        and (bool(value) or not nonempty)
        and all(type(item) is str and pattern.fullmatch(item) for item in value)
        and len(set(value)) == len(value)
    )


def _norm(text: str) -> str:
    """NFKC-normalize, then drop zero-width and soft hyphen characters."""
    return _INVISIBLE_RE.sub("", unicodedata.normalize("NFKC", text))


def _is_exempt(path: str, exempt_paths: Optional[Iterable[str]]) -> bool:
    """Segment for segment equality. A ``*`` segment matches any one path segment."""
    parts = path.split(".")
    for pattern in exempt_paths or ():
        wanted = pattern.split(".")
        if len(wanted) == len(parts) and all(part == "*" or part == piece for part, piece in zip(wanted, parts)):
            return True
    return False


def _child_path(path: str, key: str) -> str:
    # A key that is not a plain identifier can never match an exempt path.
    return "%s.%s" % (path, key if type(key) is str and _SAFE_KEY_RE.fullmatch(key) else "!")


# ---------------------------------------------------------------- JSON input


def _check_depth(text: str) -> None:
    depth = 0
    in_string = False
    escaped = False
    for ch in text:
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
        elif ch == '"':
            in_string = True
        elif ch in "[{":
            depth += 1
            if depth > _MAX_JSON_DEPTH:
                _fail("malformed_json")
        elif ch in "]}":
            depth = max(depth - 1, 0)


def strict_json(text: Any, max_bytes: int) -> Any:
    """Parse JSON, rejecting what lenient parsers accept.

    Rejects input over ``max_bytes`` UTF-8 bytes, nesting deeper than 32, duplicate
    object keys, ``NaN``/``Infinity``, non-finite numbers, unescaped control
    characters, invalid UTF-8, and trailing garbage.
    """
    if isinstance(text, (bytes, bytearray)):
        try:
            text = bytes(text).decode("utf-8")
        except UnicodeDecodeError:
            _fail("malformed_json")
    if type(text) is not str:
        _fail("malformed_json")
    try:
        size = len(text.encode("utf-8"))
    except UnicodeEncodeError:
        _fail("malformed_json")
    if size > max_bytes:
        _fail("input_too_large")
    _check_depth(text)

    def no_duplicates(pairs: list) -> dict:
        obj = {}
        for key, value in pairs:
            if key in obj:
                _fail("duplicate_json_field")
            obj[key] = value
        return obj

    def no_constants(_name: str) -> None:
        _fail("malformed_json")

    def finite_float(raw: str) -> float:
        value = float(raw)
        if not math.isfinite(value):
            _fail("malformed_json")
        return value

    try:
        return json.loads(text, object_pairs_hook=no_duplicates, parse_constant=no_constants, parse_float=finite_float)
    except Invalid:
        raise
    except (ValueError, RecursionError):
        _fail("malformed_json")


# ------------------------------------------------------------------ scanning


def _key_violation(key: str) -> Optional[str]:
    lowered = _norm(key).lower()
    tokens = _TOKEN_SPLIT_RE.split(lowered)
    # "x-api-key" and "api key" name the same field as "api_key".
    folded = _SEPARATOR_RE.sub("_", lowered)
    if any(token in _SECRET_KEY_TOKENS for token in tokens) or _SECRET_KEY_RE.search(folded):
        return "secret_detected"
    if any(token in _PII_KEY_TOKENS for token in tokens) or _PII_KEY_RE.search(folded):
        return "pii_detected"
    return None


def _has_seed_phrase(norm_text: str) -> bool:
    """True when 12 or more consecutive words look like BIP-39 words."""
    run = 0
    for word in norm_text.split():
        if _SEED_WORD_RE.fullmatch(word) and word not in _SEED_STOPWORDS:
            run += 1
            if run >= 12:
                return True
        else:
            run = 0
    return False


def _string_violation(text: str) -> Optional[str]:
    low = _norm(text).lower()
    if _JWT_RE.search(low) or _BEARER_RE.search(low) or _COOKIE_RE.search(low) or _HEX64_RE.search(low):
        return "secret_detected"
    if _has_seed_phrase(_norm(text)) or _OTP_RE.search(low):
        return "secret_detected"
    if _EMAIL_RE.search(low):
        return "pii_detected"
    return None


def _scan(value: Any, path: str, exempt_paths: Optional[Iterable[str]]) -> Optional[str]:
    if type(value) is dict:
        for key, child in value.items():
            violation = _key_violation(key)
            if violation:
                return violation
            violation = _scan(child, _child_path(path, key), exempt_paths)
            if violation:
                return violation
    elif type(value) is list:
        for child in value:
            violation = _scan(child, path + "[*]", exempt_paths)
            if violation:
                return violation
    elif type(value) is str:
        if not _is_exempt(path, exempt_paths):
            return _string_violation(value)
    elif type(value) is int:
        if not _is_exempt(path, exempt_paths) and path not in _INT_CHECK_EXEMPT_PATHS and 1000 <= value <= 99999999:
            return "secret_detected"
    return None


def scan_secrets(value: Any, exempt_paths: Optional[Iterable[str]] = None) -> Optional[str]:
    """Return ``secret_detected`` or ``pii_detected`` for the first hit, else ``None``.

    Keys are always checked. Strings and 4-to-8-digit integers are checked unless
    their path (``$``, ``.prop``, ``[*]``) matches an exempt path segment for
    segment, where ``*`` in an exempt path matches any one segment.
    """
    return _scan(value, "$", tuple(exempt_paths) if exempt_paths else None)


def _has_url(value: Any, path: str, exempt_paths: Optional[Iterable[str]]) -> bool:
    if _is_exempt(path, exempt_paths):
        return False
    if type(value) is dict:
        return any(_has_url(child, _child_path(path, key), exempt_paths) for key, child in value.items())
    if type(value) is list:
        return any(_has_url(child, path + "[*]", exempt_paths) for child in value)
    if type(value) is str:
        return _URL_RE.search(_norm(value)) is not None
    return False


def contains_url(value: Any, exempt_paths: Optional[Iterable[str]] = None) -> bool:
    """True when any non-exempt string holds ``http://``, ``https://`` or ``www.`` after normalization."""
    return _has_url(value, "$", tuple(exempt_paths) if exempt_paths else None)


# -------------------------------------------------------------- validators


def _shape(value: Any, keys: Iterable[str], code: str) -> None:
    keys = tuple(keys)
    _require(type(value) is dict, code)
    if any(key not in keys for key in value):
        _fail("unknown_field" if code == "invalid_field_value" else code)
    _require(len(value) == len(keys), code)


def _is_https_url(value: Any) -> bool:
    if not _is_printable(value, 12, 2048):
        return False
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError:
        return False
    host = parts.hostname
    return (
        parts.scheme == "https"
        and host is not None
        and _HOST_RE.fullmatch(host) is not None
        and parts.username is None
        and parts.password is None
        and (port is None or port > 0)
    )


def _is_origin(value: Any) -> bool:
    if not _is_printable(value, 8, 2048):
        return False
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError:
        return False
    host = parts.hostname
    return (
        parts.scheme in ("http", "https")
        and host is not None
        and parts.username is None
        and parts.password is None
        and parts.path in ("", "/")
        and not parts.query
        and not parts.fragment
        and (port is None or port > 0)
    )


def _is_reviewed_text(value: Any) -> bool:
    return _is_printable(value, 1, 400) and not _REVIEWED_TEXT_FORBIDDEN_RE.search(value) and not contains_url(value)


def _is_receipt_value(value: Any) -> bool:
    return type(value) is str and RECEIPT_VALUE_RE.fullmatch(value) is not None


def validate_observation(observation: Any, adapter: str) -> None:
    """Validate a synthetic observation against the shape its adapter reads."""
    if adapter == "fixture_voucher":
        _shape(observation, ("eligible", "receipt"), "invalid_field_value")
        _require(type(observation["eligible"]) is bool, "invalid_field_value")
        receipt = observation["receipt"]
        if receipt is None:
            return
        _shape(receipt, RECEIPT_PINS + ("success", "finalized"), "invalid_field_value")
        _require(all(_is_receipt_value(receipt[key]) for key in RECEIPT_PINS), "invalid_field_value")
        _require(type(receipt["success"]) is bool and type(receipt["finalized"]) is bool, "invalid_field_value")
        _require(observation["eligible"] is not False, "receipt_conflicts_with_ineligible")
    elif adapter == "fixture_browser_email":
        _shape(observation, ("page_origin", "account_status", "inputs_ready"), "invalid_field_value")
        _require(
            _is_origin(observation["page_origin"])
            and _is_enum(observation["account_status"], OBSERVED_ACCOUNT_STATUSES)
            and type(observation["inputs_ready"]) is bool,
            "invalid_field_value",
        )
    else:
        _fail("adapter_not_allowed")


def validate_manifest(manifest: Any) -> None:
    """Validate the task manifest: identity, revision, ref hash and bindings per task.

    A card, feed or domain may be bound by one task only.
    """
    code = "invalid_manifest"
    _shape(manifest, MANIFEST_FIELDS, code)
    _require(
        type(manifest["schema_version"]) is int
        and manifest["schema_version"] == TASK_SCHEMA_VERSION
        and manifest["kind"] == "task_manifest",
        code,
    )
    tasks = manifest["tasks"]
    _require(type(tasks) is list and 1 <= len(tasks) <= 256, code)
    task_ids = set()
    claimed = {field: set() for field in BINDING_FIELDS}
    for entry in tasks:
        _shape(entry, ENTRY_FIELDS, code)
        _require(type(entry["bindings"]) is dict, code)
        _shape(entry["bindings"], BINDING_FIELDS, code)
        bindings = entry["bindings"]
        _require(
            _is_id(entry["task_id"])
            and entry["task_id"] not in task_ids
            and type(entry["revision"]) is int
            and entry["revision"] >= 1
            and entry["ref_path"] == "%s.v%s.json" % (entry["task_id"], entry["revision"])
            and type(entry["ref_sha256"]) is str
            and SHA256_RE.fullmatch(entry["ref_sha256"]) is not None
            and _is_string_list(bindings["card_ids"], CARD_ID_RE)
            and _is_string_list(bindings["feed_ids"], FEED_ID_RE)
            and _is_string_list(bindings["domains"], DOMAIN_RE),
            code,
        )
        task_ids.add(entry["task_id"])
        for field in BINDING_FIELDS:
            _require(not claimed[field] & set(bindings[field]), code)
            claimed[field].update(bindings[field])
    violation = scan_secrets(manifest, MANIFEST_EXEMPT_PATHS)
    if violation:
        _fail(violation)


def _validate_check(check: Any, adapter: str, source_kinds: dict, code: str) -> None:
    if type(check) is not dict or not _is_enum(check.get("type"), CHECK_TYPES):
        _fail(code)
    kind = check["type"]
    _require(kind in ADAPTER_CHECKS[adapter], "mode_not_allowed")
    if kind != "http_json_pins":
        _shape(check, ("type",), code)
        return
    _shape(check, ("type", "source_id", "pins"), code)
    _require(source_kinds.get(check["source_id"]) == "public_read_only_endpoint", "mode_not_allowed")
    pins = check["pins"]
    _require(type(pins) is dict and 1 <= len(pins) <= 32, code)
    for key, value in pins.items():
        _require(
            type(key) is str and PIN_KEY_RE.fullmatch(key) is not None and _is_printable(value, 1, 256),
            code,
        )


def validate_ref(ref: Any, entry: Optional[dict] = None) -> None:
    """Validate a task reference and its cross-field rules.

    ``entry`` is the task's manifest row. When given, the reference must carry the
    same task ID and revision, and a synthetic fixture must not bind real cards.
    """
    code = "invalid_reference"
    _shape(ref, REF_FIELDS, code)
    _require(
        type(ref["schema_version"]) is int and ref["schema_version"] == TASK_SCHEMA_VERSION and ref["kind"] == "task_ref",
        code,
    )
    _require(_is_id(ref["task_id"]), code)
    _require(type(ref["revision"]) is int and ref["revision"] >= 1, code)
    _require(_is_reviewed_text(ref["title"]) and _is_reviewed_text(ref["summary"]), code)
    _require(_is_enum(ref["mode"], TASK_MODES) and type(ref["adapter"]) is str, code)
    _shape(ref["review"], REVIEW_FIELDS, code)
    review = ref["review"]
    _require(_is_reviewed_text(review["reviewed_by"]) and _is_reviewed_text(review["reviewed_at"]), code)
    violation = scan_secrets(ref, REF_EXEMPT_PATHS)
    if violation:
        _fail(violation)

    sources = ref["official_sources"]
    _require(type(sources) is list and len(sources) <= 32, code)
    for source in sources:
        _shape(source, ("id", "kind", "url"), code)
        _require(_is_id(source["id"]) and _is_enum(source["kind"], SOURCE_KINDS) and _is_https_url(source["url"]), code)
    source_kinds = {source["id"]: source["kind"] for source in sources}
    _require(len(source_kinds) == len(sources), code)

    activation = ref["activation"]
    _shape(activation, ("state", "source_ids"), code)
    _require(_is_enum(activation["state"], ACTIVATION_STATES) and _is_id_list(activation["source_ids"]), code)
    _require(set(activation["source_ids"]) <= set(source_kinds), code)
    _require(_is_string_list(ref["networks"], NETWORK_RE, nonempty=True), code)
    _require(_is_id_list(ref["required_capabilities"]), code)
    _require(set(ref["required_capabilities"]) <= set(CAPABILITIES) - {"wallet_human"}, code)

    checkpoints = ref["checkpoints"]
    _require(type(checkpoints) is list and len(checkpoints) <= 32, code)
    for checkpoint in checkpoints:
        _shape(checkpoint, CHECKPOINT_FIELDS, code)
        _require(
            _is_id(checkpoint["id"])
            and _is_enum(checkpoint["type"], CHECKPOINT_TYPES)
            and _is_reviewed_text(checkpoint["action"])
            and _is_reviewed_text(checkpoint["resume_when"]),
            code,
        )
    checkpoint_ids = {checkpoint["id"] for checkpoint in checkpoints}
    _require(len(checkpoint_ids) == len(checkpoints), code)

    steps = ref["steps"]
    _require(type(steps) is list and 1 <= len(steps) <= 32, code)
    earlier = set()
    for step in steps:
        _shape(step, STEP_FIELDS, code)
        _require(_is_id(step["id"]) and step["id"] not in earlier and _is_reviewed_text(step["title"]), code)
        _require(_is_id_list(step["depends_on"]) and _is_id_list(step["source_ids"]), code)
        _require(set(step["depends_on"]) <= earlier and set(step["source_ids"]) <= set(source_kinds), code)
        human = step["actor"] == "human"
        _require(_is_enum(step["actor"], ACTORS) and human == (step["checkpoint_id"] is not None), code)
        _require(step["checkpoint_id"] is None or step["checkpoint_id"] in checkpoint_ids, code)
        earlier.add(step["id"])

    adapter = ref["adapter"]
    _require(adapter in ADAPTERS, "adapter_not_allowed")
    _require(ADAPTERS[adapter] == ref["mode"], "mode_not_allowed")
    if ref["mode"] == "live_read_only":
        _require(len(sources) >= 1, code)
    for step in steps:
        if step["check"] is not None:
            _validate_check(step["check"], adapter, source_kinds, code)

    if activation["state"] != "active":
        _require(any(checkpoint["type"] == "await_activation" for checkpoint in checkpoints), code)

    proof = ref["proof"]
    _require(type(proof) is dict and _is_enum(proof.get("kind"), PROOF_KINDS), code)
    kind = proof["kind"]
    if kind == "onchain_receipt":
        _shape(proof, ("kind", "pins"), code)
        _require(type(proof["pins"]) is dict and tuple(proof["pins"]) == RECEIPT_PINS, code)
        _require(all(_is_receipt_value(value) for value in proof["pins"].values()), code)
    elif kind == "account_status":
        _shape(proof, ("kind", "source_id", "required_status"), code)
        _require(
            source_kinds.get(proof["source_id"]) == "official_app" and proof["required_status"] == "verified",
            code,
        )
    elif kind == "unknown_until_active":
        _shape(proof, ("kind",), code)
        _require(activation["state"] != "active", code)
    used = {step["check"]["type"] for step in steps if step["check"] is not None}
    _require("fixture_receipt" not in used or kind == "onchain_receipt", code)
    _require("fixture_account_status" not in used or kind == "account_status", code)

    fixture = ref["fixture"]
    if ref["mode"] == "synthetic_fixture":
        _shape(fixture, ("cases",), code)
        cases = fixture["cases"]
        _require(type(cases) is dict and 1 <= len(cases) <= 64 and all(_is_id(name) for name in cases), code)
        for observation in cases.values():
            validate_observation(observation, adapter)
            if adapter == "fixture_browser_email":
                _require(observation["page_origin"].startswith("https://"), code)
        # A fixture stops at a human checkpoint, so it needs a human step to name it.
        _require(any(step["actor"] == "human" for step in steps), code)
    else:
        _require(fixture is None, code)

    if entry is not None:
        _require(entry["task_id"] == ref["task_id"] and entry["revision"] == ref["revision"], code)
        if ref["mode"] == "synthetic_fixture":
            _require(not any(entry["bindings"][field] for field in BINDING_FIELDS), "invalid_manifest")
