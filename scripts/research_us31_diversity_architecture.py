from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
from typing import Dict, List, Tuple

import duckdb
import numpy as np
import pandas as pd

STUDY_VERSION = "us3.1-diversity-architecture-v0"
RESEARCH_GRADE = "SURVIVOR_ONLY_EXPLORATORY"
EVAL_START = "2017-01-01"

K7_SIGNALS = [
    "sig_cloud_above",
    "sig_tk_gt_kijun",
    "sig_bb_breakout",
    "sig_ma_alignment",
    "sig_high_close_volume",
    "sig_near_52w_high",
    "sig_rs120_outperform_spy",
]

K7_WEIGHTS = {
    "sig_cloud_above": 1.0,
    "sig_tk_gt_kijun": 1.0,
    "sig_bb_breakout": 1.5,
    "sig_ma_alignment": 1.0,
    "sig_high_close_volume": 0.5,
    "sig_near_52w_high": 2.5,
    "sig_rs120_outperform_spy": 2.0,
}

CONT6 = [
    "r_ret120",
    "r_ret252",
    "r_ma120_gap",
    "r_ma60_slope5",
    "r_tk_gap",
    "r_relvol1_20",
]


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--threads", type=int, default=2)
    p.add_argument("--memory-limit", default="5GB")
    return p.parse_args()


def safe_float(v):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def monthly_turnover_and_spells(members: pd.DataFrame) -> dict:
    if members.empty:
        return {
            "months": 0,
            "meanMonthlyTurnover": None,
            "medianMonthlyTurnover": None,
            "meanSpellMonths": None,
            "medianSpellMonths": None,
            "p90SpellMonths": None,
        }

    members = members.copy()
    members["dt"] = pd.to_datetime(members["dt"])
    sets = {dt: set(g["symbol"].astype(str)) for dt, g in members.groupby("dt")}
    dates = sorted(sets)

    turnovers: List[float] = []
    prev = None
    active: Dict[str, int] = {}
    finished: List[int] = []

    for dt in dates:
        cur = sets[dt]
        if prev:
            turnovers.append(1 - len(prev & cur) / len(prev))

        for sym in (prev or set()) - cur:
            if sym in active:
                finished.append(active.pop(sym))

        for sym in cur:
            active[sym] = active.get(sym, 0) + 1
        prev = cur

    finished.extend(active.values())
    return {
        "months": len(dates),
        "meanMonthlyTurnover": safe_float(np.mean(turnovers)) if turnovers else None,
        "medianMonthlyTurnover": safe_float(np.median(turnovers)) if turnovers else None,
        "meanSpellMonths": safe_float(np.mean(finished)) if finished else None,
        "medianSpellMonths": safe_float(np.median(finished)) if finished else None,
        "p90SpellMonths": safe_float(np.quantile(finished, 0.90)) if finished else None,
    }


def architecture_definitions() -> Dict[str, dict]:
    return {
        "A1_RET120": {
            "family": "SPARSE_CONTINUOUS",
            "featureCount": 1,
            "expr": "r_ret120",
        },
        "A2_MOM2": {
            "family": "SPARSE_CONTINUOUS",
            "featureCount": 2,
            "expr": "0.50*r_ret120 + 0.50*r_ret252",
        },
        "B1_CONT6_EQUAL": {
            "family": "DIVERSE_CONTINUOUS",
            "featureCount": 6,
            "expr": "(" + " + ".join(CONT6) + ")/6.0",
        },
        "B2_CONT6_MOM_HEAVY": {
            "family": "DIVERSE_CONTINUOUS",
            "featureCount": 6,
            "expr": (
                "0.30*r_ret120 + 0.20*r_ret252 + "
                "0.15*r_ma120_gap + 0.15*r_ma60_slope5 + "
                "0.10*r_tk_gap + 0.10*r_relvol1_20"
            ),
        },
        "C1_K7_EQUAL": {
            "family": "KOREAN_STYLE_CHECKLIST",
            "featureCount": 7,
            "expr": "(" + " + ".join(K7_SIGNALS) + ")/7.0",
        },
        "C2_K7_KR_WEIGHTED": {
            "family": "KOREAN_STYLE_CHECKLIST",
            "featureCount": 7,
            "expr": (
                "1.0*sig_cloud_above + "
                "1.0*sig_tk_gt_kijun + "
                "1.5*sig_bb_breakout + "
                "1.0*sig_ma_alignment + "
                "0.5*sig_high_close_volume + "
                "2.5*sig_near_52w_high + "
                "2.0*sig_rs120_outperform_spy"
            ) + "/9.5",
        },
        "H1_MOM70_K730": {
            "family": "HYBRID",
            "featureCount": 9,
            "expr": (
                "0.70*(0.50*r_ret120 + 0.50*r_ret252) + "
                "0.30*((1.0*sig_cloud_above + 1.0*sig_tk_gt_kijun + "
                "1.5*sig_bb_breakout + 1.0*sig_ma_alignment + "
                "0.5*sig_high_close_volume + 2.5*sig_near_52w_high + "
                "2.0*sig_rs120_outperform_spy)/9.5)"
            ),
        },
        "H2_MOM50_K750": {
            "family": "HYBRID",
            "featureCount": 9,
            "expr": (
                "0.50*(0.50*r_ret120 + 0.50*r_ret252) + "
                "0.50*((1.0*sig_cloud_above + 1.0*sig_tk_gt_kijun + "
                "1.5*sig_bb_breakout + 1.0*sig_ma_alignment + "
                "0.5*sig_high_close_volume + 2.5*sig_near_52w_high + "
                "2.0*sig_rs120_outperform_spy)/9.5)"
            ),
        },
        "H3_MOM30_K770": {
            "family": "HYBRID",
            "featureCount": 9,
            "expr": (
                "0.30*(0.50*r_ret120 + 0.50*r_ret252) + "
                "0.70*((1.0*sig_cloud_above + 1.0*sig_tk_gt_kijun + "
                "1.5*sig_bb_breakout + 1.0*sig_ma_alignment + "
                "0.5*sig_high_close_volume + 2.5*sig_near_52w_high + "
                "2.0*sig_rs120_outperform_spy)/9.5)"
            ),
        },
    }


def k7_ablation_expr(drop_signal: str | None) -> Tuple[str, float]:
    weights = {
        k: v for k, v in K7_WEIGHTS.items()
        if drop_signal is None or k != drop_signal
    }
    denom = sum(weights.values())
    expr = " + ".join(f"{w}*{k}" for k, w in weights.items())
    return f"({expr})/{denom}", denom


def evaluate_top_tail(
    con: duckdb.DuckDBPyConnection,
    feature_path: str,
    candidate: str,
    family: str,
    feature_count: int,
    expr: str,
    horizon: int,
) -> Tuple[dict, pd.DataFrame]:
    target = f"fwd_ret_{horizon}"
    spy = f"spy_fwd_{horizon}"

    daily = con.execute(
        f"""
        WITH s AS (
          SELECT
            dt, symbol, {target} AS target, {spy} AS spy_target,
            ({expr}) AS score
          FROM read_parquet('{feature_path}')
          WHERE {target} IS NOT NULL
            AND {spy} IS NOT NULL
        ),
        r AS (
          SELECT *,
            PERCENT_RANK() OVER (PARTITION BY dt ORDER BY score) AS score_pct,
            PERCENT_RANK() OVER (PARTITION BY dt ORDER BY target) AS target_pct
          FROM s
        )
        SELECT
          dt,
          COUNT(*)::BIGINT AS n,
          CORR(score_pct, target_pct) AS rank_ic,
          COUNT(*) FILTER (WHERE score_pct >= 0.90)::BIGINT AS top10_n,
          COUNT(*) FILTER (WHERE score_pct >= 0.80)::BIGINT AS top20_n,
          AVG(CASE WHEN score_pct >= 0.90 THEN target END) AS top10_return,
          AVG(CASE WHEN score_pct >= 0.80 THEN target END) AS top20_return,
          AVG(target) AS universe_return,
          ANY_VALUE(spy_target) AS spy_return
        FROM r
        GROUP BY dt
        ORDER BY dt
        """
    ).df()

    daily["top10_excess_universe"] = daily["top10_return"] - daily["universe_return"]
    daily["top20_excess_universe"] = daily["top20_return"] - daily["universe_return"]
    daily["top10_excess_spy"] = daily["top10_return"] - daily["spy_return"]
    daily["top20_excess_spy"] = daily["top20_return"] - daily["spy_return"]
    daily["year"] = pd.to_datetime(daily["dt"]).dt.year

    ic_std = daily["rank_ic"].std(ddof=1)
    rec = {
        "candidate": candidate,
        "family": family,
        "featureCount": feature_count,
        "horizon": horizon,
        "days": int(daily["rank_ic"].notna().sum()),
        "meanRankIC": safe_float(daily["rank_ic"].mean()),
        "rankIcIR": (
            safe_float(daily["rank_ic"].mean() / ic_std)
            if pd.notna(ic_std) and ic_std > 0 else None
        ),
        "positiveIcRatio": safe_float((daily["rank_ic"] > 0).mean()),
        "meanTop10N": safe_float(daily["top10_n"].mean()),
        "meanTop20N": safe_float(daily["top20_n"].mean()),
        "meanTop10Return": safe_float(daily["top10_return"].mean()),
        "meanTop10ExcessUniverse": safe_float(daily["top10_excess_universe"].mean()),
        "medianTop10ExcessUniverse": safe_float(daily["top10_excess_universe"].median()),
        "positiveTop10ExcessUniverse": safe_float((daily["top10_excess_universe"] > 0).mean()),
        "meanTop10ExcessSpy": safe_float(daily["top10_excess_spy"].mean()),
        "meanTop20ExcessUniverse": safe_float(daily["top20_excess_universe"].mean()),
        "meanTop20ExcessSpy": safe_float(daily["top20_excess_spy"].mean()),
    }
    return rec, daily


def evaluate_threshold(
    con: duckdb.DuckDBPyConnection,
    feature_path: str,
    candidate: str,
    expr: str,
    threshold: int,
    horizon: int,
    mode: str,
) -> Tuple[dict, pd.DataFrame]:
    target = f"fwd_ret_{horizon}"
    spy = f"spy_fwd_{horizon}"
    mode = mode.upper()
    if mode not in {"STATE", "ONSET"}:
        raise ValueError(mode)

    selected_clause = (
        f"score >= {threshold/100.0}"
        if mode == "STATE"
        else f"prev_score < {threshold/100.0} AND score >= {threshold/100.0}"
    )

    daily = con.execute(
        f"""
        WITH b AS (
          SELECT
            dt, symbol, {target} AS target, {spy} AS spy_target,
            ({expr}) AS score
          FROM read_parquet('{feature_path}')
          WHERE {target} IS NOT NULL
            AND {spy} IS NOT NULL
        ),
        p AS (
          SELECT *,
            LAG(score) OVER (PARTITION BY symbol ORDER BY dt) AS prev_score
          FROM b
        ),
        u AS (
          SELECT dt, AVG(target) AS universe_return
          FROM b
          GROUP BY dt
        ),
        sel AS (
          SELECT
            dt,
            COUNT(*)::BIGINT AS selected_n,
            AVG(target) AS selected_return,
            ANY_VALUE(spy_target) AS spy_return
          FROM p
          WHERE {selected_clause}
          GROUP BY dt
        )
        SELECT
          sel.dt, sel.selected_n, sel.selected_return,
          u.universe_return, sel.spy_return
        FROM sel
        JOIN u USING(dt)
        ORDER BY sel.dt
        """
    ).df()

    if daily.empty:
        rec = {
            "candidate": candidate,
            "mode": mode,
            "threshold": threshold,
            "horizon": horizon,
            "days": 0,
            "meanSelectedN": None,
            "meanReturn": None,
            "meanExcessUniverse": None,
            "medianExcessUniverse": None,
            "positiveExcessUniverse": None,
            "meanExcessSpy": None,
        }
        return rec, daily

    daily["excess_universe"] = daily["selected_return"] - daily["universe_return"]
    daily["excess_spy"] = daily["selected_return"] - daily["spy_return"]
    daily["year"] = pd.to_datetime(daily["dt"]).dt.year

    rec = {
        "candidate": candidate,
        "mode": mode,
        "threshold": threshold,
        "horizon": horizon,
        "days": int(len(daily)),
        "meanSelectedN": safe_float(daily["selected_n"].mean()),
        "meanReturn": safe_float(daily["selected_return"].mean()),
        "meanExcessUniverse": safe_float(daily["excess_universe"].mean()),
        "medianExcessUniverse": safe_float(daily["excess_universe"].median()),
        "positiveExcessUniverse": safe_float((daily["excess_universe"] > 0).mean()),
        "meanExcessSpy": safe_float(daily["excess_spy"].mean()),
    }
    return rec, daily


def main() -> None:
    args = parse_args()
    root = Path(args.input).resolve()
    out = Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=True)

    temp_root = Path(os.environ.get("RUNNER_TEMP", str(out.parent / ".us31-work")))
    work = temp_root / "cloudtrend-us31"
    work.mkdir(parents=True, exist_ok=True)
    (work / "tmp").mkdir(parents=True, exist_ok=True)

    canonical = sorted((root / "canonical").glob("year=*/us_stock_daily.parquet"))
    if len(canonical) != 11:
        raise RuntimeError(f"expected 11 canonical yearly files, found {len(canonical)}")
    bench = root / "benchmark" / "us_benchmarks_adjusted.parquet"
    if not bench.exists():
        raise FileNotFoundError(bench)

    con = duckdb.connect(str(work / "us31.duckdb"))
    con.execute(f"SET memory_limit='{args.memory_limit}'")
    con.execute(f"SET threads={int(args.threads)}")
    con.execute(f"SET temp_directory='{str(work / 'tmp')}'")

    price_glob = str(root / "canonical" / "year=*" / "us_stock_daily.parquet").replace("'", "''")
    bench_path = str(bench).replace("'", "''")
    feature_path = str(work / "us31_features.parquet").replace("'", "''")

    feature_sql = f"""
    WITH src AS (
      SELECT
        CAST(symbol AS VARCHAR) AS symbol,
        CAST(tradeDateUsEastern AS DATE) AS dt,
        CAST(open AS DOUBLE) AS open,
        CAST(high AS DOUBLE) AS high,
        CAST(low AS DOUBLE) AS low,
        CAST(close AS DOUBLE) AS close,
        CAST(volume AS DOUBLE) AS volume
      FROM read_parquet('{price_glob}', union_by_name=true)
    ),
    w1 AS (
      SELECT
        *,
        LAG(close,120) OVER w AS close_l120,
        LAG(close,252) OVER w AS close_l252,
        LEAD(close,120) OVER w AS close_f120,
        LEAD(close,252) OVER w AS close_f252,
        AVG(close) OVER (PARTITION BY symbol ORDER BY dt ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20,
        AVG(close) OVER (PARTITION BY symbol ORDER BY dt ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) AS ma60,
        AVG(close) OVER (PARTITION BY symbol ORDER BY dt ROWS BETWEEN 119 PRECEDING AND CURRENT ROW) AS ma120,
        STDDEV_SAMP(close) OVER (PARTITION BY symbol ORDER BY dt ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS sd20,
        AVG(volume) OVER (PARTITION BY symbol ORDER BY dt ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS avgvol20,
        MAX(high) OVER (PARTITION BY symbol ORDER BY dt ROWS BETWEEN 8 PRECEDING AND CURRENT ROW) AS high9,
        MIN(low) OVER (PARTITION BY symbol ORDER BY dt ROWS BETWEEN 8 PRECEDING AND CURRENT ROW) AS low9,
        MAX(high) OVER (PARTITION BY symbol ORDER BY dt ROWS BETWEEN 25 PRECEDING AND CURRENT ROW) AS high26,
        MIN(low) OVER (PARTITION BY symbol ORDER BY dt ROWS BETWEEN 25 PRECEDING AND CURRENT ROW) AS low26,
        MAX(high) OVER (PARTITION BY symbol ORDER BY dt ROWS BETWEEN 51 PRECEDING AND CURRENT ROW) AS high52,
        MIN(low) OVER (PARTITION BY symbol ORDER BY dt ROWS BETWEEN 51 PRECEDING AND CURRENT ROW) AS low52,
        MAX(high) OVER (PARTITION BY symbol ORDER BY dt ROWS BETWEEN 251 PRECEDING AND CURRENT ROW) AS high252,
        MAX(high) OVER (PARTITION BY symbol ORDER BY dt ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS prior20_high
      FROM src
      WINDOW w AS (PARTITION BY symbol ORDER BY dt)
    ),
    w2 AS (
      SELECT
        *,
        (high9 + low9)/2.0 AS tenkan,
        (high26 + low26)/2.0 AS kijun,
        ((high9 + low9)/2.0 + (high26 + low26)/2.0)/2.0 AS span_a_unshifted,
        (high52 + low52)/2.0 AS span_b_unshifted
      FROM w1
    ),
    w3 AS (
      SELECT
        *,
        LAG(ma60,5) OVER (PARTITION BY symbol ORDER BY dt) AS ma60_l5,
        LAG(span_a_unshifted,26) OVER (PARTITION BY symbol ORDER BY dt) AS cloud_a,
        LAG(span_b_unshifted,26) OVER (PARTITION BY symbol ORDER BY dt) AS cloud_b
      FROM w2
    ),
    b0 AS (
      SELECT CAST(dt AS DATE) AS dt, CAST(spy_close AS DOUBLE) AS spy_close
      FROM read_parquet('{bench_path}')
    ),
    b1 AS (
      SELECT
        dt,
        spy_close,
        spy_close / NULLIF(LAG(spy_close,120) OVER (ORDER BY dt),0) - 1 AS spy_ret120,
        LEAD(spy_close,120) OVER (ORDER BY dt) / NULLIF(spy_close,0) - 1 AS spy_fwd120,
        LEAD(spy_close,252) OVER (ORDER BY dt) / NULLIF(spy_close,0) - 1 AS spy_fwd252
      FROM b0
    ),
    f AS (
      SELECT
        w3.symbol,
        w3.dt,
        w3.close / NULLIF(w3.close_l120,0) - 1 AS ret120,
        w3.close / NULLIF(w3.close_l252,0) - 1 AS ret252,
        w3.close / NULLIF(w3.ma120,0) - 1 AS ma120_gap,
        w3.ma60 / NULLIF(w3.ma60_l5,0) - 1 AS ma60_slope5,
        w3.tenkan / NULLIF(w3.kijun,0) - 1 AS tk_gap,
        w3.volume / NULLIF(w3.avgvol20,0) - 1 AS relvol1_20,
        w3.close / NULLIF(w3.high252,0) - 1 AS high252_gap,
        w3.close / NULLIF(w3.prior20_high,0) - 1 AS donchian20_gap,
        w3.close_f120 / NULLIF(w3.close,0) - 1 AS fwd_ret_120,
        w3.close_f252 / NULLIF(w3.close,0) - 1 AS fwd_ret_252,
        b1.spy_fwd120 AS spy_fwd_120,
        b1.spy_fwd252 AS spy_fwd_252,
        CASE WHEN w3.close > GREATEST(w3.cloud_a,w3.cloud_b) THEN 1.0 ELSE 0.0 END AS sig_cloud_above,
        CASE WHEN w3.tenkan > w3.kijun THEN 1.0 ELSE 0.0 END AS sig_tk_gt_kijun,
        CASE WHEN w3.close > w3.ma20 + 2.0*w3.sd20 THEN 1.0 ELSE 0.0 END AS sig_bb_breakout,
        CASE WHEN w3.ma20 > w3.ma60 AND w3.ma60 > w3.ma120 THEN 1.0 ELSE 0.0 END AS sig_ma_alignment,
        CASE WHEN
          w3.volume >= 1.5*w3.avgvol20
          AND CASE WHEN w3.high > w3.low THEN (w3.close-w3.low)/(w3.high-w3.low) ELSE 0 END >= 0.70
          THEN 1.0 ELSE 0.0 END AS sig_high_close_volume,
        CASE WHEN w3.close / NULLIF(w3.high252,0) - 1 >= -0.10 THEN 1.0 ELSE 0.0 END AS sig_near_52w_high,
        CASE WHEN
          w3.close / NULLIF(w3.close_l120,0) - 1 > b1.spy_ret120
          THEN 1.0 ELSE 0.0 END AS sig_rs120_outperform_spy
      FROM w3
      LEFT JOIN b1 USING(dt)
      WHERE w3.dt >= DATE '{EVAL_START}'
    ),
    eligible AS (
      SELECT *
      FROM f
      WHERE ret120 IS NOT NULL
        AND ret252 IS NOT NULL
        AND ma120_gap IS NOT NULL
        AND ma60_slope5 IS NOT NULL
        AND tk_gap IS NOT NULL
        AND relvol1_20 IS NOT NULL
        AND spy_fwd_120 IS NOT NULL
    )
    SELECT
      *,
      PERCENT_RANK() OVER (PARTITION BY dt ORDER BY ret120) AS r_ret120,
      PERCENT_RANK() OVER (PARTITION BY dt ORDER BY ret252) AS r_ret252,
      PERCENT_RANK() OVER (PARTITION BY dt ORDER BY ma120_gap) AS r_ma120_gap,
      PERCENT_RANK() OVER (PARTITION BY dt ORDER BY ma60_slope5) AS r_ma60_slope5,
      PERCENT_RANK() OVER (PARTITION BY dt ORDER BY tk_gap) AS r_tk_gap,
      PERCENT_RANK() OVER (PARTITION BY dt ORDER BY relvol1_20) AS r_relvol1_20
    FROM eligible
    """

    con.execute(
        f"COPY ({feature_sql}) TO '{feature_path}' "
        "(FORMAT PARQUET, COMPRESSION ZSTD)"
    )

    qa = con.execute(
        f"""
        SELECT
          COUNT(*)::BIGINT AS rows,
          COUNT(DISTINCT symbol)::BIGINT AS symbols,
          MIN(dt) AS min_date,
          MAX(dt) AS max_date
        FROM read_parquet('{feature_path}')
        """
    ).df()
    qa.to_csv(out / "common_sample_qa.csv", index=False)

    # Binary signal incidence and redundancy.
    incidence_rows = []
    for sig in K7_SIGNALS:
        row = con.execute(
            f"""
            SELECT
              AVG({sig}) AS prevalence,
              COUNT(*)::BIGINT AS rows
            FROM read_parquet('{feature_path}')
            """
        ).fetchone()
        incidence_rows.append({
            "signal": sig,
            "prevalence": safe_float(row[0]),
            "rows": int(row[1]),
        })
    pd.DataFrame(incidence_rows).to_csv(out / "k7_signal_incidence.csv", index=False)

    month_end = con.execute(
        f"""
        WITH x AS (
          SELECT *,
            MAX(dt) OVER (PARTITION BY DATE_TRUNC('month',dt)) AS month_end
          FROM read_parquet('{feature_path}')
        )
        SELECT {", ".join(K7_SIGNALS)}
        FROM x
        WHERE dt = month_end
        """
    ).df()
    corr = month_end[K7_SIGNALS].corr()
    corr.to_csv(out / "k7_signal_correlation.csv")

    architectures = architecture_definitions()
    overall_rows = []
    yearly_frames = []
    turnover_rows = []

    for candidate, spec in architectures.items():
        for horizon in (120,252):
            rec, daily = evaluate_top_tail(
                con, feature_path, candidate, spec["family"],
                spec["featureCount"], spec["expr"], horizon
            )
            overall_rows.append(rec)
            yearly = (
                daily.groupby("year",as_index=False)
                .agg(
                    days=("rank_ic","count"),
                    meanRankIC=("rank_ic","mean"),
                    meanTop10ExcessUniverse=("top10_excess_universe","mean"),
                    meanTop10ExcessSpy=("top10_excess_spy","mean"),
                    meanTop20ExcessUniverse=("top20_excess_universe","mean"),
                    positiveTop10ExcessUniverse=("top10_excess_universe",lambda x: (x>0).mean()),
                )
            )
            yearly["candidate"] = candidate
            yearly["family"] = spec["family"]
            yearly["horizon"] = horizon
            yearly_frames.append(yearly)

        members = con.execute(
            f"""
            WITH s AS (
              SELECT dt, symbol, ({spec["expr"]}) AS score
              FROM read_parquet('{feature_path}')
            ),
            m AS (
              SELECT *,
                MAX(dt) OVER (PARTITION BY DATE_TRUNC('month',dt)) AS month_end
              FROM s
            ),
            r AS (
              SELECT dt, symbol,
                PERCENT_RANK() OVER (PARTITION BY dt ORDER BY score) AS score_pct
              FROM m
              WHERE dt=month_end
            )
            SELECT dt,symbol
            FROM r
            WHERE score_pct >= 0.90
            ORDER BY dt,symbol
            """
        ).df()
        tr = monthly_turnover_and_spells(members)
        tr.update({
            "candidate": candidate,
            "family": spec["family"],
            "featureCount": spec["featureCount"],
        })
        turnover_rows.append(tr)

    overall = pd.DataFrame(overall_rows)
    yearly = pd.concat(yearly_frames, ignore_index=True)
    turnover = pd.DataFrame(turnover_rows)
    overall.to_csv(out / "architecture_overall.csv", index=False)
    yearly.to_csv(out / "architecture_yearly.csv", index=False)
    turnover.to_csv(out / "architecture_turnover.csv", index=False)

    # Checklist State/Onset 60/70/80.
    threshold_candidates = {
        k: v for k,v in architectures.items()
        if k in {"C1_K7_EQUAL","C2_K7_KR_WEIGHTED","H2_MOM50_K750"}
    }
    threshold_rows = []
    threshold_yearly_frames = []
    threshold_turnover_rows = []

    for candidate, spec in threshold_candidates.items():
        for threshold in (60,70,80):
            for mode in ("STATE","ONSET"):
                for horizon in (120,252):
                    rec, daily = evaluate_threshold(
                        con, feature_path, candidate, spec["expr"],
                        threshold, horizon, mode
                    )
                    threshold_rows.append(rec)
                    if not daily.empty:
                        yr = (
                            daily.groupby("year",as_index=False)
                            .agg(
                                days=("excess_universe","count"),
                                meanSelectedN=("selected_n","mean"),
                                meanExcessUniverse=("excess_universe","mean"),
                                meanExcessSpy=("excess_spy","mean"),
                                positiveExcessUniverse=("excess_universe",lambda x:(x>0).mean()),
                            )
                        )
                        yr["candidate"] = candidate
                        yr["threshold"] = threshold
                        yr["mode"] = mode
                        yr["horizon"] = horizon
                        threshold_yearly_frames.append(yr)

            # monthly membership turnover for STATE thresholds
            members = con.execute(
                f"""
                WITH s AS (
                  SELECT dt, symbol, ({spec["expr"]}) AS score
                  FROM read_parquet('{feature_path}')
                ),
                m AS (
                  SELECT *,
                    MAX(dt) OVER (PARTITION BY DATE_TRUNC('month',dt)) AS month_end
                  FROM s
                )
                SELECT dt,symbol
                FROM m
                WHERE dt=month_end
                  AND score >= {threshold/100.0}
                ORDER BY dt,symbol
                """
            ).df()
            tr = monthly_turnover_and_spells(members)
            tr.update({
                "candidate": candidate,
                "threshold": threshold,
                "mode": "STATE",
            })
            threshold_turnover_rows.append(tr)

    pd.DataFrame(threshold_rows).to_csv(out / "threshold_overall.csv", index=False)
    if threshold_yearly_frames:
        pd.concat(threshold_yearly_frames,ignore_index=True).to_csv(
            out / "threshold_yearly.csv", index=False
        )
    pd.DataFrame(threshold_turnover_rows).to_csv(
        out / "threshold_turnover.csv", index=False
    )

    # Korean-weighted checklist leave-one-out ablation.
    ablation_rows = []
    ablation_specs = [("FULL_K7", None)] + [
        (f"DROP_{sig.replace('sig_','').upper()}", sig) for sig in K7_SIGNALS
    ]
    for label, drop in ablation_specs:
        expr, denom = k7_ablation_expr(drop)
        for horizon in (120,252):
            rec, _ = evaluate_top_tail(
                con, feature_path, label, "K7_ABLATION",
                7 if drop is None else 6, expr, horizon
            )
            rec["droppedSignal"] = drop
            rec["weightDenominator"] = denom
            # Add State80 because high-score behavior matters for checklist models.
            state80, _ = evaluate_threshold(
                con, feature_path, label, expr, 80, horizon, "STATE"
            )
            rec["state80Days"] = state80["days"]
            rec["state80MeanN"] = state80["meanSelectedN"]
            rec["state80ExcessUniverse"] = state80["meanExcessUniverse"]
            rec["state80ExcessSpy"] = state80["meanExcessSpy"]
            ablation_rows.append(rec)
    pd.DataFrame(ablation_rows).to_csv(out / "k7_ablation.csv", index=False)

    arch_config = pd.DataFrame([
        {
            "candidate": name,
            "family": spec["family"],
            "featureCount": spec["featureCount"],
            "expression": spec["expr"],
        }
        for name,spec in architectures.items()
    ])
    arch_config.to_csv(out / "architecture_config.csv", index=False)

    summary = {
        "study": "CloudTrend US-3.1 Feature Diversity / Checklist Architecture Study",
        "version": STUDY_VERSION,
        "researchGrade": RESEARCH_GRADE,
        "finalOosAllowed": False,
        "purpose": (
            "Test whether a Korean-screener-like diversified checklist or a broader "
            "continuous feature set adds incremental value versus sparse momentum, "
            "instead of assuming feature compression is optimal."
        ),
        "commonSample": {
            "rows": int(qa.iloc[0]["rows"]),
            "symbols": int(qa.iloc[0]["symbols"]),
            "minDate": str(qa.iloc[0]["min_date"]),
            "maxDate": str(qa.iloc[0]["max_date"]),
        },
        "k7Analogue": {
            "sig_cloud_above": "close above displayed Ichimoku cloud top",
            "sig_tk_gt_kijun": "Tenkan > Kijun",
            "sig_bb_breakout": "close > 20D Bollinger upper band",
            "sig_ma_alignment": "MA20 > MA60 > MA120",
            "sig_high_close_volume": "volume >= 1.5x 20D avg and CLV >= 0.70",
            "sig_near_52w_high": "close within 10% of rolling 252D high",
            "sig_rs120_outperform_spy": "120D stock return > 120D SPY return",
        },
        "k7Weights": K7_WEIGHTS,
        "architectures": architectures,
        "thresholds": [60,70,80],
        "modes": ["STATE","ONSET"],
        "horizons": [120,252],
        "executionNote": (
            "This stage evaluates signal architecture using close-to-forward-close returns. "
            "Tradable t+1 open execution remains a later validation stage."
        ),
        "limitations": [
            "Current-universe survivor-only backfill",
            "No US point-in-time delisted universe",
            "Current data mainly price/volume/benchmark; no independent institutional/fundamental flow block yet",
        ],
    }
    (out / "summary.json").write_text(json.dumps(summary,indent=2),encoding="utf-8")

    print(json.dumps({
        "ok": True,
        "study": STUDY_VERSION,
        "output": str(out),
        "commonSample": summary["commonSample"],
        "architectures": len(architectures),
        "ablationModels": len(ablation_specs),
    }))


if __name__ == "__main__":
    main()
