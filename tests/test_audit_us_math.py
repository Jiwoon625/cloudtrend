"""Synthetic-only tests. No operational ledger, source files, or network access."""
import copy
import hashlib
import importlib.util
import json
import math
import tempfile
import unittest
from datetime import date, datetime
from decimal import Decimal, ROUND_CEILING
from pathlib import Path
from unittest.mock import patch

import audit_us_math as audit

D = Decimal


def fixture():
    sessions = ["2020-12-30", "2020-12-31", "2021-01-04", "2021-01-05", "2021-01-06", "2021-01-07"]
    initial = D("74671.44")
    slot = D("3733.572")
    contract = {"startDate": sessions[0], "endDate": sessions[-1], "sessions": sessions,
                "initialCapitalUsd": str(initial), "oneWayCost": "0.0015",
                "bookId": "synthetic-research", "contractHash": "synthetic-hash"}
    rows, trades, cash, fees, shares = [], [], initial, D(0), 0
    holdings = [None, D("125"), D("110"), D("95"), None, D("101.8")]
    specs = {
        1: ("BUY", "PARTIAL", 10, D("123.45678901"), 0, "ENTRY_ONSET80"),
        2: ("BUY", "EXECUTED", 20, D("120"), 0, "ENTRY_ONSET80"),
        3: ("SELL", "PARTIAL", 11, D("90"), 2, "CORE_BELOW_0.70"),
        4: ("SELL", "EXECUTED", 19, D("100"), 2, "CORE_BELOW_0.70"),
        5: ("BUY", "EXECUTED", 37, D("100"), 4, "ENTRY_ONSET80"),
    }
    remaining = slot
    for i, when in enumerate(sessions):
        day_fee = D(0)
        if i in specs:
            side, status, qty, price, signal_i, reason = specs[i]
            gross = qty * price
            # Expected values are calculated directly without calling audit helpers.
            day_fee = ((gross * D("0.0015")) * 10**8).to_integral_value(rounding=ROUND_CEILING) / D(10**8)
            shares += qty if side == "BUY" else -qty
            cash += (-gross if side == "BUY" else gross) - day_fee
            fees += day_fee
            if side == "BUY":
                remaining -= gross
            trades.append({"tradeKey": f"SYNTHETIC|{i}", "symbol": "PRIVATE_SYNTHETIC_TICKER",
                           "signalDate": sessions[signal_i], "executionDate": when,
                           "status": status, "side": side, "modelShares": qty,
                           "modelPrice": str(price), "modelNotional": str(gross),
                           "feeUsd": str(day_fee), "reason": reason})
        if i in (0, 1, 4):
            if i == 4:
                remaining = slot
            trades.append({"tradeKey": f"PENDING|{0 if i < 2 else 4}", "symbol": "PRIVATE_SYNTHETIC_TICKER",
                           "signalDate": sessions[0 if i < 2 else 4], "executionDate": None,
                           "status": "PENDING", "side": "BUY", "modelShares": None,
                           "modelPrice": None, "modelNotional": str(remaining), "feeUsd": 0,
                           "reason": "ENTRY_ONSET80"})
        if i in (2, 3):
            trades.append({"tradeKey": "PENDING|SELL", "symbol": "PRIVATE_SYNTHETIC_TICKER",
                           "signalDate": sessions[2], "executionDate": None,
                           "status": "PENDING", "side": "SELL", "modelShares": shares,
                           "modelPrice": None, "modelNotional": None, "feeUsd": 0,
                           "reason": "CORE_BELOW_0.70"})
        rows.append({"date": when, "nav": str(cash + shares * (holdings[i] or D(0))),
                     "cash": str(cash), "fees": str(day_fee), "positionCount": int(shares > 0),
                     "valuationStatus": "COMPLETE", "staleMarkSymbols": []})
    numbers = [float(row["nav"]) for row in rows]
    peak, drawdown = float(initial), 0
    for number in numbers:
        peak = max(peak, number)
        drawdown = min(drawdown, number / peak - 1)
    days = (date.fromisoformat(sessions[-1]) - date.fromisoformat(sessions[0])).days
    summary = {"US_A0": {"status": "COMPLETE", "startDate": sessions[0], "endDate": sessions[-1],
                         "observations": len(sessions), "elapsedCalendarDays": days,
                         "initialCapital": str(initial), "finalNAV": numbers[-1],
                         "cumulativeReturn": numbers[-1] / float(initial) - 1,
                         "cagr": math.pow(numbers[-1] / float(initial), 365.2425 / days) - 1,
                         "mdd": drawdown, "missingValuationCount": 0, "staleValuationCount": 0,
                         "annualization": "ACTUAL_DAYS_365_2425"}}
    state = {"initialCapital": str(initial), "initializedDate": sessions[0], "lastDate": sessions[-1],
             "modelCashExact": str(cash), "cash": str(cash), "modelFeesExact": str(fees), "totalFees": str(fees),
             "positions": {"PRIVATE_SYNTHETIC_TICKER": {"shares": shares, "lastPrice": "101.8"}},
             "allocationPolicy": {"version": "us-initial-capital-slots-v1", "targetPositions": 20,
                                  "initialCapitalUsd": str(initial), "quarterlyRebalance": False,
                                  "fundingOnlySales": False}, "lastQuarterRebalance": None,
             "executionPolicy": {"bookId": contract["bookId"], "contractHash": contract["contractHash"],
                                 "accountingStartDate": sessions[0], "initialCapital": str(initial),
                                 "oneWayCost": "0.0015"},
             "pendingTargets": {}, "pendingExits": {}, "benchmarkBasePrice": 100,
             "benchmarkBaseDate": sessions[0]}
    benchmark = [{"dt": when, "spy_close": price} for when, price in zip(sessions, (100, 101, 95, 96, 102, 103))]
    return summary, contract, state, rows, trades, benchmark


class AuditMathTests(unittest.TestCase):
    def setUp(self):
        self.args = fixture()

    def run_audit(self):
        return audit.audit_records(*self.args)

    def test_annual_budget_uses_previous_year_nav_and_preserves_old_intent(self):
        summary,contract,state,nav,trades,benchmark=self.args
        contract["annualBudgetPolicy"]={"policyId":"US_A0_ANNUAL_ENTRY_BUDGET_PRIOR_NAV_V1"}
        prior=D(str(nav[1]["nav"])).quantize(audit.QUANTUM)
        budgets={"2020":audit.SLOT_BUDGET,"2021":(prior/20).quantize(audit.QUANTUM,rounding=audit.ROUND_DOWN)}
        state["annualEntryBudgetResearch"]={"policyId":contract["annualBudgetPolicy"]["policyId"],"byYear":{
            "2020":{"sourceDate":None,"referenceNavUsd":str(audit.INITIAL_CAPITAL),"entryPrincipalUsd":str(budgets["2020"])},
            "2021":{"sourceDate":"2020-12-31","referenceNavUsd":str(prior),"entryPrincipalUsd":str(budgets["2021"])}}}
        gross={}
        for t in trades:
            key=audit._intent(t)
            if t["side"]=="BUY":
                if t["status"]=="PENDING":t["modelNotional"]=str(budgets[t["signalDate"][:4]]-gross.get(key,D(0)))
                else:gross[key]=gross.get(key,D(0))+D(str(t["modelNotional"]))
        result=self.run_audit()
        self.assertEqual(result["status"],"PASS",{k:v for k,v in result["checks"].items() if not v["passed"]})
        self.assertIsNone(result["ledger"]["fixedGrossEntryBudgetExact"])
        state["annualEntryBudgetResearch"]["byYear"]["2021"]["sourceDate"]="2021-01-04"
        self.assertFalse(self.run_audit()["checks"]["annualBudgetNoCurrentYearNAV"]["passed"])

    def test_explicit_proxy_may_execute_at_same_day_close(self):
        trade=next(t for t in self.args[4] if t["side"]=="SELL" and t["status"]=="EXECUTED")
        trade["signalDate"]=trade["executionDate"]
        trade["reason"]="US_A0_ALL_HELD_LAST_VALID_CLOSE_EXIT_V1"
        trade["detail"]={"trigger_session_date":trade["executionDate"],"reference_price_date":"2021-01-05","reference_price":"100","retrospective_exit_proxy":True,"retroactive_nav_rewrite":False,"corporate_actions_modeled":False}
        result=self.run_audit()
        self.assertTrue(result["checks"]["executionAfterSignal"]["passed"])
        self.assertTrue(result["checks"]["proxyCloseRecognitionOnly"]["passed"])
        self.assertEqual(result["ledger"]["retrospectiveProxyExitFills"],1)

    def test_valid_full_synthetic_ledger_and_fee_ceil(self):
        result = self.run_audit()
        failed = {k: v for k, v in result["checks"].items() if not v["passed"]}
        self.assertEqual(result["status"], "PASS", failed)
        self.assertEqual(result["ledger"]["totalFeesExact"], "15.33685184")
        self.assertEqual(result["ledger"]["fixedGrossEntryBudgetExact"], "3733.572")
        self.assertEqual(result["ledger"]["finalCashExact"], "70211.53525806")
        self.assertEqual(result["ledger"]["completedPositionLifecycles"], 1)
        self.assertEqual(result["tradeCounts"]["allFills"], {"BUY": 3, "SELL": 2, "total": 5})
        self.assertEqual(result["tradeCounts"]["EXECUTED"], {"BUY": 2, "SELL": 1, "total": 3})
        self.assertEqual(result["tradeCounts"]["PARTIAL"], {"BUY": 1, "SELL": 1, "total": 2})
        self.assertEqual(result["tradeCounts"]["pendingRows"]["total"], 5)
        self.assertEqual(result["tradeCounts"]["uniqueSignalIntents"]["total"], 3)

    def test_first_year_initial_subsequent_previous_year_end(self):
        result = self.run_audit()
        annual = result["annualReturns"]
        self.assertEqual(annual[0]["baseNAV"], "74671.44")
        self.assertEqual(annual[1]["baseNAV"], annual[0]["endingNAV"])
        self.assertAlmostEqual(annual[1]["return"], float(D(annual[1]["endingNAV"]) / D(annual[0]["endingNAV"]) - 1))

    def test_benchmark_exact_same_dates_and_unverified_dividends(self):
        self.args[-1].insert(0, {"dt": "2019-01-01", "spy_close": 30})
        result = self.run_audit()["benchmark"]
        self.assertEqual(result["matchedSessions"], 6)
        self.assertFalse(result["dividendTotalReturnCertified"])
        self.assertAlmostEqual(result["performance"]["cumulativeReturn"], .03)
        self.assertAlmostEqual(result["performance"]["mdd"], 95 / 101 - 1)
        self.assertEqual(result["performance"]["maximumDrawdownPeriod"]["peakDate"], "2020-12-31")
        self.assertEqual(result["performance"]["maximumDrawdownPeriod"]["troughDate"], "2021-01-04")
        self.assertAlmostEqual(result["annualReturns"][0]["return"], .01)
        self.assertAlmostEqual(result["annualReturns"][1]["return"], 103 / 101 - 1)

    def test_source_inputs_unchanged_and_no_raw_output(self):
        original = copy.deepcopy(self.args)
        result = self.run_audit()
        self.assertEqual(self.args, original)
        serialized = json.dumps(result, allow_nan=False)
        self.assertNotIn("PRIVATE_SYNTHETIC_TICKER", serialized)
        self.assertNotIn("SYNTHETIC|", serialized)
        self.assertNotIn("daily-nav", serialized)

    def test_forward_labels_never_read(self):
        class Forbidden:
            def __str__(self):
                raise AssertionError("Forward label was read")
        for row in self.args[3] + self.args[4] + self.args[5]:
            row["future_return_20d"] = Forbidden()
        self.assertEqual(self.run_audit()["status"], "PASS")

    def test_one_quantum_fee_tamper_fails(self):
        trade = next(t for t in self.args[4] if t["status"] == "PARTIAL")
        trade["feeUsd"] = str(D(trade["feeUsd"]) - D("0.00000001"))
        result = self.run_audit()
        self.assertEqual(result["checks"]["fillFeeCeilingEightDecimals"]["failures"], 1)
        self.assertEqual(result["status"], "FAIL")

    def test_daily_cash_deposit_tamper_detected(self):
        self.args[3][2]["cash"] = str(D(self.args[3][2]["cash"]) + D("100"))
        result = self.run_audit()
        self.assertEqual(result["checks"]["dailyCashReconstruction"]["failures"], 1)
        self.assertEqual(result["checks"]["dailyCashReconstruction"]["maxAbsoluteDifference"], "100")

    def test_daily_fees_tamper_detected(self):
        self.args[3][0]["fees"] = "0.01"
        self.assertEqual(self.run_audit()["checks"]["dailyFeeReconstruction"]["failures"], 1)

    def test_integer_quantities_required(self):
        self.args[4][1]["modelShares"] = "10.5"
        result = self.run_audit()
        self.assertEqual(result["checks"]["positiveSafeIntegerFillQuantity"]["failures"], 1)

    def test_eight_decimal_price_precision_required(self):
        self.args[4][1]["modelPrice"] = "123.456789011"
        self.assertEqual(self.run_audit()["checks"]["priceExactAtEightDecimals"]["failures"], 1)

    def test_gross_entry_budget_aggregates_partial_fills(self):
        next(t for t in self.args[4] if t["status"] == "EXECUTED" and t["side"] == "BUY")["modelShares"] = 21
        self.assertGreater(self.run_audit()["checks"]["entryIntentGrossBudget"]["failures"], 0)

    def test_reentry_does_not_reuse_lifetime_symbol_budget(self):
        result = self.run_audit()
        self.assertGreater(D(result["ledger"]["buyGrossExact"]), D("3733.572"))
        self.assertTrue(result["checks"]["positionLifecycleGrossBudget"]["passed"])

    def test_rebalance_or_funding_reasons_forbidden(self):
        self.args[4][0]["reason"] = "ENTRY_MINIMUM_PROPORTIONAL_FUNDING"
        result = self.run_audit()
        self.assertEqual(result["checks"]["noRebalanceOrFundingReason"]["failures"], 1)

    def test_same_day_signal_execution_forbidden(self):
        self.args[4][1]["signalDate"] = self.args[4][1]["executionDate"]
        self.assertEqual(self.run_audit()["checks"]["executionAfterSignal"]["failures"], 1)

    def test_duplicate_fill_not_silently_deduplicated(self):
        self.args[4].insert(2, copy.deepcopy(self.args[4][1]))
        self.assertEqual(self.run_audit()["checks"]["fillTradeKeyUnique"]["failures"], 1)

    def test_repeated_pending_not_counted_as_executions(self):
        self.args[4].insert(1, copy.deepcopy(self.args[4][0]))
        result = self.run_audit()
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["tradeCounts"]["allFills"]["total"], 5)
        self.assertEqual(result["tradeCounts"]["pendingRows"]["total"], 6)

    def test_summary_tamper_detected(self):
        self.args[0]["US_A0"]["cagr"] += .001
        self.assertFalse(self.run_audit()["tsSummaryComparison"]["cagr"]["matches"])

    def test_final_holdings_tamper_detected(self):
        self.args[2]["positions"]["PRIVATE_SYNTHETIC_TICKER"]["shares"] = 38
        self.assertEqual(self.run_audit()["checks"]["finalPositionQuantityReconstruction"]["failures"], 1)

    def test_missing_benchmark_not_filled(self):
        self.args[-1].pop(2)
        result = self.run_audit()
        self.assertEqual(result["benchmark"]["missingSessions"], 1)
        self.assertIsNone(result["benchmark"]["performance"])
        self.assertEqual(result["status"], "FAIL")

    def test_duplicate_benchmark_fails(self):
        self.args[-1].append(copy.deepcopy(self.args[-1][2]))
        self.assertEqual(self.run_audit()["benchmark"]["duplicateSessions"], 1)
        self.assertEqual(self.run_audit()["status"], "FAIL")

    def test_invalid_benchmark_price_fails(self):
        self.args[-1][2]["spy_close"] = float("nan")
        self.assertEqual(self.run_audit()["benchmark"]["invalidPricesInPeriod"], 1)

    def test_missing_or_stale_nav_fails_quality(self):
        self.args[3][1]["valuationStatus"] = "STALE"
        self.assertFalse(self.run_audit()["valuationQuality"]["completeNonstaleExactCoverage"])
        self.args[3][1]["nav"] = None
        result = self.run_audit()
        self.assertIsNone(result["performance"])
        self.assertEqual(result["valuationQuality"]["missingSessions"], 1)

    def test_mdd_initial_peak_and_tie_dates(self):
        points = [("2020-01-02", D(90)), ("2020-01-03", D(90)), ("2020-01-04", D(100))]
        result = audit.performance(points, D(100), "2020-01-02")
        self.assertEqual(result["mdd"], -.1)
        self.assertEqual(result["maximumDrawdownPeriod"]["peakDate"], "2020-01-02")
        self.assertEqual(result["maximumDrawdownPeriod"]["troughDate"], "2020-01-02")
        self.assertTrue(result["maximumDrawdownPeriod"]["peakIsInitialCapital"])

    def test_no_drawdown_and_zero_elapsed_conventions(self):
        result = audit.performance([("2020-01-02", D(101))], D(100), "2020-01-02")
        self.assertIsNone(result["cagr"])
        self.assertEqual(result["mdd"], 0)
        self.assertIsNone(result["maximumDrawdownPeriod"]["troughDate"])

    def test_json_files_remain_unchanged_and_yearly_policy_checked(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            names = ["summary.json", "US_A0.contract.json", "US_A0.final-state.json"]
            for name, value in zip(names, self.args[:3]):
                (root / name).write_text(json.dumps(value))
            for name, value in zip(("US_A0.daily-nav.jsonl", "US_A0.trades.jsonl"), self.args[3:5]):
                (root / name).write_text("\n".join(json.dumps(row) for row in value))
            (root / "US_A0.yearly-budgets.json").write_text(json.dumps({
                "policy": "FIXED_INITIAL_CAPITAL_DIV_20_NO_REBALANCE", "initialCapital": "74671.44", "yearlyReset": False}))
            before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in root.iterdir()}
            with patch.object(audit, "_read_benchmark_parquet", return_value=self.args[-1]):
                result = audit.audit_result(root, root / "synthetic.parquet")
            self.assertEqual(result["status"], "PASS")
            self.assertTrue(result["checks"]["yearlyBudgetPolicy"]["passed"])
            after = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in root.iterdir()}
            self.assertEqual(before, after)

    def test_safe_error_does_not_expose_source_paths(self):
        with self.assertRaises(audit.AuditError) as caught:
            audit.audit_result(Path("/secret/no-such-run"), Path("/secret/no-such-benchmark"))
        self.assertEqual(str(caught.exception), "AUDIT_INPUT_FILE_MISSING")
        self.assertIsNone(caught.exception.__cause__)

    @unittest.skipUnless(importlib.util.find_spec("pyarrow"), "pyarrow is not installed; pure calculations and adapter selection are tested separately")
    def test_real_parquet_adapter_projects_only_required_columns(self):
        import pyarrow as pa
        import pyarrow.parquet as pq
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "synthetic.parquet"
            pq.write_table(pa.Table.from_pylist([
                {"dt": datetime(2020, 1, 2), "spy_close": 100.0, "future_return": 999.0}]), path)
            rows = audit._read_benchmark_parquet(path)
            self.assertEqual(set(rows[0]), {"dt", "spy_close"})
            self.assertEqual(audit.iso_date(rows[0]["dt"]), "2020-01-02")


if __name__ == "__main__":
    unittest.main(verbosity=2)
