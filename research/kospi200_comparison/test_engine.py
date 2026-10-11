"""Synthetic-only regressions. No network, credentials, or operational writes."""
import csv
import hashlib
import json
import math
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

from research.kospi200_comparison.engine import (
    ARMS,
    DataNotReady,
    EtfAccount,
    POLICY_ID,
    analyze,
    block_bootstrap_mean_spread,
    causal_weight,
    load_verified_inputs,
    run,
    simulate,
)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_csv(path: Path, cols: list[str], rows: list[dict]) -> None:
    with path.open("w", encoding="utf-8", newline="") as out:
        writer = csv.DictWriter(out, fieldnames=cols)
        writer.writeheader()
        writer.writerows(rows)


class ValidSyntheticCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        cursor, final = date(2017, 9, 1), date(2026, 9, 11)
        self.sessions = []
        while cursor <= final:
            if cursor.weekday() < 5:
                self.sessions.append(cursor.isoformat())
            cursor += timedelta(days=1)
        stock, etf, gates, calendar = [], [], [], []
        nav = 100_000_000.0
        px = 22000.0
        for i, dt in enumerate(self.sessions):
            nav *= 1 + 0.00032 + math.sin(i * 0.37) * 0.008
            open_tr = px * (1 + math.sin(i * 0.13) * 0.002)
            px *= 1 + 0.0004 + math.cos(i * 0.31) * 0.009
            stock.append({"date": dt, "nav": f"{nav:.8f}", "stock_exposure": "0.4"})
            etf.append({"date": dt, "open_tr": f"{open_tr:.8f}", "close_tr": f"{px:.8f}"})
            gates.append({"date": dt, "asof_date": dt, "available_after_close": "true", "status": "NEUTRAL"})
            calendar.append({"date": dt})
        self.contents = {
            "stock_nav": (["date", "nav", "stock_exposure"], stock),
            "kodex200_total_return": (["date", "open_tr", "close_tr"], etf),
            "kospi_market_gate": (["date", "asof_date", "available_after_close", "status"], gates),
            "krx_sessions": (["date"], calendar),
        }
        self.manifest = {
            "schema": "KOSPI200_COMPARISON_INPUT_V1",
            "stock_policy_id": POLICY_ID,
            "benchmark_symbol": "069500",
            "benchmark_price_basis": "audited_total_return_adjusted_ohlc",
            "stock_replay_verified": True,
            "benchmark_distribution_verified": True,
            "gate_point_in_time_verified": True,
            "krx_calendar_verified": True,
            "stock_corporate_actions_reviewed": True,
            "stock_replay_commit": "0123456789abcdef123456789abcdef12345678",
            "stock_replay_evidence": "SYNTHETIC_CERT_STOCK",
            "benchmark_distribution_evidence": "SYNTHETIC_CERT_DISTRIBUTIONS",
            "gate_evidence": "SYNTHETIC_CERT_GATE",
            "calendar_evidence": "SYNTHETIC_CERT_SESSIONS",
            "stock_replay_policy_sha256": "f" * 64,
            "stock_budget_policy": "initial_capital_divided_by_30",
            "stock_one_way_fee": 0.0015,
            "stock_nav_basis": "post_cost_mark_to_market",
            "sources": {},
        }
        self.refresh()

    def refresh(self):
        for name, (columns, rows) in self.contents.items():
            filename = f"{name}.csv"
            write_csv(self.root / filename, columns, rows)
            self.manifest["sources"][name] = {"path": filename, "sha256": sha256(self.root / filename)}
        self.path = self.root / "manifest.json"
        self.path.write_text(json.dumps(self.manifest, ensure_ascii=False), encoding="utf-8")

    def test_full_realistic_horizon_preflight(self):
        v = load_verified_inputs(self.path)
        self.assertEqual(v.start, "2018-01-02")
        self.assertEqual(v.end, "2026-09-11")
        self.assertEqual(len(v.hashes), 4)

    def test_compare_four_accounts_plus_exposure_control(self):
        summary = run(self.path, self.root / "results")
        self.assertEqual(set(summary["segments"]["full"]), set(ARMS))
        self.assertTrue((self.root / "results" / "daily_nav.csv").exists())
        self.assertTrue((self.root / "results" / "summary.json").exists())
        self.assertEqual(summary["judgement"], "DESCRIPTIVE_ONLY_REQUIRES_HUMAN_INTERPRETATION")
        self.assertIn("2025", summary["annual"])
        self.assertIn("2018_2024", summary["segments"])
        self.assertIn("excluding_2025_daily_return_stitch_not_executable", summary["segments"])
        self.assertEqual(len(summary["leave_one_full_year_out_stitched"]), 8)
        self.assertGreater(summary["rolling_504_session"]["etf_100"]["windows"], 300)

    def test_unverified_distribution_blocks_without_output(self):
        self.manifest["benchmark_distribution_verified"] = False
        self.refresh()
        output = self.root / "results"
        with self.assertRaisesRegex(DataNotReady, "benchmark_distribution_verified"):
            run(self.path, output)
        self.assertFalse(output.exists())

    def test_wrong_budgets_block(self):
        self.manifest["stock_budget_policy"] = "annual_prior_nav_divided_by_30"
        self.refresh()
        with self.assertRaisesRegex(DataNotReady, "Historical annual-prior"):
            load_verified_inputs(self.path)

    def test_hash_mismatch_blocks(self):
        self.refresh()
        with (self.root / "stock_nav.csv").open("ab") as output:
            output.write(b"added after hash\n")
        with self.assertRaisesRegex(DataNotReady, "SHA-256 mismatch"):
            load_verified_inputs(self.path)

    def test_missing_exchange_session_blocks(self):
        rows = self.contents["stock_nav"][1]
        rows[:] = [r for r in rows if r["date"] != "2025-03-04"]
        self.refresh()
        with self.assertRaisesRegex(DataNotReady, "Missing 1 stock_nav"):
            load_verified_inputs(self.path)

    def test_duplicate_etf_day_blocks(self):
        rows = self.contents["kodex200_total_return"][1]
        rows.append(rows[-1].copy())
        self.refresh()
        with self.assertRaisesRegex(DataNotReady, "Duplicate date"):
            load_verified_inputs(self.path)

    def test_future_dated_gate_evidence_blocks(self):
        rows = self.contents["kospi_market_gate"][1]
        i = next(i for i, r in enumerate(rows) if r["date"] == "2025-03-04")
        rows[i]["asof_date"] = "2025-03-05"
        self.refresh()
        with self.assertRaisesRegex(DataNotReady, "as-of provenance"):
            load_verified_inputs(self.path)

    def test_market_gate_decision_uses_yesterdays_close(self):
        gates = self.contents["kospi_market_gate"][1]
        for row in gates:
            if row["date"] == "2018-01-02":
                row["status"] = "RISK_OFF"
            elif row["date"] == "2018-01-03":
                row["status"] = "RISK_ON"
        self.refresh()
        inputs = load_verified_inputs(self.path)
        trace, _ = simulate(inputs)
        jan3 = next(row for row in trace if row["date"] == "2018-01-03")
        jan4 = next(row for row in trace if row["date"] == "2018-01-04")
        self.assertEqual(jan3["gate_decision_date"], "2018-01-02")
        self.assertEqual(jan3["gate_etf_target"], 0.0)
        self.assertEqual(jan4["gate_decision_date"], "2018-01-03")
        self.assertEqual(jan4["gate_etf_target"], 1.0)

    def test_volatility_only_prior_closes(self):
        inputs = load_verified_inputs(self.path)
        filtered = [d for d in inputs.sessions if d <= inputs.end]
        at = filtered.index("2018-05-01")
        base = causal_weight(filtered, at, inputs.stock, inputs.etf)
        # Changing same-day/future prices and NAV cannot affect today's open target.
        inputs.stock["2018-05-01"]["nav"] = "999999999999"
        inputs.etf["2018-05-01"]["close_tr"] = "0.000001"
        self.assertEqual(base, causal_weight(filtered, at, inputs.stock, inputs.etf))

    def test_no_leverage_and_fee_cash_accounting(self):
        account = EtfAccount()
        account.trade_at_open(25000.0, 1.0)
        self.assertGreater(account.fees, 0)
        self.assertAlmostEqual(account.cash, 0, places=5)
        self.assertLess(account.close_nav(25000.0), 100_000_000.0)
        with self.assertRaises(DataNotReady):
            account.trade_at_open(25000.0, 1.02)

    def test_bootstrap_determinism_and_year_filter(self):
        a = [0.001 + (i % 9) * 0.0001 for i in range(100)]
        b = [0.0005 + (i % 7) * 0.0001 for i in range(100)]
        self.assertEqual(block_bootstrap_mean_spread(a, b), block_bootstrap_mean_spread(a, b))
        inp = load_verified_inputs(self.path)
        trace, _ = simulate(inp)
        result = analyze(trace)
        self.assertLess(result["segments"]["excluding_2025_daily_return_stitch_not_executable"]["etf_100"]["cumulative"],
                        result["segments"]["full"]["etf_100"]["cumulative"])
        self.assertIn("2025", result["leave_one_full_year_out_stitched"])


if __name__ == "__main__":
    unittest.main()
