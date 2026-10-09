"""Run: PYTHONPATH=<pyarrow installation> python -m unittest discover -s tests -p test_adopted_kr_etf_input.py

All fixtures are local and temporary. No network, publication, or large backtest.
"""
import csv
from decimal import Decimal
import gzip
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

import pyarrow as pa
import pyarrow.parquet as pq


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("kr_etf_inputs", ROOT / "scripts/prepare-adopted-kr-etf-inputs.py")
prep = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prep)


class AdoptedKrEtfInputTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.raw = self.root / "raw"
        self.raw.mkdir()
        self.manifest = self.root / "source-manifest.json"

    def manifest_for(self, sources):
        entries = []
        for index, (relative, table) in enumerate(sources, 1):
            path = self.raw / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            pq.write_table(table, path, row_group_size=2)
            entries.append({"order": index, "sourceGroup": "ETF" if relative.startswith("sources/") else "STOCK_KR",
                            "sourcePath": relative, "bytes": path.stat().st_size,
                            "sha256": prep.sha256_file(path).removeprefix("sha256:")})
        manifest = {"version": prep.SOURCE_VERSION, "orderedFiles": entries}
        self.manifest.write_text(json.dumps(manifest), encoding="utf-8")
        return manifest

    def prepare(self, output="prepared", **kwargs):
        return prep.prepare(self.manifest, self.raw, self.root / output, **kwargs)

    def read_csv(self, manifest, file_index=0, output="prepared"):
        with gzip.open(self.root / output / manifest["files"][file_index]["path"], "rt", encoding="utf-8", newline="") as stream:
            return list(csv.reader(stream))

    def basic(self):
        return pa.table({"symbol": ["005930"], "date": ["2026-09-11"], "market": ["KOSPI"], "close": ["0"]})

    def extension_for(self, rows=None, names=None, **overrides):
        names = names or ["symbol", "date", "market", "securityType", "close", "notes"]
        if rows is None:
            rows = [[symbol, day, market, kind, close, '한글, "quote"\r\nnext line  ']
                    for day in ("2026-09-12", "2026-09-14")
                    for symbol, market, kind, close in (("KOSPI", "INDEX", "INDEX", "100.000"),
                                                        ("005930", "KOSPI", "STOCK", "-0.0"),
                                                        ("KOSDAQ", "INDEX", "INDEX", ""))]
        source = self.root / "extension.csv"
        with source.open("w", encoding="utf-8", newline="") as stream:
            writer = csv.writer(stream, lineterminator="\r\n")
            writer.writerow(names)
            writer.writerows(rows)
        contract = {"version": prep.EXTENSION_VERSION, "localPath": str(source),
                    "bytes": source.stat().st_size, "sha256": prep.sha256_file(source),
                    "afterDate": "2026-09-11", "throughDate": "2026-09-14",
                    "evidence": {"verification": "Synthetic private-source equivalence fixture"}, **overrides}
        path = self.root / "extension-manifest.json"
        path.write_text(json.dumps(contract, ensure_ascii=False), encoding="utf-8")
        return path, contract, names, rows

    def test_extension_preserves_base_and_selected_cells_header_order_and_real_sessions(self):
        self.manifest_for([("stock_history/base.parquet", self.basic()),
                           ("sources/etf.parquet", pa.table({"symbol": ["0193T0"], "date": ["2026-09-30"],
                                                            "market": ["KOSPI"], "securityType": ["ETF"], "close": ["9"]}))])
        base = self.prepare("base")
        extension, contract, names, selected = self.extension_for(names=["\ufeffsymbol", "date", "market", "securityType", "close", "notes"])
        omitted = [["005930", "2026-09-11", "KOSPI", "STOCK", "999", "cutoff"],
                   ["KOSPI", "2026-09-10", "INDEX", "INDEX", "999", "older"],
                   ["0193T0", "2026-09-13", "KOSPI", "ETF", "999", "ETF-only date"],
                   ["KOSPI", "2026-09-14", "INDEX", "ETF", "999", "ETF despite index symbol"],
                   ["005930", "2026-09-16", "KOSPI", "STOCK", "999", "later"],
                   ["SPY", "2026-09-14", "NYSE", "STOCK", "999", "foreign"],
                   ["^GSPC", "2026-09-14", "INDEX", "INDEX", "999", "other index"],
                   ["OTHER", "2026-09-14", "KOSPI", "OTHER", "999", "other type"]]
        # Interleave selected and omitted records so order preservation is tested.
        all_rows = [omitted[0], selected[0], omitted[1], *selected[1:4], *omitted[2:], *selected[4:]]
        extension, contract, names, _ = self.extension_for(all_rows, names)
        before = {path: path.read_bytes() for path in [self.manifest, extension, self.root / "extension.csv", *self.raw.rglob("*.parquet")]}
        result = self.prepare(extension_manifest=extension, through="2026-09-14")
        self.assertEqual(result["files"][:2], base["files"])
        self.assertEqual(result["sourceManifestFingerprint"], base["sourceManifestFingerprint"])
        for item in base["files"]:
            self.assertEqual((self.root / "prepared" / item["path"]).read_bytes(), (self.root / "base" / item["path"]).read_bytes())
        self.assertEqual(self.read_csv(result, 2), [names, *selected])
        self.assertEqual(result["sessions"], ["2026-09-11", "2026-09-12", "2026-09-14"])
        self.assertEqual(result["calendarEvidenceRows"], {"KR_INDEX": 4, "KR_STOCK": 3})
        self.assertFalse(result["allRawRowsRetained"])
        self.assertTrue(result["allBaseRawRowsRetained"])
        self.assertEqual(result["sourceFileCount"], 3)
        self.assertEqual(result["baseSourceFileCount"], 2)
        info = result["extension"]
        self.assertEqual(info["source"], contract)
        self.assertEqual(info["rows"], 6)
        self.assertEqual(info["sourceTotalRows"], 14)
        self.assertEqual(info["omittedRows"], 8)
        self.assertEqual(info["omittedRowsByReason"], {"ETF": 2, "AT_OR_BEFORE_CUTOFF": 2, "AFTER_THROUGH": 1,
                                                     "OTHER_TYPE": 1, "NON_KOREAN_STOCK": 1, "OTHER_INDEX": 1})
        self.assertEqual(info["sourceFirstDate"], "2026-09-10")
        self.assertEqual(info["sourceLastDate"], "2026-09-16")
        self.assertEqual(info["selectedRowsByType"], {"INDEX": 4, "STOCK": 2})
        self.assertEqual(info["selectedKoreanSessions"], {key: ["2026-09-12", "2026-09-14"] for key in ("KOSPI", "KOSDAQ", "KR_STOCK")})
        self.assertTrue(info["utf8BomRetained"])
        self.assertEqual(info["originalHeader"], names)
        continuity = info["continuityEvidence"]
        self.assertEqual(continuity["rows"], 2)
        self.assertFalse(continuity["includedInReplayFiles"])
        self.assertEqual(continuity["comparisonStatus"], "EVIDENCE_ONLY_NOT_YET_COMPARED_TO_BASE")
        self.assertEqual(continuity["afterDate"], "2026-09-11")
        with gzip.open(self.root / "prepared" / continuity["files"][0]["path"], "rt", encoding="utf-8", newline="") as stream:
            self.assertEqual(list(csv.reader(stream)), [names, omitted[0], omitted[1]])
        self.assertTrue(set(item["path"] for item in continuity["files"]).isdisjoint(item["path"] for item in result["files"]))
        for item in result["files"]:
            output = self.root / "prepared" / item["path"]
            self.assertEqual(prep.sha256_file(output), item["sha256"])
            self.assertEqual(output.stat().st_size, item["bytes"])
        self.assertEqual((self.root / "prepared/extension-manifest.json").read_bytes(), before[extension])
        self.assertEqual((self.root / "prepared/source-manifest.json").read_bytes(), before[self.manifest])
        self.assertEqual(before, {path: path.read_bytes() for path in before})

    def test_extension_chunks_only_between_selected_complete_records(self):
        self.manifest_for([("stock_history/base.parquet", self.basic())])
        extension, _, names, rows = self.extension_for()
        with mock.patch.object(prep, "MAX_PREPARED_CHARS", 120):
            result = self.prepare(extension_manifest=extension)
        appended = result["files"][1:]
        self.assertGreater(len(appended), 1)
        actual = []
        for index, item in enumerate(appended, 1):
            records = self.read_csv(result, index)
            self.assertEqual(records[0], names)
            self.assertEqual(item["sourcePart"], index)
            self.assertEqual(item["sourcePartCount"], len(appended))
            actual.extend(records[1:])
        self.assertEqual(actual, rows)

    def test_extension_continuity_evidence_is_bounded_hashed_and_excluded_from_replay(self):
        self.manifest_for([("stock_history/base.parquet", self.basic())])
        _, _, names, selected = self.extension_for()
        overlap = [[f"{100+i:06d}", "2026-09-11", "KOSPI", "STOCK", str(i), 'quoted, "data"\nline'] for i in range(8)]
        excluded = [["SPY", "2026-09-10", "NYSE", "STOCK", "500", "foreign"],
                    ["0193T0", "2026-09-10", "KOSPI", "ETF", "999", "ETF"]]
        extension, _, _, _ = self.extension_for([*overlap[:4], *selected, *excluded, *overlap[4:]], names)
        with mock.patch.object(prep, "MAX_PREPARED_CHARS", 120):
            result = self.prepare(extension_manifest=extension)
        continuity = result["extension"]["continuityEvidence"]
        self.assertEqual(continuity["rows"], 8)
        self.assertEqual(continuity["rowsByType"], {"STOCK": 8})
        self.assertGreater(len(continuity["files"]), 1)
        actual = []
        replay_paths = {item["path"] for item in result["files"]}
        for index, item in enumerate(continuity["files"], 1):
            self.assertNotIn(item["path"], replay_paths)
            self.assertEqual(item["sourcePart"], index)
            path = self.root / "prepared" / item["path"]
            self.assertEqual(item["sha256"], prep.sha256_file(path))
            self.assertEqual(item["bytes"], path.stat().st_size)
            with gzip.open(path, "rt", encoding="utf-8", newline="") as stream:
                records = list(csv.reader(stream))
            self.assertEqual(records[0], names)
            self.assertEqual(len(records)-1, item["rows"])
            actual.extend(records[1:])
        self.assertEqual(actual, overlap)
        self.assertEqual(sum(item["rows"] for item in result["files"]), 1+len(selected))

    def test_extension_pin_preflight_and_post_read_mutation_fail_closed(self):
        self.manifest_for([("stock_history/base.parquet", self.basic())])
        for override, message in [({"sha256": "0"*64}, "SHA-256"), ({"bytes": 1}, "byte count")]:
            extension, _, _, _ = self.extension_for(**override)
            original = (self.root / "extension.csv").read_bytes()
            with self.assertRaisesRegex(ValueError, message):
                self.prepare(extension_manifest=extension)
            self.assertFalse((self.root / "prepared").exists())
            self.assertEqual((self.root / "extension.csv").read_bytes(), original)
        extension, _, _, _ = self.extension_for()
        source = self.root / "extension.csv"
        original_reader = csv.reader
        def mutate_after_read(*args, **kwargs):
            yield from original_reader(*args, **kwargs)
            source.write_bytes(source.read_bytes().replace(b"100.000", b"999.000", 1))
        with mock.patch.object(prep.csv, "reader", side_effect=mutate_after_read):
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                self.prepare(extension_manifest=extension)
        self.assertFalse((self.root / "prepared").exists())

    def test_extension_schema_bounds_and_selected_identity_fail_closed(self):
        self.manifest_for([("stock_history/base.parquet", self.basic())])
        _, _, names, rows = self.extension_for()
        cases = [
            (names + ["type"], [row+[row[3]] for row in rows], {}, "Ambiguous"),
            (names[:-1], rows, {}, "width mismatch"),
            (names, [[*rows[0][:1], "2026-09-14-extra", *rows[0][2:]], *rows[1:]], {}, "ISO dates"),
            (names, rows, {"afterDate": "2026-09-10"}, "last base"),
            (names, rows, {"throughDate": "2026-09-15"}, "actually selected"),
            (names, rows[:-1], {}, "sessions disagree"),
            (names, rows+[rows[1]], {}, "Duplicate selected"),
            (names, rows+[[*rows[1][:4], "999", "different duplicate"]], {}, "Duplicate selected"),
            (names, rows+[["005930", "2026-09-11", "KOSPI", "STOCK", "1", ""]]*2, {}, "Duplicate continuity"),
            (names, [rows[0], ["1.88E+02", *rows[1][1:]], *rows[2:]], {}, "stock identity"),
            (names, [["KOSPI", "2026-09-12", "KOSDAQ", "INDEX", "1", ""], *rows[1:]], {}, "index identity"),
            (names, rows, {"afterDate": "2026-09-14"}, "strictly increasing"),
            (names, rows, {"throughDate": "2026-09-31"}, "date bounds"),
            (names, rows, {"evidence": {}}, "evidence"),
        ]
        for header, records, overrides, error in cases:
            with self.subTest(error=error, overrides=overrides):
                extension, _, _, _ = self.extension_for(records, header, **overrides)
                with self.assertRaisesRegex(ValueError, error):
                    self.prepare(extension_manifest=extension)
                self.assertFalse((self.root / "prepared").exists())

    def test_extension_cli_matches_python_interface(self):
        self.manifest_for([("stock_history/base.parquet", self.basic())])
        extension, _, _, _ = self.extension_for()
        command = ["python", str(ROOT / "scripts/prepare-adopted-kr-etf-inputs.py"),
                   "--source-manifest", str(self.manifest), "--staged-root", str(self.raw),
                   "--output", str(self.root / "prepared"), "--extension-manifest", str(extension), "--through", "2026-09-14"]
        result = subprocess.run(command, text=True, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        manifest = json.loads((self.root / "prepared/manifest.json").read_text())
        self.assertEqual(manifest["extension"]["rows"], 6)
        self.assertEqual(json.loads(result.stdout)["lastDate"], "2026-09-14")

    def test_extension_existing_parser_preserves_earlier_stock_and_all_etf_bars(self):
        bundler = ROOT / "node_modules/esbuild/lib/main.js"
        if not shutil.which("node") or not bundler.exists():
            self.skipTest("Existing esbuild dependency is not installed")
        table = pa.table({"symbol": ["005930", "KOSPI", "KOSDAQ", "0193T0"],
                          "date": ["2026-09-11"]*3+["2026-09-30"],
                          "market": ["KOSPI", "INDEX", "INDEX", "KOSPI"],
                          "securityType": ["STOCK", "INDEX", "INDEX", "ETF"],
                          "close": ["10", "100", "50", "9"]})
        self.manifest_for([("stock_history/base.parquet", table)])
        _, _, names, rows = self.extension_for()
        extension, _, _, _ = self.extension_for(rows + [
            ["005930", "2026-09-11", "KOSPI", "STOCK", "999", "must not overwrite"],
            ["0193T0", "2026-09-30", "KOSPI", "ETF", "999", "must not overwrite"],
            ["0193T0", "2026-09-14", "KOSPI", "ETF", "999", "must not add"],
        ], names)
        manifest = self.prepare(extension_manifest=extension)
        files = [str(self.root / "prepared" / item["path"]) for item in manifest["files"]]
        check = self.root / "extension-parser-check.ts"
        check.write_text(f'''import {{ readFileSync }} from "node:fs";
import {{ gunzipSync }} from "node:zlib";
import assert from "node:assert/strict";
import {{ parseManualMarketData }} from {json.dumps(str(ROOT / "src/lib/engine/manualDataset.ts"))};
const files = {json.dumps(files)};
const dataset = parseManualMarketData(files.map(p => gunzipSync(readFileSync(p)).toString("utf8")), {{allowIncompleteIndex: true}}).dataset;
const stocks = dataset.observedBars!["005930"];
assert.equal(stocks.length, 3);
assert.equal(stocks[0].tradeDate, "2026-09-11");
assert.equal(stocks[0].close, 10);
assert.deepEqual(stocks.map(bar => bar.tradeDate), ["2026-09-11", "2026-09-12", "2026-09-14"]);
assert.equal(stocks[1].close, -0);
assert.equal(dataset.observedBars!["0193T0"].length, 1);
assert.equal(dataset.observedBars!["0193T0"][0].tradeDate, "2026-09-30");
assert.equal(dataset.observedBars!["0193T0"][0].close, 9);
console.log("EXTENSION_PARSER_PASS");
''')
        bundle = self.root / "extension-parser-check.mjs"
        compiled = subprocess.run(["node", "-e", 'require("esbuild").buildSync({entryPoints:[process.argv[1]],outfile:process.argv[2],bundle:true,platform:"node",format:"esm",target:"node20",ignoreAnnotations:true})', str(check), str(bundle)], cwd=ROOT, text=True, capture_output=True, timeout=30)
        self.assertEqual(compiled.returncode, 0, compiled.stdout + compiled.stderr)
        parsed = subprocess.run(["node", str(bundle)], cwd=ROOT, text=True, capture_output=True, timeout=30)
        self.assertEqual(parsed.returncode, 0, parsed.stdout + parsed.stderr)
        self.assertIn("EXTENSION_PARSER_PASS", parsed.stdout)

    def test_exact_string_fields_order_duplicates_nulls_and_deterministic_gzip(self):
        source = pa.table({
            "symbol": ["005930", "005930", "KOSPI"],
            "date": ["2026-09-14T15:30:00+09:00", "2026-09-14T15:30:00+09:00", "2026-09-11"],
            "market": ["KOSPI", "KOSPI", "KOSPI"], "type": ["STOCK", "STOCK", "INDEX"],
            "close": ["12345678901234567890.001", "", "0.0"], "volume": ["0", None, ""],
            "foreignNetBuyValue": ["-0.0", "1.00000000000000000001", "NA"],
            "rawScore": ["98.12345678901234567890", "null", "0"],
            "notes": ['한글, "따옴표"\n다음 줄', "  preserve whitespace  ", ""],
        })
        older = pa.table({"symbol": ["000100"], "date": ["2016-08-12"], "market": ["코스닥"], "close": ["1"]})
        original = self.manifest_for([("stock_history/z-first.parquet", source), ("stock_history/a-later.parquet", older)])
        first = self.prepare(batch_size=1)
        second = self.prepare("other", batch_size=3)
        for manifest in (first, second):
            self.assertGreater(manifest["preparationMetrics"]["maxRssKiB"], 0)
            self.assertGreaterEqual(manifest["preparationMetrics"]["elapsedSeconds"], 0)
        self.assertEqual({k:v for k,v in first.items() if k != "preparationMetrics"},
                         {k:v for k,v in second.items() if k != "preparationMetrics"})
        self.assertEqual(first["sessions"], ["2016-08-12", "2026-09-11", "2026-09-14"])
        self.assertEqual(first["throughDate"], "2026-09-11")
        self.assertEqual(first["rows"], 4)
        self.assertEqual([f["source"]["sourcePath"] for f in first["files"]], [e["sourcePath"] for e in original["orderedFiles"]])
        rows = self.read_csv(first)
        self.assertEqual(rows[0], source.column_names)
        self.assertEqual(rows[1:], [["" if value is None else value for value in row.values()] for row in source.to_pylist()])
        self.assertEqual(first["files"][0]["columns"][5]["nulls"], 1)
        for item in first["files"]:
            path = self.root / "prepared" / item["path"]
            self.assertEqual(item["sha256"], prep.sha256_file(path))
            self.assertEqual(item["bytes"], path.stat().st_size)
        self.assertEqual((self.root / "prepared/source-manifest.json").read_bytes(), self.manifest.read_bytes())
        self.assertEqual(first["sourceManifestFingerprint"], prep.sha256_file(self.manifest))
        self.assertEqual(json.loads((self.root / "prepared/manifest.json").read_text()), first)

    def test_chunks_between_complete_rows_and_preserves_original_order(self):
        source = pa.table({"symbol": ["005930"]*8, "date": ["2026-09-11"]*8,
                           "market": ["KOSPI"]*8, "close": [str(i) for i in range(8)],
                           "notes": ['한글, "quoted"\nsecond line ' + str(i) for i in range(8)]})
        self.manifest_for([("stock_history/chunked.parquet", source)])
        with mock.patch.object(prep, "MAX_PREPARED_CHARS", 100):
            result = self.prepare()
        self.assertEqual(result["sourceFileCount"], 1)
        self.assertGreater(result["preparedFileCount"], 1)
        self.assertEqual(sum(item["rows"] for item in result["files"]), 8)
        collected = []
        for index, item in enumerate(result["files"]):
            rows = self.read_csv(result, index)
            self.assertEqual(rows[0], source.column_names)
            self.assertEqual(item["sourcePart"], index+1)
            collected.extend(rows[1:])
        self.assertEqual(collected, [[value for value in row.values()] for row in source.to_pylist()])

    def test_typed_numeric_timestamp_precision_and_signed_zero(self):
        table = pa.table({
            "symbol": ["005930", "000001"], "date": ["2026-09-10", "2026-09-11"], "market": ["KOSPI", "KOSDAQ"],
            "close": pa.array([Decimal("12345678901234567890.123456789"), Decimal("0.000000000")], type=pa.decimal128(38, 9)),
            "volume": pa.array([0, 9223372036854775807], type=pa.int64()),
            "extraFloat": [-0.0, 0.10000000000000002], "bool": [True, False],
            "timestamp": pa.array([1234567891, None], type=pa.timestamp("ns", tz="Asia/Seoul")),
        })
        self.manifest_for([("stock_history/typed.parquet", table)])
        manifest = self.prepare()
        rows = self.read_csv(manifest)
        self.assertEqual(rows[1][3:], ["12345678901234567890.123456789", "0", "-0.0", "true", "1970-01-01 09:00:01.234567891+09:00"])
        self.assertEqual(rows[2][3:], ["0E-9", "9223372036854775807", "0.10000000000000002", "false", ""])

    def test_symbol_audit_preserves_raw_identifiers_without_changing_scope(self):
        table = pa.table({"symbol": ["12345.0", "0193T0", "SPY", "SPY", "^GSPC", "ABC"],
                          "date": ["2020-01-02"]*6, "market": ["ETF"]*4+["INDEX", "KOSPI"],
                          "type": ["ETF"]*4+["INDEX", "STOCK"], "close": [100]*6})
        self.manifest_for([("sources/audit.parquet", table)])
        raw = (self.raw / "sources/audit.parquet").read_bytes()
        result = prep.inspect_symbols(self.manifest, self.raw, self.root / "audit.json")
        self.assertEqual(result["status"], "INPUT_CLASSIFICATION_ONLY")
        self.assertEqual(result["invalid"], [{"rawSymbol": "SPY", "normalizedSymbol": "SPY", "market": "ETF", "type": "ETF", "rows": 2, "sourceOrders": [1]}])
        self.assertEqual((self.raw / "sources/audit.parquet").read_bytes(), raw)

    def test_pinned_identity_recovery_preserves_every_original_cell(self):
        table = pa.table({"symbol": ["1.88E+02", "1.88E+02", "KOSPI"], "name": ["Synthetic ETF"]*2+["Other"],
                          "market": ["KOSPI", "KOSPI", "INDEX"], "securityType": ["ETF", "ETF", "INDEX"],
                          "date": ["2020-01-02", "2020-01-03", "2020-01-03"], "close": [100, 101, 102]})
        self.manifest_for([("stock_history/identity.parquet", table)])
        item = json.loads(self.manifest.read_text())["orderedFiles"][0]
        repair = {"sourceSha256": item["sha256"], "canonicalSymbol": "0188E0", "name": "Synthetic ETF",
                  "firstDate": "2020-01-02", "lastDate": "2020-01-03", "expectedRows": 2,
                  "issuerEvidence": "https://example.test/synthetic"}
        with mock.patch.object(prep, "VERIFIED_SYMBOL_REPAIR", repair):
            result = self.prepare()
        rows = self.read_csv(result)
        self.assertEqual(rows[0], table.schema.names+["code"])
        self.assertEqual([r[:-1] for r in rows[1:]], [[str(v) for v in row.values()] for row in table.to_pylist()])
        self.assertEqual([r[-1] for r in rows[1:]], ["0188E0", "0188E0", "KOSPI"])
        self.assertEqual(result["files"][0]["symbolIdentityRepairs"][0]["affectedRows"], 2)
        with mock.patch.object(prep, "VERIFIED_SYMBOL_REPAIR", {**repair, "name": "Wrong"}):
            with self.assertRaisesRegex(ValueError, "identity mismatch"):
                self.prepare("bad")
        with mock.patch.object(prep, "VERIFIED_SYMBOL_REPAIR", {**repair, "expectedRows": 3}):
            with self.assertRaisesRegex(ValueError, "row count"):
                self.prepare("bad-count")

    def test_calendar_uses_observed_kr_rows_even_without_prices(self):
        table = pa.table({
            "종목코드": ["KOSPI", "KOSDAQ", "005930", "000660", "SPY", "0193T0", "VKOSPI", "", "ABC"],
            "일자": ["2026-09-11", "20260912", "2026-09-14 00:01:00+09:00", "2026-09-16", "2026-09-15", "2026-09-17", "2026-09-18", "2026-09-19", "bad-date"],
            "시장": ["INDEX", "INDEX", "코스피", "KOSDAQ", "NYSE", "KOSPI", "KOSPI", "KOSPI", "KOSPI"],
            "security_type": ["INDEX", "INDEX", "STOCK", "", "ETF", "ETF", "INDEX", "STOCK", "STOCK"],
            "close": [None] * 9,
        })
        self.manifest_for([("stock_history/calendar.parquet", table)])
        manifest = self.prepare()
        # 09-12 is a Saturday: retained because it is observed source evidence,
        # not silently corrected. No calendar weekday/holiday guesses.
        self.assertEqual(manifest["sessions"], ["2026-09-11", "2026-09-12", "2026-09-14", "2026-09-16"])
        self.assertEqual(manifest["calendarEvidenceRows"], {"KR_INDEX": 2, "KR_STOCK": 2})
        self.assertEqual(manifest["files"][0]["missingOrInvalidDateRows"], 1)

    def test_hash_and_byte_failures_do_not_create_output_or_mutate_source(self):
        manifest = self.manifest_for([("stock_history/source.parquet", self.basic())])
        original = (self.raw / "stock_history/source.parquet").read_bytes()
        for key, value, message in [("sha256", "0" * 64, "SHA-256"), ("bytes", len(original) + 1, "byte count")]:
            bad = json.loads(json.dumps(manifest))
            bad["orderedFiles"][0][key] = value
            self.manifest.write_text(json.dumps(bad))
            with self.assertRaisesRegex(ValueError, message):
                self.prepare()
            self.assertFalse((self.root / "prepared").exists())
            self.assertEqual((self.raw / "stock_history/source.parquet").read_bytes(), original)

    def test_order_paths_group_and_existing_output_fail_closed(self):
        valid = self.manifest_for([("stock_history/source.parquet", self.basic())])
        for field, value in [("order", 2), ("sourcePath", "../escape.parquet"), ("sourcePath", "/tmp/x.parquet"), ("sourceGroup", "CM"), ("bytes", True)]:
            bad = json.loads(json.dumps(valid))
            bad["orderedFiles"][0][field] = value
            self.manifest.write_text(json.dumps(bad))
            with self.assertRaises(ValueError):
                self.prepare()
            self.assertFalse((self.root / "prepared").exists())
        self.manifest.write_text(json.dumps(valid))
        output = self.root / "prepared"
        output.mkdir()
        (output / "keep.txt").write_text("unchanged")
        with self.assertRaisesRegex(ValueError, "fresh"):
            self.prepare()
        self.assertEqual((output / "keep.txt").read_text(), "unchanged")

    def test_mid_conversion_failure_cleans_only_new_output(self):
        self.manifest_for([("stock_history/source.parquet", self.basic())])
        before = {p: p.read_bytes() for p in self.raw.rglob("*.parquet")}
        with mock.patch.object(prep, "convert_file", side_effect=ValueError("decode failed")):
            with self.assertRaisesRegex(ValueError, "decode failed"):
                self.prepare()
        self.assertFalse((self.root / "prepared").exists())
        self.assertEqual(before, {p: p.read_bytes() for p in before})

    def test_unsupported_nested_field_fails_without_lossy_export(self):
        table = self.basic().append_column("nested", pa.array([[1, 2]]))
        self.manifest_for([("stock_history/nested.parquet", table)])
        with self.assertRaisesRegex(ValueError, "Unsupported lossless CSV type"):
            self.prepare()
        self.assertFalse((self.root / "prepared").exists())

    def test_only_etf_dates_cannot_invent_korean_calendar(self):
        table = pa.table({"symbol": ["SPY"], "date": ["2026-09-11"], "type": ["ETF"], "market": ["NYSE"], "close": ["1"]})
        self.manifest_for([("sources/etf.parquet", table)])
        with self.assertRaisesRegex(ValueError, "No observed Korean"):
            self.prepare()
        self.assertFalse((self.root / "prepared").exists())

    def test_gzip_outputs_match_existing_typescript_parser_later_nonempty_merge(self):
        bundler = ROOT / "node_modules/esbuild/lib/main.js"
        if not shutil.which("node") or not bundler.exists():
            self.skipTest("Existing esbuild dependency is not installed")
        first = pa.table({
            "symbol": ["KOSPI", "005930", "005930"], "date": ["2026-09-10"] * 3,
            "type": ["INDEX", "STOCK", "STOCK"], "market": ["KOSPI"] * 3,
            "open": ["100", "5", ""], "high": ["101", "7", ""], "low": ["99", "4", ""],
            "close": ["100", "6", ""], "volume": ["1000", "1", "0"],
            "foreignNetBuyValue": ["", "7", ""], "rawScore": ["99", "99", "99"],
        })
        second = pa.table({
            "symbol": ["005930"], "date": ["2026-09-10"], "type": ["STOCK"], "market": ["KOSPI"],
            "close": [None], "volume": [None], "foreignNetBuyValue": ["0"],
        })
        self.manifest_for([("stock_history/z-first.parquet", first), ("stock_history/a-last.parquet", second)])
        manifest = self.prepare(batch_size=1)
        reference = []
        for table in [first, second]:
            stream = io.StringIO(newline="")
            writer = csv.writer(stream, lineterminator="\n")
            writer.writerow(table.column_names)
            writer.writerows([["" if cell is None else cell for cell in row.values()] for row in table.to_pylist()])
            reference.append(stream.getvalue())
        data = self.root / "parser-input.json"
        data.write_text(json.dumps({"files": [str(self.root / "prepared" / item["path"]) for item in manifest["files"]], "reference": reference}))
        check = self.root / "parser-check.ts"
        check.write_text(f'''import {{ readFileSync }} from "node:fs";
import {{ gunzipSync }} from "node:zlib";
import assert from "node:assert/strict";
import {{ parseManualMarketData }} from {json.dumps(str(ROOT / "src/lib/engine/manualDataset.ts"))};
const input = JSON.parse(readFileSync({json.dumps(str(data))}, "utf8"));
const actual = parseManualMarketData(input.files.map((p: string) => gunzipSync(readFileSync(p)).toString("utf8")), {{allowIncompleteIndex: true}});
const expected = parseManualMarketData(input.reference, {{allowIncompleteIndex: true}});
assert.deepEqual(actual, expected);
const bar = actual.dataset.observedBars!["005930"][0];
assert.equal(bar.close, 6);
assert.equal(bar.volume, 0);
assert.equal(bar.foreignNetBuyValue, 0);
assert.equal(actual.dataset.observedBars!["005930"].length, 1);
console.log("PARSER_EQUIVALENCE_PASS");
''')
        bundle = self.root / "parser-check.mjs"
        compile_result = subprocess.run(["node", "-e", 'require("esbuild").buildSync({entryPoints:[process.argv[1]],outfile:process.argv[2],bundle:true,platform:"node",format:"esm",target:"node20",ignoreAnnotations:true})', str(check), str(bundle)], cwd=ROOT, text=True, capture_output=True, timeout=30)
        self.assertEqual(compile_result.returncode, 0, compile_result.stdout + compile_result.stderr)
        result = subprocess.run(["node", str(bundle)], cwd=ROOT, text=True, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("PARSER_EQUIVALENCE_PASS", result.stdout)


if __name__ == "__main__":
    unittest.main()
