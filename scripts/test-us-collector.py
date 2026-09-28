"""Offline contract tests for notebook code, without credentials or network access."""
import ast
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
import pandas as pd

NOTEBOOK = json.loads(next((Path(__file__).resolve().parents[1] / "notebooks").glob("cloudtrend_US_*.ipynb")).read_text(encoding="utf-8-sig"))

def cell(index):
    return "".join(NOTEBOOK["cells"][index]["source"])

def functions(index, namespace):
    tree = ast.parse(cell(index))
    tree.body = [node for node in tree.body if isinstance(node, ast.FunctionDef)]
    exec(compile(tree, "collector", "exec"), namespace)

def candle(date):
    return dict(timestamp=date + "T00:00:00-04:00", openPrice="100", highPrice="101", lowPrice="99", closePrice="100", volume="10000", currency="USD")

class CollectorTest(unittest.TestCase):
    def test_roster_requires_live_support_and_rechecks_waiting_candidates(self):
        ns = dict(pd=pd)
        functions(5, ns)
        roster = pd.DataFrame([
            dict(ticker='OLD',sectorCode='IT',role='EQUITY'),
            dict(ticker='WAIT',sectorCode='FINANCE',role='EQUITY'),
            dict(ticker='SPY',sectorCode='BENCHMARK',role='BENCHMARK'),
        ])
        build = ns['build_collection_seed']
        old = dict(symbol='OLD',isCommonShare=True)
        self.assertEqual(build(roster,[old]).ticker.tolist(),['OLD','SPY'])
        self.assertEqual(build(roster,[old,dict(symbol='WAIT',isCommonShare=False)]).ticker.tolist(),['OLD','SPY'])
        self.assertEqual(build(roster,[old,dict(symbol='WAIT',isCommonShare=True)]).ticker.tolist(),['OLD','SPY','WAIT'])
        self.assertEqual(build(roster,[dict(symbol='WAIT',isCommonShare=True)]).ticker.tolist(),['SPY','WAIT'])
        with self.assertRaises(RuntimeError): build(roster,[])
        with self.assertRaises(ValueError): build(pd.concat([roster,roster]),[old])
        with self.assertRaises(ValueError): build(roster[roster.ticker.ne('SPY')],[old])

    def namespace(self):
        ns = dict(pd=pd, np=np, json=json, AS_OF_DATE="2026-09-25", INITIAL_BARS=4, INCREMENTAL_BARS=2, FORCE_FULL_REFRESH=False)
        functions(7, ns)
        return ns

    def test_inclusive_pages_and_unclosed_candle(self):
        ns = self.namespace()
        pages = [(["2026-09-28", "2026-09-25", "2026-09-24"], "cursor1"), (["2026-09-24", "2026-09-23", "2026-09-22"], None)]
        requests = []
        def get(path, params, chart):
            requests.append(params.copy())
            dates, cursor = pages.pop(0)
            return {"result": {"candles": [candle(d) for d in dates], "nextBefore": cursor}}, {}
        ns["toss_get"] = get
        rows = ns["fetch_history"]("TEST", full=True)
        self.assertEqual([r["date"] for r in rows], ["2026-09-25", "2026-09-24", "2026-09-23", "2026-09-22"])
        self.assertEqual(requests[1]["before"], "cursor1")
        self.assertTrue(all(r["adjusted"] == "true" and r["count"] == 200 for r in requests))

    def test_numpy_checkpoint_and_resume(self):
        ns = self.namespace()
        rows, _ = ns["parse_candles"]("TEST", {"result": {"candles": [candle("2026-09-25")]}})
        with tempfile.TemporaryDirectory() as tmp:
            ns["CHECKPOINT_DIR"] = Path(tmp)
            ns["fetch_history"] = lambda *args, **kwargs: rows
            self.assertIsNone(ns["task"]("TEST")[2])
            def forbidden(*args, **kwargs):
                raise AssertionError("Resume should use checkpoint")
            ns["fetch_history"] = forbidden
            self.assertEqual(ns["task"]("TEST")[1][0]["volume"], 10000)
            ns["FORCE_FULL_REFRESH"] = True
            self.assertIn("AssertionError", ns["task"]("TEST")[2])

    def test_features_require_sessions_and_history(self):
        dates = pd.bdate_range(end="2026-09-25", periods=300).strftime("%Y-%m-%d").tolist()
        records = []
        for symbol in ["SPY", "FULL", "GAP", "IPO"]:
            for i, date in enumerate(dates):
                if symbol == "GAP" and i == 290 or symbol == "IPO" and i < 290:
                    continue
                close = 100 + i + np.sin(i)
                records.append(dict(symbol=symbol,date=date,open=close,high=close+1,low=close-1,close=close,volume=10000,currency="USD"))
        symbols = ["SPY", "FULL", "GAP", "IPO"]
        master = pd.DataFrame([dict(symbol=s,name=s,englishName=s,market="NYSE",securityType="STOCK",status="ACTIVE",currency="USD",sharesOutstanding=100000,isCommonShare=True,sector="TEST") for s in symbols])
        ns = dict(pd=pd,np=np,combined=pd.DataFrame(records),seed=pd.DataFrame({"ticker":symbols}),master=master,AS_OF_DATE=dates[-1],truthy=lambda x: str(x).lower() == "true")
        with contextlib.redirect_stdout(io.StringIO()):
            exec(compile(cell(8), "features", "exec"), ns)
        snap = ns["snap"].set_index("symbol")
        self.assertTrue(snap.loc["FULL", "active20"])
        self.assertFalse(snap.loc["GAP", "active20"])
        self.assertFalse(snap.loc["IPO", "active20"])
        self.assertTrue(pd.isna(snap.loc["IPO", "ret252"]))
        self.assertFalse(snap.loc["SPY", "is_common_share"])
        full = pd.DataFrame(records).query("symbol == 'FULL'")
        self.assertAlmostEqual(snap.loc["FULL", "ret252"], full.iloc[-1].close / full.iloc[-253].close - 1)

    def test_every_code_cell_compiles(self):
        for index, item in enumerate(NOTEBOOK["cells"]):
            if item["cell_type"] == "code":
                source = "\n".join(line for line in cell(index).splitlines() if not line.lstrip().startswith(("!", "%")))
                compile(source, f"cell{index}", "exec")

    def test_lifecycle_exemption_is_dated_and_never_fills_prices(self):
        ns = dict(pd=pd, np=np)
        functions(8, ns)
        apply = ns["apply_verified_lifecycle"]
        event = dict(symbol="TBPH", effective_date="2026-09-24", status="SUSPENDED", source_url="https://www.nasdaqtrader.com/TraderNews.aspx?id=ECA2026-668")
        def snapshot():
            return pd.DataFrame([dict(symbol="TBPH",close=np.nan,status="ACTIVE",toss_tradable=True,active20=True)])
        with self.assertRaisesRegex(RuntimeError, "Missing confirmed"):
            apply(snapshot(), ["TBPH"], "2026-09-23", [event])
        with self.assertRaisesRegex(RuntimeError, "Missing confirmed"):
            apply(snapshot(), ["TBPH"], "2026-09-25", [])
        frame = snapshot()
        self.assertEqual(apply(frame, ["TBPH"], "2026-09-25", [event]), [event])
        self.assertTrue(pd.isna(frame.loc[0,"close"]))
        self.assertFalse(frame.loc[0,"toss_tradable"])
        self.assertFalse(frame.loc[0,"active20"])
        self.assertEqual(frame.loc[0,"status"], "SUSPENDED")
        with self.assertRaises(ValueError):
            apply(frame, ["SPY"], "2026-09-25", [{**event,"symbol":"SPY"}])

    def test_same_day_source_bytes_are_frozen(self):
        with tempfile.TemporaryDirectory() as tmp:
            ns = dict(pd=pd,np=np,OUTPUT_DIR=Path(tmp),latest_date="2026-09-25",AS_OF_DATE="2026-09-25",display=lambda *args: None)
            import hashlib
            ns["hashlib"] = hashlib
            ns["snap"] = pd.DataFrame([dict(date="2026-09-25",symbol="SPY",close=100,fx_usdkrw=1400)])
            with contextlib.redirect_stdout(io.StringIO()):
                exec(compile(cell(10), "snapshot", "exec"), ns)
                first = ns["raw"]
                ns["snap"].loc[0,"fx_usdkrw"] = 1500
                exec(compile(cell(10), "snapshot", "exec"), ns)
            self.assertEqual(ns["raw"], first)
            self.assertEqual(ns["out"].loc[0,"fx_usdkrw"], 1400)

if __name__ == "__main__":
    unittest.main()
