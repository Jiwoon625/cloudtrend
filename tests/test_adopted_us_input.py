"""Offline feature/atomic-input parity checks. No network or publication."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

import numpy as np
import pandas as pd
from pandas.testing import assert_frame_equal

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("prepare_adopted_us", ROOT / "scripts/prepare-adopted-us-backtest.py")
prep = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prep)


def fixture():
    dates = pd.bdate_range("2016-01-04", periods=520).strftime("%Y-%m-%d").tolist()
    frames = []
    for symbol, scale in [("SPY", 1), ("AAA", 1.4)]:
        values = 100 * np.cumprod(1 + 0.0004 + scale * 0.005 * np.sin(np.arange(len(dates)) / 7))
        frames.append(pd.DataFrame({"symbol": symbol, "date": dates, "open": values * .998,
            "high": values * 1.002, "low": values * .997, "close": values,
            "volume": 1_000_000 + np.arange(len(dates)) * 17}))
    return pd.concat(frames, ignore_index=True), dates


class AdoptedUsInputTests(unittest.TestCase):
    def test_parquet_bin_and_csv_preserve_float_precision_and_na_ticker(self):
        frame = pd.DataFrame({"symbol": ["NA"], "close": [1.2345678901234567]})
        with tempfile.TemporaryDirectory() as directory:
            for suffix in [".parquet.bin", ".csv"]:
                path = Path(directory) / ("prices" + suffix)
                if suffix == ".parquet.bin":
                    frame.to_parquet(path, index=False)
                else:
                    frame.to_csv(path, index=False)
                assert_frame_equal(prep.read_frame(path), frame)

    def test_sector_zip_selects_mapping_not_review_rows_and_hashes_member(self):
        raw = b"symbol,sectorCode,mappingVersion\nAAA,SOFTWARE,v1\nBBB,FINANCE,v1\n"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sector.zip"
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("manual_review_candidates.csv", "symbol,sectorCode\nAAA,SOFTWARE\n")
                archive.writestr("us_stock_sector_map_14_v1.csv", raw)
            sector_map, evidence = prep.load_sector_map(path)
            self.assertEqual(evidence["member"], "us_stock_sector_map_14_v1.csv")
            self.assertEqual(evidence["sha256"], prep.sha(path))
            self.assertEqual(evidence["memberSha256"], "sha256:" + prep.hashlib.sha256(raw).hexdigest())
            self.assertEqual(evidence["rows"], 2)
            self.assertEqual(evidence["mappingVersions"], ["v1"])
            master = pd.DataFrame({"symbol": ["BBB", "AAA"]}, index=[8, 3])
            joined = prep.join_sectors(master, sector_map)
            self.assertEqual(joined.sector.tolist(), ["FINANCE", "SOFTWARE"])

    def test_sector_map_rejects_missing_extra_duplicate_blank_and_conflicts(self):
        master = pd.DataFrame({"symbol": ["AAA", "BBB"]})
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sector.csv"
            for text, message in [
                ("symbol,sectorCode\nAAA,TECH\nAAA,TECH\n", "unique"),
                ("symbol,sectorCode\nAAA,\nBBB,TECH\n", "missing sector"),
                ("symbol,sectorCode\n,TECH\nBBB,TECH\n", "nonempty symbols"),
                ("symbol,sectorCode,sector\nAAA,TECH,FINANCE\n", "conflicting"),
            ]:
                path.write_text(text)
                with self.assertRaisesRegex(ValueError, message):
                    prep.load_sector_map(path)
            path.write_text("symbol,sectorCode\nAAA,TECH\n")
            sectors, _ = prep.load_sector_map(path)
            with self.assertRaisesRegex(ValueError, "exactly match"):
                prep.join_sectors(master, sectors)
            with self.assertRaisesRegex(ValueError, "exactly match"):
                prep.join_sectors(master.iloc[:1], pd.DataFrame({"symbol": ["AAA", "EXTRA"], "sector": ["TECH", "TECH"]}))
            with self.assertRaisesRegex(ValueError, "conflicts"):
                prep.join_sectors(pd.DataFrame({"symbol": ["AAA"], "sector": ["FINANCE"]}), sectors)
            ambiguous = Path(directory) / "ambiguous.zip"
            with zipfile.ZipFile(ambiguous, "w") as archive:
                archive.writestr("a.csv", "symbol,sectorCode\nAAA,TECH\n")
                archive.writestr("b.csv", "symbol,sectorCode\nAAA,TECH\n")
            with self.assertRaisesRegex(ValueError, "unambiguous"):
                prep.load_sector_map(ambiguous)

    def test_explicit_active_status_matches_production_without_missing_defaults(self):
        features = pd.DataFrame({"symbol": ["AAA", "BBB", "SPY"], "date": ["2016-12-30"] * 3, "close": [10., 20., 100.]})
        master = pd.DataFrame({"symbol": ["AAA", "BBB"], "status": ["ACTIVE", "DELISTED"],
                               "is_common_share": [True, False], "sector": ["TECH", "FINANCE"]})
        atomic = prep.enrich_atomic(features, master).set_index("symbol")
        self.assertEqual(atomic.toss_tradable.tolist(), [True, False, False])
        self.assertEqual(atomic.is_common_share.tolist(), [True, False, False])
        for column, value, message in [("status", "", "explicit status"), ("is_common_share", "unknown", "invalid explicit"),
                                       ("sector", None, "explicit sector")]:
            invalid = master.astype({column: object}).copy()
            invalid.loc[0, column] = value
            with self.assertRaisesRegex(ValueError, message):
                prep.enrich_atomic(features, invalid)
        missing_symbol = features.copy()
        missing_symbol.loc[0, "symbol"] = "MISSING"
        with self.assertRaisesRegex(ValueError, "explicit master"):
            prep.enrich_atomic(missing_symbol, master)

    def test_master_cannot_overwrite_dated_features(self):
        features = pd.DataFrame({"symbol": ["AAA"], "date": ["2017-01-03"],
                                 "close": [10.], "ret252": [.15], "adv20_usd": [1_500_000.],
                                 "active20": [False], "dollar_volume": [100.]})
        master = pd.DataFrame({"symbol": ["AAA"], "is_common_share": [True],
                               "status": ["ACTIVE"], "sector": ["TECH"],
                               "ret252": [9.99], "adv20_usd": [999_999_999.],
                               "active20": [True], "dollar_volume": [9_999_999.],
                               "fx_usdkrw": [5000.]})
        row = prep.enrich_atomic(features, master).iloc[0]
        self.assertEqual(row.ret252, .15)
        self.assertEqual(row.adv20_usd, 1_500_000.)
        self.assertFalse(row.active20)
        self.assertEqual(row.dollar_volume, 100.)
        self.assertIsNone(row.fx_usdkrw)

    def test_current_feature_math_and_no_future_dependency(self):
        frame, dates = fixture()
        original = frame.copy(deep=True)
        full = prep.core.compute_us_feature_panel(frame)
        past = prep.core.compute_us_feature_panel(frame.loc[frame.date.le(dates[399])])
        assert_frame_equal(frame, original)
        assert_frame_equal(full.loc[full.date.le(dates[399])].reset_index(drop=True), past.reset_index(drop=True))
        row = full.loc[full.symbol.eq("AAA")].iloc[-1]
        close = frame.loc[frame.symbol.eq("AAA"), "close"].reset_index(drop=True)
        self.assertEqual(row.ret252, close.iloc[-1] / close.iloc[-253] - 1)
        self.assertTrue(row.active20)

    def test_missing_session_stays_missing_and_blocks_active20(self):
        frame, dates = fixture()
        frame = frame.loc[~(frame.symbol.eq("AAA") & frame.date.eq(dates[-2]))]
        result = prep.core.compute_us_feature_panel(frame)
        missing = result.loc[result.symbol.eq("AAA") & result.date.eq(dates[-2])].iloc[0]
        latest = result.loc[result.symbol.eq("AAA")].iloc[-1]
        self.assertTrue(pd.isna(missing.close))
        self.assertFalse(latest.active20)
        self.assertTrue(pd.isna(latest.adv20_usd))

    def test_duplicate_nonempty_observations_and_required_master(self):
        frame = pd.DataFrame([{"symbol": "AAA", "date": "2017-01-03", "open": 10, "close": 11},
                              {"symbol": "AAA", "date": "2017-01-03", "open": "", "close": 12}])
        row = prep.merge_observations(frame).iloc[0]
        self.assertEqual(row.open, 10)
        self.assertEqual(row.close, 12)
        with self.assertRaisesRegex(ValueError, "Master requires"):
            prep.enrich_atomic(frame.iloc[:1], pd.DataFrame({"symbol": ["AAA"]}))

    def test_year_chunked_atomic_csvs_preserve_schema_cash_inputs_and_hashes(self):
        frame, dates = fixture()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            canonical = []
            stocks = frame.loc[frame.symbol.eq("AAA")].copy()
            stocks["year"] = stocks.date.str[:4]
            for year, rows in stocks.groupby("year"):
                path = root / f"{year}.csv"
                rows.drop(columns="year").to_csv(path, index=False)
                canonical.append(path)
            benchmark = root / "benchmark.csv"
            frame.loc[frame.symbol.eq("SPY"), ["date", "close"]].rename(columns={"date": "dt", "close": "spy_close"}).to_csv(benchmark, index=False)
            master = root / "master.csv"
            pd.DataFrame([{"symbol": "AAA", "name": "AAA", "status": "ACTIVE", "isCommonShare": True,
                           "market": "NASDAQ", "currency": "USD", "sector": "TECH"}]).to_csv(master, index=False)
            start = dates[-12]
            manifest = prep.prepare(canonical, benchmark, master, root / "out", start)
            self.assertEqual(manifest["sessions"], dates[-12:])
            self.assertEqual(manifest["rows"], 24)
            self.assertEqual(json.loads((root / "out/manifest.json").read_text()), manifest)
            for item in manifest["files"]:
                path = root / "out" / item["file"]
                self.assertEqual(prep.sha(path), item["sha256"])
                atomic = pd.read_csv(path)
                self.assertEqual(list(atomic), prep.FIELDS)
                self.assertFalse(atomic.set_index("symbol").loc["SPY", "is_common_share"])
                self.assertTrue(pd.isna(atomic.set_index("symbol").loc["SPY", "open"]))
                self.assertFalse(any(c.startswith("fwd") or "future" in c for c in atomic))
            with self.assertRaisesRegex(ValueError, "must be empty"):
                prep.prepare(canonical, benchmark, master, root / "out", start)
            # Separate-map flow retains independently hashable source evidence.
            master_rows = pd.read_csv(master).drop(columns="sector")
            master_bin = root / "master.parquet.bin"
            master_rows.to_parquet(master_bin, index=False)
            sectors = root / "sector.csv"
            pd.DataFrame({"symbol": ["AAA"], "sectorCode": ["TECH"]}).to_csv(sectors, index=False)
            mapped = prep.prepare(canonical, benchmark, master_bin, root / "mapped", start, sector_map_path=sectors)
            self.assertEqual(mapped["sectorMap"]["sha256"], prep.sha(sectors))
            self.assertEqual(pd.read_csv(root / "mapped" / mapped["files"][0]["file"]).iloc[0].sector, "TECH")


if __name__ == "__main__":
    unittest.main(verbosity=2)
