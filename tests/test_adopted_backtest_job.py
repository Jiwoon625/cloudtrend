"""Offline job tests: fake HTTP, synthetic source bytes, and injected local commands only."""
import argparse
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("adopted_job", ROOT / "scripts/run-adopted-kr-etf-job.py")
job = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(job)
OWNER = "11111111-2222-3333-4444-555555555555"
SECRET = "FAKE_PRIVATE_SECRET_NEVER_PRINT"


class Response:
    def __init__(self, status=200, data=b"", metadata=None, fail_stream=False):
        self.status_code, self.data, self.metadata = status, data, metadata
        self.fail_stream = fail_stream
        self.closed = False

    def json(self):
        return self.metadata

    def iter_content(self, chunk_size):
        for offset in range(0, len(self.data), 5):
            yield self.data[offset:offset + 5]
            if self.fail_stream:
                raise RuntimeError(SECRET + " https://private.invalid/?token=private")

    def close(self):
        self.closed = True


class Session:
    def __init__(self):
        self.objects, self.calls, self.registry = {}, [], []
        self.bucket = {"id": job.BUCKET, "public": False, "file_size_limit": None, "allowed_mime_types": None}
        self.redirect = self.fail_after_store = self.fail_before_store = self.tamper_readback = False
        self.closed = False

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        assert kwargs["allow_redirects"] is False
        assert url.startswith(job.EXPECTED_SUPABASE_URL + "/storage/v1/") or url == job.EXPECTED_SUPABASE_URL + "/rest/v1/analysis_source_files"
        if url.endswith("/rest/v1/analysis_source_files"):
            assert method == "GET"
            return Response(metadata=self.registry)
        if self.redirect:
            return Response(302, data=SECRET.encode())
        if "/bucket/" in url:
            assert method == "GET"
            return Response(metadata=self.bucket)
        read_marker = "/object/authenticated/" + job.BUCKET + "/"
        if read_marker in url:
            assert method == "GET"
            key = url.split(read_marker)[1]
            if key not in self.objects:
                return Response(404, metadata={"statusCode": "404", "message": "Object not found"})
            return Response(data=self.objects[key])
        marker = "/object/" + job.BUCKET + "/"
        assert method == "POST" and marker in url
        assert kwargs["headers"]["x-upsert"] == "false"
        key = url.split(marker)[1]
        body = kwargs["data"].read()
        assert int(kwargs["headers"]["Content-Length"]) == len(body)
        if self.fail_before_store:
            self.fail_before_store = False
            raise RuntimeError(SECRET)
        if key in self.objects:
            return Response(409)
        self.objects[key] = body + (b"corrupt" if self.tamper_readback else b"")
        if self.fail_after_store:
            self.fail_after_store = False
            raise RuntimeError(SECRET)
        return Response(201)

    def close(self):
        self.closed = True


def fixture():
    session = Session()
    payloads = [b"synthetic-stock-raw-private", b"synthetic-etf-raw-private"]
    catalog = [{"fileId": "FAKEFILEID" + str(i) * 20, "path": name, "bytes": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest()}
               for i, (name, payload) in enumerate(zip(["stock_history/stock.parquet", "sources/etf.parquet"], payloads))]
    catalog_sha = hashlib.sha256(job.json_bytes(catalog)).hexdigest()
    ordered = []
    for i, (item, payload) in enumerate(zip(catalog, payloads), 1):
        storage_path = job.input_prefix(OWNER) + item["sha256"] + "/" + item["path"]
        session.objects[storage_path] = payload
        ordered.append({"order": i, "sourcePath": item["path"], "driveFileId": item["fileId"],
                        "sourceGroup": "STOCK_KR" if i == 1 else "ETF", "storagePath": storage_path,
                        "sha256": item["sha256"], "bytes": item["bytes"]})
    manifest = {"version": job.SOURCE_VERSION, "bucket": job.BUCKET, "owner": OWNER,
                "catalogSha256": catalog_sha, "orderedFiles": ordered}
    session.objects[job.input_prefix(OWNER) + catalog_sha + "/source-manifest.json"] = job.json_bytes(manifest)
    return session, catalog_sha, manifest


class FakeCommands:
    def __init__(self, fail_smoke=False):
        self.calls = []
        self.fail_smoke = fail_smoke
        self.verification_calls = []

    def __call__(self, command, log, environment):
        if "--inspect-symbols-only" in command:
            target = Path(command[command.index("--output")+1])
            target.write_bytes(job.json_bytes({"schema": "adopted-kr-etf-symbol-audit-v1", "status": "INPUT_CLASSIFICATION_ONLY", "sourceFileCount": 2,
                "invalid": [{"rawSymbol": "SPY", "normalizedSymbol": "SPY", "market": "ETF", "type": "ETF", "rows": 20, "sourceOrders": [2]}]}))
            return
        if "--results" in command:
            self.verification_calls.append(command)
            target = Path(command[command.index("--results") + 1])
            summary = json.loads((target / "summary.json").read_bytes())
            verified = {book: {"closedTradeMetrics": {**job.TRADE_METRIC_CONTRACT,
                "status": "VERIFIED" if value["status"] == "COMPLETE" else "WITHHELD_INCOMPLETE_RUN",
                "closedTradeCount": 2, "excludedOpenPositionCount": 1, "proxyClosedTradeCount": 0,
                "meanNetReturn": 0.1 if value["status"] == "COMPLETE" else None,
                "medianNetReturn": 0.05 if value["status"] == "COMPLETE" else None}} for book, value in summary.items()}
            (target / "verification.json").write_bytes(job.json_bytes({"status": "PASS", "books": verified}))
            return
        self.calls.append((command, log, environment))
        assert "SUPABASE_SERVICE_ROLE_KEY" not in environment
        assert "GITHUB_TOKEN" not in environment
        assert SECRET not in json.dumps(environment)
        log.write_text("Private local subprocess log " + SECRET)
        os.chmod(log, 0o600)
        if "--output" in command:
            if "--extension-manifest" in command:
                self.extension_manifest = json.loads(Path(command[command.index("--extension-manifest")+1]).read_text())
            target = Path(command[command.index("--output") + 1])
            target.mkdir(mode=0o700)
            (target / "manifest.json").write_bytes(job.json_bytes({"preparationMetrics": {"elapsedSeconds": 2.5, "maxRssKiB": 123456}}))
            return
        smoke = "--smoke-sessions" in command
        if smoke and self.fail_smoke:
            raise job.JobError("LOCAL_RESEARCH_PROCESS_FAILED")
        target = Path(command[command.index("--out") + 1])
        target.mkdir(mode=0o700)
        quality = {"runStatus": "FINISHED", "mode": "SAMPLE_INCOMPLETE" if smoke else "SELECTED_RANGE_REPLAY",
                   "sessions": int(command[command.index("--smoke-sessions") + 1]) if smoke else 40,
                   "maxRssKiB": 100000, "elapsedSeconds": 1.5}
        if hasattr(self, "extension_manifest"):
            quality["extensionContinuity"] = {"status": "PASS", "afterDate": "2026-09-11", "comparedRows": 6, "unmatchedRows": 0,
                "comparedIndexRows": 4, "comparedFields": ["open", "high", "low", "close"], "priceBasisAdjusted": False}
        market = command[command.index("--market") + 1]
        books = ["US_A0"] if market == "us" else ["ETF_V02"] if market == "etf" else [
            "KR_COMBINED_ADOPTED", "KOSPI_STANDALONE_DIAGNOSTIC", "KOSDAQ_STANDALONE_DIAGNOSTIC"] + (["ETF_V02"] if market == "kr-etf" else [])
        quality.update({"sourceCalendarStart": "2016-08-12", "sourceCalendarEnd": "2026-09-11",
                        "signalReadiness": {"firstAnyValidScoreDate": {"ETF": "2017-09-01"},
                                            "firstEntryReadyDate": {"ETF": "2017-09-04"},
                                            "validScoreObservations": {"ETF": 100},
                                            "entryReadyObservations": {"ETF": 2}}})
        quality.update({book: {"tradeCount": 3, "terminalOpenPositions": 1, "private": SECRET} for book in books})
        summary = {book: {"status": "SAMPLE_INCOMPLETE" if smoke else "COMPLETE",
                          "startDate": command[command.index("--start") + 1], "endDate": command[command.index("--through") + 1],
                          "observations": quality["sessions"], "cagr": None if smoke else 0.1,
                          "mdd": None if smoke else -0.2, "cumulativeReturn": None if smoke else 0.3,
                          "missingValuationCount": 0, "staleValuationCount": 0, "annualization": "ACTUAL_DAYS_365_2425",
                          "finalNAV": 100, "privateSource": "PRIVATE_NAV_TEST", "positions": ["PRIVATE_POSITION"]}
                   for book in books}
        for name, value in {"quality.json": quality, "summary.json": summary, "provenance.json": {"synthetic": True}}.items():
            (target / name).write_bytes(job.json_bytes(value))
        (target / "report.md").write_text("Synthetic private result")
        book = "US_A0" if command[command.index("--market") + 1] == "us" else "KR_COMBINED_ADOPTED"
        (target / (book + ".daily-nav.jsonl")).write_text('{"private": "nav"}\n')


class JobTests(unittest.TestCase):
    def test_full_rejects_unverified_late_stock_environment(self):
        self.options.mode = "full"
        self.options.through = "2026-09-30"
        for market in ["kr", "etf", "kr-etf"]:
            self.options.market = market
            with self.assertRaisesRegex(job.JobError, "UNVERIFIED_POST_CUTOFF_STOCK_ENVIRONMENT"):
                job.validate_options(self.options)

    def setUp(self):
        self.session, self.sha, self.manifest = fixture()
        self.options = argparse.Namespace(catalog_sha=self.sha, source_manifest_sha=hashlib.sha256(job.json_bytes(self.manifest)).hexdigest(), mode="smoke", market="kr-etf",
                                          start="2017-01-03", through="2026-09-11", smoke_sessions=20)
        self.env = {"GITHUB_ACTIONS": "true", "GITHUB_EVENT_NAME": "workflow_dispatch",
                    "GITHUB_WORKFLOW": "KR ETF final-strategy backtest", "GITHUB_RUN_ID": "12345", "GITHUB_RUN_ATTEMPT": "1",
                    "GITHUB_SHA": "1" * 40,
                    "SUPABASE_URL": job.EXPECTED_SUPABASE_URL, "SUPABASE_USER_ID": OWNER,
                    "SUPABASE_SERVICE_ROLE_KEY": SECRET, "GITHUB_TOKEN": "FAKE_GITHUB_SECRET", "PATH": os.environ["PATH"]}
        self.commands, self.logs = FakeCommands(), []
        self.us_input_hook = None

    def run_job(self):
        return job.run_github_job(self.options, environment=self.env, session_factory=lambda: self.session,
                                  command_runner=self.commands, us_input_hook=self.us_input_hook, emit=self.logs.append)

    def writes(self):
        return [call for call in self.session.calls if call[0] == "POST"]

    def test_smoke_uploads_only_verified_allowlisted_results_and_preserves_inputs(self):
        originals = dict(self.session.objects)
        result = self.run_job()
        self.assertEqual(result, {"status": "COMPLETE", "mode": "smoke", "market": "kr-etf", "outputFiles": 6, "privateRun": "12345-1"})
        self.assertEqual(len(self.commands.calls), 2)
        self.assertEqual(len(self.writes()), 7)
        for key, data in originals.items():
            self.assertEqual(self.session.objects[key], data)
        for method, url, kwargs in self.writes():
            self.assertIn(OWNER + "/research/adopted-full-period/runs/12345-1/", url)
            self.assertNotIn("/inputs/", url)
            self.assertNotIn("/cm/", url)
            self.assertNotIn(".log", url)
            self.assertNotIn(".parquet", url)
        self.assertTrue(self.writes()[-1][1].endswith("/run-manifest.json"))
        self.assertTrue(self.session.closed)
        self.assertEqual(len(self.logs), 1)
        for secret in [SECRET, "PRIVATE_NAV_TEST", "synthetic-stock-raw", "https://"]:
            self.assertNotIn(secret, self.logs[0])

    def test_extension_reads_only_exact_owner_hash_bytes_and_preserves_source(self):
        payload = b"synthetic extension source bytes"
        sha = hashlib.sha256(payload).hexdigest()
        sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        key = OWNER + "/source/screening/" + sid + "/publish.csv"
        row = {"id": sid, "user_id": OWNER, "file_hash": "sha256:"+sha, "file_size_bytes": len(payload),
               "storage_bucket": job.BUCKET, "storage_path": key, "source_type": "screening", "status": "superseded"}
        self.session.registry = [row]
        self.session.objects[key] = payload
        self.options.through = "2026-09-30"
        with mock.patch.object(job, "EXTENSION_SHA256", sha), mock.patch.object(job, "EXTENSION_BYTES", len(payload)):
            result = self.run_job()
        self.assertEqual(result["status"], "COMPLETE")
        self.assertEqual(self.session.objects[key], payload)
        self.assertEqual(self.commands.extension_manifest["sha256"], sha)
        self.assertEqual(self.commands.extension_manifest["afterDate"], "2026-09-11")
        self.assertNotIn(SECRET, json.dumps(self.commands.extension_manifest))
        read = next(c for c in self.session.calls if "/rest/v1/" in c[1])
        self.assertEqual(read[2]["params"]["user_id"], "eq."+OWNER)
        self.assertEqual(read[2]["params"]["file_hash"], "eq.sha256:"+sha)
        metadata = json.loads(base64.b64decode(self.writes()[-1][2]["headers"]["x-metadata"]))
        self.assertEqual(metadata["extensionHashes"], [sha])
        self.assertTrue(all("/research/adopted-full-period/runs/" in call[1] for call in self.writes()))

    def test_extension_rejects_changed_owner_duplicate_registry_and_changed_bytes(self):
        payload = b"synthetic extension source bytes"
        sha = hashlib.sha256(payload).hexdigest()
        sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        key = OWNER + "/source/screening/" + sid + "/publish.csv"
        original = {"id": sid, "user_id": OWNER, "file_hash": "sha256:"+sha, "file_size_bytes": len(payload),
                    "storage_bucket": job.BUCKET, "storage_path": key, "source_type": "screening", "status": "superseded"}
        for variation in ("owner", "duplicate", "path", "bytes"):
            session = Session()
            item = dict(original)
            if variation == "owner": item["user_id"] = sid
            if variation == "path": item["storage_path"] = sid+"/outside.csv"
            session.registry = [item, item] if variation == "duplicate" else [item]
            session.objects[key] = payload+b"changed" if variation == "bytes" else payload
            storage = job.PrivateStorage(session, job.EXPECTED_SUPABASE_URL, OWNER, SECRET, self.sha, "12345-1")
            with tempfile.TemporaryDirectory() as tmp, mock.patch.object(job, "EXTENSION_SHA256", sha), mock.patch.object(job, "EXTENSION_BYTES", len(payload)):
                with self.assertRaises(job.JobError): storage.verified_september_extension(Path(tmp)/"extension.csv")
            self.assertFalse(any(method == "POST" for method, _, _ in session.calls))

    def test_private_symbol_audit_is_not_a_performance_completion(self):
        self.options.mode = "symbols"
        result = self.run_job()
        self.assertEqual(result["status"], "INPUT_CLASSIFICATION_ONLY")
        self.assertEqual(result["invalidClasses"], 1)
        metadata = json.loads(base64.b64decode(self.writes()[-1][2]["headers"]["x-metadata"]))
        self.assertEqual(metadata["schema"], "adopted-kr-etf-symbol-audit-v1")
        self.assertNotIn("books", metadata)
        self.assertEqual(metadata["examples"][0]["rawSymbol"], "SPY")
        invalid = json.loads(json.dumps(metadata))
        invalid["examples"][0]["rawSymbol"] = "X"*129
        with self.assertRaisesRegex(job.JobError, "SYMBOL_AUDIT"):
            job.safe_symbol_audit_metadata(invalid)

    def test_run_manifest_header_contains_only_bounded_safe_summary_metadata(self):
        self.assertEqual(self.run_job()["status"], "COMPLETE")
        metadata_calls = []
        for _method, url, kwargs in self.writes():
            if "x-metadata" not in kwargs["headers"]:
                self.assertFalse(url.endswith("/run-manifest.json"))
                continue
            self.assertTrue(url.endswith("/run-manifest.json"))
            header = kwargs["headers"]["x-metadata"]
            self.assertLessEqual(len(header.encode()), 8192)
            metadata = json.loads(base64.b64decode(header, validate=True))
            metadata_calls.append(metadata)
            self.assertEqual(set(metadata), job.SUMMARY_FIELDS)
            self.assertEqual(metadata["schema"], "adopted-backtest-summary-v1")
            self.assertEqual(set(metadata["books"]), {"KR_COMBINED_ADOPTED", "KOSPI_STANDALONE_DIAGNOSTIC", "KOSDAQ_STANDALONE_DIAGNOSTIC", "ETF_V02"})
            self.assertEqual(metadata["checks"]["signals"]["ETF"], {"scoreFirst": "2017-09-01", "entryFirst": "2017-09-04", "scoreCount": 100, "entryCount": 2})
            self.assertEqual(metadata["checks"]["accounts"]["ETF_V02"], {"events": 3, "openCount": 1})
            for book in metadata["books"].values():
                self.assertEqual(set(book), job.BOOK_SUMMARY_FIELDS)
                self.assertEqual(book["status"], "SAMPLE_INCOMPLETE")
                self.assertIsNone(book["cagr"])
            key = url.split("/object/" + job.BUCKET + "/")[1]
            self.assertEqual(metadata["resultManifestSha256"], hashlib.sha256(self.session.objects[key]).hexdigest())
            encoded = json.dumps(metadata)
            for denied in [OWNER, SECRET, "FAKEFILEID", "sourcePath", "finalNAV", "cash", "positions", "trades", "PRIVATE_NAV_TEST"]:
                self.assertNotIn(denied, encoded)
        self.assertEqual(len(metadata_calls), 1)

    def test_metadata_rejects_extras_nonfinite_types_size_and_other_targets(self):
        self.assertEqual(self.run_job()["status"], "COMPLETE")
        kwargs = self.writes()[-1][2]
        valid = json.loads(base64.b64decode(kwargs["headers"]["x-metadata"]))
        def changed():
            return json.loads(json.dumps(valid))
        invalid = changed()
        invalid["owner"] = OWNER
        with self.assertRaisesRegex(job.JobError, "FIELDS"):
            job.safe_summary_metadata(invalid)
        for field, value in [("cagr", float("nan")), ("mdd", float("inf")), ("cagr", 10 ** 1000),
                             ("observations", True), ("observations", 2 ** 53), ("cumulativeReturn", "0.5")]:
            invalid = changed()
            invalid["books"]["ETF_V02"][field] = value
            with self.assertRaises(job.JobError):
                job.safe_summary_metadata(invalid)
        invalid = changed()
        for key, bad in [("meanNetReturn", 0.2), ("closedTradeCount", True), ("proxyClosedTradeCount", 99), ("extra", SECRET)]:
            invalid = changed()
            invalid["closedTradeMetrics"]["books"]["ETF_V02"][key] = bad
            with self.assertRaisesRegex(job.JobError, "TRADE_METRIC"):
                job.safe_summary_metadata(invalid)
        invalid = changed()
        invalid["books"]["ETF_V02"]["finalNAV"] = 100
        with self.assertRaisesRegex(job.JobError, "BOOK_FIELDS"):
            job.safe_summary_metadata(invalid)
        for field, value in [("scoreFirst", SECRET), ("entryCount", True), ("scoreCount", -1), ("extra", SECRET)]:
            invalid = changed()
            invalid["checks"]["signals"]["ETF"][field] = value
            with self.assertRaisesRegex(job.JobError, "CHECKS"):
                job.safe_summary_metadata(invalid)
        invalid = changed()
        invalid["checks"]["accounts"]["ETF_V02"]["events"] = SECRET
        with self.assertRaisesRegex(job.JobError, "CHECKS"):
            job.safe_summary_metadata(invalid)
        with mock.patch.object(job, "MAX_METADATA_BYTES", 16):
            with self.assertRaisesRegex(job.JobError, "TOO_LARGE"):
                job.safe_summary_metadata(valid)
        storage = job.PrivateStorage(Session(), job.EXPECTED_SUPABASE_URL, OWNER, SECRET, self.sha, "12345-2")
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "result.json"
            file.write_bytes(b"{}")
            with self.assertRaisesRegex(job.JobError, "METADATA_ONLY_ALLOWED"):
                storage.create_result("result/summary.json", file, metadata=valid)
            with self.assertRaisesRegex(job.JobError, "HASH_MISMATCH"):
                storage.create_result("run-manifest.json", file, metadata=valid)
        self.assertEqual(storage.session.calls, [])

    def test_full_measures_real_source_smoke_first(self):
        self.options.mode = "full"
        self.assertEqual(self.run_job()["status"], "COMPLETE")
        self.assertEqual(len(self.commands.calls), 3)
        self.assertIn("--smoke-sessions", self.commands.calls[1][0])
        self.assertNotIn("--smoke-sessions", self.commands.calls[2][0])
        report = json.loads(next(data for key, data in self.session.objects.items() if key.endswith("/run-manifest.json")))
        self.assertEqual([row["mode"] for row in report["measurements"]], ["smoke", "full"])
        self.assertEqual(report["measurements"][0]["maxRssKiB"], 100000)
        self.assertEqual(report["codeCommit"], "1" * 40)
        self.assertEqual(report["preparation"], {"elapsedSeconds": 2.5, "maxRssKiB": 123456})

    def test_failed_smoke_never_advances_to_full_or_publishes_complete(self):
        self.options.mode = "full"
        self.commands.fail_smoke = True
        self.assertEqual(self.run_job()["code"], "LOCAL_RESEARCH_PROCESS_FAILED")
        self.assertEqual(len(self.commands.calls), 2)
        self.assertEqual(self.writes(), [])

    def test_unverified_bucket_stops_before_any_source_read_or_write(self):
        self.session.bucket["public"] = True
        self.assertEqual(self.run_job()["code"], "BUCKET_NOT_PRIVATE")
        self.assertEqual(len(self.session.calls), 1)
        self.assertEqual(self.commands.calls, [])

    def test_project_owner_and_local_execution_rejected_before_network(self):
        for key, value in [("SUPABASE_URL", job.EXPECTED_SUPABASE_URL + ".evil.invalid"),
                           ("SUPABASE_USER_ID", "../owner"), ("GITHUB_EVENT_NAME", "push"), ("GITHUB_ACTIONS", "false")]:
            with self.subTest(key=key):
                old = self.env[key]
                self.env[key] = value
                self.assertEqual(self.run_job()["status"], "STOPPED")
                self.env[key] = old
        self.assertEqual(self.session.calls, [])

    def test_code_commit_must_be_exact_full_hex_before_network(self):
        for commit in [None, "", "1" * 39, "1" * 41, "g" * 40, "../../private"]:
            with self.subTest(commit=commit):
                self.env["GITHUB_SHA"] = commit
                self.assertEqual(self.run_job()["code"], "INVALID_CODE_COMMIT")
        self.assertEqual(self.session.calls, [])

    def test_manifest_scope_order_paths_sizes_catalog_hash_are_strict(self):
        for key, value in [("storagePath", OWNER + "/research/cm/input.parquet"),
                           ("sourcePath", "stock_history/../input.parquet"), ("sourcePath", "/etc/passwd"),
                           ("sourcePath", "stock_history/%2e%2e.parquet"), ("bytes", True), ("bytes", 0),
                           ("order", 2), ("sourceGroup", "US"), ("sha256", "0" * 64)]:
            with self.subTest(key=key, value=value):
                manifest = json.loads(json.dumps(self.manifest))
                manifest["orderedFiles"][0][key] = value
                with self.assertRaises(job.JobError):
                    job.validate_manifest(manifest, self.sha, OWNER)
        bad = json.loads(json.dumps(self.manifest))
        bad["orderedFiles"][0]["driveFileId"] = "B" * 30
        with self.assertRaisesRegex(job.JobError, "CATALOG_HASH_MISMATCH"):
            job.validate_manifest(bad, self.sha, OWNER)
        bad["owner"] = "other-owner"
        with self.assertRaises(job.JobError):
            job.validate_manifest(bad, self.sha, OWNER)

    def test_changed_transfer_manifest_stops_before_input_staging(self):
        self.options.source_manifest_sha = "0" * 64
        self.assertEqual(self.run_job()["code"], "SOURCE_MANIFEST_HASH_MISMATCH")
        self.assertEqual(self.commands.calls, [])
        self.assertEqual(self.writes(), [])

    def test_cli_rejects_us_market(self):
        self.options.market = "us"
        with mock.patch.object(job, "parse_options", return_value=self.options), mock.patch("builtins.print") as output:
            self.assertEqual(job.main(), 1)
        self.assertIn("ONLY_KR_ETF_REPLAY_ALLOWED", output.call_args[0][0])
        self.assertEqual(self.session.calls, [])

    def test_corrupt_download_stops_before_local_research(self):
        key = self.manifest["orderedFiles"][0]["storagePath"]
        self.session.objects[key] = b"x" * len(self.session.objects[key])
        self.assertEqual(self.run_job()["code"], "PRIVATE_OBJECT_HASH_MISMATCH")
        self.assertEqual(self.commands.calls, [])
        self.assertEqual(self.writes(), [])

    def test_us_metadata_extends_catalog_hash_but_never_enters_kr_staging(self):
        payload = b"synthetic-private-US-metadata"
        sha = hashlib.sha256(payload).hexdigest()
        extra = {"sourceGroup": "US_METADATA", "sourcePath": "metadata/us-master.parquet",
                 "driveFileId": "FAKEFILEID" + "3" * 20, "bytes": len(payload), "sha256": sha,
                 "storagePath": job.input_prefix(OWNER) + sha + "/metadata/us-master.parquet"}
        self.manifest["extraFiles"] = [extra]
        projection = [{"fileId": item["driveFileId"], "path": item["sourcePath"], "bytes": item["bytes"], "sha256": item["sha256"]}
                      for item in self.manifest["orderedFiles"] + [extra]]
        self.sha = hashlib.sha256(job.json_bytes(projection)).hexdigest()
        self.options.catalog_sha = self.sha
        self.manifest["catalogSha256"] = self.sha
        self.session.objects[job.input_prefix(OWNER) + self.sha + "/source-manifest.json"] = job.json_bytes(self.manifest)
        self.session.objects[extra["storagePath"]] = payload
        self.options.source_manifest_sha = hashlib.sha256(job.json_bytes(self.manifest)).hexdigest()
        self.assertEqual(self.run_job()["status"], "COMPLETE")
        self.assertFalse(any(extra["storagePath"] in call[1] for call in self.session.calls))
        self.manifest["extraFiles"][0]["bytes"] += 1
        with self.assertRaisesRegex(job.JobError, "CATALOG_HASH_MISMATCH"):
            job.validate_manifest(self.manifest, self.sha, OWNER)

    def test_redirect_stops_without_leaking_response(self):
        self.session.redirect = True
        self.assertEqual(self.run_job()["code"], "BUCKET_METADATA_UNAVAILABLE")
        self.assertNotIn(SECRET, "".join(self.logs))
        self.assertEqual(self.writes(), [])

    def test_uncertain_post_readback_succeeds_without_retry(self):
        self.session.fail_after_store = True
        self.assertEqual(self.run_job()["status"], "COMPLETE")
        self.assertEqual(len(self.writes()), 7)

    def test_uncertain_before_store_and_corrupt_readback_stop_without_retry(self):
        self.session.fail_before_store = True
        self.assertEqual(self.run_job()["code"], "UNCERTAIN_RESULT_CREATE")
        self.assertEqual(len(self.writes()), 1)
        self.session, self.sha, self.manifest = fixture()
        self.session.tamper_readback = True
        self.assertEqual(self.run_job()["code"], "PRIVATE_OBJECT_SIZE_MISMATCH")
        self.assertEqual(len(self.writes()), 1)

    def test_same_run_conflict_is_not_overwritten(self):
        key = OWNER + "/research/adopted-full-period/runs/12345-1/result/KR_COMBINED_ADOPTED.daily-nav.jsonl"
        self.session.objects[key] = b"previous conflicting result"
        self.assertEqual(self.run_job()["status"], "STOPPED")
        self.assertEqual(self.session.objects[key], b"previous conflicting result")
        self.assertEqual(self.writes(), [])

    def test_subprocess_output_is_private_local_and_secrets_not_in_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "process.log"
            def fake_run(command, **kwargs):
                self.assertEqual(kwargs["env"], {"PATH": self.env["PATH"]})
                self.assertIs(kwargs["stderr"], job.subprocess.STDOUT)
                kwargs["stdout"].write((SECRET + " PRIVATE_NAV").encode())
                return argparse.Namespace(returncode=1)
            with mock.patch.object(job.subprocess, "run", side_effect=fake_run):
                with self.assertRaisesRegex(job.JobError, "LOCAL_RESEARCH_PROCESS_FAILED"):
                    job.run_command(["node", "local-only"], log, self.env)
            self.assertIn(SECRET, log.read_text())
            self.assertEqual(log.stat().st_mode & 0o777, 0o600)

    def test_error_diagnostics_emit_only_public_source_location(self):
        for message, expected in [
            ("Invalid or stale ETF pending entry: " + SECRET, "SOURCE_ASSERT_src/lib/ledger/etfAdoptedShadow.ts:"),
            (SECRET + "\nRESEARCH_FAILURE_FRAME src/lib/engine/manualDataset.ts:300:4", "SOURCE_FRAME_src/lib/engine/manualDataset.ts:300:4"),
        ]:
            with tempfile.TemporaryDirectory() as directory:
                def fake_run(command, **kwargs):
                    kwargs["stdout"].write(message.encode())
                    return argparse.Namespace(returncode=1)
                with mock.patch.object(job.subprocess, "run", side_effect=fake_run):
                    with self.assertRaises(job.JobError) as caught:
                        job.run_command(["node", "local-only"], Path(directory) / "log", self.env)
                self.assertIn(expected, str(caught.exception))
                self.assertNotIn(SECRET, str(caught.exception))

    def test_raw_files_and_symlinks_cannot_enter_result_upload(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            (target / "raw.parquet").write_bytes(b"private")
            with self.assertRaisesRegex(job.JobError, "UNEXPECTED_RESULT_FILE"):
                job.output_files(target)
            (target / "raw.parquet").unlink()
            (target / "quality.json").symlink_to("/etc/hosts")
            with self.assertRaisesRegex(job.JobError, "UNEXPECTED_RESULT_FILE"):
                job.output_files(target)

    def test_unexpected_error_messages_are_not_public(self):
        self.commands = mock.Mock(side_effect=RuntimeError(SECRET + " https://private.invalid"))
        result = self.run_job()
        self.assertEqual(result["code"], "UNEXPECTED_JOB_ERROR_NO_DETAILS_LOGGED")
        self.assertNotIn(SECRET, json.dumps(result) + "".join(self.logs))

    def make_request(self, directory, mode="smoke"):
        request = Path(directory) / "request.json"
        request.write_bytes(job.json_bytes({"mode": mode, "market": "kr-etf", "catalog_sha": self.sha,
                                            "source_manifest_sha": hashlib.sha256(job.json_bytes(self.manifest)).hexdigest(),
                                            "start": "2017-01-03", "through": "2026-09-11", "smoke_sessions": 20}))
        event = Path(directory) / "event.json"
        event.write_bytes(job.json_bytes({"head_commit": {"message": "run(kr-etf-backtest): " + mode + "\n\nExplicit requested research run"}}))
        return request, event

    def test_explicit_feature_branch_push_request_smoke_and_full(self):
        for mode in ("smoke", "full"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                self.session, self.sha, self.manifest = fixture()
                self.commands = FakeCommands()
                request, event = self.make_request(directory, mode)
                self.options = job.parse_options(["--request", str(request)])
                self.env.update(GITHUB_EVENT_NAME="push", GITHUB_REF=job.REQUEST_BRANCH, GITHUB_EVENT_PATH=str(event))
                self.assertEqual(self.run_job()["status"], "COMPLETE")
                self.assertEqual(len(self.commands.calls), 2 if mode == "smoke" else 3)

    def test_ordinary_push_wrong_branch_and_mismatched_commit_never_reach_network(self):
        with tempfile.TemporaryDirectory() as directory:
            request, event = self.make_request(directory)
            self.options = job.parse_options(["--request", str(request)])
            self.env.update(GITHUB_EVENT_NAME="push", GITHUB_REF=job.REQUEST_BRANCH, GITHUB_EVENT_PATH=str(event))
            for message in ["ordinary update", "run(kr-etf-backtest): full", "run(kr-etf-backtest): smoke ",
                            "prefix run(kr-etf-backtest): smoke", "\nrun(kr-etf-backtest): smoke", "", None]:
                event.write_bytes(job.json_bytes({"head_commit": {"message": message}}))
                self.assertEqual(self.run_job()["code"], "PUSH_REQUEST_COMMIT_MISMATCH")
            event.write_bytes(job.json_bytes({"head_commit": {"message": "run(kr-etf-backtest): smoke"}}))
            for branch in ["refs/heads/main", "refs/heads/other", "refs/tags/feat/kr-etf-final-history", ""]:
                self.env["GITHUB_REF"] = branch
                self.assertEqual(self.run_job()["code"], "EXPLICIT_GITHUB_JOB_REQUIRED")
            self.env["GITHUB_REF"] = job.REQUEST_BRANCH
            self.options.request_file = None
            self.assertEqual(self.run_job()["code"], "EXPLICIT_GITHUB_JOB_REQUIRED")
        self.assertEqual(self.session.calls, [])
        self.assertEqual(self.commands.calls, [])

    def test_push_request_is_revalidated_and_event_file_required(self):
        with tempfile.TemporaryDirectory() as directory:
            request, event = self.make_request(directory)
            self.options = job.parse_options(["--request", str(request)])
            self.env.update(GITHUB_EVENT_NAME="push", GITHUB_REF=job.REQUEST_BRANCH, GITHUB_EVENT_PATH=str(event))
            data = json.loads(request.read_bytes())
            data["mode"] = "full"
            request.write_bytes(job.json_bytes(data))
            self.assertEqual(self.run_job()["code"], "REQUEST_OPTIONS_MISMATCH")
            data["mode"] = "smoke"
            request.write_bytes(job.json_bytes(data))
            event.unlink()
            self.assertEqual(self.run_job()["code"], "INVALID_PUSH_EVENT")
        self.assertEqual(self.session.calls, [])

    def test_request_schema_conflicting_flags_and_direct_flags(self):
        with tempfile.TemporaryDirectory() as directory:
            request, _event = self.make_request(directory)
            with self.assertRaisesRegex(job.JobError, "REQUEST_CANNOT_MIX_SELECTION_FLAGS"):
                job.parse_options(["--request", str(request), "--mode", "smoke"])
            data = json.loads(request.read_bytes())
            data["unexpected"] = "not allowed"
            request.write_bytes(job.json_bytes(data))
            with self.assertRaisesRegex(job.JobError, "INVALID_REQUEST_FIELDS"):
                job.parse_options(["--request", str(request)])
            del data["unexpected"]
            data["mode"] = []
            request.write_bytes(job.json_bytes(data))
            with self.assertRaisesRegex(job.JobError, "INVALID_MODE_OR_MARKET"):
                job.parse_options(["--request", str(request)])
            request.unlink()
            request.symlink_to("/etc/hosts")
            with self.assertRaisesRegex(job.JobError, "INVALID_REQUEST_FILE"):
                job.parse_options(["--request", str(request)])
        parsed = job.parse_options(["--catalog-sha", self.sha, "--source-manifest-sha", hashlib.sha256(job.json_bytes(self.manifest)).hexdigest(), "--mode", "smoke", "--market", "kr",
                                    "--start", "2017-01-03", "--through", "2026-09-11"])
        self.assertEqual(parsed.smoke_sessions, 20)
        self.assertIsNone(parsed.request_file)
        job.authorize_github_trigger(parsed, self.env)

    def test_us_hook_prepares_current_inputs_and_never_downloads_kr_sources(self):
        self.options.market = "us"
        calls = []
        def hook(storage, owner, manifest, workdir):
            self.assertEqual(owner, OWNER)
            self.assertEqual(manifest, self.manifest)
            workdir.mkdir(mode=0o700)
            files = {}
            for name in ["2016.csv", "2017.csv", "spy.csv", "master.csv", "sectors.zip"]:
                files[name] = workdir / name
                files[name].write_bytes(b"synthetic-private-input")
            calls.append(workdir)
            return {"canonical": [files["2016.csv"], files["2017.csv"]], "benchmark": files["spy.csv"],
                    "master": files["master.csv"], "sectorMap": files["sectors.zip"],
                    "provenance": {"hashStatus": "OBSERVED_AT_DOWNLOAD_NOT_PREPINNED", "synthetic": True}}
        self.us_input_hook = hook
        result = self.run_job()
        self.assertEqual(result["status"], "COMPLETE")
        self.assertEqual(result["market"], "us")
        self.assertEqual(len(calls), 1)
        prepare_command = self.commands.calls[0][0]
        self.assertTrue(prepare_command[1].endswith("prepare-adopted-us-backtest.py"))
        self.assertIn("--canonical", prepare_command)
        self.assertIn("--sector-map", prepare_command)
        self.assertNotIn("--source-manifest", prepare_command)
        self.assertTrue(any(url.endswith("/result/US_A0.daily-nav.jsonl") for _method, url, _kwargs in self.writes()))
        self.assertTrue(any(url.endswith("/result/input-provenance.json") for _method, url, _kwargs in self.writes()))
        for item in self.manifest["orderedFiles"]:
            self.assertFalse(any(item["storagePath"] in url for _method, url, _kwargs in self.session.calls))

    def test_us_hook_rejects_paths_outside_private_stage(self):
        self.options.market = "us"
        def hook(storage, owner, manifest, workdir):
            workdir.mkdir(mode=0o700)
            return {"canonical": [Path("/etc/hosts")], "benchmark": "/etc/hosts", "master": "/etc/hosts", "provenance": {}}
        self.us_input_hook = hook
        self.assertEqual(self.run_job()["code"], "US_HOOK_PATH_OUTSIDE_PRIVATE_STAGE")
        self.assertEqual(self.commands.calls, [])
        self.assertEqual(self.writes(), [])

    def test_observed_hash_download_is_bounded_allowlisted_and_explicit(self):
        storage = job.PrivateStorage(self.session, job.EXPECTED_SUPABASE_URL, OWNER, SECRET, self.sha, "12345-1")
        item = self.manifest["orderedFiles"][0]
        storage.input_keys.add(item["storagePath"])
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "observed"
            evidence = storage.download_observed(item["storagePath"], target, item["bytes"])
            self.assertEqual(evidence, {"bytes": item["bytes"], "sha256": item["sha256"], "hashStatus": "OBSERVED_AT_DOWNLOAD_NOT_PREPINNED"})
            target.unlink()
            with self.assertRaisesRegex(job.JobError, "PRIVATE_OBJECT_SIZE_MISMATCH"):
                storage.download_observed(item["storagePath"], target, item["bytes"] - 1)
            self.assertFalse(target.exists())
            with self.assertRaisesRegex(job.JobError, "STORAGE_PATH_OUTSIDE_JOB"):
                storage.download_observed(OWNER + "/research/cm/arbitrary", target, 3)


if __name__ == "__main__":
    unittest.main()
