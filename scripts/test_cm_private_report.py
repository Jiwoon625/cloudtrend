import base64
from contextlib import redirect_stdout
from copy import deepcopy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

import pandas as pd
from cmresearchengine import runtime
from cm06.metrics import performance_metrics
from cmresearchengine.storage import ImmutableConflict

SPEC = importlib.util.spec_from_file_location("cm_report", Path(__file__).with_name("export-cm-audited-report.py"))
report = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(report)
ENV = {"GITHUB_ACTIONS": "true", "GITHUB_WORKFLOW": "CMresearchengine S20 S23 private final audit",
       "GITHUB_EVENT_NAME": "push", "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1", "GITHUB_SHA": "a" * 40}


class FakeStore:
    def __init__(self, private=True):
        self.objects = {}
        self.private = private
        self.posts = []

    def verify_private_bucket(self):
        return {"public": not self.private}

    def scoped_checkpoints(self, plan, candidate):
        return self

    def get_bytes(self, key):
        return self.get_object(key)

    def get_object(self, key, max_bytes=10000000):
        if key not in self.objects:
            raise FileNotFoundError()
        value = self.objects[key]
        if len(value) > max_bytes:
            raise report.ReportError("TOO_LARGE")
        return value

    def _object_route(self, key):
        return key

    def _request(self, method, route, consume, *, data=None, headers=None):
        assert method == "POST"
        self.posts.append((route, data, headers))
        self.objects[route] = data


def fixture():
    store = FakeStore()
    identity = {"candidate": {"candidate_id": "S05"}, "plan_sha256": report.PLAN}
    identity_hash = report.sha256(report.canonical(identity))
    nav = pd.DataFrame({"at": ["2017-08-21T22:00:00+00:00", "2020-01-02T22:00:00+00:00", "2026-09-11T22:00:00+00:00"],
                        "gross_nav_krw": [99900000.0, 90000000.0, 140000000.0]})
    series = pd.Series([100000000.0] + list(nav.gross_nav_krw),
                       index=pd.to_datetime(["2017-08-21T00:00:00+00:00"] + list(nav["at"]), utc=True))
    summary = {"schema": "CM_RESEARCH_RESULT_V1", "candidate_id": "S05", "evaluation_start": "2017-08-21",
               "evaluation_end": "2026-09-11", "historical_pit_certified": False,
               "actual_historical_execution_certified": False, "full_tax_supported": False,
               "ordinary_and_proxy_sales_share_one_way_fee": "0.0015", "proxy_exit_count": 0,
               "unresolved_rights_encounter_count": 0, "execution_contract": {"initial_capital_krw": 100000000},
               "performance": performance_metrics(series)}
    files = {"summary.json": report.canonical(summary), "nav.csv": nav.to_csv(index=False).encode()}
    files["file_manifest.json"] = report.canonical({"files": {name: {"sha256": report.sha256(raw), "size": len(raw)} for name, raw in files.items()}})
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as z:
        for name, raw in files.items():
            z.writestr(name, raw)
    raw = archive.getvalue()
    completion = {"schema": "CM06_FRESH_COMPLETED_V1", "identity": identity, "outputs_id": "zip",
                  "outputs_size": len(raw), "outputs_sha256": report.sha256(raw)}
    source = f"results/{report.PLAN}/S05/{identity_hash}/"
    store.objects.update({source + "completion.json": report.canonical(completion),
                          "complete_" + identity_hash: report.canonical(completion), "zip": raw,
                          source + "summary.json": files["summary.json"]})
    return store, identity_hash


class PrivateReportTests(unittest.TestCase):
    def test_verified_aggregate_only_create_and_readback(self):
        store, identity = fixture()
        result = report.prepare_report(store, "S05", identity, report.github_context(ENV), {"S05"})
        self.assertAlmostEqual(result["metrics"]["cumulative_return"], 0.4)
        self.assertAlmostEqual(result["metrics"]["mdd"], -0.1)
        before = deepcopy(store.objects)
        result_hash = report.publish_report(store, result)
        self.assertEqual(len(store.posts), 1)
        path, raw, headers = store.posts[0]
        self.assertTrue(path.startswith("results/reports/audited/"))
        self.assertEqual(headers["x-upsert"], "false")
        self.assertEqual(result_hash, report.sha256(raw))
        metadata = json.loads(base64.b64decode(headers["x-metadata"]))
        self.assertEqual(metadata["report_sha256"], result_hash)
        self.assertNotIn("nav", metadata)
        self.assertNotIn("holdings", metadata)
        self.assertNotIn("events", metadata)
        self.assertLessEqual(len(headers["x-metadata"]), 8192)
        for key, value in before.items():
            self.assertEqual(store.objects[key], value)
        report.publish_report(store, result)
        self.assertEqual(len(store.posts), 1)

    def test_unapproved_and_wrong_identity_rejected_without_writes(self):
        store, identity = fixture()
        with self.assertRaises(report.ReportError):
            report.prepare_report(store, "S05", identity, {}, {"S01"})
        with self.assertRaises(report.ReportError):
            report.prepare_report(store, "S05", "../secret", {}, {"S05"})
        self.assertFalse(store.posts)

    def test_completion_and_zip_tampering_rejected(self):
        for target in ("zip", "marker", "summary"):
            store, identity = fixture()
            key = {"zip": "zip", "marker": "complete_" + identity,
                   "summary": f"results/{report.PLAN}/S05/{identity}/summary.json"}[target]
            store.objects[key] += b"changed"
            with self.assertRaises((report.ReportError, ValueError)):
                report.prepare_report(store, "S05", identity, {}, {"S05"})
            self.assertFalse(store.posts)

    def test_private_bucket_and_metadata_limits(self):
        store, identity = fixture()
        result = report.prepare_report(store, "S05", identity, report.github_context(ENV), {"S05"})
        store.private = False
        with self.assertRaises(report.ReportError):
            report.publish_report(store, result)
        store.private = True
        result["audit"] = {"oversized": "x" * 10000}
        with self.assertRaises(report.ReportError):
            report.publish_report(store, result)
        self.assertFalse(store.posts)

    def test_audit_gate_and_sanitized_failure(self):
        store, identity = fixture()
        with self.assertRaises(report.ReportError):
            report.export_reports([], accounting_audit_passed=False, environ=ENV, store=store)
        captured = io.StringIO()
        with redirect_stdout(captured), self.assertRaises(SystemExit):
            report.export_reports_safely([], accounting_audit_passed=True, environ={"SECRET": "do-not-print"}, store=store)
        self.assertEqual(captured.getvalue().strip(), '{"status":"PRIVATE_AGGREGATE_REPORT_BLOCKED"}')
        self.assertFalse(store.posts)

    def test_export_requires_approved_manifest_and_saves_once(self):
        store, identity = fixture()
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "approved.json"
            path.write_bytes((runtime.ROOT / "REPRESENTATIVE_300_APPROVED.json").read_bytes())
            captured = io.StringIO()
            with redirect_stdout(captured):
                report.export_reports([["S05", identity]], accounting_audit_passed=True, environ=ENV,
                                      store=store, approved_path=path)
            self.assertEqual(json.loads(captured.getvalue())["status"], "PRIVATE_AGGREGATE_REPORTS_VERIFIED")
            self.assertNotIn("0.4", captured.getvalue())
            self.assertEqual(len(store.posts), 1)

    def test_no_metadata_field_expansion_or_nonfinite_metrics(self):
        for mutation in (lambda d: d.update(secret="never-export"),
                         lambda d: d["metrics"].update(cagr=float("nan")),
                         lambda d: d["yearly_returns"][0].update(raw_prices=[1, 2])):
            store, identity = fixture()
            result = report.prepare_report(store, "S05", identity, report.github_context(ENV), {"S05"})
            mutation(result)
            with self.assertRaises(report.ReportError):
                report.publish_report(store, result)
            self.assertFalse(store.posts)

    def test_existing_conflict_preserved_without_post(self):
        store, identity = fixture()
        result = report.prepare_report(store, "S05", identity, report.github_context(ENV), {"S05"})
        result_hash = report.sha256(report.canonical(result))
        path = f"results/reports/audited/{report.PLAN}/S05/{identity}/{result_hash}.json"
        store.objects[path] = b"{}"
        with self.assertRaises(ImmutableConflict):
            report.publish_report(store, result)
        self.assertEqual(store.objects[path], b"{}")
        self.assertFalse(store.posts)


if __name__ == "__main__":
    unittest.main()
