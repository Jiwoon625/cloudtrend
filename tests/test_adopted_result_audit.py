"""Offline synthetic fixtures only. No service, source dataset, or secret reads."""
import argparse
import base64
import copy
from decimal import Decimal
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


job = module("annual_result_audit", ROOT / "scripts/audit-adopted-kr-etf-results.py")
legacy = module("annual_result_http_fixture", ROOT / "tests/test_adopted_backtest_job.py")
base, core = job.base, job.core
OWNER, SECRET = legacy.OWNER, legacy.SECRET


def sha(value):
    return hashlib.sha256(value).hexdigest()


def clone(value):
    return copy.deepcopy(value)


def synthetic_rows(start, through):
    dates = []
    for year in range(int(start[:4]), int(through[:4]) + 1):
        dates.extend([start if year == int(start[:4]) else f"{year}-01-02",
                      through if year == int(through[:4]) else f"{year}-12-29"])
    return [{"date": day, "nav": "100000000", "cash": "100000000", "marketValue": "0", "fees": "0",
             "valuationStatus": "COMPLETE", "openPositions": 0, "positionCount": 0} for day in dates]


def source_fixture(session, workspace, request, market):
    role, start, through = "replay-" + market, job.SOURCE_REQUEST[market + "_start"], job.SOURCE_REQUEST["through"]
    folder = workspace / role
    result = folder / "result"
    result.mkdir(parents=True)
    rows, summary = synthetic_rows(start, through), {}
    for book in sorted(core.result_books(market)):
        summary[book] = {"status": "COMPLETE", "startDate": start, "endDate": through, "observations": len(rows),
                         "cagr": 0.0, "mdd": 0.0, "cumulativeReturn": 0.0, "missingValuationCount": 0,
                         "staleValuationCount": 0, "annualization": "ACTUAL_DAYS_365_2425"}
        (result / (book + ".daily-nav.jsonl")).write_text("\n".join(json.dumps(row) for row in rows) + "\n")
        (result / (book + ".trades.jsonl")).write_bytes(b"")
        budgets = [{"year": int(rows[i]["date"][:4]), "nav": "100000000", "budget": "3333333.33333333",
                    "valuationDate": rows[i-1]["date"] if i else None, "effectiveDate": rows[i]["date"]} for i in range(0, len(rows), 2)]
        base.local_json(result / (book + ".yearly-budgets.json"),
                        {"policy": "ANNUAL_NAV_VOLATILITY_SIGNAL_YEAR_V1", "yearlyReset": True, "years": budgets} if market == "etf" else budgets)
        if market == "kr":
            base.local_json(result / (book + ".accounting.json"), {"fees": {}})
            base.local_json(result / (book + ".evidence.json"), {"exitTiming": {}})
        else:
            base.local_json(result / (book + ".contract.json"), {"privateSecret": SECRET})
            base.local_json(result / (book + ".final-state.json"), {"owner": OWNER, "symbol": "SYNTHETIC_PRIVATE_SYMBOL"})
    base.local_json(result / "summary.json", summary)
    base.local_json(result / "provenance.json", {"privateSecret": SECRET, "owner": OWNER})
    (result / "report.md").write_text("Private synthetic source content " + SECRET)
    quality = {"runStatus": "FINISHED", "mode": "SELECTED_RANGE_REPLAY", "generatedScoringSessions": 0,
               "signalCache": {"allIndexedRowsValidatedBeforeExecution": True, "chunks": 20}, "elapsedSeconds": 1.0, "maxRssKiB": 100,
               "portfolioExecutionPasses": {book: int(book in summary) for book in job.BOOKS}}
    base.local_json(result / "quality.json", quality)
    verification = job.verifier.verify(result)
    outputs = [{"path": "attempt-1/result/" + path.name, **base.digest_file(path)} for path in sorted(result.iterdir())]
    scope = job.source_scope(OWNER, role, request)
    options = argparse.Namespace(**job.SOURCE_REQUEST, market=market)
    origins = [{"runId": job.SOURCE_REQUEST["resume_from"]["runId"], "codeCommit": job.SOURCE_REQUEST["resume_from"]["codeCommit"],
                "role": "score-%03d" % i, "completionSha256": "a" * 64, "planSha256": "b" * 64} for i in range(17)]
    report = core.result_report(options, scope, {"preparationMetrics": {"elapsedSeconds": 1.0, "maxRssKiB": 100}},
                               [{"bytes": 1}], "c" * 64, {"measurements": [{"elapsedSeconds": 1.0, "maxRssKiB": 100}]},
                               result, verification, outputs, import_origins=origins)
    base.local_json(folder / "run-manifest.json", report)
    completion = {"version": core.COMPLETE_VERSION, "status": "COMPLETE", "scope": scope,
                  "proof": {"planSha256": "c" * 64, "market": market, "start": start, "through": through,
                            "cacheChunks": 20, "verifiedArithmetic": True},
                  "files": outputs + [{"path": "attempt-1/run-manifest.json", **base.digest_file(folder / "run-manifest.json")} ]}
    prefix = OWNER + "/research/adopted-full-period/resumable/" + job.SOURCE_RUN_ID + "/" + role + "/"
    for item in completion["files"]:
        session.objects[prefix + item["path"]] = (folder / core.logical_path(item["path"])).read_bytes()
    session.objects[prefix + "completion.json"] = base.json_bytes(completion)
    request["sourceCompletionSha256"][role] = sha(session.objects[prefix + "completion.json"])
    return prefix


class ArithmeticRunner:
    def __init__(self):
        self.calls = []
        self.fail = False
        self.skip = False
        self.modify = False

    def __call__(self, command, log, environment):
        self.calls.append((command, environment))
        assert command[1] == str(ROOT / "scripts/verify-adopted-kr-etf-results.py") and command[2] == "--results"
        assert set(environment) <= {"PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ", "NODE_OPTIONS"}
        assert SECRET not in json.dumps(environment)
        if self.fail:
            raise RuntimeError(SECRET)
        if self.skip:
            return
        target = Path(command[-1])
        result = job.verifier.verify(target)
        if self.modify:
            result["books"][next(iter(result["books"]))]["feesVerified"] = False
            (target / "verification.json").write_bytes(base.json_bytes(result))
        log.write_text("Private log " + SECRET)


class AuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.session = legacy.Session()
        self.request = {"version": job.REQUEST_VERSION, "sourceRunId": job.SOURCE_RUN_ID, "sourceCommit": job.SOURCE_COMMIT,
                        "sourceRequest": clone(job.SOURCE_REQUEST), "sourceCompletionSha256": {}}
        self.prefixes = {"replay-" + market: source_fixture(self.session, self.root, self.request, market) for market in ("kr", "etf")}
        self.request_file, self.event_file = self.root / "request.json", self.root / "event.json"
        self.commit = "2" * 40
        self.event = {"after": self.commit, "ref": base.REQUEST_BRANCH, "head_commit": {"id": self.commit, "message": job.COMMIT_MARKER}}
        self.env = {"GITHUB_ACTIONS": "true", "GITHUB_WORKFLOW": job.WORKFLOW, "GITHUB_REF": base.REQUEST_BRANCH,
                    "GITHUB_EVENT_NAME": "push", "GITHUB_EVENT_PATH": str(self.event_file), "GITHUB_SHA": self.commit,
                    "GITHUB_RUN_ID": "99001", "GITHUB_RUN_ATTEMPT": "1", "SUPABASE_URL": base.EXPECTED_SUPABASE_URL,
                    "SUPABASE_USER_ID": OWNER, "SUPABASE_SERVICE_ROLE_KEY": SECRET, "GITHUB_TOKEN": SECRET, "PATH": os.environ["PATH"]}
        self.runner, self.logs = ArithmeticRunner(), []
        self.originals = dict(self.session.objects)
        self.save()

    def tearDown(self):
        self.temp.cleanup()

    def save(self):
        self.request_file.write_bytes(base.json_bytes(self.request))
        self.event_file.write_bytes(base.json_bytes(self.event))

    def run_job(self, **kwargs):
        self.save()
        return job.run_github_job(self.request_file, environment=self.env, session_factory=lambda: self.session,
                                 runner=kwargs.get("runner", self.runner), emit=self.logs.append)

    def posts(self):
        return [call for call in self.session.calls if call[0] == "POST"]

    def patch_completion(self, role, change):
        key = self.prefixes[role] + "completion.json"
        value = json.loads(self.session.objects[key])
        change(value)
        self.session.objects[key] = base.json_bytes(value)
        self.request["sourceCompletionSha256"][role] = sha(self.session.objects[key])

    def rehash_source_file(self, role, relative):
        prefix = self.prefixes[role]
        payload = self.session.objects[prefix + "attempt-1/" + relative]
        evidence = {"path": "attempt-1/" + relative, "bytes": len(payload), "sha256": sha(payload)}
        report_key = prefix + "attempt-1/run-manifest.json"
        if relative != "run-manifest.json":
            report = json.loads(self.session.objects[report_key])
            report["outputs"] = [evidence if e["path"] == evidence["path"] else e for e in report["outputs"]]
            self.session.objects[report_key] = base.json_bytes(report)
        report_evidence = {"path": "attempt-1/run-manifest.json", "bytes": len(self.session.objects[report_key]), "sha256": sha(self.session.objects[report_key])}
        def change(value):
            value["files"] = [evidence if e["path"] == evidence["path"] else report_evidence if e["path"] == report_evidence["path"] else e for e in value["files"]]
        self.patch_completion(role, change)

    def aggregate(self):
        rows = synthetic_rows(job.SOURCE_REQUEST["etf_start"], job.SOURCE_REQUEST["through"])
        metrics = job.verifier.closed_trade_metrics("ETF_V02", [])
        return job.build_aggregate("ETF_V02", rows, metrics, self.request, self.env)

    def test_complete_real_verifier_create_only_completion_last_no_raw_leaks(self):
        self.assertEqual(self.run_job()["status"], "COMPLETE")
        self.assertEqual(len(self.runner.calls), 2)
        self.assertEqual(len(self.posts()), 5)
        self.assertTrue(self.posts()[-1][1].endswith("/completion.json"))
        for key, value in self.originals.items():
            self.assertEqual(self.session.objects[key], value)
        for _, url, call in self.posts():
            self.assertIn("/result-audits/99001/attempt-1/", url)
            self.assertEqual(call["headers"]["x-upsert"], "false")
            encoded = call["headers"]["x-metadata"]
            self.assertLessEqual(len(encoded), 8192)
            value = base64.b64decode(encoded).decode()
            for private in (SECRET, OWNER, "SYNTHETIC_PRIVATE_SYMBOL", '"cash"', '"nav"', '"symbol"', '"balances"'):
                self.assertNotIn(private, value)
        aggregate = json.loads(base64.b64decode(self.posts()[0][2]["headers"]["x-metadata"]))
        self.assertEqual(aggregate["provenance"]["auditCommit"], self.commit)
        self.assertEqual(aggregate["provenance"]["sourceCommit"], job.SOURCE_COMMIT)
        self.assertNotEqual(aggregate["provenance"]["sourceRunId"], aggregate["provenance"]["auditRunId"])
        self.assertEqual(aggregate["annualPortfolio"][0]["periodType"], "PARTIAL_FIRST_YEAR")
        self.assertEqual(aggregate["annualPortfolio"][-1]["periodType"], "PARTIAL_LAST_YEAR")
        for _, url, _ in self.session.calls:
            self.assertNotIn("/inputs/", url)
            self.assertNotIn("/score-", url)
            self.assertNotIn("/plan/", url)
        self.assertNotIn(SECRET, "".join(self.logs))
        self.assertNotIn(OWNER, "".join(self.logs))

    def test_actual_subprocess_verifier_runs_without_strategy(self):
        self.assertEqual(self.run_job(runner=base.run_command)["status"], "COMPLETE")
        self.assertEqual(len(self.posts()), 5)

    def test_idempotent_same_attempt_verifies_without_overwrite(self):
        self.assertEqual(self.run_job()["status"], "COMPLETE")
        count = len(self.posts())
        self.assertEqual(self.run_job()["status"], "COMPLETE")
        self.assertEqual(len(self.posts()), count)

    def test_template_non_executable_and_source_contract_matches(self):
        template = json.loads((ROOT / ".github/kr-etf-result-audit-request.template.json").read_text())
        with self.assertRaises(base.JobError):
            job.validate_request(template)
        self.assertEqual(template["sourceRequest"], json.loads((ROOT / ".github/kr-etf-resumable-request.json").read_text()))

    def test_strict_source_pins(self):
        changes = [("sourceRunId", "9"), ("sourceCommit", "a" * 40), ("version", "wrong"), ("sourceRequest", {})]
        for key, value in changes:
            bad = clone(self.request)
            bad[key] = value
            with self.subTest(key=key), self.assertRaises(base.JobError):
                job.validate_request(bad)
        for value in (None, "pending", "0" * 64, "a" * 63, "A" * 64):
            bad = clone(self.request)
            bad["sourceCompletionSha256"]["replay-kr"] = value
            with self.subTest(value=value), self.assertRaises(base.JobError):
                job.validate_request(bad)
        bad = clone(self.request)
        bad["sourceRequest"]["chunk_sessions"] = 120.0
        with self.assertRaises(base.JobError):
            job.validate_request(bad)

    def test_exact_marker_and_actual_head_sha_required_before_network(self):
        for marker in ("run(kr-etf-resumable): full", job.COMMIT_MARKER + " extra", "anything"):
            self.event["head_commit"]["message"] = marker
            self.assertEqual(self.run_job()["status"], "STOPPED")
        self.event["head_commit"]["message"] = job.COMMIT_MARKER
        self.event["after"] = "a" * 40
        self.assertEqual(self.run_job()["status"], "STOPPED")
        self.assertEqual(self.session.calls, [])

    def test_dispatch_and_source_run_relabel_are_rejected(self):
        self.env["GITHUB_EVENT_NAME"] = "workflow_dispatch"
        self.assertEqual(self.run_job()["status"], "STOPPED")
        self.env["GITHUB_EVENT_NAME"] = "push"
        self.env["GITHUB_RUN_ID"] = job.SOURCE_RUN_ID
        self.assertEqual(self.run_job()["status"], "STOPPED")
        self.assertEqual(self.session.calls, [])

    def test_wrong_completion_hash_fails_before_writes(self):
        self.request["sourceCompletionSha256"]["replay-etf"] = "d" * 64
        self.assertEqual(self.run_job()["code"], "SOURCE_COMPLETION_HASH_MISMATCH")
        self.assertFalse(self.posts())

    def test_missing_completion_fails_before_writes(self):
        del self.session.objects[self.prefixes["replay-kr"] + "completion.json"]
        self.assertEqual(self.run_job()["status"], "STOPPED")
        self.assertFalse(self.posts())

    def test_incomplete_completion_fails_even_when_hash_re_pinned(self):
        self.patch_completion("replay-etf", lambda value: value.update(status="INCOMPLETE"))
        self.assertEqual(self.run_job()["code"], "SOURCE_COMPLETION_SCOPE_MISMATCH")
        self.assertFalse(self.posts())

    def test_false_arithmetic_claim_rejected(self):
        self.patch_completion("replay-kr", lambda value: value["proof"].update(verifiedArithmetic=False))
        self.assertEqual(self.run_job()["code"], "INVALID_SOURCE_COMPLETION_PROOF")
        self.assertFalse(self.posts())

    def test_every_result_byte_hash_is_required_including_private_provenance(self):
        self.session.objects[self.prefixes["replay-kr"] + "attempt-1/result/provenance.json"] += b" "
        self.assertEqual(self.run_job()["status"], "STOPPED")
        self.assertFalse(self.posts())

    def test_all_source_files_required(self):
        self.patch_completion("replay-kr", lambda value: value["files"].pop(0))
        self.assertEqual(self.run_job()["code"], "INCOMPLETE_CHECKPOINT")
        self.assertFalse(self.posts())

    def test_completion_owner_scope_is_enforced(self):
        self.patch_completion("replay-etf", lambda value: value["scope"].update(owner="66666666-2222-3333-4444-555555555555"))
        self.assertEqual(self.run_job()["code"], "SOURCE_COMPLETION_SCOPE_MISMATCH")
        self.assertFalse(self.posts())

    def test_required_arithmetic_catches_consistently_rehashed_wrong_cash(self):
        role = "replay-kr"
        name = "result/KR_COMBINED_ADOPTED.daily-nav.jsonl"
        key = self.prefixes[role] + "attempt-1/" + name
        rows = [json.loads(line) for line in self.session.objects[key].splitlines()]
        rows[-1]["cash"] = "99999999"
        self.session.objects[key] = ("\n".join(json.dumps(row) for row in rows) + "\n").encode()
        self.rehash_source_file(role, name)
        self.assertEqual(self.run_job()["status"], "STOPPED")
        self.assertEqual(len(self.runner.calls), 2)
        self.assertFalse(self.posts())

    def test_missing_fresh_arithmetic_receipt_fails(self):
        self.runner.skip = True
        self.assertEqual(self.run_job()["status"], "STOPPED")
        self.assertFalse(self.posts())

    def test_modified_fresh_arithmetic_receipt_fails(self):
        self.runner.modify = True
        self.assertEqual(self.run_job()["status"], "STOPPED")
        self.assertFalse(self.posts())

    def test_source_adapter_rejects_inputs_other_roles_and_all_write_entrypoints(self):
        source = job.ReadOnlyResultStorage(self.session, self.env, self.request, "replay-kr")
        for call in (lambda: source.manifest(), lambda: source.verified_september_extension(None), lambda: source.download_observed(None, None, None),
                     lambda: source.key("score-001", "completion.json"), lambda: source.put("x", "x"), lambda: source.complete(),
                     lambda: source.create_result("x", "x"), lambda: source.key("replay-kr", "completion.json", write=True)):
            with self.assertRaises(base.JobError):
                call()
        self.assertFalse(self.session.calls)

    def test_metadata_exact_nested_whitelist_and_scalar_domains(self):
        original = self.aggregate()
        mutations = [lambda value: value.update(nav="100000000"), lambda value: value["provenance"].update(owner=OWNER),
                     lambda value: value["annualPortfolio"][0].update(balance=123),
                     lambda value: value["annualClosedTrades"][0].update(symbol="private"),
                     lambda value: value["annualPortfolio"][0].update(periodType=SECRET),
                     lambda value: value["annualPortfolio"][0].update(netReturn=float("inf")),
                     lambda value: value["annualClosedTrades"][0].update(closedTradeCount=True),
                     lambda value: value.update(verifiedArithmetic=False),
                     lambda value: value["provenance"].update(auditCommit=job.SOURCE_COMMIT)]
        for mutation in mutations:
            value = clone(original)
            mutation(value)
            with self.subTest(mutation=mutation), self.assertRaises(base.JobError):
                job.safe_aggregate(value)
        self.assertLessEqual(len(job.safe_aggregate(original)), 8192)

    def test_output_provenance_and_book_path_cannot_be_relabelled(self):
        output = job.AggregateStorage(self.session, self.env, self.request)
        value = self.aggregate()
        value["provenance"]["auditCommit"] = "3" * 40
        with self.assertRaisesRegex(base.JobError, "AUDIT_OUTPUT_PROVENANCE_MISMATCH"):
            output.put("ETF_V02.json", value, self.root)
        value = self.aggregate()
        with self.assertRaisesRegex(base.JobError, "AUDIT_BOOK_PATH_MISMATCH"):
            output.put("KR_COMBINED_ADOPTED.json", value, self.root)
        self.assertFalse(self.posts())

    def test_output_source_hash_is_bound_to_validated_request(self):
        output = job.AggregateStorage(self.session, self.env, self.request)
        value = self.aggregate()
        value["provenance"]["sourceCompletionSha256"] = "e" * 64
        with self.assertRaisesRegex(base.JobError, "AUDIT_OUTPUT_SOURCE_PIN_MISMATCH"):
            output.put("ETF_V02.json", value, self.root)
        self.assertFalse(self.posts())

    def test_completion_cannot_be_written_before_all_verified_aggregates(self):
        output = job.AggregateStorage(self.session, self.env, self.request)
        completion = {"schema": job.COMPLETION_VERSION, "status": "COMPLETE", "auditRunId": self.env["GITHUB_RUN_ID"],
                      "auditRunAttempt": self.env["GITHUB_RUN_ATTEMPT"], "auditCommit": self.commit, "auditWorkflow": job.WORKFLOW,
                      "sourceRunId": job.SOURCE_RUN_ID, "sourceCommit": job.SOURCE_COMMIT,
                      "sourceCompletionSha256": self.request["sourceCompletionSha256"], "verifiedArithmetic": True,
                      "files": [{"path": book + ".json", "bytes": 123, "sha256": "a" * 64} for book in sorted(job.BOOKS)]}
        with self.assertRaisesRegex(base.JobError, "AUDIT_COMPLETION_MUST_BE_LAST"):
            output.put("completion.json", completion, self.root)
        self.assertFalse(self.posts())

    def test_realistic_full_precision_annual_metadata_fits_and_oversize_is_rejected(self):
        value = self.aggregate()
        for annual in value["annualPortfolio"]:
            annual.update(netReturn=0.12345678901234567, mdd=-0.23456789012345678, observations=251)
        for annual in value["annualClosedTrades"]:
            annual.update(closedTradeCount=500, proxyClosedTradeCount=100,
                          meanNetReturn=0.12345678901234567, medianNetReturn=-0.12345678901234567)
        self.assertLess(len(job.safe_aggregate(value)), 8192)
        with mock.patch.object(job, "MAX_AGGREGATE", 64), self.assertRaisesRegex(base.JobError, "AGGREGATE_METADATA_TOO_LARGE"):
            job.safe_aggregate(value)

    def test_source_book_incomplete_is_rejected_even_with_valid_file_hashes(self):
        role, name = "replay-etf", "result/summary.json"
        key = self.prefixes[role] + "attempt-1/" + name
        value = json.loads(self.session.objects[key])
        value["ETF_V02"]["status"] = "INCOMPLETE"
        self.session.objects[key] = base.json_bytes(value)
        self.rehash_source_file(role, name)
        self.assertEqual(self.run_job()["code"], "INCOMPLETE_SOURCE_BOOK")
        self.assertFalse(self.posts())

    def test_uncertain_write_after_store_is_verified_without_retry(self):
        self.session.fail_after_store = True
        self.assertEqual(self.run_job()["status"], "COMPLETE")
        self.assertEqual(len(self.posts()), 5)

    def test_uncertain_write_before_store_stops_without_retry_or_completion(self):
        self.session.fail_before_store = True
        self.assertEqual(self.run_job()["code"], "UNCERTAIN_AUDIT_CREATE")
        self.assertEqual(len(self.posts()), 1)
        self.assertFalse(any("result-audits" in key and key.endswith("completion.json") for key in self.session.objects))

    def test_tampered_readback_stops_without_completion(self):
        self.session.tamper_readback = True
        self.assertEqual(self.run_job()["status"], "STOPPED")
        self.assertEqual(len(self.posts()), 1)
        self.assertFalse(any("result-audits" in key and key.endswith("completion.json") for key in self.session.objects))

    def test_existing_conflicting_aggregate_never_overwritten(self):
        key = OWNER + "/research/adopted-full-period/result-audits/99001/attempt-1/ETF_V02.json"
        self.session.objects[key] = b"conflicting existing private bytes"
        self.assertEqual(self.run_job()["status"], "STOPPED")
        self.assertEqual(self.session.objects[key], b"conflicting existing private bytes")
        self.assertFalse(self.posts())

    def test_public_bucket_and_redirect_fail_closed(self):
        self.session.bucket["public"] = True
        self.assertEqual(self.run_job()["code"], "BUCKET_NOT_PRIVATE")
        self.assertFalse(self.posts())
        self.session.bucket["public"] = False
        self.session.redirect = True
        self.assertEqual(self.run_job()["status"], "STOPPED")
        self.assertFalse(self.posts())

    def test_error_details_do_not_escape_private_logs(self):
        self.runner.fail = True
        self.assertEqual(self.run_job()["code"], "AUDIT_FAILED_NO_PRIVATE_DETAILS_LOGGED")
        self.assertNotIn(SECRET, "".join(self.logs))
        self.assertEqual(job.public_failure_code(SECRET), "AUDIT_FAILED_NO_PRIVATE_DETAILS_LOGGED")
        self.assertEqual(job.public_failure_code("https://private.invalid/?token=x"), "AUDIT_FAILED_NO_PRIVATE_DETAILS_LOGGED")

    def test_workflow_has_no_replay_or_public_upload_steps(self):
        workflow = (ROOT / ".github/workflows/kr-etf-result-audit.yml").read_text()
        for forbidden in ("actions/upload-artifact", "actions/cache", "npm ci", "run-adopted-kr-etf-backtest.ts", "--phase replay", "--phase score"):
            self.assertNotIn(forbidden, workflow)
        self.assertIn(job.WORKFLOW, workflow)
        self.assertIn(job.COMMIT_MARKER, workflow)


class AnnualBoundaryTests(unittest.TestCase):
    def rows(self, values):
        return [{"date": day, "nav": str(nav), "valuationStatus": "COMPLETE"} for day, nav in values]

    def test_previous_year_close_denominator_and_reset_opening_peak(self):
        rows = self.rows([("2023-08-01", 120000000), ("2023-12-29", 110000000),
                          ("2024-01-02", 99000000), ("2024-12-30", 121000000),
                          ("2025-01-02", 108900000), ("2025-09-11", 119790000)])
        result = job.annual_portfolio(rows, "2023-08-01", "2025-09-11")
        self.assertAlmostEqual(result[0]["netReturn"], 0.10)
        self.assertAlmostEqual(result[0]["mdd"], -1 / 12)
        self.assertAlmostEqual(result[1]["netReturn"], 0.10)
        self.assertAlmostEqual(result[1]["mdd"], -0.10)
        self.assertAlmostEqual(result[2]["netReturn"], -0.01)
        self.assertAlmostEqual(result[2]["mdd"], -0.10)
        self.assertEqual([item["periodType"] for item in result], ["PARTIAL_FIRST_YEAR", "FULL_YEAR", "PARTIAL_LAST_YEAR"])
        self.assertEqual(result[1]["openingBase"], "PREVIOUS_YEAR_FINAL_NAV")
        self.assertNotIn("100000000", json.dumps(result))

    def test_first_day_loss_is_included_and_single_partial_year_is_labeled(self):
        rows = self.rows([("2023-08-01", 90000000), ("2023-09-01", 95000000)])
        result = job.annual_portfolio(rows, "2023-08-01", "2023-09-01")[0]
        self.assertEqual(result["periodType"], "PARTIAL_FIRST_AND_LAST_YEAR")
        self.assertAlmostEqual(result["netReturn"], -0.05)
        self.assertAlmostEqual(result["mdd"], -0.10)

    def test_missing_stale_unsorted_year_gaps_and_nonfinite_nav_fail(self):
        cases = [self.rows([("2023-08-01", 100000000), ("2025-09-01", 100000000)]),
                 self.rows([("2023-08-01", 100000000), ("2023-09-01", "NaN")]),
                 self.rows([("2023-08-01", 100000000), ("2023-09-01", -1)])]
        stale = self.rows([("2023-08-01", 100000000), ("2023-09-01", 100000000)])
        stale[-1]["valuationStatus"] = "STALE"
        cases.append(stale)
        for rows in cases:
            with self.subTest(rows=rows), self.assertRaises(base.JobError):
                job.annual_portfolio(rows, rows[0]["date"], rows[-1]["date"])

    def test_annual_trade_values_use_final_exit_year_and_net_fees(self):
        trades = [{"id": "one", "status": "CLOSED", "shares": 2, "entryPrice": 100, "exitPrice": 120,
                   "entryDate": "2022-12-30", "exitDate": "2023-01-02", "exitReason": "normal"},
                  {"id": "two", "status": "CLOSED", "shares": 1, "entryPrice": 100, "exitPrice": 80,
                   "entryDate": "2023-01-03", "exitDate": "2023-12-29", "exitReason": "모델 가정 청산"},
                  {"id": "open", "status": "OPEN"}]
        metrics = job.verifier.closed_trade_metrics("KR_COMBINED_ADOPTED", trades)
        annual = metrics["byFinalExitYear"]
        expected = ((Decimal("239.64") - Decimal("200.3")) / Decimal("200.3") +
                    (Decimal("79.88") - Decimal("100.15")) / Decimal("100.15")) / 2
        self.assertEqual(len(annual), 1)
        self.assertEqual(annual[0]["exitYear"], 2023)
        self.assertEqual(annual[0]["closedTradeCount"], 2)
        self.assertEqual(annual[0]["proxyClosedTradeCount"], 1)
        self.assertAlmostEqual(annual[0]["meanNetReturn"], float(expected))
        self.assertEqual(annual[0]["medianNetReturn"], annual[0]["meanNetReturn"])
        self.assertEqual(metrics["excludedOpenPositionCount"], 1)
        self.assertEqual(metrics["definition"], job.FORMULA)


if __name__ == "__main__":
    unittest.main()
