"""Offline only: fake HTTP objects, synthetic bytes/calendars and injected commands."""
import argparse
import base64
from datetime import date, timedelta
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]

def module(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

job = module("resumable_job", ROOT / "scripts/run-adopted-kr-etf-resumable-job.py")
legacy = module("legacy_job_tests", ROOT / "tests/test_adopted_backtest_job.py")
base = job.base
OWNER, SECRET = legacy.OWNER, legacy.SECRET
BOOKS = {"ETF_V02", "KR_COMBINED_ADOPTED", "KOSPI_STANDALONE_DIAGNOSTIC", "KOSDAQ_STANDALONE_DIAGNOSTIC"}


def fixture():
    session = legacy.Session()
    catalog, ordered, extras = [], [], []
    for i in range(31):
        relative = ("stock_history/stock-%02d.parquet" % i if i < 20 else "sources/etf-%02d.parquet" % i) if i < 30 else "metadata/us.parquet"
        payload = ("synthetic-private-original-%02d" % i).encode()
        evidence = {"bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
        file_id = "SYNTHETICFILEID" + str(i).zfill(20)
        catalog.append({"fileId": file_id, "path": relative, **evidence})
        key = base.input_prefix(OWNER) + evidence["sha256"] + "/" + relative
        session.objects[key] = payload
        item = {"sourcePath": relative, "driveFileId": file_id, "sourceGroup": "STOCK_KR" if i < 20 else "ETF" if i < 30 else "US_METADATA",
                "storagePath": key, **evidence}
        if i < 30:
            item["order"] = i + 1
            ordered.append(item)
        else:
            extras.append(item)
    catalog_hash = hashlib.sha256(base.json_bytes(catalog)).hexdigest()
    manifest = {"version": base.SOURCE_VERSION, "bucket": base.BUCKET, "owner": OWNER, "catalogSha256": catalog_hash,
                "orderedFiles": ordered, "extraFiles": extras}
    session.objects[base.input_prefix(OWNER) + catalog_hash + "/source-manifest.json"] = base.json_bytes(manifest)
    return session, catalog_hash, manifest


class Commands(legacy.FakeCommands):
    def __init__(self):
        super().__init__()
        self.all_calls = []
        self.calendar = sorted(set([(date(2016, 8, 1) + timedelta(days=i)).isoformat() for i in range(600)] + ["2026-09-11"]))
        self.parity_drift = False
        self.execute_in_score = False
        self.rescore_in_replay = False
        self.empty_trades = False
        self.leak = False

    def __call__(self, command, log, environment):
        self.all_calls.append(command)
        assert set(environment) <= {"PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ", "NODE_OPTIONS"}
        if self.leak:
            raise RuntimeError(SECRET)
        if "--output" in command:
            target = Path(command[command.index("--output") + 1])
            target.mkdir(mode=0o700)
            source = Path(command[command.index("--source-manifest") + 1]).read_bytes()
            manifest = json.loads(source)
            base.local_json(target / "manifest.json", {"version": "adopted-kr-etf-inputs-v1", "sourceFileCount": 30,
                "sourceCatalogSha256": manifest["catalogSha256"], "sourceManifestFingerprint": "sha256:" + hashlib.sha256(source).hexdigest(),
                "allRawRowsRetained": True, "savedScoresReusedForSignals": False, "sessions": self.calendar,
                "preparationMetrics": {"elapsedSeconds": 2.5, "maxRssKiB": 120000}})
            log.write_text(SECRET)
            return
        if "--scoring-only" in command:
            target = Path(command[command.index("--out") + 1])
            target.mkdir(mode=0o700)
            first, last = command[command.index("--start")+1], command[command.index("--through")+1]
            dates = [day for day in self.calendar if first <= day <= last]
            prepared = json.loads(Path(command[command.index("--manifest")+1]).read_bytes())
            identity = {"version": job.CACHE_VERSION, "sourceHash": job.stable_hash(prepared["sourceCatalogSha256"]),
                "calendarHash": job.stable_hash(self.calendar), "actualCalendarHash": job.stable_hash(self.calendar),
                "codeHash": "sha256:" + "c"*64, "policyHash": "sha256:" + "d"*64}
            identity_hash = job.stable_hash(identity)
            data = gzip.compress(("\n".join(json.dumps({"date": day}) for day in dates) + "\n").encode(), mtime=0)
            (target / "signal-cache.jsonl.gz").write_bytes(data)
            base.local_json(target / "signal-cache.manifest.json", {"version": job.CACHE_VERSION, "identity": identity, "identityHash": identity_hash,
                "selectionHash": job.stable_hash({"identityHash": identity_hash, "evaluationDates": dates}), "evaluationDates": dates, "records": len(dates),
                "data": {"path": "signal-cache.jsonl.gz", "bytes": len(data), "sha256": "sha256:" + hashlib.sha256(data).hexdigest()},
                "audit": {"createdAt": "2026-10-09T12:00:00.000Z", "timestampRole": "GENERATION_TIME_ONLY_NOT_MARKET_EVIDENCE"}})
            base.local_json(target / "quality.json", {"runStatus": "FINISHED", "mode": "SCORING_ONLY", "scoringSessions": len(dates),
                "portfolioExecutionPasses": {name: int(self.execute_in_score) for name in BOOKS}, "elapsedSeconds": 4.2, "maxRssKiB": 150000})
            base.local_json(target / "provenance.json", {"private": SECRET})
            base.local_json(target / "summary.json", {})
            (target / "report.md").write_text("Synthetic private score report")
            log.write_text(SECRET)
            return
        super().__call__(command, log, environment)
        if "--results" in command:
            target = Path(command[command.index("--results")+1])
            verification = json.loads((target / "verification.json").read_bytes())
            summary = json.loads((target / "summary.json").read_bytes())
            verification["schema"] = "adopted-kr-etf-independent-verification-v1"
            for book, evidence in verification["books"].items():
                evidence.update({"feesVerified": True, "navCashPlusMarksVerified": True, "annualBudgetsVerified": True,
                                 "metricsVerified": summary[book]["status"] == "COMPLETE",
                                 "dailyCashReconciled": summary[book]["observations"], "tradeRowsChecked": 3})
            (target / "verification.json").write_bytes(base.json_bytes(verification))
            return
        target = Path(command[command.index("--out")+1])
        summary = json.loads((target / "summary.json").read_bytes())
        if set(summary) == {"ETF_V02"}:
            (target / "KR_COMBINED_ADOPTED.daily-nav.jsonl").unlink()
        for book in summary:
            for suffix in ["daily-nav.jsonl", "trades.jsonl", "yearly-budgets.json"] + (["accounting.json", "evidence.json"] if book != "ETF_V02" else []):
                (target / (book + "." + suffix)).write_bytes(base.json_bytes({"economic": "same", "book": book}))
            if book == "ETF_V02":
                for suffix in ["final-state.json", "contract.json"]:
                    (target / (book + "." + suffix)).write_bytes(base.json_bytes({"economic": "same"}))
        if self.empty_trades:
            for book in summary:
                (target / (book + ".trades.jsonl")).write_bytes(b"")
        if self.parity_drift and "--cache-input" in command:
            (target / "ETF_V02.trades.jsonl").write_text('{"economic":"different"}')
        quality = json.loads((target / "quality.json").read_bytes())
        quality["generatedScoringSessions"] = int(self.rescore_in_replay) if "--cache-input" in command else 20
        quality["portfolioExecutionPasses"] = {name: int(name in summary) for name in BOOKS}
        quality["signalCache"] = {"allIndexedRowsValidatedBeforeExecution": True, "chunks": 3}
        (target / "quality.json").write_bytes(base.json_bytes(quality))


class ResumableTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.session, self.catalog, self.source = fixture()
        self.request = {"version": job.REQUEST_VERSION, "mode": "full", "catalog_sha": self.catalog,
            "source_manifest_sha": hashlib.sha256(base.json_bytes(self.source)).hexdigest(), "etf_start": "2017-01-11",
            "kr_start": "2017-08-21", "through": "2026-09-11", "chunk_sessions": 120}
        self.request_file = self.root / "request.json"
        base.local_json(self.request_file, self.request)
        self.event = self.root / "event.json"
        base.local_json(self.event, {"inputs": {"mode": "full"}})
        self.env = {"GITHUB_ACTIONS": "true", "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_EVENT_PATH": str(self.event),
                    "GITHUB_WORKFLOW": "KR ETF resumable final-strategy backtest", "GITHUB_REF": base.REQUEST_BRANCH,
                    "GITHUB_RUN_ID": "12345", "GITHUB_RUN_ATTEMPT": "1", "GITHUB_SHA": "1"*40,
                    "GITHUB_OUTPUT": str(self.root / "github-output"), "SUPABASE_URL": base.EXPECTED_SUPABASE_URL,
                    "SUPABASE_USER_ID": OWNER, "SUPABASE_SERVICE_ROLE_KEY": SECRET, "GITHUB_TOKEN": SECRET,
                    "PATH": os.environ["PATH"]}
        self.commands, self.logs = Commands(), []
        self.originals = dict(self.session.objects)

    def tearDown(self):
        self.temp.cleanup()

    def options(self, phase="plan", index=None, market=None):
        return argparse.Namespace(**self.request, request_file=str(self.request_file), phase=phase, chunk_index=index, market=market)

    def run_job(self, phase="plan", index=None, market=None):
        return job.run_github_job(self.options(phase, index, market), environment=self.env,
            session_factory=lambda: self.session, command_runner=self.commands, emit=self.logs.append)

    def key(self, role, file):
        return OWNER + "/research/adopted-full-period/resumable/12345/" + role + "/" + (file if file == "completion.json" else "attempt-1/" + file)

    def assert_complete(self, result):
        self.assertEqual(result["status"], "COMPLETE", result)

    def plan(self):
        self.assert_complete(self.run_job())
        return json.loads(self.session.objects[self.key("plan", "plan.json")])

    def all_scores(self):
        plan = self.plan()
        for chunk in plan["matrix"]["include"]:
            self.assert_complete(self.run_job("score", chunk["chunkIndex"]))
        return plan

    def test_full_flow_only_private_immutable_writes_and_single_cached_replay_per_market(self):
        plan = self.all_scores()
        for market in ["kr", "etf"]:
            before = len(self.commands.all_calls)
            self.assert_complete(self.run_job("replay", market=market))
            commands = self.commands.all_calls[before:]
            replay = [c for c in commands if "--cache-input" in c]
            self.assertEqual(len(replay), 1)
            self.assertFalse(any("--scoring-only" in c for c in commands))
            marker = json.loads(self.session.objects[self.key("replay-" + market, "completion.json")])
            self.assertEqual(marker["proof"]["cacheChunks"], len(plan["matrix"]["include"]))
        for key, value in self.originals.items():
            self.assertEqual(self.session.objects[key], value)
        writes = [call for call in self.session.calls if call[0] == "POST"]
        for _, url, kwargs in writes:
            self.assertIn("/resumable/12345/", url)
            self.assertFalse(any(s in url for s in ["/inputs/", "/cm/", ".parquet", ".log"]))
            self.assertEqual(kwargs["headers"]["x-upsert"], "false")
            self.assertIs(kwargs["allow_redirects"], False)
            if "x-metadata" in kwargs["headers"]:
                self.assertTrue(url.endswith("/completion.json"))
                metadata = base64.b64decode(kwargs["headers"]["x-metadata"]).decode()
                self.assertNotIn(SECRET, metadata)
                self.assertNotIn("PRIVATE_POSITION", metadata)
        self.assertNotIn(SECRET, " ".join(self.logs))
        self.assertNotIn("supabase", " ".join(self.logs))

    def test_plan_actual_boundaries_matrix_and_twenty_session_parity(self):
        plan = self.plan()
        dates = [day for day in self.commands.calendar if self.request["etf_start"] <= day <= self.request["through"]]
        assembled = []
        for chunk in plan["matrix"]["include"]:
            selected = [day for day in self.commands.calendar if chunk["first"] <= day <= chunk["last"]]
            self.assertEqual(len(selected), chunk["sessions"])
            self.assertLessEqual(len(selected), 120)
            assembled.extend(selected)
        self.assertEqual(assembled, dates)
        parity = json.loads(self.session.objects[self.key("plan", "parity.json")])
        self.assertEqual(parity["first"], "2017-08-21")
        self.assertEqual(parity["chunkSessions"], [10, 10])
        self.assertEqual(len(self.commands.verification_calls), 2)
        self.assertIn("matrix=", (self.root / "github-output").read_text())

    def test_completed_roles_reuse_across_attempts_without_prepare_or_score(self):
        self.all_scores()
        self.assert_complete(self.run_job("replay", market="kr"))
        self.env["GITHUB_RUN_ATTEMPT"] = "9"
        calls = len(self.commands.all_calls)
        for result in [self.run_job(), self.run_job("score", 0), self.run_job("replay", market="kr")]:
            self.assert_complete(result)
            self.assertTrue(result["reused"])
        self.assertEqual(len(self.commands.all_calls), calls)
        self.assertFalse(any("/12345-9/" in key for key in self.session.objects))

    def test_partial_score_manifest_data_quality_recovered_without_process(self):
        self.plan()
        self.assert_complete(self.run_job("score", 0))
        del self.session.objects[self.key("score-000", "completion.json")]
        calls = len(self.commands.all_calls)
        result = self.run_job("score", 0)
        self.assert_complete(result)
        self.assertTrue(result["partialRecovered"])
        self.assertEqual(len(self.commands.all_calls), calls)

    def test_corrupt_completed_file_rejected_not_overwritten(self):
        self.plan()
        self.assert_complete(self.run_job("score", 0))
        self.session.objects[self.key("score-000", "signal-cache.jsonl.gz")] += b"corrupt"
        before = len([call for call in self.session.calls if call[0] == "POST"])
        result = self.run_job("score", 0)
        self.assertEqual(result["status"], "STOPPED")
        self.assertIn("PRIVATE_OBJECT", result["code"])
        self.assertEqual(len([call for call in self.session.calls if call[0] == "POST"]), before)

    def test_completion_owner_run_role_code_request_proof_tampering_rejected(self):
        self.plan()
        key = self.key("plan", "completion.json")
        saved = self.session.objects[key]
        for field, value in [("owner", "other"), ("runId", "2"), ("role", "replay-etf"), ("codeCommit", "2"*40)]:
            marker = json.loads(saved)
            marker["scope"][field] = value
            self.session.objects[key] = base.json_bytes(marker)
            self.assertEqual(self.run_job()["code"], "CHECKPOINT_SCOPE_MISMATCH")
        self.session.objects[key] = saved
        self.env["GITHUB_SHA"] = "3"*40
        self.assertEqual(self.run_job()["code"], "CHECKPOINT_SCOPE_MISMATCH")

    def test_missing_prefix_chunk_blocks_kr_replay_before_executor(self):
        self.all_scores()
        del self.session.objects[self.key("score-000", "completion.json")]
        calls = len(self.commands.all_calls)
        result = self.run_job("replay", market="kr")
        self.assertEqual(result["code"], "CHECKPOINT_READ_FAILED")
        self.assertFalse(any("--cache-input" in c for c in self.commands.all_calls[calls:]))

    def test_parity_drift_blocks_plan_and_all_storage_writes(self):
        self.commands.parity_drift = True
        self.assertEqual(self.run_job()["code"], "CACHE_ECONOMIC_PARITY_FAILED")
        self.assertFalse(any(c[0] == "POST" for c in self.session.calls))

    def test_score_portfolio_or_final_rescoring_rejected(self):
        self.plan()
        self.commands.execute_in_score = True
        self.assertEqual(self.run_job("score", 0)["code"], "SCORE_EXECUTED_PORTFOLIO")
        self.commands.execute_in_score = False
        for chunk in json.loads(self.session.objects[self.key("plan", "plan.json")])["matrix"]["include"]:
            self.assert_complete(self.run_job("score", chunk["chunkIndex"]))
        self.commands.rescore_in_replay = True
        self.assertEqual(self.run_job("replay", market="etf")["code"], "REPLAY_RECOMPUTED_SIGNALS")

    def test_source_hash_catalog_count_bucket_redirect_fail_closed(self):
        for mode in ["hash", "public", "redirect", "count"]:
            with self.subTest(mode=mode):
                saved_objects = dict(self.session.objects)
                if mode == "hash":
                    key = base.input_prefix(OWNER) + self.catalog + "/source-manifest.json"
                    self.session.objects[key] += b" "
                elif mode == "public":
                    self.session.bucket["public"] = True
                elif mode == "redirect":
                    self.session.redirect = True
                else:
                    # Pin a valid catalog with the wrong approved source count.
                    with mock.patch.object(base, "validate_manifest", return_value=self.source["orderedFiles"][:-1]):
                        self.assertEqual(self.run_job()["code"], "PINNED_CATALOG_FILE_COUNT_MISMATCH")
                    continue
                self.assertEqual(self.run_job()["status"], "STOPPED")
                self.session.objects = saved_objects
                self.session.bucket["public"] = False
                self.session.redirect = False
        self.assertFalse(any(c[0] == "POST" for c in self.session.calls))

    def test_explicit_trigger_request_and_cli_are_mandatory(self):
        parsed = job.parse_options(["--request", str(self.request_file), "--phase", "score", "--chunk-index", "0"])
        self.assertEqual(parsed.chunk_index, 0)
        for key, value in [("GITHUB_WORKFLOW", "other"), ("GITHUB_REF", "refs/heads/main"), ("GITHUB_ACTIONS", "false")]:
            saved = self.env[key]
            self.env[key] = value
            self.assertEqual(self.run_job()["code"], "EXPLICIT_RESUMABLE_JOB_REQUIRED")
            self.env[key] = saved
        self.event.write_bytes(base.json_bytes({"inputs": {"mode": "verify"}}))
        self.assertEqual(self.run_job()["code"], "EXPLICIT_FULL_DISPATCH_REQUIRED")
        self.env["GITHUB_EVENT_NAME"] = "push"
        self.event.write_bytes(base.json_bytes({"head_commit": {"message": "run(kr-etf-resumable): full\n\nBounded request"}}))
        job.authorize_trigger(self.options(), self.env)
        self.event.write_bytes(base.json_bytes({"head_commit": {"message": "ordinary update"}}))
        self.assertEqual(self.run_job()["code"], "PUSH_REQUEST_COMMIT_MISMATCH")
        self.assertFalse(self.session.calls)

    def test_fixed_period_chunk_and_arg_domains(self):
        for field, value in [("chunk_sessions", True), ("chunk_sessions", 121), ("through", "2026-09-30"), ("etf_start", "2017-01-10")]:
            options = self.options()
            setattr(options, field, value)
            with self.assertRaises(base.JobError):
                job.validate_options(options)
        for options in [self.options("plan", index=0), self.options("score", index=-1), self.options("score", index=True),
                        self.options("replay", market=None), self.options("score", index=0, market="kr")]:
            with self.assertRaises(base.JobError):
                job.validate_options(options)

    def test_network_process_errors_never_print_private_values(self):
        self.commands.leak = True
        self.assertEqual(self.run_job()["code"], "UNEXPECTED_JOB_ERROR_NO_DETAILS_LOGGED")
        self.assertNotIn(SECRET, " ".join(self.logs))
        self.commands.leak = False
        with mock.patch.object(self.commands, "__call__", side_effect=base.JobError(SECRET)):
            # Special method lookup occurs on the type: inject a runner explicitly.
            def failure(*_):
                raise base.JobError(SECRET)
            result = job.run_github_job(self.options(), environment=self.env, session_factory=lambda: self.session,
                                        command_runner=failure, emit=self.logs.append)
        self.assertEqual(result["code"], "JOB_FAILED_NO_PRIVATE_DETAILS_LOGGED")
        self.assertNotIn(SECRET, " ".join(self.logs))

    def test_object_allowlist_bounded_reads_and_duplicate_json(self):
        storage = job.ResumableStorage(self.session, base.EXPECTED_SUPABASE_URL, OWNER, SECRET, self.catalog, "12345", "score-000")
        for role, file in [("score-000", "../source.parquet"), ("score-1000", "quality.json"), ("replay-us", "completion.json")]:
            with self.assertRaises(base.JobError):
                storage.key(role, file)
        with self.assertRaisesRegex(base.JobError, "WRONG_ROLE"):
            storage.key("plan", "attempt-1/plan.json", write=True)
        self.session.objects[self.key("score-000", "completion.json")] = b"x"*100
        with self.assertRaisesRegex(base.JobError, "TOO_LARGE"):
            storage.bounded("score-000", "completion.json", limit=20)
        with self.assertRaisesRegex(base.JobError, "DUPLICATE"):
            job.parse_json('{"a":1,"a":2}', "DUPLICATE")

    def test_partial_create_network_failure_readback_and_conflict(self):
        storage = job.ResumableStorage(self.session, base.EXPECTED_SUPABASE_URL, OWNER, SECRET, self.catalog, "12345", "score-000")
        local = self.root / "object"
        local.write_bytes(b"identical-private-data")
        self.session.fail_after_store = True
        evidence = storage.put("signal-cache.jsonl.gz", local)
        self.assertEqual(evidence, storage.put("signal-cache.jsonl.gz", local))
        local.write_bytes(b"different-private-data")
        with self.assertRaises(base.JobError):
            storage.put("signal-cache.jsonl.gz", local)
        self.assertEqual(self.session.objects[self.key("score-000", "signal-cache.jsonl.gz")], b"identical-private-data")



    def test_empty_trade_files_complete_and_restore_but_empty_cache_fails(self):
        self.all_scores()
        self.commands.empty_trades = True
        for market in ["kr", "etf"]:
            self.assert_complete(self.run_job("replay", market=market))
            marker = json.loads(self.session.objects[self.key("replay-" + market, "completion.json")])
            trades = [entry for entry in marker["files"] if entry["path"].endswith(".trades.jsonl")]
            self.assertEqual(len(trades), len(job.result_books(market)))
            self.assertTrue(all(entry["bytes"] == 0 and entry["sha256"] == hashlib.sha256(b"").hexdigest() for entry in trades))
            self.env["GITHUB_RUN_ATTEMPT"] = "2"
            self.assertTrue(self.run_job("replay", market=market)["reused"])
            self.env["GITHUB_RUN_ATTEMPT"] = "1"
        storage = job.ResumableStorage(self.session, base.EXPECTED_SUPABASE_URL, OWNER, SECRET, self.catalog, "12345", "score-099")
        empty = self.root / "empty"
        empty.write_bytes(b"")
        with self.assertRaisesRegex(base.JobError, "INVALID_CHECKPOINT_SIZE"):
            storage.put("signal-cache.jsonl.gz", empty)

    def test_every_upload_boundary_recovers_on_new_attempt_without_overwrite(self):
        # Each phase starts with its dependencies complete. Interruption is before
        # every possible POST, including the final canonical completion marker.
        for phase, market in [("plan", None), ("score", None), ("replay", "etf"), ("replay", "kr")]:
            self.session.objects = dict(self.originals)
            self.env["GITHUB_RUN_ATTEMPT"] = "1"
            if phase == "score":
                self.plan()
            elif phase == "replay":
                self.all_scores()
            dependencies = dict(self.session.objects)
            count = 3 if phase == "plan" else 4 if phase == "score" else len(job.result_names(market)) + 2
            for boundary in range(1, count + 1):
                with self.subTest(phase=phase, market=market, boundary=boundary):
                    self.session.objects = dict(dependencies)
                    self.env["GITHUB_RUN_ATTEMPT"] = "1"
                    original_request = self.session.request
                    posts = [0]
                    def interrupted(method, url, **kwargs):
                        if method == "POST":
                            posts[0] += 1
                            if posts[0] == boundary:
                                raise RuntimeError(SECRET)
                        return original_request(method, url, **kwargs)
                    with mock.patch.object(self.session, "request", side_effect=interrupted):
                        failed = self.run_job(phase, 0 if phase == "score" else None, market)
                    self.assertEqual(failed["status"], "STOPPED")
                    preserved = dict(self.session.objects)
                    self.env["GITHUB_RUN_ATTEMPT"] = "2"
                    self.assert_complete(self.run_job(phase, 0 if phase == "score" else None, market))
                    for key, value in preserved.items():
                        self.assertEqual(self.session.objects[key], value)
                    role = "plan" if phase == "plan" else "score-000" if phase == "score" else "replay-" + market
                    marker = json.loads(self.session.objects[self.key(role, "completion.json")])
                    self.assertTrue(all(entry["path"].startswith("attempt-2/") for entry in marker["files"]))

    def test_restored_replay_requires_exact_books_and_semantic_evidence(self):
        self.all_scores()
        self.assert_complete(self.run_job("replay", market="kr"))
        marker_key = self.key("replay-kr", "completion.json")
        baseline = dict(self.session.objects)
        for mutation in ["missing-book", "verification-status", "verification-flags", "quality-passes", "quality-rescore", "report-outputs"]:
            with self.subTest(mutation=mutation):
                self.session.objects = dict(baseline)
                marker = json.loads(self.session.objects[marker_key])
                if mutation == "missing-book":
                    marker["files"] = [item for item in marker["files"] if not item["path"].endswith("KR_COMBINED_ADOPTED.daily-nav.jsonl")]
                else:
                    name = "result/verification.json" if mutation.startswith("verification") else "result/quality.json" if mutation.startswith("quality") else "run-manifest.json"
                    item = next(item for item in marker["files"] if job.logical_path(item["path"]) == name)
                    key = OWNER + "/research/adopted-full-period/resumable/12345/replay-kr/" + item["path"]
                    value = json.loads(self.session.objects[key])
                    if mutation == "verification-status":
                        value["status"] = "FAIL"
                    elif mutation == "verification-flags":
                        value["books"]["KR_COMBINED_ADOPTED"]["feesVerified"] = False
                    elif mutation == "quality-passes":
                        value["portfolioExecutionPasses"]["KR_COMBINED_ADOPTED"] = 2
                    elif mutation == "quality-rescore":
                        value["generatedScoringSessions"] = 1
                    else:
                        value["outputs"] = []
                    data = base.json_bytes(value)
                    self.session.objects[key] = data
                    item.update({"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
                    # Keep report.outputs byte evidence consistent, so the deeper
                    # semantic check, rather than only a stale hash, must reject.
                    if name != "run-manifest.json":
                        report_item = next(x for x in marker["files"] if job.logical_path(x["path"]) == "run-manifest.json")
                        report_key = OWNER + "/research/adopted-full-period/resumable/12345/replay-kr/" + report_item["path"]
                        report = json.loads(self.session.objects[report_key])
                        report["outputs"] = [x for x in marker["files"] if job.logical_path(x["path"]) != "run-manifest.json"]
                        report_data = base.json_bytes(report)
                        self.session.objects[report_key] = report_data
                        report_item.update({"bytes": len(report_data), "sha256": hashlib.sha256(report_data).hexdigest()})
                self.session.objects[marker_key] = base.json_bytes(marker)
                calls = len(self.commands.all_calls)
                result = self.run_job("replay", market="kr")
                self.assertEqual(result["status"], "STOPPED", result)
                self.assertEqual(len(self.commands.all_calls), calls)


if __name__ == "__main__":
    unittest.main()
