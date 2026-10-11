"""Fail-closed, research-only KOSPI strategy vs KODEX 200 total-return comparison.

Never fetches mutable live inputs, writes operational tables, or infers missing
distributions. A certified *current-policy* stock NAV is an upstream prerequisite.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import random
import statistics
import sys
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Sequence

POLICY_ID = "kospi-20261012-fixedcapital-e8-confirm1-u95-h60-v1"
BENCHMARK_SYMBOL = "069500"
START = "2018-01-02"
END = "2026-09-11"
INITIAL_CAPITAL = 100_000_000.0
ONE_WAY_FEE = 0.0015
LOOKBACK = 63
ARMS = ("stock", "etf_100", "etf_vol_matched", "etf_gate", "etf_exposure_matched")
REQUIRED = {
    "stock_nav": ("date", "nav", "stock_exposure"),
    "kodex200_total_return": ("date", "open_tr", "close_tr"),
    "kospi_market_gate": ("date", "status"),
    "krx_sessions": ("date",),
}


class DataNotReady(ValueError):
    """Raised rather than computing a misleading investment recommendation."""


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise DataNotReady(message)


def _day(value: str) -> str:
    try:
        parsed = date.fromisoformat(value)
        _assert(parsed.isoformat() == value, "Invalid ISO date " + repr(value))
    except ValueError as exc:
        raise DataNotReady("Invalid ISO date " + repr(value)) from exc
    return value


def _number(value: Any, context: str, *, min_value: float | None = None) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise DataNotReady("Non-numeric " + context) from exc
    _assert(math.isfinite(parsed), "Non-finite " + context)
    if min_value is not None:
        _assert(parsed >= min_value, "Out-of-range " + context)
    return parsed


def _sha256(file: Path) -> str:
    digest = hashlib.sha256()
    with file.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


@dataclass
class VerifiedInputs:
    manifest: dict[str, Any]
    hashes: dict[str, str]
    stock: dict[str, dict[str, str]]
    etf: dict[str, dict[str, str]]
    gate: dict[str, dict[str, str]]
    sessions: list[str]
    start: str
    end: str


def _read_unique_csv(source: Path, columns: tuple[str, ...]) -> dict[str, dict[str, str]]:
    with source.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        _assert(reader.fieldnames is not None, f"Empty CSV: {source.name}")
        _assert(set(columns).issubset(reader.fieldnames), f"Missing columns in {source.name}: {columns}")
        rows: dict[str, dict[str, str]] = {}
        for row in reader:
            if row.get("date") is None:
                raise DataNotReady(f"Empty date in {source.name}")
            dt = _day(row["date"].strip())
            _assert(dt not in rows, f"Duplicate date {dt} in {source.name}")
            rows[dt] = row
    _assert(bool(rows), f"No data in {source.name}")
    return rows


def load_verified_inputs(manifest_path: Path, start: str = START, end: str = END) -> VerifiedInputs:
    """Provenance validation MUST succeed before results are produced."""
    start, end = _day(start), _day(end)
    _assert(start <= end, "start must not be later than end")
    with manifest_path.open("r", encoding="utf-8") as handle:
        config: dict[str, Any] = json.load(handle)
    _assert(config.get("schema") == "KOSPI200_COMPARISON_INPUT_V1", "Wrong manifest schema")
    _assert(config.get("stock_policy_id") == POLICY_ID, "Stock replay is not the pinned 2026-10-12 strategy")
    _assert(config.get("benchmark_symbol") == BENCHMARK_SYMBOL, "Only KODEX 200 (069500) is certified in this run")
    _assert(config.get("benchmark_price_basis") == "audited_total_return_adjusted_ohlc", "Adjusted raw prices are NOT a verified dividend-reinvested total-return series")
    for name in ("stock_replay_verified", "benchmark_distribution_verified", "gate_point_in_time_verified", "krx_calendar_verified", "stock_corporate_actions_reviewed", "stock_cash_distributions_verified", "stock_pit_universe_verified", "stock_execution_replay_verified"):
        _assert(config.get(name) is True, f"Certification missing: {name}")
    for name in ("stock_replay_commit", "stock_replay_evidence", "benchmark_distribution_evidence", "gate_evidence", "calendar_evidence"):
        _assert(isinstance(config.get(name), str) and len(config[name].strip()) >= 12, f"Missing provenance: {name}")
    _assert(isinstance(config.get("stock_replay_policy_sha256"), str) and len(config["stock_replay_policy_sha256"]) == 64 and all(c in "0123456789abcdef" for c in config["stock_replay_policy_sha256"]), "Missing stock replay policy hash")
    _assert(config.get("stock_budget_policy") == "initial_capital_divided_by_30", "Historical annual-prior-NAV budget is NOT today's policy")
    _assert(config.get("stock_one_way_fee") == ONE_WAY_FEE, "Stock fees differ from compared 0.15% one-way ETF cost")
    _assert(config.get("stock_nav_basis") == "post_cost_mark_to_market", "Stock NAV must include open holdings and trading fees")

    files = config.get("sources")
    _assert(isinstance(files, dict), "Missing sources map")
    root = manifest_path.resolve().parent
    parsed: dict[str, dict[str, dict[str, str]]] = {}
    hashes: dict[str, str] = {}
    for key, columns in REQUIRED.items():
        item = files.get(key)
        _assert(isinstance(item, dict), f"Missing source {key}")
        rel = item.get("path")
        expected_sha = item.get("sha256")
        _assert(isinstance(rel, str) and rel.strip(), f"Missing file path: {key}")
        _assert(isinstance(expected_sha, str) and len(expected_sha) == 64 and all(c in "0123456789abcdef" for c in expected_sha), f"Missing SHA-256: {key}")
        target = (root / rel).resolve()
        _assert(target.is_relative_to(root), f"Unsafe source path: {key}")
        _assert(target.is_file(), f"Missing source file: {key} -> {target}")
        actual_sha = _sha256(target)
        _assert(actual_sha == expected_sha, f"SHA-256 mismatch for {key}")
        hashes[key] = actual_sha
        parsed[key] = _read_unique_csv(target, columns)

    sessions = sorted(parsed["krx_sessions"])
    _assert(start in sessions and end in sessions, "Requested start/end must be actual verified exchange sessions")
    prestart = [d for d in sessions if d < start]
    _assert(len(prestart) >= LOOKBACK + 1, f"Need at least {LOOKBACK + 1} pre-start exchange closes for causal volatility")
    relevant = [d for d in sessions if prestart[-(LOOKBACK + 1)] <= d <= end]
    required = set(relevant)
    for key in ("stock_nav", "kodex200_total_return", "kospi_market_gate"):
        missing = sorted(required - parsed[key].keys())
        _assert(not missing, f"Missing {len(missing)} {key} exchange sessions, first {missing[:5]}")
    # 2018..2024 complete calendar years, 2025 complete, 2026 only through the
    # explicitly pinned end. Earlier or later periods must be declared separately.
    if start == START and end == END:
        _assert(all(str(y) in {d[:4] for d in sessions if start <= d <= end} for y in range(2018, 2027)), "Missing full research-year coverage")
    # A mere dated file is not proof of complete historical coverage.
    # Each full calendar year has many sessions; the separate certified KRX
    # calendar is the stronger authority on exact holiday/session dates.
    for year in range(2018, 2026):
        if start <= f"{year}-01-02" and end >= f"{year}-12-28":
            count = sum(dt.startswith(str(year)) for dt in sessions)
            _assert(count >= 190, f"Suspiciously sparse KRX calendar year {year}: {count}")
    for dt in relevant:
        stock = parsed["stock_nav"][dt]
        _number(stock["nav"], f"stock NAV {dt}", min_value=0.000001)
        _number(stock["stock_exposure"], f"stock exposure {dt}", min_value=0.0)
        _assert(float(stock["stock_exposure"]) <= 1.00000001, f"Leveraged stock exposure {dt}")
        etf = parsed["kodex200_total_return"][dt]
        op = _number(etf["open_tr"], f"ETF open {dt}", min_value=0.000001)
        cl = _number(etf["close_tr"], f"ETF close {dt}", min_value=0.000001)
        _assert(0.25 < cl / op < 4.0, f"Extreme unreviewed ETF open/close adjustment at {dt}")
        gate = parsed["kospi_market_gate"][dt]
        _assert(gate["status"] in ("RISK_ON", "NEUTRAL", "RISK_OFF", "UNKNOWN"), f"Unknown gate label {dt}")
        # Gate is dated at its decision close, not backfilled from future observations.
        _assert(gate.get("asof_date") == dt, f"Missing as-of provenance for gate {dt}")
        _assert(gate.get("available_after_close") == "true", f"Missing close-time availability for gate {dt}")
    return VerifiedInputs(config, hashes, parsed["stock_nav"], parsed["kodex200_total_return"], parsed["kospi_market_gate"], sessions, start, end)


def sample_vol(returns: Sequence[float]) -> float:
    return statistics.stdev(returns) if len(returns) >= 2 else 0.0


def causal_weight(dates: list[str], index: int, stock: dict[str, dict[str, str]], etf: dict[str, dict[str, str]]) -> float:
    """Index is today's open. Only closes strictly before today are included."""
    past = dates[index - LOOKBACK - 1:index]
    if len(past) != LOOKBACK + 1:
        raise DataNotReady("Missing causal volatility window")
    sr = [float(stock[past[i]]["nav"]) / float(stock[past[i - 1]]["nav"]) - 1 for i in range(1, len(past))]
    er = [float(etf[past[i]]["close_tr"]) / float(etf[past[i - 1]]["close_tr"]) - 1 for i in range(1, len(past))]
    sv, ev = sample_vol(sr), sample_vol(er)
    if ev < 1e-10:
        return 0.0 if sv == 0 else 1.0
    return min(1.0, max(0.0, sv / ev))


@dataclass
class EtfAccount:
    cash: float = INITIAL_CAPITAL
    units: float = 0.0
    fees: float = 0.0
    turnover_notional: float = 0.0

    def trade_at_open(self, price: float, target_weight: float) -> None:
        """Fractional *synthetic total-return* units; not literal broker fills."""
        _assert(0.0 <= target_weight <= 1.0, "ETF weight outside cash-only range")
        before = self.cash + price * self.units
        equity = self.units * price
        numerator = target_weight * before - equity
        denominator = 1 + target_weight * ONE_WAY_FEE if numerator >= 0 else 1 - target_weight * ONE_WAY_FEE
        trade_value = numerator / denominator
        fee = abs(trade_value) * ONE_WAY_FEE
        self.cash -= trade_value + fee
        self.units += trade_value / price
        if abs(self.cash) < 1e-7:
            self.cash = 0
        _assert(self.cash >= -1e-5 and self.units >= -1e-8, "Negative cash/ETF position after trade")
        self.fees += fee
        self.turnover_notional += abs(trade_value)

    def close_nav(self, price: float) -> float:
        return self.cash + self.units * price


def simulate(inp: VerifiedInputs) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    all_days = [dt for dt in inp.sessions if dt <= inp.end]
    traded_days = [dt for dt in all_days if dt >= inp.start]
    first_idx = all_days.index(inp.start)
    stock_reference = float(inp.stock[all_days[first_idx - 1]]["nav"])
    accounts = {name: EtfAccount() for name in ARMS if name != "stock"}
    trace: list[dict[str, Any]] = []
    previous_month: str | None = None
    previous_gate_target: float | None = None
    previous_exposure_target: float | None = None
    for idx in range(first_idx, len(all_days)):
        dt = all_days[idx]
        prev = all_days[idx - 1]
        price = inp.etf[dt]
        open_tr, close_tr = float(price["open_tr"]), float(price["close_tr"])
        month = dt[:7]
        # From exactly the previous exchange close; UNKNOWN is not risk-on.
        gate_target = 1.0 if inp.gate[prev]["status"] in ("RISK_ON", "NEUTRAL") else 0.0
        exposure_target = float(inp.stock[prev]["stock_exposure"])
        if idx == first_idx:
            accounts["etf_100"].trade_at_open(open_tr, 1.0)
        if month != previous_month:
            vol_target = causal_weight(all_days, idx, inp.stock, inp.etf)
            accounts["etf_vol_matched"].trade_at_open(open_tr, vol_target)
        if previous_gate_target is None or gate_target != previous_gate_target:
            accounts["etf_gate"].trade_at_open(open_tr, gate_target)
        if previous_exposure_target is None or abs(exposure_target - previous_exposure_target) > 1e-12:
            accounts["etf_exposure_matched"].trade_at_open(open_tr, exposure_target)
        stock_nav = INITIAL_CAPITAL * float(inp.stock[dt]["nav"]) / stock_reference
        row: dict[str, Any] = {
            "date": dt,
            "stock": stock_nav,
            "stock_exposure": float(inp.stock[dt]["stock_exposure"]),
            "gate_decision_date": prev,
            "gate_decision": inp.gate[prev]["status"],
            "gate_etf_target": gate_target,
            "mirror_target": exposure_target,
        }
        for arm, account in accounts.items():
            row[arm] = account.close_nav(close_tr)
        trace.append(row)
        previous_month = month
        previous_gate_target = gate_target
        previous_exposure_target = exposure_target
    return trace, {
        arm: {"total_fees_krw": round(a.fees, 4), "total_turnover_krw": round(a.turnover_notional, 4)}
        for arm, a in accounts.items()
    }


def _returns(rows: list[dict[str, Any]], arm: str, *, prior_nav: float | None = None) -> list[float]:
    previous = INITIAL_CAPITAL if prior_nav is None else prior_nav
    values: list[float] = []
    for row in rows:
        current = float(row[arm])
        _assert(current > 0, f"Nonpositive {arm} NAV at {row['date']}")
        values.append(current / previous - 1)
        previous = current
    return values


def metrics(ret: Sequence[float]) -> dict[str, float | None]:
    if not ret:
        return {"cumulative": None, "cagr": None, "sharpe": None, "mdd": None, "volatility": None, "calmar": None}
    equity, peak, mdd = 1.0, 1.0, 0.0
    for r in ret:
        _assert(-1 < r < 100, "Unreviewed return outlier")
        equity *= 1 + r
        peak = max(peak, equity)
        mdd = min(mdd, equity / peak - 1)
    annual = equity ** (252 / len(ret)) - 1
    vol = sample_vol(ret) * math.sqrt(252)
    sharpe = (statistics.mean(ret) / sample_vol(ret) * math.sqrt(252)) if sample_vol(ret) > 1e-12 else None
    return {
        "cumulative": equity - 1,
        "cagr": annual,
        "sharpe": sharpe,
        "mdd": mdd,
        "volatility": vol,
        "calmar": annual / abs(mdd) if mdd < -1e-12 else None,
    }


def _sequence_metrics(rows: list[dict[str, Any]], arms: Sequence[str]) -> dict[str, Any]:
    # Each filtered period is calculated by chaining only the included daily
    # returns, instead of dividing by a NAV immediately before an excluded year.
    return {name: metrics([r for _, r in rows_to_returns(rows, name)]) for name in arms}


def rows_to_returns(rows: list[dict[str, Any]], arm: str) -> list[tuple[str, float]]:
    result: list[tuple[str, float]] = []
    prev = INITIAL_CAPITAL
    for row in rows:
        current = float(row[arm])
        result.append((row["date"], current / prev - 1))
        prev = current
    return result


def _filtered_metrics(dated_returns: dict[str, list[tuple[str, float]]], predicate) -> dict[str, Any]:
    return {arm: metrics([r for dt, r in vals if predicate(dt)]) for arm, vals in dated_returns.items()}


def block_bootstrap_mean_spread(a: Sequence[float], b: Sequence[float], *,
                                seed: int = 20261012, iterations: int = 500,
                                block: int = 20) -> dict[str, float | int]:
    """Paired fixed-block bootstrap: descriptive uncertainty, NOT fresh OOS evidence."""
    _assert(len(a) == len(b) and len(a) > block, "Insufficient paired bootstrap observations")
    rng = random.Random(seed)
    n = len(a)
    spreads = [x - y for x, y in zip(a, b)]
    samples: list[float] = []
    for _ in range(iterations):
        drawn: list[float] = []
        while len(drawn) < n:
            first = rng.randrange(0, n - block + 1)
            drawn.extend(spreads[first:first + block])
        samples.append(statistics.mean(drawn[:n]) * 252)
    samples.sort()
    return {
        "annualized_arithmetic_mean_excess": statistics.mean(spreads) * 252,
        "ci95_low": samples[int(iterations * 0.025)],
        "ci95_high": samples[min(iterations - 1, int(iterations * 0.975))],
        "bootstrap_iterations": iterations,
        "block_sessions": block,
    }


def analyze(rows: list[dict[str, Any]], *, first_year: int = 2018) -> dict[str, Any]:
    _assert(len(rows) > 504, "Need at least two years of sessions to make a full-period judgement")
    dates = [r["date"] for r in rows]
    _assert(dates == sorted(set(dates)), "Unsorted or duplicated NAV dates")
    dated = {arm: rows_to_returns(rows, arm) for arm in ARMS}
    all_ret = {arm: [r for _, r in dated[arm]] for arm in ARMS}
    end_year = int(dates[-1][:4])
    by_year = {
        str(y): _filtered_metrics(dated, lambda dt, y=y: dt[:4] == str(y))
        for y in range(first_year, end_year + 1)
    }
    segments = {
        "full": _filtered_metrics(dated, lambda _: True),
        "2018_2024": _filtered_metrics(dated, lambda dt: "2018" <= dt[:4] <= "2024"),
        "2025_only": _filtered_metrics(dated, lambda dt: dt.startswith("2025")),
        "2026_ytd": _filtered_metrics(dated, lambda dt: dt.startswith("2026")),
        "excluding_2025_daily_return_stitch_not_executable": _filtered_metrics(dated, lambda dt: not dt.startswith("2025")),
    }
    left_out = {
        str(y): _filtered_metrics(dated, lambda dt, y=y: dt[:4] != str(y))
        for y in range(first_year, min(end_year, 2025) + 1)
    }
    rolling = []
    for i in range(504, len(rows) + 1):
        window = {arm: metrics(all_ret[arm][i - 504:i]) for arm in ARMS}
        rolling.append({"end_date": dates[i - 1], "metrics": window})
    rolling_summary = {}
    for arm in ARMS[1:]:
        count = len(rolling)
        rolling_summary[arm] = {
            "windows": count,
            "stock_higher_504d_cumulative_share": sum(
                x["metrics"]["stock"]["cumulative"] > x["metrics"][arm]["cumulative"] for x in rolling
            ) / count,
            "stock_higher_504d_sharpe_share": sum(
                x["metrics"]["stock"]["sharpe"] is not None
                and x["metrics"][arm]["sharpe"] is not None
                and x["metrics"]["stock"]["sharpe"] > x["metrics"][arm]["sharpe"]
                for x in rolling
            ) / count,
        }
    inference = {
        arm: block_bootstrap_mean_spread(all_ret["stock"], all_ret[arm])
        for arm in ARMS[1:]
    }
    pre2025_returns = {
        arm: [value for dt, value in dated[arm] if "2018" <= dt[:4] <= "2024"]
        for arm in ARMS
    }
    inference_pre2025 = {
        arm: block_bootstrap_mean_spread(pre2025_returns["stock"], pre2025_returns[arm])
        for arm in ARMS[1:]
    }
    checks = {}
    for arm in ARMS[1:]:
        before = segments["2018_2024"]
        skipped = segments["excluding_2025_daily_return_stitch_not_executable"]
        ci = inference_pre2025[arm]
        checks[arm] = {
            "pre2025_sharpe_higher": before["stock"]["sharpe"] is not None
                and before[arm]["sharpe"] is not None
                and before["stock"]["sharpe"] > before[arm]["sharpe"],
            "pre2025_cagr_higher": before["stock"]["cagr"] > before[arm]["cagr"],
            "pre2025_mdd_smaller_absolute_loss": before["stock"]["mdd"] > before[arm]["mdd"],
            "without2025_stitched_sharpe_higher": skipped["stock"]["sharpe"] is not None
                and skipped[arm]["sharpe"] is not None
                and skipped["stock"]["sharpe"] > skipped[arm]["sharpe"],
            "pre2025_bootstrap_mean_daily_excess_ci95_above_zero": ci["ci95_low"] > 0,
            "full_rolling_two_year_return_majority": rolling_summary[arm]["stock_higher_504d_cumulative_share"] > 0.5,
            "interpretation": "Descriptive comparison only; no independent OOS or causal proof.",
        }
    return {
        "period": {"start": dates[0], "end": dates[-1], "sessions": len(rows)},
        "annual": by_year,
        "segments": segments,
        "leave_one_full_year_out_stitched": left_out,
        "rolling_504_session": rolling_summary,
        "paired_bootstrap_full_sample": inference,
        "paired_bootstrap_2018_2024": inference_pre2025,
        "robustness_checks_not_an_investment_verdict": checks,
        "methodology": {
            "policy": POLICY_ID,
            "benchmark": "069500 KODEX 200 audited synthetic total-return OHLC",
            "etf_buy_hold": "100% synthetic units with entry fee",
            "etf_vol_matched": "monthly rebalance, prior 63 sessions of stock/ETF return vol, cash weight capped [0,1]",
            "etf_gate": "previous CLOSE market gate controls NEXT OPEN ETF; RISK_OFF/UNKNOWN => cash; benchmark timing proxy, not stock entry-only gate replication",
            "etf_exposure_matched": "previous CLOSE stock invested fraction applied to NEXT OPEN ETF; stock selection control",
            "etf_units": "fractional total-return synthetic units, NOT literal shares or actual dividends ledger",
            "transaction_cost_one_way": ONE_WAY_FEE,
            "cash_interest": 0,
            "cagr_convention": "geometric 252-session equivalent for stitched-period comparability",
            "significance": "fixed 20-session paired block bootstrap of daily arithmetic mean excess; observational, reused history, not OOS",
            "excluded_2025_warning": "Removing daily returns is a NON-EXECUTABLE sensitivity, not a backtest with a year skipped.",
        },
        "judgement": "DESCRIPTIVE_ONLY_REQUIRES_HUMAN_INTERPRETATION",
    }


def run(manifest_path: Path, output: Path, start: str = START, end: str = END) -> dict[str, Any]:
    inp = load_verified_inputs(manifest_path, start, end)
    trace, turnover = simulate(inp)
    summary = analyze(trace, first_year=int(start[:4]))
    summary["source_provenance"] = {
        "manifest_sha256": _sha256(manifest_path),
        "source_hashes": inp.hashes,
        "stock_replay_commit": inp.manifest["stock_replay_commit"],
        "policy_sha256": inp.manifest["stock_replay_policy_sha256"],
        "distribution_evidence": inp.manifest["benchmark_distribution_evidence"],
        "gate_evidence": inp.manifest["gate_evidence"],
        "calendar_evidence": inp.manifest["calendar_evidence"],
    }
    summary["execution"] = turnover
    # No output at all before EVERY validation, simulation, and analysis passes.
    output.mkdir(parents=True, exist_ok=True)
    (output / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
    fields = list(trace[0])
    with (output / "daily_nav.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(trace)
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("preflight", "run"))
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--start", default=START)
    parser.add_argument("--end", default=END)
    parser.add_argument("--output", type=Path, default=Path("tmp/kospi200-risk-comparison"))
    args = parser.parse_args()
    try:
        inp = load_verified_inputs(args.manifest, args.start, args.end)
        if args.action == "preflight":
            print(json.dumps({"status": "READY_FOR_COMPARISON_ONLY", "date_range": [inp.start, inp.end], "sources": inp.hashes}, indent=2))
            return 0
        result = run(args.manifest, args.output, args.start, args.end)
        print(json.dumps({"status": "RESEARCH_COMPLETED_NOT_INVESTMENT_CERTIFICATION", "output": str(args.output), "period": result["period"]}, ensure_ascii=False))
        return 0
    except (DataNotReady, FileNotFoundError, json.JSONDecodeError, OSError) as exc:
        print(json.dumps({"status": "BLOCKED_NO_RESULT", "reason": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
