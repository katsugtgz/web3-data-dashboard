"""Exercise run.py through its command line: argv in, report and exit code out."""
import hashlib
import http.client
import io
import json
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from email.message import Message
from pathlib import Path
from unittest import mock

import run as runner
import test_contract

SKILL = Path(__file__).resolve().parents[1]
RUN = SKILL / "scripts" / "run.py"
TASKS = SKILL.parents[1] / "data" / "tasks"
GOLDEN = SKILL / "tests" / "golden" / "flop-testnet-voucher.v1.blocked_not_active.json"
CHAIN_URL = "https://faucet.flop.network/chain"
CHAIN_BODY = {
    "network": "testnet",
    "chain": "FLOP Testnet",
    "genesisHash": "0x918abd58fb16306b30ef3886514cfaebffecb4de43e82b6f8ec4795c43cfd800",
    "caip2": "polkadot:918abd58fb16306b30ef3886514cfaeb",
}


def load(path):
    return json.loads(path.read_bytes().decode("utf-8"))


def ref_file(task_id):
    return load(TASKS / ("%s.v1.json" % task_id))


MATCHED = ref_file("voucher-demo")["fixture"]["cases"]["matched"]


def voucher_observation(**changes):
    observation = json.loads(json.dumps(MATCHED))
    observation.update(changes)
    return observation


class FakeResponse(io.BytesIO):
    def __init__(self, status, body):
        super().__init__(body)
        self.status = status


class FakeOpener:
    """Stands in for the HTTPS opener: records each request, then answers or raises."""

    def __init__(self, outcome):
        self.outcome = outcome
        self.requests = []

    def open(self, request, timeout=None):
        self.requests.append((request, timeout))
        if isinstance(self.outcome, BaseException):
            raise self.outcome
        return FakeResponse(200, self.outcome)


class CannedHTTPSHandler(urllib.request.BaseHandler):
    """Real urllib handler that answers from memory, so redirect handling runs for real."""

    handler_order = 100

    def __init__(self, answers):
        self.answers = []
        for status, body, extra in answers:
            headers = Message()
            for name, value in extra:
                headers[name] = value
            self.answers.append((status, body, headers))
        self.calls = 0

    def https_open(self, request):
        status, body, headers = self.answers[min(self.calls, len(self.answers) - 1)]
        self.calls += 1
        response = FakeResponse(status, body)
        response.code, response.msg = status, "canned"
        response.info = lambda: headers
        return response


def no_network(test):
    """Fail the test if anything tries to create a socket."""
    @mock.patch("socket.socket", side_effect=AssertionError("network used"))
    def patched(instance, *_args, **_kwargs):
        return test(instance)

    return patched


class RunnerTests(unittest.TestCase):
    def run_task(self, *argv, opener=None, stdin=None):
        if stdin is not None and type(stdin) is not bytes:
            stdin = json.dumps(stdin).encode("utf-8")
        report, code = runner.run_task(list(argv), opener=opener, stdin=stdin)
        test_contract.assert_schema(report, test_contract.load_schema("run-report"))
        self.assertCheckpointFollowsStatus(report)
        return report, code

    def assertCheckpointFollowsStatus(self, report):
        """The status rules of parseRunReport in shared/taskContract.ts."""
        checkpoint, status = report["checkpoint"], report["status"]
        if status == "needs_user":
            self.assertIsNotNone(checkpoint, "needs_user without a checkpoint")
            self.assertTrue(checkpoint["human_action_required_now"])
        elif status == "blocked_not_active":
            self.assertTrue(checkpoint is None or (checkpoint["type"] == "await_activation" and not checkpoint["human_action_required_now"]))
        else:
            self.assertIsNone(checkpoint, "%s carries a checkpoint" % status)

    def argv(self, *extra, task="voucher-demo", tasks_dir=TASKS, revision="1", expect_sha256=None):
        """A valid command line for ``task``. The pin comes from that dir's manifest unless given."""
        if expect_sha256 is None:
            entry = next(item for item in load(tasks_dir / "manifest.json")["tasks"] if item["task_id"] == task)
            expect_sha256 = entry["ref_sha256"]
        return ["--task", task, "--revision", revision, "--expect-sha256", expect_sha256, "--tasks-dir", str(tasks_dir), *extra]

    def tasks_dir(self, mutate=None, tasks=None, rehash=True, row=None):
        """Copy data/tasks to a temp dir, optionally mutating refs and manifest rows."""
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root, True)
        manifest = load(TASKS / "manifest.json")
        for index in range(len(manifest["tasks"])) if tasks is None else tasks:
            entry = manifest["tasks"][index]
            ref = ref_file(entry["task_id"])
            if mutate:
                mutate(ref)
            if row:
                row(entry)
            raw = (json.dumps(ref, indent=2) + "\n").encode("utf-8")
            (root / entry["ref_path"]).write_bytes(raw)
            if rehash:
                entry["ref_sha256"] = hashlib.sha256(raw).hexdigest()
        (root / "manifest.json").write_bytes((json.dumps(manifest, indent=2) + "\n").encode("utf-8"))
        return root

    def cli(self, *argv, payload=None):
        if payload is not None and type(payload) is not bytes:
            payload = json.dumps(payload).encode("utf-8")
        return subprocess.run([sys.executable, "-B", str(RUN), *argv], input=payload, capture_output=True, check=False)

    @staticmethod
    def activate_flop(ref):
        if ref["task_id"] == "flop-testnet-voucher":
            ref["activation"]["state"] = "active"
            ref["proof"] = ref_file("voucher-demo")["proof"]

    def active_dir(self):
        return self.tasks_dir(mutate=self.activate_flop, tasks=[2])

    # The seven voucher fixture tests, ported from web3-voucher-fixture.

    def test_bundled_scenarios(self):
        for case, expected in {
            "eligible": "needs_user", "ineligible": "ineligible",
            "matched": "verified_fixture", "wrong": "needs_user",
        }.items():
            with self.subTest(case=case):
                report, code = self.run_task(*self.argv("--case", case))
                self.assertEqual((code, report["status"]), (0, expected))
                self.assertEqual(report["mode"], "synthetic_fixture")
                self.assertEqual(bool(report["checkpoint"]), expected == "needs_user")

    def test_failed_and_unfinalized_receipts_are_not_completion(self):
        for field in ("success", "finalized"):
            observation = voucher_observation()
            observation["receipt"][field] = False
            report, code = self.run_task(*self.argv("--observation"), stdin=observation)
            with self.subTest(field=field):
                self.assertEqual((code, report["status"]), (0, "needs_user"))
                self.assertEqual(report["evidence"]["receipt"], "failed" if field == "success" else "not_finalized")

    def test_all_receipt_pins_must_match(self):
        for field in ref_file("voucher-demo")["proof"]["pins"]:
            observation = voucher_observation()
            observation["receipt"][field] = "other"
            report, code = self.run_task(*self.argv("--observation"), stdin=observation)
            with self.subTest(field=field):
                self.assertEqual((code, report["status"]), (0, "needs_user"))
                self.assertEqual(report["evidence"]["receipt"], "mismatched")
                self.assertNotIn("other", json.dumps(report))

    def test_unsupported_revision_task_and_case(self):
        newer = self.tasks_dir(
            tasks=[0], mutate=lambda ref: ref.update(revision=2), row=lambda item: item.update(revision=2, ref_path="voucher-demo.v2.json")
        )
        for label, argv, expected in (
            ("stale", self.argv("--case", "eligible", tasks_dir=newer), "stale_revision"),
            ("unknown", self.argv("--case", "eligible", revision="2"), "unknown_revision"),
            ("task", self.argv("--case", "eligible", task="other-task", expect_sha256="0" * 64), "unsupported_task"),
            ("unsafe task", self.argv("--case", "eligible", task="BAD TASK", expect_sha256="0" * 64), "unsupported_task"),
            ("case", self.argv("--case", "unknown"), "invalid_field_value"),
        ):
            with self.subTest(label=label):
                report, code = self.run_task(*argv)
                self.assertEqual((code, report["status"], report["error"]), (2, "invalid_input", expected))
        for task, expected in (("other-task", "other-task"), ("BAD TASK", None)):
            report = self.run_task(*self.argv("--case", "eligible", task=task, expect_sha256="0" * 64))[0]
            self.assertEqual(report["task_id"], expected)

    def test_report_names_only_a_verified_reference_hash(self):
        tampered = self.tasks_dir(mutate=lambda ref: ref.update(title="Other"), rehash=False)
        for label, argv, expected in (
            ("verified", self.argv("--case", "matched"), self.argv()[5]),
            ("unsupported task", self.argv("--case", "matched", task="other-task", expect_sha256="0" * 64), None),
            ("wrong expected hash", self.argv("--case", "matched", expect_sha256="0" * 64), None),
            ("tampered file", self.argv("--case", "matched", tasks_dir=tampered), None),
            ("unreadable command line", [], None),
        ):
            with self.subTest(label=label):
                report, code = self.run_task(*argv)
                self.assertEqual((report["kind"], report["ref_sha256"]), ("run_report", expected))

    def test_malformed_and_unexpected_input(self):
        for payload in (
            b"{", b'{"eligible":true,"eligible":false,"receipt":null}',
            {"eligible": 1, "receipt": None}, {"eligible": True, "receipt": {}},
            {"eligible": True, "receipt": None, "endpoint": "untrusted"},
            {"eligible": False, "receipt": MATCHED["receipt"]},
            b" " * (runner.contract.MAX_OBSERVATION_BYTES + 1),
        ):
            report, code = self.run_task(*self.argv("--observation"), stdin=payload)
            with self.subTest(payload=type(payload).__name__):
                self.assertEqual((code, report["status"]), (2, "invalid_input"))
                self.assertNotIn("untrusted", json.dumps(report))

    def test_json_output_and_human_summary_are_separate(self):
        for case, message in (
            ("eligible", "Human checkpoint pending"), ("ineligible", "Not eligible"),
            ("matched", "Synthetic receipt matched"), ("wrong", "different claim"),
        ):
            result = self.cli(*self.argv("--case", case))
            with self.subTest(case=case):
                self.assertEqual(result.returncode, 0)
                self.assertEqual(json.loads(result.stdout)["task_id"], "voucher-demo")
                summary = result.stderr.decode("utf-8")
                self.assertIn("[fixture only]", summary)
                self.assertIn(message, summary)
                self.assertEqual(len(result.stderr.splitlines()), 1)
                self.assertNotIn("[fixture only]", result.stdout.decode("utf-8"))

    def test_repeat_output_is_identical(self):
        for case in ("eligible", "ineligible", "matched", "wrong"):
            with self.subTest(case=case):
                first = self.cli(*self.argv("--case", case))
                second = self.cli(*self.argv("--case", case))
                self.assertEqual((first.returncode, first.stdout, first.stderr), (second.returncode, second.stdout, second.stderr))

    # Pinning: manifest, revision and hash decide before anything is evaluated.

    def test_tampered_ref_and_wrong_expected_hash_fail_closed(self):
        def tamper(ref):
            if ref["task_id"] == "voucher-demo":
                ref["proof"]["pins"]["recipient"] = "fixture-other-recipient"

        tampered = self.tasks_dir(mutate=tamper, rehash=False)
        report, code = self.run_task(*self.argv("--case", "matched", tasks_dir=tampered))
        self.assertEqual((code, report["status"], report["error"]), (2, "invalid_input", "ref_sha256_mismatch"))
        # The same tamper passes once its hash is re-pinned, so the hash is what stopped it.
        report, code = self.run_task(*self.argv("--case", "matched", tasks_dir=self.tasks_dir(mutate=tamper)))
        self.assertEqual((code, report["status"]), (0, "needs_user"))
        for expect in ("0" * 64, "not-a-sha"):
            with self.subTest(expect=expect):
                report, code = self.run_task(*self.argv("--case", "matched", expect_sha256=expect))
                self.assertEqual((code, report["status"], report["error"]), (2, "invalid_input", "expect_sha256_mismatch"))

    def test_cli_argument_errors(self):
        valid = self.argv("--case", "matched")
        for label, argv in (
            ("revision", [*valid, "--revision", "x"]),
            ("zero revision", [*valid, "--revision", "0"]),
            ("negative revision", [*valid, "--revision=-1"]),
            ("case and observation", [*valid, "--observation"]),
            ("neither case nor observation", self.argv()),
            ("unknown flag", [*valid, "--dry-run"]),
            ("missing task", valid[2:]),
            ("bad capability", self.argv("--case", "matched", "--capabilities", "teleport")),
            ("human capability", self.argv("--case", "matched", "--capabilities", "wallet_human")),
        ):
            with self.subTest(label=label):
                report, code = self.run_task(*argv)
                expected = "invalid_field_value" if "capability" in label else "invalid_cli_arguments"
                self.assertEqual((code, report["status"], report["error"]), (2, "invalid_input", expected))

    def test_invalid_manifest_and_reference_are_rejected(self):
        empty = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, empty, True)
        broken = self.tasks_dir()
        (broken / "manifest.json").write_bytes(b"{")
        no_manifest_pin = {"expect_sha256": "0" * 64}
        for label, tasks_dir, expected, extra in (
            ("missing manifest", empty, "invalid_manifest", no_manifest_pin),
            ("malformed manifest", broken, "malformed_json", no_manifest_pin),
            ("unknown adapter", self.tasks_dir(mutate=lambda ref: ref.update(adapter="fixture_unknown")), "adapter_not_allowed", {}),
            ("mode mismatch", self.tasks_dir(mutate=lambda ref: ref.update(mode="live_read_only")), "mode_not_allowed", {}),
            ("broken ref", self.tasks_dir(mutate=lambda ref: ref["steps"][1].update(id=ref["steps"][0]["id"])), "invalid_reference", {}),
        ):
            with self.subTest(label=label):
                report, code = self.run_task(*self.argv("--case", "matched", tasks_dir=tasks_dir, **extra))
                self.assertEqual((code, report["status"], report["error"]), (2, "invalid_input", expected))

    # The live task stops at preflight.

    @no_network
    def test_flop_not_active_matches_golden_without_network(self):
        pin = self.argv(task="flop-testnet-voucher")[5]
        report, code = self.run_task(*self.argv("--capabilities", "", task="flop-testnet-voucher"))
        result = self.cli("--task", "flop-testnet-voucher", "--revision", "1", "--expect-sha256", pin)
        self.assertEqual((result.returncode, result.stdout), (0, GOLDEN.read_bytes()))
        self.assertEqual(report, json.loads(result.stdout))
        self.assertTrue(result.stderr.startswith(b"[live read-only] "))
        self.assertEqual(report["status"], "blocked_not_active")
        self.assertEqual(report["evidence"]["activation"], "not_active")
        self.assertEqual(report["checkpoint"]["human_action_required_now"], False)
        self.assertEqual([(step["id"], step["outcome"]) for step in report["attempted_steps"]], [
            ("verify_voucher_window", "blocked"), ("verify_network", "skipped"),
        ])

    @no_network
    def test_live_task_rejects_case_and_observation(self):
        for extra in (["--case", "matched"], ["--observation"]):
            with self.subTest(extra=extra):
                report, code = self.run_task(*self.argv(*extra, task="flop-testnet-voucher"), stdin={"eligible": True, "receipt": None})
                self.assertEqual((code, report["status"], report["error"]), (2, "invalid_input", "mode_not_allowed"))

    # Capability gate.

    def test_capability_gate_blocks_before_evaluation(self):
        for value, missing in {
            "": ["browser", "email_inbox"], "browser": ["email_inbox"],
            "email_inbox": ["browser"], "network_read": ["browser", "email_inbox"],
        }.items():
            with self.subTest(value=value):
                argv = self.argv("--case", "verified", "--capabilities", value, task="browser-email-demo")
                report, code = self.run_task(*argv)
                self.assertEqual((code, report["status"]), (0, "blocked_missing_capability"))
                self.assertEqual(report["missing_capabilities"], missing)
                self.assertIsNone(report["checkpoint"])
                self.assertEqual({step["outcome"] for step in report["attempted_steps"]}, {"skipped"})
        # Enough capabilities granted: the fixture is evaluated.
        for value in (None, "browser,email_inbox", " email_inbox , browser "):
            with self.subTest(granted=value):
                extra = [] if value is None else ["--capabilities", value]
                report, code = self.run_task(*self.argv("--case", "verified", *extra, task="browser-email-demo"))
                self.assertEqual((code, report["status"]), (0, "verified_fixture"))
        # A task that requires no capability runs with none granted.
        for value in (None, "", "network_read"):
            with self.subTest(voucher=value):
                extra = [] if value is None else ["--capabilities", value]
                report, code = self.run_task(*self.argv("--case", "matched", *extra))
                self.assertEqual((code, report["status"]), (0, "verified_fixture"))

    @no_network
    def test_capability_gate_runs_after_the_activation_gate(self):
        for extra in (["--capabilities", ""], []):
            with self.subTest(extra=extra):
                report, code = self.run_task(*self.argv(*extra, task="flop-testnet-voucher"))
                self.assertEqual((code, report["status"]), (0, "blocked_not_active"))

    # Browser and email fixture.

    def test_browser_email_demo_cases(self):
        expected = {
            "inputs_missing": ("needs_user", "unverified", "batch_inputs"),
            "awaiting_verification": ("needs_user", "pending", "email_verification"),
            "wrong_origin": ("needs_user", "origin_mismatch", "login"),
            "verified": ("verified_fixture", "verified", None),
        }
        for case, (status, account_status, checkpoint_id) in expected.items():
            with self.subTest(case=case):
                report, code = self.run_task(*self.argv("--case", case, task="browser-email-demo"))
                self.assertEqual((code, report["status"]), (0, status))
                self.assertEqual(report["evidence"]["account_status"], account_status)
                self.assertEqual((report["checkpoint"] or {}).get("id"), checkpoint_id)
                if report["checkpoint"]:
                    self.assertTrue(report["checkpoint"]["human_action_required_now"])
        outcomes = {
            case: [(step["id"], step["outcome"]) for step in self.run_task(*self.argv("--case", case, task="browser-email-demo"))[0]["attempted_steps"]]
            for case in expected
        }
        self.assertEqual(outcomes["verified"], [
            ("precheck_official_app", "pass"), ("human_browser_auth", "pass"), ("verify_account_status", "pass"),
        ])
        self.assertEqual(outcomes["wrong_origin"][0], ("precheck_official_app", "fail"))
        self.assertEqual(outcomes["awaiting_verification"][-1], ("verify_account_status", "fail"))

    def test_observation_origin_must_match_the_official_app(self):
        base = ref_file("browser-email-demo")["fixture"]["cases"]["verified"]
        argv = self.argv("--observation", task="browser-email-demo")
        for origin in (
            "https://app.fixture.invalid.evil.example/", "http://app.fixture.invalid/",
            "https://app.fixture.invalid\\evil.example/", "https://app.fixture.invalid./",
        ):
            report, code = self.run_task(*argv, stdin=dict(base, page_origin=origin))
            with self.subTest(origin=origin):
                self.assertEqual((code, report["status"]), (0, "needs_user"))
                self.assertEqual(report["evidence"]["account_status"], "origin_mismatch")
        # A value that is not a bare origin is rejected before any evaluation.
        for origin, error in (
            ("https://app.fixture.invalid/login", "invalid_field_value"),
            ("app.fixture.invalid", "invalid_field_value"),
            ("https://app.fixture.invalid@evil.example/", "pii_detected"),
            ("https://user:pw@app.fixture.invalid/", "pii_detected"),
            ("https://app.fixture.invalid:8443/", "secret_detected"),
        ):
            report, code = self.run_task(*argv, stdin=dict(base, page_origin=origin))
            with self.subTest(origin=origin):
                self.assertEqual((code, report["status"], report["error"]), (2, "invalid_input", error))

    # Secrets and PII never reach the report or the summary.

    def test_observation_secret_and_pii_are_rejected_without_echo(self):
        jwt = "eyJhbGciOiJIUzI1NiJ9." + "eyJzdWIiOiJmeGl0dXJlIn0.c2lnbmF0dXJl"
        email = "someone@" + "example.com"
        hex64 = "0123456789abcdef" * 4
        browser = ref_file("browser-email-demo")["fixture"]["cases"]["verified"]
        for label, task, payload, fragment in (
            ("secret_detected", "voucher-demo", voucher_observation(note=jwt), "eyJ"),
            ("secret_detected", "voucher-demo", voucher_observation(receipt=dict(MATCHED["receipt"], voucher_id=hex64)), hex64),
            ("pii_detected", "voucher-demo", voucher_observation(receipt=dict(MATCHED["receipt"], recipient=email)), "someone"),
            ("pii_detected", "browser-email-demo", dict(browser, page_origin="https://" + email + "/"), "someone"),
        ):
            with self.subTest(payload=label):
                result = self.cli(*self.argv("--observation", task=task), payload=payload)
                output = result.stdout.decode("utf-8") + result.stderr.decode("utf-8")
                self.assertEqual(result.returncode, 2)
                self.assertEqual((json.loads(result.stdout)["status"], json.loads(result.stdout)["error"]), ("invalid_input", label))
                self.assertNotIn(fragment, output)

    # The live read-only adapter, with the network replaced by an injected opener.

    @no_network
    def test_http_redirect_is_rejected(self):
        redirect = (302, b"", [("location", "https://evil.example.invalid/chain")])
        matched = (200, json.dumps(CHAIN_BODY).encode("utf-8"), [])
        argv = self.argv("--offline", task="flop-testnet-voucher", tasks_dir=self.active_dir())
        guarded = CannedHTTPSHandler([redirect])
        report, code = self.run_task(*argv, opener=urllib.request.build_opener(runner.NoRedirectHandler(), guarded))
        self.assertEqual((code, report["status"], report["missing_capabilities"]), (0, "blocked_missing_capability", ["network_read"]))
        self.assertEqual(guarded.calls, 1)
        # A stock opener follows the same redirect, so the guard is what stops it.
        plain = CannedHTTPSHandler([redirect, matched])
        control = self.run_task(*argv, opener=urllib.request.build_opener(plain))[0]
        self.assertEqual((control["evidence"]["network"], plain.calls), ("matched", 2))

    @no_network
    def test_http_pin_mismatch_and_transport_failures(self):
        argv = self.argv("--offline", task="flop-testnet-voucher", tasks_dir=self.active_dir())
        blocked = ("blocked_missing_capability", "not_checked", "blocked")
        for label, outcome, expected in (
            ("mismatch", json.dumps(dict(CHAIN_BODY, caip2="polkadot:other")).encode("utf-8"), ("needs_user", "mismatched", "fail")),
            ("transport", urllib.error.URLError("connection refused"), blocked),
            ("http", urllib.error.HTTPError(CHAIN_URL, 503, "Service Unavailable", Message(), None), blocked),
            ("too large", b"x" * (runner.contract.MAX_HTTP_BODY_BYTES + 1), blocked),
            ("not json", b"<html>gateway</html>", blocked),
            ("timeout", socket.timeout(), blocked),
            ("protocol", http.client.BadStatusLine("x"), blocked),
        ):
            with self.subTest(case=label):
                report, code = self.run_task(*argv, opener=FakeOpener(outcome))
                self.assertEqual((code, report["status"]), (0, expected[0]))
                self.assertEqual((report["evidence"]["network"], report["attempted_steps"][1]["outcome"]), expected[1:])
                self.assertEqual(report["missing_capabilities"], [] if expected[0] == "needs_user" else ["network_read"])
                self.assertEqual((report["checkpoint"] or {}).get("id"), "pinned_endpoint_mismatch" if label == "mismatch" else None)
                self.assertNotIn("Service Unavailable", json.dumps(report))

    @no_network
    def test_http_matching_pins_still_need_a_human(self):
        opener = FakeOpener(json.dumps(CHAIN_BODY).encode("utf-8"))
        argv = self.argv("--offline", task="flop-testnet-voucher", tasks_dir=self.active_dir())
        report, code = self.run_task(*argv, opener=opener)
        self.assertEqual((code, report["status"]), (0, "needs_user"))
        self.assertEqual(report["evidence"], {
            "activation": "active", "network": "matched", "eligibility": "not_checked",
            "receipt": "not_checked", "account_status": "not_checked",
        })
        self.assertEqual([(step["id"], step["outcome"]) for step in report["attempted_steps"]], [
            ("verify_voucher_window", "skipped"), ("verify_network", "pass"),
        ])
        # The reference defines no human step, so the runner names the action itself.
        self.assertEqual(
            (report["checkpoint"]["id"], report["checkpoint"]["human_action_required_now"]),
            ("live_claim_unverified", True),
        )
        request, timeout = opener.requests[0]
        self.assertEqual((request.get_method(), request.full_url), ("GET", CHAIN_URL))
        self.assertEqual(timeout, 10)
        headers = {name.lower() for name, _ in request.header_items()}
        self.assertFalse(headers & {"cookie", "authorization", "proxy-authorization"})

    @no_network
    def test_offline_run_opens_no_connection(self):
        active = self.active_dir()
        for extra in (["--offline"], ["--offline", "--capabilities", "network_read"]):
            with self.subTest(extra=extra):
                report, code = self.run_task(*self.argv(*extra, task="flop-testnet-voucher", tasks_dir=active))
                self.assertEqual((code, report["status"], report["missing_capabilities"]), (0, "blocked_missing_capability", ["network_read"]))


if __name__ == "__main__":
    unittest.main()
