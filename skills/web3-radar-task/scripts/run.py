"""Deterministic task runner for Web3 Radar. Standard library only.

Pins the task by manifest, revision and SHA-256, validates its reference, then
runs one allowlisted adapter. The run report goes to stdout as JSON and one
human-readable line goes to stderr. Exit code is 0 for an evaluated status and
2 for invalid_input. The report never echoes command-line, observation, or
network input.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import http.client
import json
import re
import sys
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

import contract

DEFAULT_TASKS_DIR = Path(__file__).resolve().parents[3] / "data" / "tasks"
HTTP_TIMEOUT_SECONDS = 10
USER_AGENT = "web3-radar-task/1"
HUMAN_CAPABILITY = "wallet_human"
NETWORK_CAPABILITY = "network_read"


class _TransportBlocked(Exception):
    """The pinned endpoint could not be read over HTTPS."""


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse every 3xx answer instead of following it to another address."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise _TransportBlocked()


def _report(
    status,
    *,
    task_id=None,
    revision=None,
    mode=None,
    adapter=None,
    error=None,
    steps=(),
    evidence=None,
    checkpoint=None,
    missing_capabilities=(),
):
    merged = {
        "activation": "unknown",
        "network": "not_checked",
        "eligibility": "not_checked",
        "receipt": "not_checked",
        "account_status": "not_checked",
    }
    merged.update(evidence or {})
    return {
        "schema_version": contract.TASK_SCHEMA_VERSION,
        "task_id": task_id,
        "revision": revision,
        "mode": mode,
        "adapter": adapter,
        "status": status,
        "error": error,
        "steps": list(steps),
        "evidence": merged,
        "checkpoint": checkpoint,
        "missing_capabilities": list(missing_capabilities),
    }


def _step_records(ref, outcomes):
    """One record per reference step in reference order. Unlisted steps are "skipped"."""
    return [
        {"id": step["id"], "outcome": outcomes.get(step["id"], "skipped"), "source_ids": list(step["source_ids"])}
        for step in ref["steps"]
    ]


def _by_check(ref, check_type):
    return [step["id"] for step in ref["steps"] if step["check"] is not None and step["check"]["type"] == check_type]


def _human_steps(ref):
    return [step["id"] for step in ref["steps"] if step["actor"] == "human"]


def _checkpoint(ref, checkpoint_id, human_action_required_now):
    checkpoint = next((item for item in ref["checkpoints"] if item["id"] == checkpoint_id), None)
    if checkpoint is None:
        return None
    return {
        "id": checkpoint["id"],
        "type": checkpoint["type"],
        "human_action_required_now": human_action_required_now,
        "action": checkpoint["action"],
        "resume_when": checkpoint["resume_when"],
    }


def _checkpoint_of_type(ref, checkpoint_type, human_action_required_now=True):
    checkpoint = next((item for item in ref["checkpoints"] if item["type"] == checkpoint_type), None)
    return _checkpoint(ref, checkpoint["id"], human_action_required_now) if checkpoint else None


def _checkpoint_of_first_human_step(ref):
    step = next((item for item in ref["steps"] if item["actor"] == "human"), None)
    return _checkpoint(ref, step["checkpoint_id"], True) if step else None


def _binder(ref):
    """Return ``report(status, outcomes, **fields)`` bound to one validated reference."""
    identity = {
        "task_id": ref["task_id"],
        "revision": ref["revision"],
        "mode": ref["mode"],
        "adapter": ref["adapter"],
    }

    def report(status, outcomes=None, evidence=None, **fields):
        activation = {"activation": ref["activation"]["state"]}
        activation.update(evidence or {})
        return _report(status, steps=_step_records(ref, outcomes or {}), evidence=activation, **identity, **fields)

    return report


# ------------------------------------------------------------------- loading


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise contract.Invalid("invalid_cli_arguments")


def _revision_value(text):
    if re.fullmatch(r"[1-9][0-9]{0,8}", text) is None:
        raise argparse.ArgumentTypeError("revision must be a positive integer")
    return int(text)


def _parse_args(argv):
    parser = _Parser(description=__doc__.splitlines()[0])
    parser.add_argument("--task", required=True)
    parser.add_argument("--revision", required=True, type=_revision_value)
    parser.add_argument("--expect-sha256", required=True)
    parser.add_argument("--tasks-dir", default=str(DEFAULT_TASKS_DIR))
    parser.add_argument("--capabilities", default=None, help="comma-separated granted capabilities; omit to grant every agent capability")
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--case", default=None)
    source.add_argument("--observation", action="store_true", help="read one synthetic observation as JSON from stdin")
    parser.add_argument("--offline", action="store_true", help="open no network connection")
    args = parser.parse_args(argv)
    args.tasks_dir = Path(args.tasks_dir)
    return args


def _granted_capabilities(raw, offline, opener):
    """Capabilities the agent holds. wallet_human is never granted to the agent."""
    if raw is None:
        granted = [item for item in contract.CAPABILITIES if item != HUMAN_CAPABILITY]
    else:
        granted = []
        for name in raw.split(","):
            name = name.strip()
            if not name:
                continue
            if name not in contract.CAPABILITIES or name == HUMAN_CAPABILITY:
                raise contract.Invalid("invalid_field_value")
            if name not in granted:
                granted.append(name)
    if offline and opener is None:
        granted = [item for item in granted if item != NETWORK_CAPABILITY]
    return granted


def _read_bytes(path, missing_code, limit):
    """Read a file, at most ``limit + 1`` bytes. A file that cannot be read counts as missing."""
    try:
        with open(path, "rb") as handle:
            return handle.read(limit + 1)
    except OSError:
        raise contract.Invalid(missing_code) from None


def _load_pinned_ref(tasks_dir, task, revision, expect_sha256):
    """Run evaluation order steps 2 to 6: manifest, task, revision, hashes, reference."""
    raw = _read_bytes(tasks_dir / "manifest.json", "invalid_manifest", contract.MAX_MANIFEST_BYTES)
    manifest = contract.strict_json(raw, contract.MAX_MANIFEST_BYTES)
    contract.validate_manifest(manifest)
    entry = next((item for item in manifest["tasks"] if item["task_id"] == task), None)
    if entry is None:
        raise contract.Invalid("unsupported_task")
    if revision < entry["revision"]:
        raise contract.Invalid("stale_revision")
    if revision > entry["revision"]:
        raise contract.Invalid("unknown_revision")
    raw = _read_bytes(tasks_dir / entry["ref_path"], "ref_sha256_mismatch", contract.MAX_REF_BYTES)
    if hashlib.sha256(raw).hexdigest() != entry["ref_sha256"]:
        raise contract.Invalid("ref_sha256_mismatch")
    if expect_sha256 != entry["ref_sha256"]:
        raise contract.Invalid("expect_sha256_mismatch")
    ref = contract.strict_json(raw, contract.MAX_REF_BYTES)
    contract.validate_ref(ref, entry)
    return ref


def _observation(ref, args, stdin):
    if not args.observation and args.case is None:
        raise contract.Invalid("invalid_cli_arguments")
    if args.observation:
        raw = sys.stdin.buffer.read(contract.MAX_OBSERVATION_BYTES + 1) if stdin is None else stdin
        observation = contract.strict_json(raw, contract.MAX_OBSERVATION_BYTES)
    else:
        if args.case not in ref["fixture"]["cases"]:
            raise contract.Invalid("invalid_field_value")
        observation = ref["fixture"]["cases"][args.case]
    violation = contract.scan_secrets(observation)
    if violation:
        raise contract.Invalid(violation)
    contract.validate_observation(observation, ref["adapter"])
    return observation


# ------------------------------------------------------------------ adapters


def _receipt_outcome(receipt, pins):
    if receipt is None:
        return "missing"
    if any(receipt[key] != pins[key] for key in contract.RECEIPT_PINS):
        return "mismatched"
    if receipt["success"] is not True:
        return "failed"
    if receipt["finalized"] is not True:
        return "not_finalized"
    return "matched"


def _run_fixture_voucher(ref, args, opener, stdin, report):
    observation = _observation(ref, args, stdin)
    eligibility = _by_check(ref, "fixture_eligibility")
    receipt_steps = _by_check(ref, "fixture_receipt")
    humans = _human_steps(ref)
    if observation["eligible"] is False:
        return report("ineligible", dict.fromkeys(eligibility, "fail"), evidence={"eligibility": "ineligible"})
    receipt = _receipt_outcome(observation["receipt"], ref["proof"]["pins"])
    if receipt == "matched":
        outcomes = dict.fromkeys(eligibility + receipt_steps + humans, "pass")
        return report("verified_fixture", outcomes, evidence={"eligibility": "eligible", "receipt": "matched"})
    outcomes = dict.fromkeys(eligibility, "pass")
    outcomes.update(dict.fromkeys(humans, "needs_user"))
    outcomes.update({step: "blocked" if receipt == "missing" else "fail" for step in receipt_steps})
    checkpoint = _checkpoint_of_first_human_step(ref)
    return report("needs_user", outcomes, evidence={"eligibility": "eligible", "receipt": receipt}, checkpoint=checkpoint)


def _origin(url):
    parts = urlsplit(url)
    return parts.scheme.lower(), parts.netloc.lower()


def _run_fixture_browser_email(ref, args, opener, stdin, report):
    observation = _observation(ref, args, stdin)
    sources = {source["id"]: source for source in ref["official_sources"]}
    origin_checks = [
        (step["id"], step["check"]) for step in ref["steps"] if step["check"] is not None and step["check"]["type"] == "official_origin"
    ]
    status_steps = _by_check(ref, "fixture_account_status")
    humans = _human_steps(ref)

    def stop(checkpoint, account_status, origin_outcome, human_outcome, status_outcome):
        outcomes = dict.fromkeys(humans, human_outcome)
        outcomes.update(dict.fromkeys(status_steps, status_outcome))
        outcomes.update(dict.fromkeys([step for step, _ in origin_checks], origin_outcome))
        return report("needs_user", outcomes, evidence={"account_status": account_status}, checkpoint=checkpoint)

    if any(_origin(observation["page_origin"]) != _origin(sources[check["source_id"]]["url"]) for _, check in origin_checks):
        return stop(_checkpoint_of_type(ref, "login"), "origin_mismatch", "fail", "needs_user", "blocked")
    if not observation["inputs_ready"]:
        return stop(_checkpoint_of_type(ref, "batch_inputs"), "unverified", "needs_user", "skipped", "blocked")
    if observation["account_status"] == ref["proof"]["required_status"]:
        outcomes = dict.fromkeys([step for step, _ in origin_checks] + status_steps + humans, "pass")
        return report("verified_fixture", outcomes, evidence={"account_status": observation["account_status"]})
    return stop(_checkpoint_of_first_human_step(ref), observation["account_status"], "pass", "needs_user", "fail")


def _live_opener(offline):
    if offline:
        raise _TransportBlocked()
    return urllib.request.build_opener(NoRedirectHandler())


def _fetch(opener, url):
    """HTTPS GET with no cookie or credential header. Returns at most ``MAX_HTTP_BODY_BYTES`` of JSON."""
    headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    request = urllib.request.Request(url, headers=headers, method="GET")
    with contextlib.closing(opener.open(request, timeout=HTTP_TIMEOUT_SECONDS)) as response:
        status = getattr(response, "status", None)
        if status is None:
            status = response.getcode()
        body = response.read(contract.MAX_HTTP_BODY_BYTES + 1)
    if not 200 <= status < 300 or len(body) > contract.MAX_HTTP_BODY_BYTES:
        raise _TransportBlocked()
    return contract.strict_json(body, contract.MAX_HTTP_BODY_BYTES)


def _run_http_read_only(ref, args, opener, stdin, report):
    sources = {source["id"]: source for source in ref["official_sources"]}
    unreadable = (_TransportBlocked, OSError, http.client.HTTPException, contract.Invalid)
    outcomes = {}
    for step in ref["steps"]:
        check = step["check"]
        if check is None or check["type"] != "http_json_pins":
            continue  # A reviewed_activation step is carried by the reviewed reference, not fetched.
        try:
            document = _fetch(opener or _live_opener(args.offline), sources[check["source_id"]]["url"])
        except unreadable:
            outcomes[step["id"]] = "blocked"
            return report(
                "blocked_missing_capability",
                outcomes,
                evidence={"network": "not_checked"},
                missing_capabilities=[NETWORK_CAPABILITY],
            )
        if type(document) is not dict or any(document.get(key) != value for key, value in check["pins"].items()):
            outcomes[step["id"]] = "fail"
            return report("needs_user", outcomes, evidence={"network": "mismatched"})
        outcomes[step["id"]] = "pass"
    # Phase 1 has no live receipt or eligibility verifier, so matching pins never verify a claim.
    return report("needs_user", outcomes, evidence={"network": "matched"})


_ADAPTERS = {
    "fixture_voucher": _run_fixture_voucher,
    "fixture_browser_email": _run_fixture_browser_email,
    "http_read_only": _run_http_read_only,
}


# ----------------------------------------------------------------- reporting

_RECEIPT_REASONS = {
    "missing": "is missing",
    "mismatched": "is for a different claim",
    "failed": "failed",
    "not_finalized": "is not finalized",
}


def _summary(report):
    """One line for a human. Uses fixed phrases and report codes only."""
    prefix = "[fixture only] " if report["mode"] == "synthetic_fixture" else "[live read-only] "
    status, evidence, checkpoint = report["status"], report["evidence"], report["checkpoint"]
    if status == "invalid_input":
        detail = "Invalid input: %s. Nothing was evaluated." % report["error"]
    elif status == "blocked_not_active":
        detail = "Task is not active per its reviewed reference. No network call and no user action."
    elif status == "blocked_missing_capability":
        detail = "Blocked. Missing capabilities: %s." % ", ".join(report["missing_capabilities"])
    elif status == "ineligible":
        detail = "Not eligible in this scenario."
    elif status == "needs_user":
        detail = "Human checkpoint pending: %s." % (checkpoint["id"] if checkpoint else "none")
        if evidence["receipt"] in _RECEIPT_REASONS:
            detail += " Synthetic receipt %s." % _RECEIPT_REASONS[evidence["receipt"]]
        if evidence["network"] == "mismatched":
            detail += " A pinned public endpoint did not match."
        detail += " No completion recorded."
    elif evidence["receipt"] == "matched":
        detail = "Synthetic receipt matched. No live claim was verified."
    else:
        detail = "Synthetic evidence matched. No live claim was verified."
    return prefix + detail


def run_task(argv, opener=None, stdin=None):
    """Evaluate one command line. Returns ``(report, exit_code)``.

    ``opener`` replaces the HTTPS opener and ``stdin`` the standard input, so a
    test can run an active live task without a network connection.
    """
    known = {"task_id": None, "revision": None, "mode": None, "adapter": None}
    try:
        args = _parse_args(list(argv))
        known["task_id"] = args.task if contract.ID_RE.fullmatch(args.task) else None
        known["revision"] = args.revision
        granted = _granted_capabilities(args.capabilities, args.offline, opener)
        ref = _load_pinned_ref(args.tasks_dir, args.task, args.revision, args.expect_sha256)
        known.update(task_id=ref["task_id"], revision=ref["revision"], mode=ref["mode"], adapter=ref["adapter"])
        report = _binder(ref)
        if ref["mode"] == "live_read_only" and (args.case is not None or args.observation):
            raise contract.Invalid("mode_not_allowed")
        # The activation gate comes before any network call or user prompt.
        if ref["activation"]["state"] != "active":
            gate = _by_check(ref, "reviewed_activation")[:1]
            checkpoint = _checkpoint_of_type(ref, "await_activation", False)
            return report("blocked_not_active", dict.fromkeys(gate, "blocked"), checkpoint=checkpoint), 0
        missing = [item for item in ref["required_capabilities"] if item not in granted]
        if missing:
            return report("blocked_missing_capability", missing_capabilities=missing), 0
        return _ADAPTERS[ref["adapter"]](ref, args, opener, stdin, report), 0
    except contract.Invalid as error:
        return _report("invalid_input", error=error.code, **known), 2


def main(argv=None):
    report, exit_code = run_task(sys.argv[1:] if argv is None else argv)
    sys.stdout.buffer.write((json.dumps(report, indent=2, sort_keys=True, ensure_ascii=True) + "\n").encode("utf-8"))
    sys.stderr.buffer.write((_summary(report) + "\n").encode("utf-8"))
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
