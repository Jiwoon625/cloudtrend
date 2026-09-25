from __future__ import annotations

import argparse
import json
import math
import os
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Iterable

import duckdb
import numpy as np
import pandas as pd

MAX_POSITIONS = 15
SECTOR_CAP = 3
LIQUIDITY_RANK_FLOOR = 0.10
ROUND_TRIP_COST = 0.003
ONE_WAY_COST = ROUND_TRIP_COST / 2.0

PHASE_A_PAIRS = [
    (0.90, 0.80),
    (0.90, 0.70),
    (0.90, 0.60),
    (0.80, 0.70),
    (0.80, 0.60),
    (0.80, 0.50),
]
PHASE_B_ARCHITECTURES = [
    "M",
    "M+B",
    "M+T",
    "M+V",
    "M+T+V",
    "M+B+T",
    "M+B+V",
]
PHASE_C_EXIT_RULES = [
    "RANK",
    "RANK_OR_ICHIMOKU",
    "RANK_OR_RET120_NEG",
    "RANK_OR_ICHIMOKU_OR_RET120_NEG",
]
PERIODS = [
    ("EARLY_2017_2019", "2017-01-01", "2019-12-31"),
    ("MID_2020_2022", "2020-01-01", "2022-12-31"),
    ("RECENT_2023_2026", "2023-01-01", "2026-12-31"),
]


@dataclass(frozen=True)
class Config:
    phase: str
    entry_cut: float
    exit_cut: float
    architecture: str
    exit_rule: str = "RANK"
    anchor: str | None = None

    @property
    def config_id(self) -> str:
        e = int(round(self.entry_cut * 100))
        x = int(round(self.exit_cut * 100))
        return f"{self.phase}__E{e}_X{x}__{self.architecture}__{self.exit_rule}"

    def to_dict(self) -> dict[str, Any]:
        out = asdict(self)
        out["configId"] = self.config_id
        return out


@dataclass
class PositionMeta:
    symbol: str
    sector: str
    entry_signal_date: pd.Timestamp
    entry_date: pd.Timestamp
    entry_rank: float
    entry_architecture: str
    cumulative_return: float = 1.0
    holding_intervals: int = 0


@dataclass
class PortfolioState:
    config: Config
    weights: dict[str, float] = field(default_factory=dict)
    cash_weight: float = 1.0
    positions: dict[str, PositionMeta] = field(default_factory=dict)
    daily: list[dict[str, Any]] = field(default_factory=list)
    trades: list[dict[str, Any]] = field(default_factory=list)
    last_exit_dt: pd.Timestamp | None = None


def sf(value: Any) -> float | None:
    try:
        x = float(value)
    except Exception:
        return None
    return x if math.isfinite(x) else None


def series_stats(r: pd.Series) -> dict[str, float | None]:
    r = pd.to_numeric(r, errors="coerce").fillna(0.0)
    n = len(r)
    if n == 0:
        return {
            "days": 0,
            "totalReturn": None,
            "CAGR": None,
            "annualizedVol": None,
            "Sharpe": None,
            "MDD": None,
            "positiveDayRate": None,
        }
    equity = (1.0 + r).cumprod()
    total = float(equity.iloc[-1] - 1.0)
    cagr = float((1.0 + total) ** (252.0 / n) - 1.0) if total > -1 else -1.0
    vol = float(r.std(ddof=1) * np.sqrt(252.0)) if n > 1 else np.nan
    sharpe = (
        float(r.mean() / r.std(ddof=1) * np.sqrt(252.0))
        if n > 1 and r.std(ddof=1) > 0
        else np.nan
    )
    dd = equity / equity.cummax() - 1.0
    return {
        "days": n,
        "totalReturn": total,
        "CAGR": cagr,
        "annualizedVol": sf(vol),
        "Sharpe": sf(sharpe),
        "MDD": float(dd.min()),
        "positiveDayRate": float((r > 0).mean()),
    }


def annualized_metrics(daily: pd.DataFrame, trades: pd.DataFrame) -> dict[str, Any]:
    net = series_stats(daily["netReturn"])
    gross = series_stats(daily["grossReturn"])
    spy = series_stats(daily["spyReturn"])
    years = max(len(daily) / 252.0, 1.0 / 252.0)
    closed = trades[trades["status"] == "CLOSED"].copy() if len(trades) else trades
    holding = pd.to_numeric(closed.get("holdingIntervals"), errors="coerce") if len(closed) else pd.Series(dtype=float)
    trade_ret = pd.to_numeric(closed.get("grossTradeReturn"), errors="coerce") if len(closed) else pd.Series(dtype=float)
    cagr = net["CAGR"]
    mdd = net["MDD"]
    calmar = (cagr / abs(mdd)) if cagr is not None and mdd is not None and mdd < 0 else None
    return {
        **net,
        "grossTotalReturn": gross["totalReturn"],
        "grossCAGR": gross["CAGR"],
        "grossSharpe": gross["Sharpe"],
        "grossMDD": gross["MDD"],
        "spyTotalReturn": spy["totalReturn"],
        "spyCAGR": spy["CAGR"],
        "spySharpe": spy["Sharpe"],
        "spyMDD": spy["MDD"],
        "excessCAGRVsSpy": (
            net["CAGR"] - spy["CAGR"]
            if net["CAGR"] is not None and spy["CAGR"] is not None
            else None
        ),
        "grossExcessCAGRVsSpy": (
            gross["CAGR"] - spy["CAGR"]
            if gross["CAGR"] is not None and spy["CAGR"] is not None
            else None
        ),
        "Calmar": sf(calmar),
        "avgDailyTurnover": float(daily["turnover"].mean()),
        "annualTurnover": float(daily["turnover"].sum() / years),
        "annualizedCostDragApprox": float(daily["costRate"].sum() / years),
        "avgPositions": float(daily["positions"].mean()),
        "minPositions": int(daily["positions"].min()),
        "fullCapacityRate": float((daily["positions"] >= MAX_POSITIONS).mean()),
        "entryCount": int(daily["entries"].sum()),
        "exitCount": int(daily["exits"].sum()),
        "tradesPerYear": float(daily["entries"].sum() / years),
        "avgHoldingIntervals": sf(holding.mean()) if len(holding) else None,
        "medianHoldingIntervals": sf(holding.median()) if len(holding) else None,
        "closedTradeWinRate": sf((trade_ret > 0).mean()) if len(trade_ret) else None,
        "avgClosedTradeReturn": sf(trade_ret.mean()) if len(trade_ret) else None,
        "medianClosedTradeReturn": sf(trade_ret.median()) if len(trade_ret) else None,
        "avgMissingReturnWeight": float(daily["missingReturnWeight"].mean()),
        "avgLowConfidenceWeight": float(daily["lowConfidenceWeight"].mean()),
    }


def period_metrics(daily: pd.DataFrame) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    dates = pd.to_datetime(daily["entryDate"])
    for name, start, end in PERIODS:
        g = daily[(dates >= pd.Timestamp(start)) & (dates <= pd.Timestamp(end))]
        stats = series_stats(g["netReturn"]) if len(g) else series_stats(pd.Series(dtype=float))
        out.append({"period": name, **stats})
    return out


def annual_metrics(daily: pd.DataFrame) -> list[dict[str, Any]]:
    d = daily.copy()
    d["year"] = pd.to_datetime(d["entryDate"]).dt.year
    rows = []
    for year, g in d.groupby("year", sort=True):
        net = series_stats(g["netReturn"])
        spy = series_stats(g["spyReturn"])
        rows.append(
            {
                "year": int(year),
                "return": net["totalReturn"],
                "Sharpe": net["Sharpe"],
                "MDD": net["MDD"],
                "spyReturn": spy["totalReturn"],
                "excessReturnVsSpy": (
                    net["totalReturn"] - spy["totalReturn"]
                    if net["totalReturn"] is not None and spy["totalReturn"] is not None
                    else None
                ),
                "turnover": float(g["turnover"].sum()),
                "avgPositions": float(g["positions"].mean()),
            }
        )
    return rows


def regime_metrics(daily: pd.DataFrame) -> list[dict[str, Any]]:
    rows = []
    for regime, g in daily.groupby("marketRegime", dropna=False):
        stats = series_stats(g["netReturn"])
        rows.append({"marketRegime": str(regime), **stats})
    return rows


def add_robust_score(summary: pd.DataFrame, period: pd.DataFrame) -> pd.DataFrame:
    if summary.empty:
        return summary
    p = period.pivot_table(index="configId", columns="period", values="CAGR", aggfunc="first")
    p["worstPeriodCAGR"] = p.min(axis=1, skipna=True)
    out = summary.merge(p[["worstPeriodCAGR"]], left_on="configId", right_index=True, how="left")
    out["rankSharpe"] = out["Sharpe"].rank(pct=True, method="average")
    out["rankCAGR"] = out["CAGR"].rank(pct=True, method="average")
    out["rankCalmar"] = out["Calmar"].rank(pct=True, method="average")
    out["rankWorstPeriod"] = out["worstPeriodCAGR"].rank(pct=True, method="average")
    out["rankLowTurnover"] = (-out["annualTurnover"]).rank(pct=True, method="average")
    out["robustScore"] = (
        0.35 * out["rankSharpe"].fillna(0)
        + 0.25 * out["rankCAGR"].fillna(0)
        + 0.20 * out["rankCalmar"].fillna(0)
        + 0.10 * out["rankWorstPeriod"].fillna(0)
        + 0.10 * out["rankLowTurnover"].fillna(0)
    )
    out.loc[out["avgPositions"] < 8, "robustScore"] -= 0.10
    return out.sort_values(
        ["robustScore", "Sharpe", "CAGR", "annualTurnover"],
        ascending=[False, False, False, True],
    ).reset_index(drop=True)


def architecture_mask(g: pd.DataFrame, architecture: str) -> pd.Series:
    mask = pd.Series(True, index=g.index)
    if "+B" in architecture:
        mask &= g["dr_beta60_spy"].fillna(-np.inf) >= 0.90
    if "+T" in architecture:
        mask &= g["dr_ichimoku_tk_gap"].fillna(-np.inf) >= 0.80
    if "+V" in architecture:
        mask &= g["dr_relvol1_20"].fillna(-np.inf) >= 0.80
    return mask


def sort_candidates(g: pd.DataFrame, architecture: str) -> pd.DataFrame:
    cols = ["mom_pct"]
    ascending = [False]
    if "+B" in architecture:
        cols.append("dr_beta60_spy")
        ascending.append(False)
    if "+T" in architecture:
        cols.append("dr_ichimoku_tk_gap")
        ascending.append(False)
    if "+V" in architecture:
        cols.append("dr_relvol1_20")
        ascending.append(False)
    cols.append("symbol")
    ascending.append(True)
    return g.sort_values(cols, ascending=ascending)


def exit_reason(row: pd.Series | None, config: Config) -> str | None:
    if row is None:
        return "DATA_MISSING"
    rank = row.get("mom_pct")
    if pd.isna(rank) or float(rank) < config.exit_cut:
        return "RANK_EXIT"
    if config.exit_rule in {"RANK_OR_ICHIMOKU", "RANK_OR_ICHIMOKU_OR_RET120_NEG"}:
        ichi = row.get("ichimoku_tk_gap")
        if pd.notna(ichi) and float(ichi) < 0:
            return "ICHIMOKU_BREAKDOWN"
    if config.exit_rule in {"RANK_OR_RET120_NEG", "RANK_OR_ICHIMOKU_OR_RET120_NEG"}:
        ret120 = row.get("ret120")
        if pd.notna(ret120) and float(ret120) < 0:
            return "RET120_NEGATIVE"
    return None


def process_day(state: PortfolioState, g: pd.DataFrame) -> None:
    g = g.copy()
    signal_date = pd.Timestamp(g["signal_dt"].iloc[0])
    entry_date = pd.Timestamp(g["entry_dt"].iloc[0])
    exit_dt = pd.Timestamp(g["exit_dt"].iloc[0])
    state.last_exit_dt = exit_dt
    indexed = g.set_index("symbol", drop=False)

    exited: list[tuple[str, str]] = []
    for symbol in list(state.positions):
        row = indexed.loc[symbol] if symbol in indexed.index else None
        if isinstance(row, pd.DataFrame):
            row = row.iloc[0]
        reason = exit_reason(row, state.config)
        if reason is not None:
            exited.append((symbol, reason))

    for symbol, reason in exited:
        meta = state.positions.pop(symbol)
        row = indexed.loc[symbol] if symbol in indexed.index else None
        if isinstance(row, pd.DataFrame):
            row = row.iloc[0]
        state.trades.append(
            {
                "configId": state.config.config_id,
                "symbol": symbol,
                "sectorCode": meta.sector,
                "entrySignalDate": meta.entry_signal_date,
                "entryDate": meta.entry_date,
                "exitSignalDate": signal_date,
                "exitDate": entry_date,
                "entryRank": meta.entry_rank,
                "exitRank": sf(row.get("mom_pct")) if row is not None else None,
                "holdingIntervals": meta.holding_intervals,
                "grossTradeReturn": meta.cumulative_return - 1.0,
                "exitReason": reason,
                "status": "CLOSED",
                "architecture": meta.entry_architecture,
            }
        )

    remaining = list(state.positions)
    sector_counts: dict[str, int] = {}
    for symbol in remaining:
        sector = state.positions[symbol].sector
        sector_counts[sector] = sector_counts.get(sector, 0) + 1

    entry_pool = g[
        (g["mom_pct"].fillna(-np.inf) >= state.config.entry_cut)
        & (g["dr_log_dollarvol20"].fillna(-np.inf) >= LIQUIDITY_RANK_FLOOR)
        & (g["dr_amihud20"].fillna(-np.inf) >= LIQUIDITY_RANK_FLOOR)
    ].copy()
    entry_pool = entry_pool[architecture_mask(entry_pool, state.config.architecture)]
    entry_pool = sort_candidates(entry_pool, state.config.architecture)

    entries: list[str] = []
    for _, row in entry_pool.iterrows():
        if len(state.positions) >= MAX_POSITIONS:
            break
        symbol = str(row["symbol"])
        if symbol in state.positions:
            continue
        sector = str(row["sectorCode"])
        if sector_counts.get(sector, 0) >= SECTOR_CAP:
            continue
        state.positions[symbol] = PositionMeta(
            symbol=symbol,
            sector=sector,
            entry_signal_date=signal_date,
            entry_date=entry_date,
            entry_rank=float(row["mom_pct"]),
            entry_architecture=state.config.architecture,
        )
        sector_counts[sector] = sector_counts.get(sector, 0) + 1
        entries.append(symbol)

    target_symbols = list(state.positions)
    membership_changed = bool(exited or entries) or set(state.weights) != set(target_symbols)
    if membership_changed:
        if target_symbols:
            equal_weight = 1.0 / len(target_symbols)
            target_weights = {s: equal_weight for s in target_symbols}
            target_cash = 0.0
        else:
            target_weights = {}
            target_cash = 1.0
    else:
        target_weights = {s: state.weights.get(s, 0.0) for s in target_symbols}
        total = sum(target_weights.values())
        target_cash = max(0.0, 1.0 - total)

    all_symbols = set(state.weights) | set(target_weights)
    turnover = sum(abs(target_weights.get(s, 0.0) - state.weights.get(s, 0.0)) for s in all_symbols)
    cost_rate = ONE_WAY_COST * turnover

    gross_return = 0.0
    missing_return_weight = 0.0
    low_conf_weight = 0.0
    realized_returns: dict[str, float] = {}
    for symbol, weight in target_weights.items():
        row = indexed.loc[symbol] if symbol in indexed.index else None
        if isinstance(row, pd.DataFrame):
            row = row.iloc[0]
        rr = row.get("o2o_ret") if row is not None else np.nan
        if pd.isna(rr):
            rr = 0.0
            missing_return_weight += weight
        rr = float(rr)
        realized_returns[symbol] = rr
        gross_return += weight * rr
        if row is not None and str(row.get("confidenceGrade", "")).startswith("C"):
            low_conf_weight += weight

    net_return = (1.0 - cost_rate) * (1.0 + gross_return) - 1.0
    denom = 1.0 + gross_return
    if denom <= 0:
        end_weights = {}
        end_cash = 1.0
    else:
        end_weights = {
            symbol: weight * (1.0 + realized_returns.get(symbol, 0.0)) / denom
            for symbol, weight in target_weights.items()
        }
        end_cash = target_cash / denom

    for symbol, meta in state.positions.items():
        rr = realized_returns.get(symbol, 0.0)
        meta.cumulative_return *= 1.0 + rr
        meta.holding_intervals += 1

    market_regime = g["market_regime"].dropna()
    spy_return = g["spy_return"].dropna()
    state.daily.append(
        {
            "configId": state.config.config_id,
            "phase": state.config.phase,
            "signalDate": signal_date,
            "entryDate": entry_date,
            "exitDate": exit_dt,
            "grossReturn": gross_return,
            "netReturn": net_return,
            "spyReturn": float(spy_return.iloc[0]) if len(spy_return) else 0.0,
            "costRate": cost_rate,
            "turnover": turnover,
            "positions": len(target_weights),
            "entries": len(entries),
            "exits": len(exited),
            "missingReturnWeight": missing_return_weight,
            "lowConfidenceWeight": low_conf_weight,
            "marketRegime": str(market_regime.iloc[0]) if len(market_regime) else "UNKNOWN",
            "maxSectorCount": max(sector_counts.values()) if sector_counts else 0,
            "sectorCount": len(sector_counts),
            "membershipChanged": membership_changed,
        }
    )
    state.weights = end_weights
    state.cash_weight = end_cash


def finalize_state(state: PortfolioState) -> None:
    if not state.daily:
        return
    liquidation_turnover = sum(state.weights.values())
    liquidation_cost = ONE_WAY_COST * liquidation_turnover
    last = state.daily[-1]
    last["netReturn"] = (1.0 + float(last["netReturn"])) * (1.0 - liquidation_cost) - 1.0
    last["costRate"] = float(last["costRate"]) + liquidation_cost
    last["turnover"] = float(last["turnover"]) + liquidation_turnover
    last["exits"] = int(last["exits"]) + len(state.positions)
    last["membershipChanged"] = True

    final_date = state.last_exit_dt or pd.Timestamp(last["exitDate"])
    for symbol, meta in list(state.positions.items()):
        state.trades.append(
            {
                "configId": state.config.config_id,
                "symbol": symbol,
                "sectorCode": meta.sector,
                "entrySignalDate": meta.entry_signal_date,
                "entryDate": meta.entry_date,
                "exitSignalDate": pd.Timestamp(last["signalDate"]),
                "exitDate": final_date,
                "entryRank": meta.entry_rank,
                "exitRank": None,
                "holdingIntervals": meta.holding_intervals,
                "grossTradeReturn": meta.cumulative_return - 1.0,
                "exitReason": "END_OF_SAMPLE",
                "status": "CLOSED",
                "architecture": meta.entry_architecture,
            }
        )
    state.positions.clear()
    state.weights.clear()
    state.cash_weight = 1.0


def stream_days(con: duckdb.DuckDBPyConnection, prepared_dir: Path) -> Iterable[pd.DataFrame]:
    files = sorted(prepared_dir.glob("year=*.parquet"))
    if not files:
        raise RuntimeError(f"no prepared yearly files in {prepared_dir}")
    for path in files:
        query = f"""
            SELECT *
            FROM read_parquet('{str(path).replace("'", "''")}')
            ORDER BY signal_dt, symbol
        """
        reader = con.execute(query).fetch_record_batch(rows_per_batch=100_000)
        pending = pd.DataFrame()
        for batch in reader:
            chunk = batch.to_pandas()
            if len(pending):
                chunk = pd.concat([pending, chunk], ignore_index=True)
            last_date = chunk["signal_dt"].iloc[-1]
            complete = chunk[chunk["signal_dt"] != last_date]
            pending = chunk[chunk["signal_dt"] == last_date].copy()
            for _, g in complete.groupby("signal_dt", sort=False):
                yield g
        if len(pending):
            for _, g in pending.groupby("signal_dt", sort=False):
                yield g

def run_configs(
    con: duckdb.DuckDBPyConnection,
    prepared_dir: Path,
    configs: list[Config],
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    states = {c.config_id: PortfolioState(c) for c in configs}
    for i, g in enumerate(stream_days(con, prepared_dir), 1):
        for state in states.values():
            process_day(state, g)
        if i % 250 == 0:
            print(json.dumps({"processedSignalDates": i, "configs": len(states)}))
    for state in states.values():
        finalize_state(state)

    summary_rows = []
    annual_rows = []
    period_rows = []
    regime_rows = []
    daily_frames = []
    trade_frames = []
    for config_id, state in states.items():
        daily = pd.DataFrame(state.daily)
        trades = pd.DataFrame(state.trades)
        metrics = annualized_metrics(daily, trades)
        row = {**state.config.to_dict(), **metrics}
        summary_rows.append(row)
        for rec in annual_metrics(daily):
            annual_rows.append({**state.config.to_dict(), **rec})
        for rec in period_metrics(daily):
            period_rows.append({**state.config.to_dict(), **rec})
        for rec in regime_metrics(daily):
            regime_rows.append({**state.config.to_dict(), **rec})
        daily_frames.append(daily)
        trade_frames.append(trades)

    summary = pd.DataFrame(summary_rows)
    annual = pd.DataFrame(annual_rows)
    period = pd.DataFrame(period_rows)
    regime = pd.DataFrame(regime_rows)
    daily_all = pd.concat(daily_frames, ignore_index=True) if daily_frames else pd.DataFrame()
    trades_all = pd.concat(trade_frames, ignore_index=True) if trade_frames else pd.DataFrame()
    scored = add_robust_score(summary, period)
    return scored, annual, period, regime, daily_all, trades_all


def prepare_signals(
    con: duckdb.DuckDBPyConnection,
    panel: Path,
    input_root: Path,
    sector_map: Path,
    prepared_dir: Path,
) -> dict[str, Any]:
    prepared_dir.mkdir(parents=True, exist_ok=True)
    bench = str(input_root / "benchmark" / "us_benchmarks_adjusted.parquet").replace("'", "''")
    panel_q = str(panel).replace("'", "''")
    sector_q = str(sector_map).replace("'", "''")

    year_qas: list[dict[str, Any]] = []
    for year in range(2017, 2027):
        price_paths = [input_root / "canonical" / f"year={year}" / "us_stock_daily.parquet"]
        next_path = input_root / "canonical" / f"year={year + 1}" / "us_stock_daily.parquet"
        if next_path.exists():
            price_paths.append(next_path)
        price_list = ",".join(
            "'" + str(path).replace("'", "''") + "'" for path in price_paths
        )
        out_path = prepared_dir / f"year={year}.parquet"
        out_q = str(out_path).replace("'", "''")
        con.execute(f"""
            COPY (
                WITH px AS (
                    SELECT CAST(symbol AS VARCHAR) AS symbol,
                           CAST(tradeDateUsEastern AS DATE) AS dt,
                           CAST(open AS DOUBLE) AS open
                    FROM read_parquet([{price_list}], union_by_name=true)
                ),
                b0 AS (
                    SELECT CAST(dt AS DATE) AS dt, CAST(spy_close AS DOUBLE) AS spy_close
                    FROM read_parquet('{bench}')
                ),
                cal AS (
                    SELECT dt,
                           LEAD(dt, 1) OVER (ORDER BY dt) AS entry_dt,
                           LEAD(dt, 2) OVER (ORDER BY dt) AS exit_dt
                    FROM b0
                ),
                sig AS (
                    SELECT symbol,
                           CAST(dt AS DATE) AS signal_dt,
                           market_regime,
                           mom_pct,
                           ret120,
                           ret252,
                           ichimoku_tk_gap,
                           relvol1_20,
                           beta60_spy,
                           dr_beta60_spy,
                           dr_ichimoku_tk_gap,
                           dr_relvol1_20,
                           dr_log_dollarvol20,
                           dr_amihud20
                    FROM read_parquet('{panel_q}')
                    WHERE mom_pct IS NOT NULL
                      AND YEAR(dt) = {year}
                ),
                sm AS (
                    SELECT CAST(symbol AS VARCHAR) AS symbol,
                           CAST(sectorCode AS VARCHAR) AS sectorCode,
                           CAST(confidenceGrade AS VARCHAR) AS confidenceGrade,
                           CAST(mappingVersion AS VARCHAR) AS mappingVersion
                    FROM read_csv_auto('{sector_q}', header=true)
                )
                SELECT s.*, c.entry_dt, c.exit_dt,
                       sm.sectorCode, sm.confidenceGrade, sm.mappingVersion,
                       CASE WHEN p1.open IS NULL OR p2.open IS NULL OR p1.open = 0 THEN NULL
                            ELSE p2.open / p1.open - 1 END AS o2o_ret,
                       CASE WHEN b1.spy_close IS NULL OR b2.spy_close IS NULL OR b1.spy_close = 0 THEN NULL
                            ELSE b2.spy_close / b1.spy_close - 1 END AS spy_return
                FROM sig s
                JOIN cal c ON c.dt = s.signal_dt
                JOIN sm USING (symbol)
                LEFT JOIN px p1 ON p1.symbol = s.symbol AND p1.dt = c.entry_dt
                LEFT JOIN px p2 ON p2.symbol = s.symbol AND p2.dt = c.exit_dt
                LEFT JOIN b0 b1 ON b1.dt = c.entry_dt
                LEFT JOIN b0 b2 ON b2.dt = c.exit_dt
                WHERE c.entry_dt IS NOT NULL
                  AND c.exit_dt IS NOT NULL
            ) TO '{out_q}'
            (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 50000)
        """)
        qa = con.execute(
            f"""
            SELECT COUNT(*) AS rows,
                   COUNT(DISTINCT symbol) AS symbols,
                   COUNT(DISTINCT signal_dt) AS dates,
                   MIN(signal_dt) AS min_date,
                   MAX(signal_dt) AS max_date,
                   SUM(CASE WHEN o2o_ret IS NULL THEN 1 ELSE 0 END) AS missing_returns
            FROM read_parquet('{out_q}')
            """
        ).fetchone()
        rec = {
            "year": year,
            "rows": int(qa[0]),
            "symbols": int(qa[1]),
            "signalDates": int(qa[2]),
            "minDate": str(qa[3]),
            "maxDate": str(qa[4]),
            "missingReturnRows": int(qa[5]),
            "bytes": out_path.stat().st_size,
        }
        year_qas.append(rec)
        print(json.dumps({"preparedYear": rec}, ensure_ascii=False))

    prepared_glob = str(prepared_dir / "year=*.parquet").replace("'", "''")
    symbol_count = int(
        con.execute(
            f"SELECT COUNT(DISTINCT symbol) FROM read_parquet('{prepared_glob}')"
        ).fetchone()[0]
    )
    return {
        "rows": sum(x["rows"] for x in year_qas),
        "symbols": symbol_count,
        "signalDates": sum(x["signalDates"] for x in year_qas),
        "minDate": year_qas[0]["minDate"],
        "maxDate": year_qas[-1]["maxDate"],
        "missingReturnRows": sum(x["missingReturnRows"] for x in year_qas),
        "yearly": year_qas,
    }

def save_phase(
    out: Path,
    phase: str,
    result: tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame],
) -> pd.DataFrame:
    summary, annual, period, regime, daily, trades = result
    summary.to_csv(out / f"{phase}_summary.csv", index=False)
    annual.to_csv(out / f"{phase}_annual.csv", index=False)
    period.to_csv(out / f"{phase}_period.csv", index=False)
    regime.to_csv(out / f"{phase}_regime.csv", index=False)
    daily.to_parquet(out / f"{phase}_daily.parquet", index=False, compression="zstd")
    trades.to_csv(out / f"{phase}_trades.csv", index=False)
    return summary


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--panel", required=True)
    p.add_argument("--input-root", required=True)
    p.add_argument("--sector-map", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--threads", type=int, default=2)
    p.add_argument("--memory-limit", default="5GB")
    args = p.parse_args()

    panel = Path(args.panel).resolve()
    input_root = Path(args.input_root).resolve()
    sector_map = Path(args.sector_map).resolve()
    out = Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=True)
    temp_root = Path(os.environ.get("RUNNER_TEMP", str(out / ".tmp"))) / "us33-entry-exit"
    temp_root.mkdir(parents=True, exist_ok=True)
    prepared = temp_root / "prepared_signals"

    sector = pd.read_csv(sector_map)
    if len(sector) != 5032 or sector["symbol"].nunique() != 5032 or sector["sectorCode"].nunique() != 14:
        raise RuntimeError(
            f"sector map QA failed: rows={len(sector)}, "
            f"symbols={sector['symbol'].nunique()}, sectors={sector['sectorCode'].nunique()}"
        )

    con = duckdb.connect(str(temp_root / "us33_state_machine.duckdb"))
    con.execute(f"SET threads={args.threads}")
    con.execute(f"SET memory_limit='{args.memory_limit}'")
    con.execute(f"SET temp_directory='{str(temp_root).replace("'", "''")}'")
    con.execute("SET preserve_insertion_order=false")

    prepared_qa = prepare_signals(con, panel, input_root, sector_map, prepared)
    print(json.dumps({"prepared": prepared_qa}, ensure_ascii=False))

    phase_a_configs = [
        Config("phase_a", entry, exit_, "M", "RANK")
        for entry, exit_ in PHASE_A_PAIRS
    ]
    phase_a_result = run_configs(con, prepared, phase_a_configs)
    phase_a = save_phase(out, "phase_a", phase_a_result)
    a_finalists = phase_a.head(2)["configId"].tolist()
    a_config_map = {c.config_id: c for c in phase_a_configs}
    phase_a_finalists = [a_config_map[x] for x in a_finalists]
    (out / "phase_a_finalists.json").write_text(
        json.dumps(
            {
                "selectionMethod": "Robust score: Sharpe 35%, CAGR 25%, Calmar 20%, worst subperiod CAGR 10%, low turnover 10%",
                "finalists": [c.to_dict() for c in phase_a_finalists],
                "ranked": phase_a.head(6).to_dict(orient="records"),
            },
            ensure_ascii=False,
            indent=2,
            default=str,
        ),
        encoding="utf-8",
    )

    phase_b_configs: dict[str, Config] = {}
    for base in phase_a_finalists:
        for architecture in PHASE_B_ARCHITECTURES:
            c = Config(
                "phase_b",
                base.entry_cut,
                base.exit_cut,
                architecture,
                "RANK",
                anchor=base.config_id,
            )
            phase_b_configs[c.config_id] = c

    basic = Config("phase_b", 0.90, 0.70, "M+T", "RANK", anchor="BASIC_MODEL")
    phase_b_configs[basic.config_id] = basic
    phase_b_result = run_configs(con, prepared, list(phase_b_configs.values()))
    phase_b = save_phase(out, "phase_b", phase_b_result)

    basic_row = phase_b[phase_b["configId"] == basic.config_id]
    if basic_row.empty:
        raise RuntimeError("basic model result missing")
    (out / "basic_model_summary.json").write_text(
        json.dumps(
            {
                "definition": basic.to_dict(),
                "result": basic_row.iloc[0].to_dict(),
                "interpretation": "E90 entry with Ichimoku top-20% entry confirmation; hold until core momentum falls below X70; confirmations are entry-only.",
            },
            ensure_ascii=False,
            indent=2,
            default=str,
        ),
        encoding="utf-8",
    )

    b_ids = phase_b.head(2)["configId"].tolist()
    if basic.config_id not in b_ids:
        b_ids.append(basic.config_id)
    b_config_map = {c.config_id: c for c in phase_b_configs.values()}
    phase_b_finalists = [b_config_map[x] for x in b_ids]
    (out / "phase_b_finalists.json").write_text(
        json.dumps(
            {
                "selectionMethod": "Top two by robust score, plus the predefined basic model as a mandatory anchor when not already selected.",
                "finalists": [c.to_dict() for c in phase_b_finalists],
                "ranked": phase_b.head(10).to_dict(orient="records"),
            },
            ensure_ascii=False,
            indent=2,
            default=str,
        ),
        encoding="utf-8",
    )

    phase_c_configs: dict[str, Config] = {}
    for base in phase_b_finalists:
        for rule in PHASE_C_EXIT_RULES:
            c = Config(
                "phase_c",
                base.entry_cut,
                base.exit_cut,
                base.architecture,
                rule,
                anchor=base.config_id,
            )
            phase_c_configs[c.config_id] = c

    phase_c_result = run_configs(con, prepared, list(phase_c_configs.values()))
    phase_c = save_phase(out, "phase_c", phase_c_result)
    final_recommendations = phase_c.head(3).to_dict(orient="records")

    decision = {
        "study": "CloudTrend US-3.3 Sequential Entry/Exit Portfolio Study",
        "researchGrade": "SURVIVOR_ONLY_EXPLORATORY",
        "finalOosAllowed": False,
        "execution": "Signal at t close; membership changes and trades at t+1 open; open-to-open holding returns; confirmation signals are entry-only.",
        "portfolio": {
            "maxPositions": MAX_POSITIONS,
            "sectorCap": SECTOR_CAP,
            "weighting": "Equal weight only when membership changes; weights drift between membership changes.",
            "roundTripCost": ROUND_TRIP_COST,
            "liquidityRankFloor": LIQUIDITY_RANK_FLOOR,
        },
        "preparedData": prepared_qa,
        "phaseA": {
            "tested": [c.to_dict() for c in phase_a_configs],
            "finalists": [c.to_dict() for c in phase_a_finalists],
        },
        "basicModel": {
            "config": basic.to_dict(),
            "result": basic_row.iloc[0].to_dict(),
        },
        "phaseB": {
            "testedCount": len(phase_b_configs),
            "finalists": [c.to_dict() for c in phase_b_finalists],
        },
        "phaseC": {
            "testedCount": len(phase_c_configs),
            "finalRecommendations": final_recommendations,
        },
        "selectionRule": {
            "robustScore": {
                "Sharpe": 0.35,
                "CAGR": 0.25,
                "Calmar": 0.20,
                "worstSubperiodCAGR": 0.10,
                "lowTurnover": 0.10,
            },
            "capacityPenalty": "-0.10 when average positions < 8",
        },
        "limitations": [
            "The universe is the current survivor-only research universe; production adoption is prohibited.",
            "This study optimizes architecture sequentially on the same historical sample and is exploratory, not final out-of-sample proof.",
            "SEC SIC enrichment was designed as a cross-check, but the GitHub hosted runner may be blocked by SEC fair-access controls; the pinned v1.1 map primarily uses Yahoo industry/sector plus curated overrides.",
        ],
    }
    (out / "decision_summary.json").write_text(
        json.dumps(decision, ensure_ascii=False, indent=2, default=str),
        encoding="utf-8",
    )
    (out / "run_manifest.json").write_text(
        json.dumps(
            {
                "files": sorted(p.name for p in out.iterdir() if p.is_file()),
                "mappingVersions": sector["mappingVersion"].value_counts().to_dict()
                if "mappingVersion" in sector.columns
                else {},
                "githubRunId": os.environ.get("GITHUB_RUN_ID"),
                "githubSha": os.environ.get("GITHUB_SHA"),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "ok": True,
                "phaseAFinalists": [c.config_id for c in phase_a_finalists],
                "basicModel": basic_row.iloc[0].to_dict(),
                "phaseBFinalists": [c.config_id for c in phase_b_finalists],
                "phaseCRecommendations": [
                    x.get("configId") for x in final_recommendations
                ],
            },
            ensure_ascii=False,
            default=str,
        )
    )


if __name__ == "__main__":
    main()
