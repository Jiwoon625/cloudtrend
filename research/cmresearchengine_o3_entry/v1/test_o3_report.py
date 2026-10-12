from synthetic_support import fixtures
import base64
from contextlib import redirect_stdout
from copy import deepcopy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from o3_manifest import manifest
from o3_audit import verify_and_publish
import zipfile

import pandas as pd
from cmresearchengine import runtime
from cm06.metrics import performance_metrics
from cmresearchengine.storage import ImmutableConflict

SPEC = importlib.util.spec_from_file_location("cm_report", Path(__file__).with_name("o3_report.py"))
report = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(report)
ENV = {"GITHUB_ACTIONS": "true", "GITHUB_WORKFLOW": "CMresearchengine O3 ENTRY manual extension",
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


def fixture(cash=False, bad_cash=False):
    store = FakeStore()
    candidate = "Q_K000_E000_U000_C100" if cash else "O3"
    identity = {"candidate": {"candidate_id": candidate, "initial_weights": {"K": 0, "E": 0, "U": 0, "C": 1} if cash else {"K": 1/3, "E": 1/3, "U": 1/3, "C": 0}}, "plan_sha256": report.PLAN, "o3_extension_plan":manifest(), "code_hashes":runtime.code_hashes(), "execution":{"fx_spread":"0","cash_movement":"MONTHLY"}}
    identity_hash = report.sha256(report.canonical(identity))
    nav = pd.DataFrame({"at": ["2017-08-21T22:00:00+00:00", "2020-01-02T22:00:00+00:00", "2026-09-11T22:00:00+00:00"],
                        "gross_nav_krw": [99900000.0, 90000000.0, 140000000.0]})
    if cash:
        nav["gross_nav_krw"] = 100000000.0
        nav["cash_krw"] = 100000000.0
        nav["receivable_krw"] = 0.0
        nav["market_value_krw"] = 1.0 if bad_cash else 0.0
    series = pd.Series([100000000.0] + list(nav.gross_nav_krw),
                       index=pd.to_datetime(["2017-08-21T00:00:00+00:00"] + list(nav["at"]), utc=True))
    summary = {"schema": "CM_RESEARCH_RESULT_V1", "candidate_id": candidate, "final_snapshot": {"bridge_residual_krw": "0"}, "evaluation_start": "2017-08-21",
               "evaluation_end": "2026-09-11", "historical_pit_certified": False,
               "actual_historical_execution_certified": False, "full_tax_supported": False,
               "ordinary_and_proxy_sales_share_one_way_fee": "0.0015", "proxy_exit_count": 0,
               "unresolved_rights_encounter_count": 0, "execution_contract": {"initial_capital_krw": 100000000}, "policy":{"policy_id":"RETROSPECTIVE_LAST_VALID_CLOSE_EXIT_V1"},
               "performance": performance_metrics(series)}
    files = {"events.csv":b"kind,id,quantity,price,fee,at\nBUY,test,1,100,0.15,2017-08-21T22:00:00Z\n", "retrospective_exit_proxy_audit.csv":b"fill_id\n", "summary.json": report.canonical(summary), "nav.csv": nav.to_csv(index=False).encode()}
    if cash:
        files["events.csv"] = b"kind,id\n"
        files["retrospective_exit_proxy_audit.csv"] = b"fill_id\n"
    files["file_manifest.json"] = report.canonical({"files": {name: {"sha256": report.sha256(raw), "size": len(raw)} for name, raw in files.items()}})
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as z:
        for name, raw in files.items():
            z.writestr(name, raw)
    raw = archive.getvalue()
    completion = {"schema": "CM06_FRESH_COMPLETED_V1", "identity": identity, "outputs_id": "zip",
                  "outputs_size": len(raw), "outputs_sha256": report.sha256(raw)}
    source = f"results/{report.PLAN}/{candidate}/{identity_hash}/"
    store.objects.update({source + "completion.json": report.canonical(completion),
                          "complete_" + identity_hash: report.canonical(completion), "zip": raw,
                          source + "summary.json": files["summary.json"]})
    return store, identity_hash


class PrivateReportTests(unittest.TestCase):
    def test_verified_aggregate_only_create_and_readback(self):
        store, identity = fixture()
        result = report.prepare_report(store, "O3", identity, {"run_id":"123","attempt":1,"commit":"a"*40}, {"O3"})
        self.assertAlmostEqual(result["metrics"]["cumulative_return"], 0.4)
        self.assertAlmostEqual(result["metrics"]["mdd"], -0.1)
        before = deepcopy(store.objects)
        result_hash = report.publish_report(store, result)
        self.assertEqual(len(store.posts), 1)
        path, raw, headers = store.posts[0]
        self.assertTrue(path.startswith("results/reports/o3-entry-extension/"))
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
            report.prepare_report(store, "O3", identity, {}, {"S01"})
        with self.assertRaises(report.ReportError):
            report.prepare_report(store, "O3", "../secret", {}, {"O3"})
        self.assertFalse(store.posts)

    def test_completion_and_zip_tampering_rejected(self):
        for target in ("zip", "marker", "summary"):
            store, identity = fixture()
            key = {"zip": "zip", "marker": "complete_" + identity,
                   "summary": f"results/{report.PLAN}/O3/{identity}/summary.json"}[target]
            store.objects[key] += b"changed"
            with self.assertRaises((report.ReportError, ValueError)):
                report.prepare_report(store, "O3", identity, {}, {"O3"})
            self.assertFalse(store.posts)

    def test_private_bucket_and_metadata_limits(self):
        store, identity = fixture()
        result = report.prepare_report(store, "O3", identity, {"run_id":"123","attempt":1,"commit":"a"*40}, {"O3"})
        store.private = False
        with self.assertRaises(report.ReportError):
            report.publish_report(store, result)
        store.private = True
        result["audit"] = {"oversized": "x" * 10000}
        with self.assertRaises(report.ReportError):
            report.publish_report(store, result)
        self.assertFalse(store.posts)

    def test_no_metadata_field_expansion_or_nonfinite_metrics(self):
        for mutation in (lambda d: d.update(secret="never-export"),
                         lambda d: d["metrics"].update(cagr=float("nan")),
                         lambda d: d["yearly_returns"][0].update(raw_prices=[1, 2])):
            store, identity = fixture()
            result = report.prepare_report(store, "O3", identity, {"run_id":"123","attempt":1,"commit":"a"*40}, {"O3"})
            mutation(result)
            with self.assertRaises(report.ReportError):
                report.publish_report(store, result)
            self.assertFalse(store.posts)

    def test_existing_conflict_preserved_without_post(self):
        store, identity = fixture()
        result = report.prepare_report(store, "O3", identity, {"run_id":"123","attempt":1,"commit":"a"*40}, {"O3"})
        result_hash = report.sha256(report.canonical(result))
        path = f"results/reports/o3-entry-extension/{report.PLAN}/O3/{identity}/{result_hash}.json"
        store.objects[path] = b"{}"
        with self.assertRaises(ImmutableConflict):
            report.publish_report(store, result)
        self.assertEqual(store.objects[path], b"{}")
        self.assertFalse(store.posts)

    def test_full_accounting_and_report_gate(self):
        store, identity = fixture()
        with patch('o3_audit.audit_entry_evidence',return_value={'entry_deliveries_checked':0}):
            result = verify_and_publish(store, identity, ENV)
        self.assertEqual(result["status"], "O3_PRIVATE_AUDIT_VERIFIED")
        self.assertEqual(result["trade_fee_checks"], 1)
        self.assertEqual(len(store.posts), 1)

    def test_wrong_workflow_cannot_publish(self):
        store, identity = fixture()
        with self.assertRaises(ValueError):
            verify_and_publish(store, identity, {**ENV,"GITHUB_WORKFLOW":"unrelated"})
        self.assertFalse(store.posts)

    def test_failed_accounting_cannot_publish(self):
        store, identity = fixture()
        with patch("o3_audit.audit", side_effect=AssertionError("synthetic fee mismatch")):
            with self.assertRaises(AssertionError):
                verify_and_publish(store, identity, ENV)
        self.assertFalse(store.posts)

if __name__ == "__main__":
    unittest.main()
