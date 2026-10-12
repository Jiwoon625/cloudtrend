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
CASH_CANDIDATES = {
    "Q_K000_E000_U000_C100": {"K": 0, "E": 0, "U": 0, "C": 1},
    "K25_P000_Q000_E000_U000_C100": {"P": 0, "Q": 0, "E": 0, "U": 0, "C": 1},
}


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


def fixture(cash=False, bad_cash=False, *, cash_candidate="Q_K000_E000_U000_C100",
            cash_weights=None, mutate_files=None):
    store = FakeStore()
    candidate = cash_candidate if cash else "S05"
    weights = CASH_CANDIDATES[candidate] if cash and cash_weights is None else cash_weights
    identity = {"candidate": {"candidate_id": candidate, "initial_weights": weights if cash else {"K": 1/3, "E": 1/3, "U": 1/3, "C": 0}}, "plan_sha256": report.PLAN}
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
               "unresolved_rights_encounter_count": 0, "execution_contract": {"initial_capital_krw": 100000000},
               "performance": performance_metrics(series)}
    files = {"summary.json": report.canonical(summary), "nav.csv": nav.to_csv(index=False).encode()}
    if cash:
        files["events.csv"] = b"kind,id\n"
        files["retrospective_exit_proxy_audit.csv"] = b"fill_id\n"
    if mutate_files is not None:
        # Rebuild valid manifests and ZIP hashes so semantic checks must reject
        # the changed contents, rather than merely noticing stale checksums.
        mutate_files(files)
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

    def test_pure_cash_zero_execution_contract(self):
        store, identity = fixture(cash=True)
        output = io.StringIO()
        with redirect_stdout(output):
            report.audit_cash_only("Q_K000_E000_U000_C100", identity, store=store)
        self.assertTrue(json.loads(output.getvalue())["pure_cash_contract_verified"])
        self.assertFalse(store.posts)

    def test_pure_cash_rejects_nonzero_market_value(self):
        store, identity = fixture(cash=True, bad_cash=True)
        with self.assertRaises(report.ReportError):
            report.audit_cash_only("Q_K000_E000_U000_C100", identity, store=store)
        self.assertFalse(store.posts)

    def test_both_approved_pure_cash_candidates_pass_without_writes(self):
        approved = json.loads((runtime.ROOT / "REPRESENTATIVE_300_APPROVED.json").read_text())
        self.assertEqual({row["id"] for row in approved["candidates"] if row["id"].endswith("_C100")},
                         set(CASH_CANDIDATES))
        for candidate in CASH_CANDIDATES:
            with self.subTest(candidate=candidate):
                store, identity = fixture(cash=True, cash_candidate=candidate)
                before = deepcopy(store.objects)
                output = io.StringIO()
                with redirect_stdout(output):
                    report.audit_cash_only(candidate, identity, store=store)
                result = json.loads(output.getvalue())
                self.assertEqual(result["status"], candidate + "_PRIVATE_AUDIT_VERIFIED")
                self.assertTrue(result["pure_cash_contract_verified"])
                self.assertEqual(result["nav_rows_checked"], 3)
                for field in ("trade_fee_checks", "cash_settlement_checks", "proxy_exit_checks"):
                    self.assertEqual(result[field], 0)
                self.assertEqual(store.objects, before)
                self.assertFalse(store.posts)

    def assert_cash_rejected(self, candidate, error, **fixture_options):
        store, identity = fixture(cash=True, cash_candidate=candidate, **fixture_options)
        before = deepcopy(store.objects)
        output = io.StringIO()
        with redirect_stdout(output), self.assertRaisesRegex(report.ReportError, "^" + error + "$"):
            report.audit_cash_only(candidate, identity, store=store)
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(store.objects, before)
        self.assertFalse(store.posts)

    def test_pure_cash_rejects_other_candidate_ids_even_with_cash_weights(self):
        for candidate in ("S05", "K25_P000_Q000_E000_U025_C075", "UNKNOWN_C100",
                          "K25_P000_Q000_E000_U000_C100_extra", "../Q_K000_E000_U000_C100"):
            with self.subTest(candidate=candidate):
                self.assert_cash_rejected(candidate, "PURE_CASH_CANDIDATE_ONLY",
                                          cash_weights={"P": 0, "Q": 0, "E": 0, "U": 0, "C": 1})

    def test_pure_cash_rejects_changed_missing_extra_or_cross_schema_weights(self):
        for candidate, expected in CASH_CANDIDATES.items():
            bad_weights = [{}, {**expected, "C": 0.999}, {**expected, "extra": 0},
                           {key: value for key, value in expected.items() if key != "C"}]
            bad_weights.extend({**expected, key: 0.001, "C": 0.999}
                               for key in expected if key != "C")
            bad_weights.extend(weights for other, weights in CASH_CANDIDATES.items() if other != candidate)
            for weights in bad_weights:
                with self.subTest(candidate=candidate, weights=weights):
                    self.assert_cash_rejected(candidate, "PURE_CASH_IDENTITY_MISMATCH", cash_weights=weights)

    def test_pure_cash_rejects_buy_and_sell_with_valid_archive_hashes(self):
        for candidate in CASH_CANDIDATES:
            for kind in ("BUY", "SELL"):
                with self.subTest(candidate=candidate, kind=kind):
                    self.assert_cash_rejected(candidate, "PURE_CASH_EXECUTION_FOUND",
                                              mutate_files=lambda files: files.update(
                                                  {"events.csv": f"kind,id\n{kind},trade-1\n".encode()}))

    def test_pure_cash_rejects_each_changed_nav_component(self):
        for candidate in CASH_CANDIDATES:
            for field in ("gross_nav_krw", "cash_krw", "receivable_krw", "market_value_krw"):
                with self.subTest(candidate=candidate, field=field):
                    def change_nav(files):
                        nav = pd.read_csv(io.BytesIO(files["nav.csv"]))
                        nav.loc[1, field] += 1
                        files["nav.csv"] = nav.to_csv(index=False).encode()
                    self.assert_cash_rejected(candidate, "PURE_CASH_NAV_CHANGED", mutate_files=change_nav)

    def test_pure_cash_rejects_proxy_rights_bridge_and_performance_changes(self):
        changes = [(("proxy_exit_count",), 1, "PURE_CASH_RIGHTS_FOUND"),
                   (("unresolved_rights_encounter_count",), 1, "PURE_CASH_RIGHTS_FOUND"),
                   (("final_snapshot", "bridge_residual_krw"), "0.01", "PURE_CASH_BRIDGE_FAILED")]
        changes += [(("performance", field), 0.001, "PURE_CASH_PERFORMANCE_CHANGED")
                    for field in ("cagr", "mdd", "cumulative_return", "annualized_volatility")]
        for candidate in CASH_CANDIDATES:
            with self.subTest(candidate=candidate, proxy=True):
                self.assert_cash_rejected(candidate, "PURE_CASH_EXECUTION_FOUND",
                                          mutate_files=lambda files: files.update(
                                              {"retrospective_exit_proxy_audit.csv": b"fill_id\nproxy-1\n"}))
            for path, value, error in changes:
                with self.subTest(candidate=candidate, path=path):
                    def change_summary(files):
                        summary = json.loads(files["summary.json"])
                        target = summary
                        for key in path[:-1]:
                            target = target[key]
                        target[path[-1]] = value
                        files["summary.json"] = report.canonical(summary)
                    self.assert_cash_rejected(candidate, error, mutate_files=change_summary)

    def test_split_cash_exports_aggregate_after_cash_audit(self):
        candidate = "K25_P000_Q000_E000_U000_C100"
        store, identity = fixture(cash=True, cash_candidate=candidate)
        with redirect_stdout(io.StringIO()):
            report.audit_cash_only(candidate, identity, store=store)
            report.export_reports([[candidate, identity]], accounting_audit_passed=True, environ=ENV,
                                  store=store, approved_path=runtime.ROOT / "REPRESENTATIVE_300_APPROVED.json")
        self.assertEqual(len(store.posts), 1)
        result = json.loads(store.posts[0][1])
        self.assertEqual(result["candidate_id"], candidate)
        self.assertEqual(result["metrics"]["cumulative_return"], 0)
        self.assertEqual(set(result), report.REPORT_FIELDS)


if __name__ == "__main__":
    unittest.main()
