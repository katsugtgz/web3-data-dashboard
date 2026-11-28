"""Contract vectors, bundled-data checks and schema parity for contract.py."""
import copy
import hashlib
import json
import re
import unittest
from pathlib import Path

import contract

SKILL = Path(__file__).resolve().parents[1]
REPO = SKILL.parents[1]
SCHEMAS = SKILL / "references" / "schemas"
TASKS = REPO / "data" / "tasks"
VECTORS = json.loads((SKILL / "tests" / "contract-vectors.json").read_bytes().decode("utf-8"))


def expand(value):
    """Replace {"$join": [...]} with the joined parts and {"$utf8": "<hex>"} with bytes."""
    if type(value) is dict:
        if set(value) == {"$join"}:
            return "".join(expand(part) for part in value["$join"])
        if set(value) == {"$utf8"}:
            return bytes.fromhex(value["$utf8"])
        return {key: expand(child) for key, child in value.items()}
    if type(value) is list:
        return [expand(child) for child in value]
    return value


def load_json(path):
    return json.loads(path.read_bytes().decode("utf-8"))


def load_schema(name):
    return load_json(SCHEMAS / ("%s.v1.schema.json" % name))


def _kind(value):
    if value is None:
        return "null"
    if type(value) is bool:
        return "boolean"
    if type(value) is int:
        return "integer"
    if type(value) in (dict, list):
        return "object" if type(value) is dict else "array"
    return "string" if type(value) is str else "number"


def assert_schema(value, schema, path="$", root=None):
    """Check ``value`` against the JSON Schema keywords the bundled schemas use."""
    root = schema if root is None else root
    if "$ref" in schema:
        node = root
        for part in schema["$ref"].lstrip("#/").split("/"):
            node = node[part]
        return assert_schema(value, node, path, root)
    if "const" in schema:
        assert value == schema["const"] and _kind(value) == _kind(schema["const"]), path
    if "enum" in schema:
        assert any(value == item and _kind(value) == _kind(item) for item in schema["enum"]), path
    if "type" in schema:
        kinds = schema["type"] if type(schema["type"]) is list else [schema["type"]]
        assert _kind(value) in kinds, path
    if type(value) is str:
        assert len(value) >= schema.get("minLength", 0) and len(value) <= schema.get("maxLength", 1 << 30), path
        if "pattern" in schema:
            assert re.search(schema["pattern"], value) is not None, path
    if _kind(value) == "integer":
        assert "minimum" not in schema or value >= schema["minimum"], path
    if type(value) is list:
        assert len(value) >= schema.get("minItems", 0) and len(value) <= schema.get("maxItems", 1 << 30), path
        if schema.get("uniqueItems"):
            assert len({json.dumps(item, sort_keys=True) for item in value}) == len(value), path
        if "items" in schema:
            for index, item in enumerate(value):
                assert_schema(item, schema["items"], "%s[%d]" % (path, index), root)
    if type(value) is dict:
        assert len(value) >= schema.get("minProperties", 0) and len(value) <= schema.get("maxProperties", 1 << 30), path
        for key in schema.get("required", ()):
            assert key in value, "%s missing %s" % (path, key)
        properties = schema.get("properties", {})
        extra = [key for key in value if key not in properties]
        for key, child in value.items():
            if key in properties:
                assert_schema(child, properties[key], "%s.%s" % (path, key), root)
            elif type(schema.get("additionalProperties")) is dict:
                assert_schema(child, schema["additionalProperties"], "%s.%s" % (path, key), root)
        if "additionalProperties" in schema:
            assert schema["additionalProperties"] is not False or not extra, "%s extra %s" % (path, extra)
        if "propertyNames" in schema:
            for key in value:
                assert re.search(schema["propertyNames"]["pattern"], key) is not None, "%s key %s" % (path, key)
    for keyword in ("oneOf", "anyOf"):
        if keyword in schema:
            passed = 0
            for option in schema[keyword]:
                try:
                    assert_schema(value, option, path, root)
                    passed += 1
                except AssertionError:
                    pass
            if keyword == "oneOf":
                assert passed == 1, "%s matches %d oneOf options" % (path, passed)
            else:
                assert passed > 0, "%s matches no anyOf option" % path


def _reach(ref, path):
    node = ref
    for key in path[:-1]:
        node = node[key]
    return node, path[-1]


def changed(path, value):
    def apply(ref):
        parent, key = _reach(ref, path)
        parent[key] = value

    return apply


def deleted(path):
    def apply(ref):
        parent, key = _reach(ref, path)
        del parent[key]

    return apply


class ContractVectorTests(unittest.TestCase):
    def assertVector(self, vector):
        context = vector["context"]
        if context == "scrub":
            actual = contract.scan_secrets(expand(vector["input"]), vector.get("exempt_paths"))
        elif context == "contribution_url":
            actual = contract.contains_url(expand(vector["input"]), vector.get("exempt_paths"))
        elif context == "strict_json":
            limit = vector.get("max_bytes", contract.MAX_OBSERVATION_BYTES)
            if vector["expect"] is None:
                value = contract.strict_json(expand(vector["input"]), limit)
                if "equals" in vector:
                    self.assertEqual(value, vector["equals"])
                return
            with self.assertRaises(contract.Invalid) as caught:
                contract.strict_json(expand(vector["input"]), limit)
            actual = caught.exception.code
        else:
            raise AssertionError("unknown context %r" % context)
        self.assertEqual(actual, vector["expect"])

    def test_exemptions_match_whole_segments(self):
        # A "*" segment matches any one segment: the same rule as isExempt in shared/taskContract.ts.
        origin = ["$.fixture.cases.*.page_origin"]
        for label, value, exempt_paths in (
            ("any case name", {"fixture": {"cases": {"awaiting_verification": {"page_origin": "Code 1234"}}}}, origin),
            ("array segment stays literal", {"tasks": [{"ref_sha256": "Code 1234"}]}, ["$.tasks[*].ref_sha256"]),
            ("last segment", {"steps": [{"check": {"pins": {"genesisHash": "Code 1234"}}}]}, ["$.steps[*].check.pins.*"]),
        ):
            with self.subTest(label=label):
                self.assertIsNone(contract.scan_secrets(value, exempt_paths))
        for label, value in (
            ("one segment deeper", {"fixture": {"cases": {"a": {"receipt": {"page_origin": "Code 1234"}}}}}),
            ("one segment shorter", {"fixture": {"cases": {"page_origin": "Code 1234"}}}),
            ("sibling field", {"fixture": {"cases": {"a": {"page_origin": "ok", "note": "Code 1234"}}}}),
        ):
            with self.subTest(label=label):
                self.assertEqual(contract.scan_secrets(value, origin), "secret_detected")
        self.assertFalse(contract.contains_url({"fixture": {"cases": {"a": {"page_origin": "https://app.fixture.invalid"}}}}, origin))
        self.assertTrue(contract.contains_url({"fixture": {"cases": {"a": {"note": "www.example.invalid"}}}}, origin))

    def test_contract_vectors(self):
        vectors = VECTORS["vectors"]
        self.assertEqual(VECTORS["schema_version"], contract.TASK_SCHEMA_VERSION)
        self.assertGreaterEqual(len(vectors), 42)
        self.assertEqual({vector["context"] for vector in vectors}, {"scrub", "strict_json", "contribution_url"})
        for vector in vectors:
            with self.subTest(vector=vector["name"]):
                self.assertVector(vector)

    def test_strict_json_vectors_cover_its_error_codes(self):
        codes = {
            vector["expect"] for vector in VECTORS["vectors"]
            if vector["context"] == "strict_json" and vector["expect"] is not None
        }
        self.assertEqual(codes, {"malformed_json", "duplicate_json_field", "input_too_large"})

    def test_vector_file_holds_no_raw_secret_or_pii_shape(self):
        for vector in VECTORS["vectors"]:
            raw = vector["input"]
            if vector["context"] == "scrub" and vector["expect"] is not None and type(expand(raw)) is str:
                with self.subTest(vector=vector["name"]):
                    # A whole fake token would trip the scanner, so the parts must stay split.
                    self.assertIsNone(contract.scan_secrets(raw))


class BundledDataTests(unittest.TestCase):
    def test_manifest_and_refs_are_valid_and_match_schemas(self):
        manifest = load_json(TASKS / "manifest.json")
        contract.validate_manifest(manifest)
        assert_schema(manifest, load_schema("task-manifest"))
        ref_schema = load_schema("task-ref")
        for entry in manifest["tasks"]:
            with self.subTest(task=entry["task_id"]):
                ref = load_json(TASKS / entry["ref_path"])
                contract.validate_ref(ref, entry)
                assert_schema(ref, ref_schema)
                self.assertEqual((ref["kind"], ref["review"]["reviewed_by"]), ("task_ref", "@katsugtgz"))
                self.assertTrue(all(step["title"] for step in ref["steps"]))
        self.assertEqual((manifest["kind"], [entry["task_id"] for entry in manifest["tasks"]]), ("task_manifest", [
            "voucher-demo", "browser-email-demo", "flop-testnet-voucher",
        ]))
        self.assertEqual(manifest["tasks"][2]["bindings"], {
            "card_ids": [],
            "feed_ids": ["7331604250321743f7293ccd2a8740720b4df8b1", "3d019ff90b3736d50cba052cbe3a4bc4a40cf77e"],
            "domains": [],
        })
        self.assertEqual([entry["bindings"] for entry in manifest["tasks"][:2]], [
            {"card_ids": [], "feed_ids": [], "domains": []},
        ] * 2)

    def test_manifest_hashes_are_raw_byte_sha256(self):
        for entry in load_json(TASKS / "manifest.json")["tasks"]:
            with self.subTest(task=entry["task_id"]):
                raw = (TASKS / entry["ref_path"]).read_bytes()
                self.assertEqual(entry["ref_sha256"], hashlib.sha256(raw).hexdigest())

    def test_golden_report_matches_report_schema(self):
        golden = SKILL / "tests" / "golden" / "flop-testnet-voucher.v1.blocked_not_active.json"
        report = load_json(golden)
        assert_schema(report, load_schema("run-report"))
        flop = load_ref("flop-testnet-voucher")[0]
        self.assertEqual(report["status"], "blocked_not_active")
        self.assertEqual((report["kind"], report["ref_sha256"]), ("run_report", flop["ref_sha256"]))
        self.assertEqual([step["id"] for step in report["attempted_steps"]], [
            step["id"] for step in load_ref("flop-testnet-voucher")[1]["steps"]
        ])

    def test_bundled_files_are_ascii_with_lf_and_final_newline(self):
        files = [path for path in SKILL.rglob("*") if path.is_file()]
        files += [path for path in TASKS.glob("*.json")]
        for path in files:
            if path.suffix in (".json", ".py", ".md"):
                with self.subTest(file=str(path.relative_to(REPO))):
                    raw = path.read_bytes()
                    raw.decode("ascii")
                    self.assertTrue(raw.endswith(b"\n"))
                    self.assertNotIn(b"\r", raw)


def load_ref(task_id):
    for entry in load_json(TASKS / "manifest.json")["tasks"]:
        if entry["task_id"] == task_id:
            return entry, load_json(TASKS / entry["ref_path"])
    raise AssertionError(task_id)


HEX64 = "0123456789abcdef" * 4
REF_CASES = [
    ("voucher-demo", ("mode",), "live_read_only", "mode_not_allowed"),
    ("browser-email-demo", ("mode",), "live_read_only", "mode_not_allowed"),
    ("voucher-demo", ("adapter",), "fixture_unknown", "adapter_not_allowed"),
    ("voucher-demo", ("schema_version",), 2, "invalid_reference"),
    ("voucher-demo", ("revision",), 0, "invalid_reference"),
    ("voucher-demo", ("task_id",), "Not An Id", "invalid_reference"),
    ("voucher-demo", ("networks",), [], "invalid_reference"),
    ("voucher-demo", ("required_capabilities",), ["teleport"], "invalid_reference"),
    ("voucher-demo", ("required_capabilities",), ["wallet_human"], "invalid_reference"),
    ("voucher-demo", ("activation", "state"), "maybe", "invalid_reference"),
    ("voucher-demo", ("activation", "source_ids"), ["no_such_source"], "invalid_reference"),
    ("voucher-demo", ("steps", 1, "id"), "check_fixture_eligibility", "invalid_reference"),
    ("voucher-demo", ("steps", 0, "depends_on"), ["check_fixture_receipt"], "invalid_reference"),
    ("voucher-demo", ("steps", 1, "checkpoint_id"), None, "invalid_reference"),
    ("voucher-demo", ("steps", 0, "checkpoint_id"), "voucher_claim_handoff", "invalid_reference"),
    ("voucher-demo", ("steps", 1, "checkpoint_id"), "no_such_checkpoint", "invalid_reference"),
    ("voucher-demo", ("kind",), "task", "invalid_reference"),
    ("voucher-demo", ("title",), "See https://example.invalid/docs", "invalid_reference"),
    ("voucher-demo", ("steps", 0, "title"), "", "invalid_reference"),
    ("voucher-demo", ("review", "reviewer"), "x", "invalid_reference"),
    ("voucher-demo", ("steps", 0, "check"), {"type": "fixture_eligibility", "url": "x"}, "invalid_reference"),
    ("voucher-demo", ("steps", 0, "check"), {"type": "http_json_pins", "source_id": "x", "pins": {"a": "b"}}, "mode_not_allowed"),
    ("voucher-demo", ("checkpoints", 0, "action"), "See https://example.invalid/docs", "invalid_reference"),
    ("voucher-demo", ("checkpoints", 0, "action"), "Press <Next>", "invalid_reference"),
    ("voucher-demo", ("checkpoints", 0, "action"), "x" * 401, "invalid_reference"),
    ("voucher-demo", ("checkpoints", 0, "action"), "caf" + chr(233), "invalid_reference"),
    ("voucher-demo", ("checkpoints", 0, "type"), "sign_now", "invalid_reference"),
    ("voucher-demo", ("checkpoints", 0, "id"), "bad id", "invalid_reference"),
    ("voucher-demo", ("proof", "pins", "chain"), "has space", "invalid_reference"),
    ("voucher-demo", ("fixture", "cases", "matched", "eligible"), False, "receipt_conflicts_with_ineligible"),
    ("voucher-demo", ("fixture", "cases", "matched", "receipt", "chain"), "has space", "invalid_field_value"),
    ("voucher-demo", ("fixture", "cases", "matched", "receipt", "tx"), "0xabc", "unknown_field"),
    ("voucher-demo", ("fixture", "cases", "matched", "receipt", "success"), "yes", "invalid_field_value"),
    ("voucher-demo", ("fixture", "cases", "matched", "receipt", "recipient"), "someone@" + "example.com", "pii_detected"),
    ("voucher-demo", ("fixture", "cases", "matched", "note"), "x", "unknown_field"),
    ("voucher-demo", ("fixture", "cases", "bad id"), {"eligible": True, "receipt": None}, "invalid_reference"),
    ("voucher-demo", ("fixture",), None, "invalid_reference"),
    ("voucher-demo", ("networks", 0), HEX64, "secret_detected"),
    ("voucher-demo", ("networks", 0), "chain-" + HEX64, "secret_detected"),
    ("voucher-demo", ("unexpected",), 1, "invalid_reference"),
    ("voucher-demo", ("proof",), None, "invalid_reference"),
    ("browser-email-demo", ("fixture", "cases", "verified", "account_status"), "origin_mismatch", "invalid_field_value"),
    ("browser-email-demo", ("fixture", "cases", "verified", "page_origin"), "app.fixture.invalid", "invalid_field_value"),
    # The page origin is exempt from the scanner, as in scripts/check-task-refs.mts, so its shape rule rejects this.
    ("browser-email-demo", ("fixture", "cases", "verified", "page_origin"), "https://user@app.fixture.invalid/", "invalid_field_value"),
    ("browser-email-demo", ("fixture", "cases", "verified", "page_origin"), "http://app.fixture.invalid/", "invalid_reference"),
    ("browser-email-demo", ("official_sources", 0, "kind"), "official_documentation", "invalid_reference"),
    ("browser-email-demo", ("official_sources", 0, "url"), "https://user:pw@app.fixture.invalid/", "pii_detected"),
    ("browser-email-demo", ("official_sources", 0, "url"), "http://app.fixture.invalid/", "invalid_reference"),
    ("browser-email-demo", ("official_sources", 0, "url"), "https:///no-host/", "invalid_reference"),
    ("browser-email-demo", ("steps", 1, "source_ids"), ["no_such_source"], "invalid_reference"),
    ("browser-email-demo", ("steps", 2, "check", "source_id"), "no_such_source", "invalid_reference"),
    ("flop-testnet-voucher", ("checkpoints",), [], "invalid_reference"),
    ("flop-testnet-voucher", ("official_sources",), [], "invalid_reference"),
    ("flop-testnet-voucher", ("activation", "state"), "active", "invalid_reference"),
    ("flop-testnet-voucher", ("steps", 1, "check", "source_id"), "official_timeline", "mode_not_allowed"),
    ("flop-testnet-voucher", ("steps", 1, "check", "pins"), {}, "invalid_reference"),
    ("flop-testnet-voucher", ("fixture",), {"cases": {"a": {"eligible": True, "receipt": None}}}, "invalid_reference"),
    ("flop-testnet-voucher", ("proof", "kind"), "onchain_receipt", "invalid_reference"),
]


class RefRuleTests(unittest.TestCase):
    def test_cross_field_violations_report_their_code(self):
        for task_id, path, value, expected in REF_CASES:
            with self.subTest(task=task_id, path=path):
                entry, ref = load_ref(task_id)
                ref = copy.deepcopy(ref)
                changed(path, value)(ref)
                with self.assertRaises(contract.Invalid) as caught:
                    contract.validate_ref(ref, entry)
                self.assertEqual(caught.exception.code, expected)

    def test_valid_edits_still_pass(self):
        def inactive_with_wait(ref):
            ref["activation"]["state"] = "not_active"
            ref["checkpoints"].append(
                {"id": "wait", "type": "await_activation", "action": "Wait.", "resume_when": "It is active."}
            )

        for task_id, apply in (
            ("voucher-demo", changed(("required_capabilities",), ["browser"])),
            ("voucher-demo", inactive_with_wait),
            ("flop-testnet-voucher", changed(("activation", "state"), "unknown")),
            # An agent step may carry no check, as the origin precheck of the browser fixture does.
            ("browser-email-demo", changed(("steps", 2, "check"), None)),
        ):
            with self.subTest(task=task_id):
                entry, ref = load_ref(task_id)
                ref = copy.deepcopy(ref)
                apply(ref)
                contract.validate_ref(ref, entry)

    def test_fixture_without_a_human_step_is_rejected(self):
        # Every needs_user report names a checkpoint, so a fixture needs a human step to name one.
        for task_id, index in (("voucher-demo", 1), ("browser-email-demo", 1)):
            def drop_human(ref, index=index):
                ref["steps"][index].update(actor="agent", checkpoint_id=None)

            with self.subTest(task_id=task_id):
                entry, ref = load_ref(task_id)
                ref = copy.deepcopy(ref)
                drop_human(ref)
                with self.assertRaises(contract.Invalid):
                    contract.validate_ref(ref, entry)

    def test_unknown_fields_are_rejected_at_every_level(self):
        for task_id, path in (
            ("voucher-demo", ("activation",)),
            ("voucher-demo", ("review",)),
            ("voucher-demo", ("steps", 0)),
            ("voucher-demo", ("steps", 0, "check")),
            ("voucher-demo", ("checkpoints", 0)),
            ("voucher-demo", ("proof", "pins")),
            ("flop-testnet-voucher", ("official_sources", 0)),
        ):
            entry, ref = load_ref(task_id)
            ref = copy.deepcopy(ref)
            changed(path + ("unexpected",), 1)(ref)
            with self.subTest(path=path), self.assertRaises(contract.Invalid):
                contract.validate_ref(ref, entry)

    def test_missing_fields_are_rejected(self):
        for path in (
            ("proof", "pins", "chain"), ("steps", 0, "actor"), ("steps", 0, "title"), ("review", "reviewed_at"),
        ):
            entry, ref = load_ref("voucher-demo")
            ref = copy.deepcopy(ref)
            deleted(path)(ref)
            with self.subTest(path=path), self.assertRaises(contract.Invalid):
                contract.validate_ref(ref, entry)

    def test_manifest_row_must_match_ref_identity_and_fixture_bindings(self):
        entry, voucher = load_ref("voucher-demo")
        with self.assertRaises(contract.Invalid) as caught:
            contract.validate_ref(voucher, dict(entry, revision=2))
        self.assertEqual(caught.exception.code, "invalid_reference")
        with self.assertRaises(contract.Invalid) as caught:
            contract.validate_ref(voucher, dict(entry, bindings=dict(entry["bindings"], feed_ids=["0" * 40])))
        self.assertEqual(caught.exception.code, "invalid_manifest")

    def test_manifest_violations(self):
        original = load_json(TASKS / "manifest.json")
        bound = lambda field: ("tasks", 0, "bindings", field)  # noqa: E731
        cases = [
            (("schema_version",), 2),
            (("kind",), "task_list"),
            (("tasks", 0, "task_id"), "browser-email-demo"),
            (("tasks", 0, "revision"), 0),
            (("tasks", 0, "ref_path"), "../voucher-demo.v1.json"),
            (("tasks", 0, "ref_path"), "voucher-demo.json;j"),
            (("tasks", 0, "ref_path"), "voucher-demo.v1.json\n"),
            (("tasks", 0, "ref_path"), "voucher-demo.v2.json"),
            (("tasks", 0, "bindings"), []),
            (("tasks", 0, "bindings", "slugs"), []),
            (bound("feed_ids"), ["0" * 40 + "\n"]),
            (bound("domains"), ["flop.finance\r\n"]),
            (bound("domains"), ["localhost"]),
            (("tasks", 0, "ref_sha256"), "abc"),
            (bound("feed_ids"), ["abc"]),
            (bound("card_ids"), ["abc"]),
            (bound("domains"), ["Example Domain"]),
            # A card, feed or domain belongs to one task.
            (bound("feed_ids"), ["7331604250321743f7293ccd2a8740720b4df8b1"]),
            (bound("feed_ids"), ["b" * 40, "b" * 40]),
            (("tasks", 0, "unexpected"), 1),
            (("tasks",), []),
        ]
        for path, value in cases:
            manifest = copy.deepcopy(original)
            changed(path, value)(manifest)
            with self.subTest(path=path), self.assertRaises(contract.Invalid) as caught:
                contract.validate_manifest(manifest)
            self.assertEqual(caught.exception.code, "invalid_manifest")

    def test_invalid_code_is_always_one_of_error_codes(self):
        self.assertEqual(sorted(set(contract.ERROR_CODES)), sorted(contract.ERROR_CODES))
        with self.assertRaises(AssertionError):
            contract.Invalid("made_up_code")


class SchemaParityTests(unittest.TestCase):
    def test_ref_schema_enums_match_python(self):
        props = load_schema("task-ref")["properties"]
        self.assertEqual(list(props), list(contract.REF_FIELDS))
        self.assertEqual(props["schema_version"]["const"], contract.TASK_SCHEMA_VERSION)
        self.assertEqual(props["kind"]["const"], "task_ref")
        self.assertEqual(list(props["review"]["properties"]), list(contract.REVIEW_FIELDS))
        self.assertEqual(props["mode"]["enum"], list(contract.TASK_MODES))
        self.assertEqual(props["adapter"]["enum"], list(contract.ADAPTERS))
        self.assertEqual(props["activation"]["properties"]["state"]["enum"], list(contract.ACTIVATION_STATES))
        self.assertEqual(list(props["activation"]["properties"]), ["state", "source_ids"])

    def test_nested_enums_match_python(self):
        defs = load_schema("task-ref")["$defs"]
        self.assertEqual(defs["capability"]["enum"], list(contract.CAPABILITIES))
        self.assertEqual(defs["source"]["properties"]["kind"]["enum"], list(contract.SOURCE_KINDS))
        self.assertEqual(defs["step"]["properties"]["actor"]["enum"], list(contract.ACTORS))
        self.assertEqual(list(defs["step"]["properties"]), list(contract.STEP_FIELDS))
        self.assertEqual(list(defs["checkpoint"]["properties"]), list(contract.CHECKPOINT_FIELDS))
        self.assertEqual(defs["checkpoint"]["properties"]["type"]["enum"], list(contract.CHECKPOINT_TYPES))
        self.assertEqual(list(defs["receipt"]["properties"]), list(contract.RECEIPT_PINS + ("success", "finalized")))
        kinds = [option["properties"]["kind"]["const"] for option in defs["proof"]["oneOf"]]
        self.assertEqual(kinds, list(contract.PROOF_KINDS))
        types = []
        for option in defs["step"]["properties"]["check"]["oneOf"][1]["anyOf"]:
            spec = option["properties"]["type"]
            types += spec["enum"] if "enum" in spec else [spec["const"]]
        self.assertEqual(sorted(types), sorted(contract.CHECK_TYPES))
        statuses = defs["observation"]["oneOf"][1]["properties"]["account_status"]["enum"]
        self.assertEqual(statuses, list(contract.OBSERVED_ACCOUNT_STATUSES))

    def test_report_schema_enums_match_python(self):
        props = load_schema("run-report")["properties"]
        self.assertEqual(list(props), list(contract.REPORT_FIELDS))
        self.assertEqual(props["status"]["enum"], list(contract.RUN_STATUSES))
        self.assertEqual(props["error"]["enum"], list(contract.ERROR_CODES) + [None])
        self.assertEqual(props["mode"]["enum"], list(contract.TASK_MODES) + [None])
        self.assertEqual(props["kind"]["const"], "run_report")
        self.assertEqual(props["attempted_steps"]["items"]["$ref"], "#/$defs/step_report")
        self.assertNotIn("adapter", props)
        self.assertEqual(list(load_schema("run-report")["$defs"]["evidence"]["properties"]), list(contract.EVIDENCE_ENUMS))
        evidence = load_schema("run-report")["$defs"]["evidence"]["properties"]
        self.assertEqual({key: node["enum"] for key, node in evidence.items()}, {key: list(values) for key, values in contract.EVIDENCE_ENUMS.items()})
        step = load_schema("run-report")["$defs"]["step_report"]["properties"]
        self.assertEqual(list(step), list(contract.STEP_REPORT_FIELDS))
        self.assertEqual(step["outcome"]["enum"], list(contract.STEP_OUTCOMES))
        self.assertEqual(step["id"]["pattern"], contract.ID_RE.pattern)
        checkpoint = load_schema("run-report")["$defs"]["checkpoint_report"]["properties"]
        self.assertEqual(list(checkpoint), list(contract.CHECKPOINT_REPORT_FIELDS))
        self.assertEqual(checkpoint["type"]["enum"], list(contract.CHECKPOINT_TYPES))

    def test_manifest_schema_matches_python(self):
        schema = load_schema("task-manifest")
        self.assertEqual(list(schema["properties"]), list(contract.MANIFEST_FIELDS))
        entry = schema["$defs"]["entry"]
        self.assertEqual(list(entry["properties"]), list(contract.ENTRY_FIELDS))
        self.assertEqual(schema["properties"]["kind"]["const"], "task_manifest")
        bindings = schema["$defs"]["bindings"]
        self.assertEqual(entry["properties"]["bindings"]["$ref"], "#/$defs/bindings")
        self.assertEqual(list(bindings["properties"]), list(contract.BINDING_FIELDS))

    def test_every_object_limits_extra_properties(self):
        def walk(node, path):
            if type(node) is dict:
                if node.get("type") == "object":
                    # False closes the object; a schema still constrains every extra value.
                    assert "additionalProperties" in node, path
                for key, child in node.items():
                    walk(child, "%s.%s" % (path, key))
            elif type(node) is list:
                for index, child in enumerate(node):
                    walk(child, "%s[%d]" % (path, index))

        for name in ("task-ref", "task-manifest", "run-report"):
            walk(load_schema(name), name)


if __name__ == "__main__":
    unittest.main()
