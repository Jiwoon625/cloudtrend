"""Offline private-US staging tests: synthetic Parquet/CSV, fake HTTP only."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from urllib.parse import unquote

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


us = load("adopted_us_private", "adopted-us-private-inputs.py")
job = load("adopted_job_for_us", "run-adopted-backtest-job.py")
OWNER = "11111111-2222-3333-4444-555555555555"
SECRET = "FAKE_PRIVATE_SECRET"


class Response:
    def __init__(self, data, status=200, fail=False):
        self.data, self.status_code, self.fail, self.closed = data, status, fail, False

    def iter_content(self, chunk_size):
        for offset in range(0, len(self.data), 1024):
            yield self.data[offset:offset + 1024]
            if self.fail:
                raise RuntimeError(SECRET + " private data must not be logged")

    def close(self):
        self.closed = True


class ReadOnlySession:
    def __init__(self):
        self.objects, self.calls, self.responses = {}, [], []
        self.redirect, self.fail_key = False, None

    def request(self, method, url, **kwargs):
        assert method == "GET"
        marker = job.EXPECTED_SUPABASE_URL + "/storage/v1/object/authenticated/cloudtrend-data/"
        assert url.startswith(marker)
        assert kwargs["allow_redirects"] is False and kwargs["stream"] is True
        key = unquote(url[len(marker):])
        self.calls.append(key)
        response = Response(self.objects.get(key, b""), 302 if self.redirect else 200 if key in self.objects else 404,
                            key == self.fail_key)
        self.responses.append(response)
        return response

    def close(self):
        pass


def encoded(value):
    return json.dumps(value, sort_keys=True).encode()


def parquet(frame):
    stream = io.BytesIO()
    frame.to_parquet(stream, index=False)
    return stream.getvalue()


def evidence(raw):
    return {"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


class PrivateUsInputsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "us"
        self.session = ReadOnlySession()
        self.prefix = OWNER + "/research/us/v0/"
        self.manifests = {name: {"universeVersion": us.UNIVERSE_VERSION, "researchGrade": us.RESEARCH_GRADE,
                                "canonicalRows": 22, "finalOosAllowed": False} for name in us.MANIFEST_NAMES}
        self.manifests[us.MANIFEST_NAMES[0]].update(version="us1-price-backfill-v0.2-crash-safe", universeFrozen=True,
            adjusted=True, compactionStatus="COMPLETE", readyForUs2Exploratory=True, refinedUniverseRows=2,
            completedSymbols=2, remainingSymbols=0, failedSymbolsUnresolved=0, corruptShards=0)
        self.manifests[us.MANIFEST_NAMES[1]].update(version="us2-single-feature-v0", universeRows=2,
            canonicalMinDate=us.FIRST_DATE, canonicalMaxDate=us.LAST_DATE, canonicalQaPassed=True,
            benchmarkReady=True, featurePanelYearsDone=list(us.YEARS))
        self.manifests[us.MANIFEST_NAMES[2]].update(version="us2.1-long-horizon-v0", universeRows=2,
            targetsYearsDone=list(us.YEARS))
        self.raw = {name: encoded(value) for name, value in self.manifests.items()}
        self.canonicals, dates = {}, []
        for year in us.YEARS:
            day = us.LAST_DATE if year == 2026 else f"{year}-01-04"
            dates.append(day)
            frame = pd.DataFrame({"symbol": ["AAA", "NA"], "tradeDateUsEastern": [day] * 2,
                "open": [10., 20.], "high": [11., 21.], "low": [9., 19.], "close": [10., 20.],
                "volume": [1000, 0], "adjusted": [True] * 2, "universeVersion": [us.UNIVERSE_VERSION] * 2,
                "researchGrade": [us.RESEARCH_GRADE] * 2})
            self.canonicals[year] = frame
            self.raw[f"canonical/year={year}/us_stock_daily.parquet"] = parquet(frame)
        self.benchmark = pd.DataFrame({"dt": pd.to_datetime(dates), "spy_close": [100.] * len(dates),
                                       "spy_fwd252": [999.] * len(dates)})
        self.raw[us.BENCHMARK] = parquet(self.benchmark)
        self.raw[us.SECTOR_MAP] = ("symbol,sectorCode,mappingVersion\nAAA,TECH," + us.SECTOR_VERSION +
                                 "\nNA,FINANCE," + us.SECTOR_VERSION + "\n").encode()
        self.master = pd.DataFrame({"symbol": ["AAA", "NA"], "universeVersionV01": [us.UNIVERSE_VERSION] * 2,
            "researchGradeV01": [us.RESEARCH_GRADE] * 2, "pointInTimeSafe": [False] * 2,
            "historicalBacktestEligible": [False] * 2, "universeFrozenV01": [True] * 2,
            "isCommonShare": [True] * 2, "universeVersion": ["legacy-version"] * 2,
            "researchGrade": ["EXPLORATORY_ONLY"] * 2})
        self.master_bytes = parquet(self.master)
        self.master_evidence = evidence(self.master_bytes)
        self.master_path = OWNER + "/research/adopted-full-period/inputs/" + self.master_evidence["sha256"] + "/metadata/master.parquet"
        self.manifest = {"owner": OWNER, "bucket": "cloudtrend-data", "version": us.SOURCE_VERSION,
            "extraFiles": [{"sourceGroup": "US_METADATA", "sourcePath": "metadata/master.parquet",
                            "storagePath": self.master_path, **self.master_evidence}]}
        self.pins = {name: evidence(self.raw[name]) for name in us.PINNED}
        self.sizes = {year: len(self.raw[f"canonical/year={year}/us_stock_daily.parquet"]) for year in us.YEARS}
        patcher = mock.patch.multiple(us, PINNED=self.pins, MASTER=self.master_evidence,
                                     ANNUAL_BYTES=self.sizes, UNIVERSE_ROWS=2, CANONICAL_ROWS=22)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.session.objects.update({self.prefix + key: value for key, value in self.raw.items()})
        self.session.objects[self.master_path] = self.master_bytes
        self.storage = job.PrivateStorage(self.session, job.EXPECTED_SUPABASE_URL, OWNER, SECRET, "a" * 64, "123-1")

    def stage(self):
        return us.stage_us_private_inputs(self.storage, OWNER, self.manifest, self.root)

    def replace(self, name, raw):
        self.session.objects[self.prefix + name] = raw
        if name in self.pins:
            self.pins[name] = evidence(raw)
        elif name.startswith("canonical/"):
            self.sizes[int(name.split("year=")[1][:4])] = len(raw)

    def test_full_staging_exact_paths_hash_provenance_and_private_permissions(self):
        originals = dict(self.session.objects)
        result = self.stage()
        self.assertEqual(len(self.session.calls), 17)
        self.assertEqual(self.session.objects, originals)
        self.assertTrue(all(response.closed for response in self.session.responses))
        self.assertEqual([p.parent.name for p in result["canonical"]], [f"year={y}" for y in us.YEARS])
        self.assertTrue(all(path.stat().st_mode & 0o777 == 0o600 for path in self.root.rglob("*") if path.is_file()))
        self.assertEqual(self.root.stat().st_mode & 0o777, 0o700)
        provenance = result["provenance"]
        self.assertEqual(provenance["canonicalRows"], 22)
        self.assertEqual(provenance["researchGrade"], "SURVIVOR_ONLY_EXPLORATORY")
        for key in ["pointInTimeSafe", "historicalBacktestEligible", "finalOosAllowed"]:
            self.assertIs(provenance[key], False)
        observed = [item for item in provenance["files"] if item["hashStatus"] == "OBSERVED_AT_DOWNLOAD_NOT_PREPINNED"]
        self.assertEqual(len(observed), 10)
        for row in observed:
            self.assertEqual(row["sha256"], evidence(self.raw[row["sourcePath"]])["sha256"])
        for forbidden in [SECRET, OWNER, "spy_fwd252", "driveFileId"]:
            self.assertNotIn(forbidden, json.dumps(provenance))
        self.assertFalse(any("stock_history" in key or "/cm/" in key for key in self.session.calls))

    def test_master_entry_rejects_missing_ambiguous_tampered_or_cross_owner_inputs_before_http(self):
        for extras in [[], self.manifest["extraFiles"] * 2,
                       [{**self.manifest["extraFiles"][0], "storagePath": "other/research/master.parquet"}],
                       [{**self.manifest["extraFiles"][0], "sourcePath": "metadata/../master.parquet"}],
                       [{**self.manifest["extraFiles"][0], "sha256": "0" * 64}]]:
            with self.subTest(extras=extras), mock.patch.dict(self.manifest, extraFiles=extras):
                with self.assertRaises(us.UsInputError):
                    self.stage()
        with self.assertRaisesRegex(us.UsInputError, "OWNER"):
            us.stage_us_private_inputs(self.storage, "../../other", self.manifest, self.root)
        self.assertEqual(self.session.calls, [])

    def test_nonempty_or_symlink_workspace_is_rejected(self):
        self.root.mkdir()
        with self.assertRaisesRegex(us.UsInputError, "WORKSPACE"):
            self.stage()
        self.root.rmdir()
        self.root.symlink_to(Path(self.temp.name) / "elsewhere", target_is_directory=True)
        with self.assertRaisesRegex(us.UsInputError, "WORKSPACE"):
            self.stage()
        self.assertEqual(self.session.calls, [])

    def test_source_policy_and_completion_metadata_are_required(self):
        changes = [(0, "adjusted", False), (0, "compactionStatus", "PARTIAL"), (0, "remainingSymbols", 1),
                   (0, "researchGrade", "FINAL_OOS"), (1, "canonicalMaxDate", "2026-10-01"),
                   (1, "canonicalQaPassed", False), (1, "universeVersion", "wrong"),
                   (2, "finalOosAllowed", True), (2, "canonicalRows", 21)]
        for index, field, value in changes:
            copied = json.loads(json.dumps(self.manifests))
            copied[us.MANIFEST_NAMES[index]][field] = value
            with self.subTest(field=field), self.assertRaises(us.UsInputError):
                us.validate_source_manifests(copied)

    def test_invalid_manifest_stops_before_prices_or_master_download(self):
        source = dict(self.manifests[us.MANIFEST_NAMES[0]], adjusted=False)
        self.replace(us.MANIFEST_NAMES[0], encoded(source))
        with self.assertRaisesRegex(us.UsInputError, "BACKFILL"):
            self.stage()
        self.assertEqual(set(self.session.calls), {self.prefix + name for name in us.MANIFEST_NAMES})

    def test_master_refined_metadata_does_not_accept_legacy_or_falsy_strings(self):
        path = Path(self.temp.name) / "master.parquet"
        for field, values in [("universeVersionV01", ["legacy-version"] * 2),
                              ("pointInTimeSafe", ["false"] * 2), ("historicalBacktestEligible", [True] * 2),
                              ("researchGradeV01", ["EXPLORATORY_ONLY"] * 2), ("symbol", ["AAA"] * 2)]:
            frame = self.master.copy()
            frame[field] = values
            path.write_bytes(parquet(frame))
            with self.subTest(field=field), self.assertRaises(us.UsInputError):
                us.validate_master(path)

    def test_canonical_rejects_metadata_range_duplicate_universe_and_session_changes(self):
        path = Path(self.temp.name) / "canonical.parquet"
        base = self.canonicals[2017]
        modifications = [base.assign(adjusted=False), base.assign(adjusted="true"),
                         base.assign(universeVersion="wrong"), base.assign(researchGrade="FINAL_OOS"),
                         base.assign(tradeDateUsEastern="2016-01-04"),
                         base.assign(tradeDateUsEastern="2017-01-05"), base.assign(symbol="OUTSIDE"),
                         pd.concat([base, base.iloc[:1]], ignore_index=True), base.assign(close=float("inf"))]
        for frame in modifications:
            path.write_bytes(parquet(frame))
            with self.subTest(columns=frame.to_dict()), self.assertRaises(us.UsInputError):
                us.validate_canonical(path, 2017, {"AAA", "NA"}, {"2017-01-04"})

    def test_sector_requires_exact_matching_unique_universe_and_mapping(self):
        path = Path(self.temp.name) / "sector.csv"
        for raw in ["symbol,sectorCode,mappingVersion\nAAA,TECH,wrong\nNA,TECH,wrong\n",
                    "symbol,sectorCode,mappingVersion\nAAA,TECH,v1\nAAA,TECH,v1\n"]:
            path.write_text(raw)
            with self.assertRaises(us.UsInputError):
                us.validate_sector_map(path, {"AAA", "NA"})

    def test_benchmark_duplicate_missing_or_nonpositive_prices_rejected(self):
        path = Path(self.temp.name) / "benchmark.parquet"
        for frame in [pd.concat([self.benchmark, self.benchmark.iloc[:1]], ignore_index=True),
                      self.benchmark.iloc[:-1], self.benchmark.assign(spy_close=0.)]:
            path.write_bytes(parquet(frame))
            with self.assertRaises(us.UsInputError):
                us.validate_benchmark(path)

    def test_pinned_hash_mismatch_and_redirect_are_closed_and_not_retried(self):
        key = self.prefix + us.MANIFEST_NAMES[0]
        self.session.objects[key] = b"x" * len(self.session.objects[key])
        with self.assertRaisesRegex(job.JobError, "HASH_MISMATCH"):
            self.stage()
        self.assertEqual(len(self.session.calls), 1)
        self.assertFalse((self.root / us.MANIFEST_NAMES[0]).exists())
        self.assertTrue(self.session.responses[0].closed)
        with tempfile.TemporaryDirectory() as other:
            self.session.redirect = True
            with self.assertRaisesRegex(job.JobError, "READ_FAILED"):
                us.stage_us_private_inputs(self.storage, OWNER, self.manifest, Path(other) / "us")
        self.assertEqual(len(self.session.calls), 2)

    def test_unpinned_year_has_exact_size_bound_and_partial_cleanup(self):
        name = "canonical/year=2017/us_stock_daily.parquet"
        self.session.objects[self.prefix + name] += b"unexpected"
        with self.assertRaisesRegex(job.JobError, "SIZE_MISMATCH"):
            self.stage()
        self.assertFalse((self.root / name).exists())
        self.assertTrue(self.session.responses[-1].closed)
        self.assertEqual(self.session.calls[-1], self.prefix + name)

    def test_stream_failure_is_sanitized_and_partial_file_removed(self):
        name = "canonical/year=2017/us_stock_daily.parquet"
        self.session.fail_key = self.prefix + name
        with self.assertRaisesRegex(job.JobError, "^NETWORK_OR_SESSION_ERROR$"):
            self.stage()
        self.assertFalse((self.root / name).exists())
        self.assertTrue(self.session.responses[-1].closed)

    def test_total_row_count_disagreement_stops(self):
        name = "canonical/year=2017/us_stock_daily.parquet"
        self.replace(name, parquet(self.canonicals[2017].iloc[:1]))
        with self.assertRaisesRegex(us.UsInputError, "CANONICAL_COUNT_MISMATCH"):
            self.stage()


if __name__ == "__main__":
    unittest.main()
