#!/usr/bin/env python3
"""Read-only, independent arithmetic audit of the US A0 research replay.

Only an aggregate JSON object is returned/emitted. No network, credentials,
database access, output file writes, security labels, or future-return labels.
The pure ``audit_records`` entrypoint has no third-party dependencies.

CLI:
  python audit_us_math.py --result-dir /private/run --benchmark /private/spy.parquet

The Parquet adapter reads *only* dt and spy_close, using pyarrow or pandas.
Benchmark adjustment/dividend completeness is deliberately NOT certified.
Fees follow decimal.ts and bookFill: positive gross * 0.0015, CEILING to 1e-8.
Integer fills and gross entry budgets are checked separately from fees.
"""
from __future__ import annotations

import argparse
import json
import math
from collections import Counter, defaultdict
from datetime import date, datetime
from decimal import Decimal, InvalidOperation, ROUND_CEILING, ROUND_DOWN, localcontext
from pathlib import Path
from typing import Any, Iterable, Mapping

INITIAL_CAPITAL = Decimal("74671.44")
ONE_WAY_COST = Decimal("0.0015")
SLOT_BUDGET = INITIAL_CAPITAL / 20
QUANTUM = Decimal("0.00000001")
MAX_SAFE_INTEGER = 2**53 - 1
NAV_ABSOLUTE_TOLERANCE = Decimal("0.00000001")
METRIC_ABSOLUTE_TOLERANCE = 1e-12


class AuditError(ValueError):
    """Safe fixed error code; callers may log str(error), never input contents."""


def dec(value: Any) -> Decimal:
    if isinstance(value, bool) or value is None:
        raise ValueError("Expected finite numeric value")
    try:
        result = value if isinstance(value, Decimal) else Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise ValueError("Expected finite numeric value") from exc
    if not result.is_finite():
        raise ValueError("Expected finite numeric value")
    return result


def money(value: Decimal) -> str:
    result = format(value, "f")
    return result.rstrip("0").rstrip(".") if "." in result else result


def iso_date(value: Any) -> str:
    if isinstance(value, datetime):
        value = value.date().isoformat()
    elif isinstance(value, date):
        value = value.isoformat()
    if not isinstance(value, str) or len(value) != 10:
        raise ValueError("Expected ISO date YYYY-MM-DD")
    if date.fromisoformat(value).isoformat() != value:
        raise ValueError("Expected ISO date YYYY-MM-DD")
    return value


class Checks:
    """Aggregate failures without exporting individual symbols, orders, or rows."""

    def __init__(self) -> None:
        self.results: dict[str, dict[str, Any]] = {}

    def add(self, name: str, passes: bool, difference: Decimal | None = None) -> None:
        row = self.results.setdefault(name, {"checked": 0, "failures": 0})
        row["checked"] += 1
        row["failures"] += int(not passes)
        if difference is not None:
            row["maxAbsoluteDifference"] = money(max(
                dec(row.get("maxAbsoluteDifference", "0")), abs(difference)))

    def equal_money(self, name: str, actual: Any, expected: Decimal,
                    tolerance: Decimal = Decimal(0)) -> None:
        try:
            difference = dec(actual) - expected
        except ValueError:
            self.add(name, False)
            return
        self.add(name, abs(difference) <= tolerance, difference)

    def export(self) -> dict[str, dict[str, Any]]:
        return {key: {**value, "passed": value["failures"] == 0}
                for key, value in sorted(self.results.items())}

    @property
    def passed(self) -> bool:
        return all(item["failures"] == 0 for item in self.results.values())


def performance(points: list[tuple[str, Decimal]], initial: Decimal,
                start: str) -> dict[str, Any]:
    """Calendar-day annualization; initial capital is an explicit initial peak."""
    if not points or initial <= 0:
        raise ValueError("Performance requires points and positive initial value")
    peak = initial
    peak_date = start
    peak_is_initial = True
    maximum_drawdown = Decimal(0)
    drawdown: dict[str, Any] = {
        "peakDate": None, "troughDate": None, "peakNAV": None,
        "troughNAV": None, "peakIsInitialCapital": None,
        "tieConvention": "EARLIEST_PEAK_AND_FIRST_EQUAL_MAXIMUM_DRAWDOWN",
    }
    for when, nav in points:
        if nav < 0:
            raise ValueError("Negative NAV cannot establish performance")
        if nav > peak:
            peak, peak_date, peak_is_initial = nav, when, False
        loss = nav / peak - 1
        if loss < maximum_drawdown:
            maximum_drawdown = loss
            drawdown.update(peakDate=peak_date, troughDate=when,
                            peakNAV=money(peak), troughNAV=money(nav),
                            peakIsInitialCapital=peak_is_initial)
    elapsed = (date.fromisoformat(points[-1][0]) - date.fromisoformat(start)).days
    ratio = points[-1][1] / initial
    return {
        "startDate": start, "endDate": points[-1][0], "observations": len(points),
        "elapsedCalendarDays": elapsed, "annualization": "ACTUAL_DAYS_365_2425",
        "initialNAV": money(initial), "finalNAV": money(points[-1][1]),
        "cumulativeReturn": float(ratio - 1),
        "cagr": math.pow(float(ratio), 365.2425 / elapsed) - 1 if elapsed > 0 else None,
        "mdd": float(maximum_drawdown), "maximumDrawdownPeriod": drawdown,
        "terminalValuation": "LAST_SESSION_CLOSE_NO_FORCED_LIQUIDATION",
    }


def annual_returns(points: list[tuple[str, Decimal]], initial: Decimal,
                   start: str) -> list[dict[str, Any]]:
    """First year: initial capital. Later years: preceding observed year-end NAV."""
    by_year: dict[str, list[tuple[str, Decimal]]] = defaultdict(list)
    for item in points:
        by_year[item[0][:4]].append(item)
    result = []
    base, base_date = initial, start
    for index, (year, observations) in enumerate(sorted(by_year.items())):
        end_date, ending = observations[-1]
        result.append({
            "year": int(year), "firstSession": observations[0][0],
            "lastSession": end_date, "observations": len(observations),
            "baseDate": base_date, "baseNAV": money(base), "endingNAV": money(ending),
            "return": float(ending / base - 1) if base > 0 else None,
            "basis": "INITIAL_CAPITAL" if index == 0 else "PREVIOUS_OBSERVED_YEAR_END_NAV",
        })
        base, base_date = ending, end_date
    return result


def _intent(row: Mapping[str, Any]) -> tuple[str, str, str, str]:
    return (str(row.get("symbol", "")), str(row.get("side", "")),
            str(row.get("signalDate", "")), str(row.get("reason", "")))


def _audit(summary: Mapping[str, Any], contract: Mapping[str, Any],
           final_state: Mapping[str, Any], daily_nav: Iterable[Mapping[str, Any]],
           trades: Iterable[Mapping[str, Any]],
           benchmark_rows: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    checks = Checks()
    nav_rows, trade_rows = list(daily_nav), list(trades)
    summary = summary.get("US_A0", summary)
    start, end = iso_date(contract["startDate"]), iso_date(contract["endDate"])
    sessions = [iso_date(item) for item in contract["sessions"]]
    nav_dates = [iso_date(row["date"]) for row in nav_rows]
    if not nav_rows:
        raise ValueError("Empty daily NAV series")
    checks.add("contractCalendarStrictlyIncreasing", bool(sessions) and
               all(a < b for a, b in zip(sessions, sessions[1:])))
    checks.add("dailyNavCalendarStrictlyIncreasing", all(a < b for a, b in zip(nav_dates, nav_dates[1:])))
    checks.add("dailyNavExactContractCoverage", nav_dates == sessions)
    checks.add("contractCalendarBoundaries", bool(sessions) and sessions[0] == start and sessions[-1] == end)
    checks.equal_money("contractInitialCapital", contract.get("initialCapitalUsd"), INITIAL_CAPITAL)
    checks.equal_money("contractOneWayCost", contract.get("oneWayCost"), ONE_WAY_COST)
    checks.equal_money("finalStateInitialCapital", final_state.get("initialCapital"), INITIAL_CAPITAL)
    checks.add("finalStateEndDate", final_state.get("lastDate") == end)
    checks.add("finalStateStartDate", final_state.get("initializedDate") == start)
    allocation = final_state.get("allocationPolicy", {})
    checks.add("fixedSlotAllocationPolicy", allocation.get("version") == "us-initial-capital-slots-v1" and
               allocation.get("targetPositions") == 20 and allocation.get("quarterlyRebalance") is False and
               allocation.get("fundingOnlySales") is False)
    checks.equal_money("allocationInitialCapital", allocation.get("initialCapitalUsd"), INITIAL_CAPITAL)
    checks.add("noQuarterRebalanceState", final_state.get("lastQuarterRebalance") is None)
    policy = final_state.get("executionPolicy", {})
    checks.equal_money("executionInitialCapital", policy.get("initialCapital"), INITIAL_CAPITAL)
    checks.equal_money("executionOneWayCost", policy.get("oneWayCost"), ONE_WAY_COST)
    checks.add("executionIdentityMatchesContract", policy.get("bookId") == contract.get("bookId") and
               policy.get("contractHash") == contract.get("contractHash") and
               policy.get("accountingStartDate") == start)

    points: list[tuple[str, Decimal]] = []
    missing, stale = 0, 0
    for row in nav_rows:
        stale += int(row.get("valuationStatus") == "STALE" or bool(row.get("staleMarkSymbols")))
        try:
            value = dec(row.get("nav"))
            valid = value >= 0 and row.get("valuationStatus") != "MISSING"
        except ValueError:
            valid = False
        if valid:
            points.append((row["date"], value))
        else:
            missing += 1
    checks.add("completeNonstaleValuations", missing == 0 and stale == 0)
    metric = performance(points, INITIAL_CAPITAL, start) if points and not missing else None
    years = annual_returns(points, INITIAL_CAPITAL, start) if metric else []
    complete = bool(metric and metric["elapsedCalendarDays"] > 0 and not stale and nav_dates == sessions)
    comparisons: dict[str, Any] = {}
    for key in ("cumulativeReturn", "cagr", "mdd"):
        actual, expected = summary.get(key), metric[key] if complete else None
        if actual is None or expected is None:
            matches, difference = actual is None and expected is None, None
        else:
            try:
                difference = float(actual) - expected
                matches = math.isfinite(difference) and abs(difference) <= METRIC_ABSOLUTE_TOLERANCE
            except (TypeError, ValueError):
                matches, difference = False, None
        comparisons[key] = {"reported": float(actual) if actual is not None else None,
                            "recomputed": expected, "difference": difference, "matches": matches}
        checks.add("tsSummary_" + key, matches)
    for key, expected in (("startDate", start), ("endDate", nav_dates[-1]),
                          ("observations", len(nav_rows)), ("missingValuationCount", missing),
                          ("staleValuationCount", stale), ("annualization", "ACTUAL_DAYS_365_2425")):
        checks.add("tsSummary_" + key, summary.get(key) == expected)
    checks.add("tsSummary_status", summary.get("status") == ("COMPLETE" if complete else "INCOMPLETE"))
    checks.equal_money("tsSummary_initialCapital", summary.get("initialCapital"), INITIAL_CAPITAL)
    if metric and complete:
        checks.equal_money("tsSummary_finalNAV", summary.get("finalNAV"), dec(metric["finalNAV"]), NAV_ABSOLUTE_TOLERANCE)
        checks.add("tsSummary_elapsedCalendarDays", summary.get("elapsedCalendarDays") == metric["elapsedCalendarDays"])

    annual = contract.get("annualBudgetPolicy", {}).get("policyId") == "US_A0_ANNUAL_ENTRY_BUDGET_PRIOR_NAV_V1"
    budget_by_year = {}
    for annual_row in years:
        reference = dec(annual_row["baseNAV"]).quantize(QUANTUM)
        budget_by_year[str(annual_row["year"])] = (reference / 20).quantize(QUANTUM, rounding=ROUND_DOWN)
    def budget_for_signal(signal_date):
        return budget_by_year[str(signal_date)[:4]] if annual else SLOT_BUDGET
    if annual:
        annual_state = final_state.get("annualEntryBudgetResearch", {})
        snapshots = annual_state.get("byYear", {})
        checks.add("annualBudgetYearsComplete", set(map(str, snapshots)) == set(budget_by_year))
        checks.add("annualBudgetPolicyIdentity", annual_state.get("policyId") == "US_A0_ANNUAL_ENTRY_BUDGET_PRIOR_NAV_V1")
        for annual_row in years:
            year = str(annual_row["year"]); snapshot = snapshots.get(year, {})
            checks.equal_money("annualBudgetFromPriorNAV", snapshot.get("entryPrincipalUsd"), budget_by_year[year], QUANTUM)
            checks.equal_money("annualBudgetReferenceNAV", snapshot.get("referenceNavUsd"), dec(annual_row["baseNAV"]), QUANTUM)
            checks.add("annualBudgetNoCurrentYearNAV", snapshot.get("sourceDate") in (None, annual_row["baseDate"]) if year == start[:4] else snapshot.get("sourceDate") == annual_row["baseDate"])
    proxy_fills = 0
    pending_rows = Counter()
    status_counts: dict[str, Counter[str]] = {"EXECUTED": Counter(), "PARTIAL": Counter()}
    all_signals, pending_signals, filled_signals = set(), set(), set()
    trade_keys, fills_by_date = set(), defaultdict(list)
    intent_gross: dict[tuple[str, str, str, str], Decimal] = defaultdict(Decimal)
    last_execution = ""
    for trade in trade_rows:
        status, side = trade.get("status"), trade.get("side")
        intent = _intent(trade)
        all_signals.add(intent)
        checks.add("onlyBuySellSides", side in {"BUY", "SELL"})
        checks.add("noRebalanceOrFundingReason", not any(token in str(trade.get("reason", "")).upper()
                   for token in ("QUARTER", "REBALANCE", "FUNDING")))
        checks.add("tradeSignalInsidePeriod", start <= str(trade.get("signalDate", "")) <= end)
        if status == "PENDING":
            pending_rows[str(side)] += 1
            pending_signals.add(intent)
            checks.add("pendingNotExecuted", trade.get("executionDate") is None and trade.get("modelPrice") is None)
            checks.equal_money("pendingHasZeroFee", trade.get("feeUsd"), Decimal(0))
            if side == "BUY":
                checks.equal_money("pendingEntryRemainingGrossBudget", trade.get("modelNotional"),
                                   budget_for_signal(intent[2]) - intent_gross[intent])
            continue
        checks.add("fillStatusValid", status in status_counts)
        if status not in status_counts:
            continue
        status_counts[status][str(side)] += 1
        filled_signals.add(intent)
        execution = iso_date(trade["executionDate"])
        checks.add("fillDateInNavCalendar", execution in nav_dates)
        checks.add("fillOrderChronological", execution >= last_execution)
        proxy = trade.get("reason") == "US_A0_ALL_HELD_LAST_VALID_CLOSE_EXIT_V1"
        if proxy:
            proxy_fills += 1
            detail = trade.get("detail", {})
            checks.add("proxyCloseRecognitionOnly", side == "SELL" and status == "EXECUTED" and execution == iso_date(trade["signalDate"]) and detail.get("trigger_session_date") == execution and detail.get("retrospective_exit_proxy") is True and detail.get("retroactive_nav_rewrite") is False and detail.get("corporate_actions_modeled") is False)
            checks.add("proxyPriorObservedPrice", str(detail.get("reference_price_date", "")) < execution and abs(dec(detail.get("reference_price")) - dec(trade.get("modelPrice"))) <= Decimal("0.0000000051"))
        checks.add("executionAfterSignal", execution > iso_date(trade["signalDate"]) or proxy and execution == iso_date(trade["signalDate"]))
        last_execution = execution
        key = trade.get("tradeKey")
        checks.add("fillTradeKeyUnique", isinstance(key, str) and key not in trade_keys)
        trade_keys.add(key)
        try:
            quantity = dec(trade.get("modelShares"))
            price = dec(trade.get("modelPrice"))
            valid_quantity = quantity > 0 and quantity == quantity.to_integral_value() and quantity <= MAX_SAFE_INTEGER
            valid_price = price > 0 and price <= MAX_SAFE_INTEGER and price == price.quantize(QUANTUM)
        except (ValueError, InvalidOperation):
            valid_quantity = valid_price = False
        checks.add("positiveSafeIntegerFillQuantity", valid_quantity)
        checks.add("priceExactAtEightDecimals", valid_price)
        if not valid_quantity or not valid_price or side not in {"BUY", "SELL"}:
            continue
        gross = price * quantity
        fee = (gross * ONE_WAY_COST).quantize(QUANTUM, rounding=ROUND_CEILING)
        checks.equal_money("fillNotionalEqualsPriceTimesShares", trade.get("modelNotional"), gross)
        checks.equal_money("fillFeeCeilingEightDecimals", trade.get("feeUsd"), fee)
        if side == "BUY":
            intent_gross[intent] += gross
            checks.add("entryIntentGrossBudget", intent_gross[intent] <= budget_for_signal(intent[2]))
            checks.add("entryReason", trade.get("reason") == "ENTRY_ONSET80")
        fills_by_date[execution].append((trade, int(quantity), gross, fee))

    cash, fee_total = INITIAL_CAPITAL, Decimal(0)
    reported_fee_total, buy_gross, sell_gross = Decimal(0), Decimal(0), Decimal(0)
    positions: dict[str, int] = {}
    active_intent: dict[str, tuple[str, str, str, str]] = {}
    lifecycle_gross: dict[str, Decimal] = defaultdict(Decimal)
    completed_lifecycles = 0
    minimum_cash = cash
    maximum_positions = 0
    max_lifecycle_gross = Decimal(0)
    for row in nav_rows:
        daily_fee = Decimal(0)
        for trade, quantity, gross, fee in fills_by_date[row["date"]]:
            symbol, side = trade["symbol"], trade["side"]
            current = positions.get(symbol, 0)
            if side == "BUY":
                checks.add("noHeldPositionNewEntryIntent", not current or active_intent.get(symbol) == _intent(trade))
                if not current:
                    active_intent[symbol] = _intent(trade)
                    lifecycle_gross[symbol] = Decimal(0)
                lifecycle_gross[symbol] += gross
                max_lifecycle_gross = max(max_lifecycle_gross, lifecycle_gross[symbol])
                checks.add("positionLifecycleGrossBudget", lifecycle_gross[symbol] <= budget_for_signal(active_intent[symbol][2]))
                positions[symbol] = current + quantity
                cash -= gross + fee
                buy_gross += gross
            else:
                checks.add("noShortOrExcessSellQuantity", current >= quantity > 0)
                remaining = current - quantity
                checks.add("sellStatusMatchesRemainingShares", (trade["status"] == "PARTIAL") == (remaining > 0))
                if remaining:
                    positions[symbol] = remaining
                else:
                    positions.pop(symbol, None)
                    active_intent.pop(symbol, None)
                    lifecycle_gross.pop(symbol, None)
                    completed_lifecycles += 1
                cash += gross - fee
                sell_gross += gross
            daily_fee += fee
            fee_total += fee
            reported_fee_total += dec(trade["feeUsd"])
            minimum_cash = min(minimum_cash, cash)
            maximum_positions = max(maximum_positions, len(positions))
            checks.add("nonnegativeCashAfterEveryFill", cash >= 0)
            checks.add("positionLimitAfterEveryFill", len(positions) <= 20)
        checks.equal_money("dailyCashReconstruction", row.get("cash"), cash)
        checks.equal_money("dailyFeeReconstruction", row.get("fees"), daily_fee)
        checks.add("dailyPositionCountReconstruction", row.get("positionCount") == len(positions))

    final_positions = final_state.get("positions", {})
    checks.add("finalPositionSymbolsReconstruction", set(final_positions) == set(positions))
    for symbol, position in final_positions.items():
        checks.add("finalPositionQuantityReconstruction", dec(position.get("shares")) == positions.get(symbol, 0))
    checks.equal_money("finalExactCashReconstruction", final_state.get("modelCashExact"), cash)
    checks.equal_money("finalCashNumberReconstruction", final_state.get("cash"), cash)
    checks.equal_money("finalExactFeesReconstruction", final_state.get("modelFeesExact"), fee_total)
    checks.equal_money("finalFeesNumberReconstruction", final_state.get("totalFees"), fee_total)
    checks.equal_money("totalReportedFeesEqualRecomputed", reported_fee_total, fee_total)
    final_marks = sum((dec(item["shares"]) * dec(item["lastPrice"]) for item in final_positions.values()), Decimal(0))
    checks.equal_money("finalNavFromExactCashAndMarks", nav_rows[-1].get("nav"), cash + final_marks,
                       max(NAV_ABSOLUTE_TOLERANCE, Decimal(str(math.ulp(float(cash + final_marks)))) * 8))
    for pending in final_state.get("pendingTargets", {}).values():
        checks.add("finalPendingIsEntry", pending.get("reason") == "ENTRY_ONSET80")
        checks.equal_money("finalPendingFixedGrossBudget", pending.get("fixedBudgetUsd"), budget_for_signal(pending["signalDate"]))
        intent = (pending["symbol"], "BUY", pending["signalDate"], pending["reason"])
        checks.equal_money("finalPendingRemainingGrossBudget", pending.get("remainingBudgetUsd"),
                           budget_for_signal(intent[2]) - intent_gross[intent])
        checks.equal_money("finalPendingTargetWeight", pending.get("targetWeight"), Decimal("0.05"))
        if "fixedTargetShares" in pending:
            target = dec(pending["fixedTargetShares"])
            checks.add("finalPendingFixedTargetSafeInteger", target >= 0 and target == target.to_integral_value()
                       and target <= MAX_SAFE_INTEGER)
    for pending in final_state.get("pendingExits", {}).values():
        checks.add("finalPendingExitHasHolding", pending.get("symbol") in final_positions)
        checks.add("finalPendingExitNotFunding", not any(token in str(pending.get("reason", "")).upper()
                   for token in ("QUARTER", "REBALANCE", "FUNDING")))

    benchmark_map: dict[str, Decimal] = {}
    benchmark_duplicates, benchmark_invalid, benchmark_input_count = 0, 0, 0
    wanted = set(nav_dates)
    for row in benchmark_rows:
        benchmark_input_count += 1
        # Access no columns besides the independently supplied date and SPY close.
        when = iso_date(row["dt"])
        if when not in wanted:
            continue
        if when in benchmark_map:
            benchmark_duplicates += 1
        try:
            price = dec(row["spy_close"])
            if price <= 0:
                raise ValueError("Nonpositive benchmark close")
            benchmark_map[when] = price
        except ValueError:
            benchmark_invalid += 1
    benchmark_missing = len(wanted - set(benchmark_map))
    benchmark_complete = not (benchmark_missing or benchmark_duplicates or benchmark_invalid)
    checks.add("benchmarkExactSameSessionCoverage", benchmark_complete)
    benchmark: dict[str, Any] = {
        "seriesName": "SPY supplied adjusted-close benchmark (dividend total return not certified)",
        "dividendTotalReturnCertified": False,
        "normalization": "INITIAL_CAPITAL_AT_FIRST_REPLAY_SESSION_CLOSE",
        "alignment": "EXACT_REPLAY_DATES_NO_FORWARD_FILL_OR_BACKFILL",
        "inputRows": benchmark_input_count, "matchedSessions": len(benchmark_map),
        "missingSessions": benchmark_missing, "duplicateSessions": benchmark_duplicates,
        "invalidPricesInPeriod": benchmark_invalid,
        "status": "COMPLETE" if benchmark_complete else "INCOMPLETE",
        "performance": None, "annualReturns": [],
    }
    if benchmark_complete:
        base = benchmark_map[nav_dates[0]]
        benchmark_points = [(when, INITIAL_CAPITAL * benchmark_map[when] / base) for when in nav_dates]
        benchmark.update(initialClose=money(base), finalClose=money(benchmark_map[nav_dates[-1]]),
                         performance=performance(benchmark_points, INITIAL_CAPITAL, start),
                         annualReturns=annual_returns(benchmark_points, INITIAL_CAPITAL, start))
        checks.equal_money("finalBenchmarkBasePrice", final_state.get("benchmarkBasePrice"), base)
        checks.add("finalBenchmarkBaseDate", final_state.get("benchmarkBaseDate") == nav_dates[0])

    def signal_counts(signals: set[tuple[str, str, str, str]]) -> dict[str, int]:
        counts = Counter(signal[1] for signal in signals)
        return {"BUY": counts["BUY"], "SELL": counts["SELL"], "total": len(signals)}

    counts = {status: {"BUY": count["BUY"], "SELL": count["SELL"], "total": sum(count.values())}
              for status, count in status_counts.items()}
    counts["allFills"] = {key: counts["EXECUTED"][key] + counts["PARTIAL"][key]
                          for key in ("BUY", "SELL", "total")}
    return {
        "auditVersion": "us-a0-independent-math-v1",
        "status": "PASS" if checks.passed else "FAIL",
        "arithmeticAndLedgerChecksPassed": checks.passed,
        "scope": "RETROSPECTIVE_RESEARCH_MODEL_NOT_ACTUAL_ACCOUNT",
        "performance": metric, "annualReturns": years,
        "valuationQuality": {"missingSessions": missing, "staleSessions": stale,
                             "completeNonstaleExactCoverage": complete},
        "tsSummaryComparison": comparisons,
        "tradeCounts": {**counts, "rawRows": len(trade_rows),
                        "pendingRows": {"BUY": pending_rows["BUY"], "SELL": pending_rows["SELL"],
                                        "total": sum(pending_rows.values())},
                        "uniqueSignalIntents": signal_counts(all_signals),
                        "uniquePendingIntents": signal_counts(pending_signals),
                        "uniqueFilledIntents": signal_counts(filled_signals),
                        "finalPendingEntries": len(final_state.get("pendingTargets", {})),
                        "finalPendingExits": len(final_state.get("pendingExits", {}))},
        "ledger": {"initialCashExact": money(INITIAL_CAPITAL), "finalCashExact": money(cash),
                   "totalFeesExact": money(fee_total), "reportedFillFeesExact": money(reported_fee_total),
                   "buyGrossExact": money(buy_gross), "sellGrossExact": money(sell_gross),
                   "minimumCashAfterFillExact": money(minimum_cash),
                   "finalHoldingsMarkedValueExact": money(final_marks),
                   "finalNAVFromCashAndMarksExact": money(cash + final_marks),
                   "finalPositionCount": len(positions), "maximumPositionCount": maximum_positions,
                   "completedPositionLifecycles": completed_lifecycles,
                   "fixedGrossEntryBudgetExact": None if annual else money(SLOT_BUDGET),
                   "annualGrossEntryBudgets": {year:money(value) for year,value in budget_by_year.items()} if annual else {},
                   "retrospectiveProxyExitFills": proxy_fills,
                   "maximumEntryIntentGrossExact": money(max(intent_gross.values(), default=Decimal(0))),
                   "maximumPositionLifecycleGrossExact": money(max_lifecycle_gross),
                   "oneWayCost": money(ONE_WAY_COST), "feeRounding": "CEILING_EACH_FILL_TO_0.00000001"},
        "benchmark": benchmark, "checks": checks.export(),
        "limitations": [
            "Aggregate arithmetic audit; does not re-run signal selection or certify source data/provenance.",
            "Daily cash, fees and quantities are independently rebuilt; daily marked holding values cannot be rebuilt without daily security quotes.",
            "Each new signal uses its authorized annual or fixed principal / 20; fees are separate and prior pending intent budgets remain frozen.",
            "The frozen target quantity at the first executable open cannot be independently certified from fill-only data, because zero-fill opens are absent.",
            "Repeated PENDING snapshots are not executions; distinct signal intents use symbol, side, signal date and reason.",
            "SPY adjustment and dividend completeness are not certified; this is not labeled a verified dividend total-return series.",
            "No future-return labels are read or used. Terminal positions are marked, not forcibly liquidated.",
            "Research using current rules and universe is retrospective, not independent out-of-sample evidence or actual-account performance.",
        ],
    }


def audit_records(summary: Mapping[str, Any], contract: Mapping[str, Any],
                  final_state: Mapping[str, Any], daily_nav: Iterable[Mapping[str, Any]],
                  trades: Iterable[Mapping[str, Any]],
                  benchmark_rows: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """Pure calculation; inputs are never mutated; returns JSON-serializable aggregates."""
    with localcontext() as context:
        context.prec = 50
        return _audit(summary, contract, final_state, daily_nav, trades, benchmark_rows)


def _read_json(path: str | Path) -> Any:
    with Path(path).open(encoding="utf-8") as handle:
        return json.load(handle, parse_float=Decimal)


def _read_jsonl(path: str | Path) -> Iterable[Mapping[str, Any]]:
    with Path(path).open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                yield json.loads(line, parse_float=Decimal)


def _read_benchmark_parquet(path: str | Path) -> Iterable[Mapping[str, Any]]:
    try:
        import pyarrow.parquet as parquet
    except ImportError:
        try:
            import pandas as pd
            frame = pd.read_parquet(path, columns=["dt", "spy_close"])
        except ImportError as exc:
            raise RuntimeError("Parquet input requires pyarrow or pandas with a Parquet engine; pure audit_records needs neither") from exc
        return frame.to_dict(orient="records")
    names=set(parquet.ParquetFile(path).schema_arrow.names)
    if {"dt","spy_close"} <= names:
        return parquet.read_table(path, columns=["dt", "spy_close"]).to_pylist()
    if {"date","closeadj"} <= names:
        return [{"dt":r["date"],"spy_close":r["closeadj"]} for r in parquet.read_table(path,columns=["date","closeadj"]).to_pylist()]
    raise ValueError("Unsupported verified SPY benchmark schema")


def audit_files(summary_path: str | Path, contract_path: str | Path,
                final_state_path: str | Path, daily_nav_path: str | Path,
                trades_path: str | Path, benchmark_parquet_path: str | Path) -> dict[str, Any]:
    return audit_records(_read_json(summary_path), _read_json(contract_path),
                         _read_json(final_state_path), _read_jsonl(daily_nav_path),
                         _read_jsonl(trades_path), _read_benchmark_parquet(benchmark_parquet_path))


def audit_result(result_dir: Path, benchmark_path: Path) -> dict[str, Any]:
    """Filesystem entrypoint with fixed, non-sensitive error codes only.

    Source byte/SHA provenance must be verified by the caller. This function does
    not write any source or output file. Read/parser errors fail closed.
    """
    root = Path(result_dir)
    try:
        result = audit_files(root / "summary.json", root / "US_A0.contract.json",
                             root / "US_A0.final-state.json", root / "US_A0.daily-nav.jsonl",
                             root / "US_A0.trades.jsonl", benchmark_path)
        budgets = _read_json(root / "US_A0.yearly-budgets.json")
        annual = result["ledger"]["fixedGrossEntryBudgetExact"] is None
        valid = (budgets.get("policy") == ("US_A0_ANNUAL_ENTRY_BUDGET_PRIOR_NAV_V1" if annual else "FIXED_INITIAL_CAPITAL_DIV_20_NO_REBALANCE") and
                 budgets.get("yearlyReset") is annual and dec(budgets.get("initialCapital")) == INITIAL_CAPITAL)
        result["checks"]["yearlyBudgetPolicy"] = {"checked": 1, "failures": int(not valid), "passed": valid}
        if not valid:
            result["status"] = "FAIL"
            result["arithmeticAndLedgerChecksPassed"] = False
        return result
    except AuditError:
        raise
    except FileNotFoundError:
        raise AuditError("AUDIT_INPUT_FILE_MISSING") from None
    except PermissionError:
        raise AuditError("AUDIT_INPUT_ACCESS_DENIED") from None
    except json.JSONDecodeError:
        raise AuditError("AUDIT_INVALID_JSON") from None
    except (ImportError, RuntimeError):
        raise AuditError("AUDIT_PARQUET_READER_UNAVAILABLE") from None
    except (KeyError, TypeError, ValueError, InvalidOperation, OverflowError, ZeroDivisionError):
        raise AuditError("AUDIT_INVALID_INPUT_SCHEMA_OR_VALUE") from None
    except OSError:
        raise AuditError("AUDIT_INPUT_IO_ERROR") from None
    except Exception:
        raise AuditError("AUDIT_UNEXPECTED_CALCULATION_ERROR") from None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--result-dir", type=Path, required=True)
    parser.add_argument("--benchmark", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = audit_result(args.result_dir, args.benchmark)
    except AuditError as exc:
        print(json.dumps({"status": "ERROR", "error": str(exc)}))
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))
    return 0 if result["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
