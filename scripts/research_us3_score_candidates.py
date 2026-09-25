from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
from typing import Dict

import duckdb
import numpy as np
import pandas as pd

RESEARCH_GRADE = "SURVIVOR_ONLY_EXPLORATORY"
STUDY_VERSION = "us3-score-candidates-v0"
EVAL_START = "2017-01-01"

# Daily cross-sectional percentile-rank composites.
# Core = ret120, ret252, lower vol60, lower amihud20.
# Challengers = ma120_gap, beta60_spy.
CANDIDATES: Dict[str, Dict[str, float]] = {
    "S1_RET120": {"r_ret120": 1.00},
    "S2_MOMENTUM_EQ": {"r_ret120": 0.50, "r_ret252": 0.50},
    "S3_MOM_VOL_EQ": {"r_ret120": 1 / 3, "r_ret252": 1 / 3, "r_low_vol60": 1 / 3},
    "S4_MOM_LIQ_EQ": {"r_ret120": 1 / 3, "r_ret252": 1 / 3, "r_low_amihud20": 1 / 3},
    "S5_CORE4_EQ": {
        "r_ret120": 0.25,
        "r_ret252": 0.25,
        "r_low_vol60": 0.25,
        "r_low_amihud20": 0.25,
    },
    "S6_CORE4_MOM_HEAVY": {
        "r_ret120": 0.35,
        "r_ret252": 0.25,
        "r_low_vol60": 0.20,
        "r_low_amihud20": 0.20,
    },
    "S7_CORE4_QUALITY_HEAVY": {
        "r_ret120": 0.25,
        "r_ret252": 0.15,
        "r_low_vol60": 0.30,
        "r_low_amihud20": 0.30,
    },
    "S8_CORE4_PLUS_MA120": {
        "r_ret120": 0.225,
        "r_ret252": 0.225,
        "r_low_vol60": 0.225,
        "r_low_amihud20": 0.225,
        "r_ma120_gap": 0.10,
    },
    "S9_CORE4_PLUS_BETA": {
        "r_ret120": 0.225,
        "r_ret252": 0.225,
        "r_low_vol60": 0.225,
        "r_low_amihud20": 0.225,
        "r_beta60_spy": 0.10,
    },
    "S10_CORE4_PLUS_BOTH": {
        "r_ret120": 0.20,
        "r_ret252": 0.20,
        "r_low_vol60": 0.20,
        "r_low_amihud20": 0.20,
        "r_ma120_gap": 0.10,
        "r_beta60_spy": 0.10,
    },
}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--threads", type=int, default=2)
    p.add_argument("--memory-limit", default="5GB")
    return p.parse_args()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def safe_float(value):
    if value is None:
        return None
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def score_expr(weights: Dict[str, float]) -> str:
    return " + ".join(f"({float(w):.12f}) * {col}" for col, w in weights.items())


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

    turnovers: list[float] = []
    prev: set[str] | None = None
    active: dict[str, int] = {}
    finished: list[int] = []

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


def main() -> None:
    args = parse_args()
    root = Path(args.input).resolve()
    out = Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=True)
    runner_temp = Path(os.environ.get("RUNNER_TEMP", str(out.parent / ".us3-work")))
    work = runner_temp / "cloudtrend-us3"
    work.mkdir(parents=True, exist_ok=True)
    (work / "tmp").mkdir(parents=True, exist_ok=True)

    canonical = sorted((root / "canonical").glob("year=*/us_stock_daily.parquet"))
    if len(canonical) != 11:
        raise RuntimeError(f"expected 11 canonical yearly files, found {len(canonical)}")

    bench = root / "benchmark" / "us_benchmarks_adjusted.parquet"
    if not bench.exists():
        raise FileNotFoundError(bench)

    source_manifest = {
        "studyVersion": STUDY_VERSION,
        "researchGrade": RESEARCH_GRADE,
        "canonicalFiles": [
            {
                "path": str(p.relative_to(root)),
                "bytes": p.stat().st_size,
                "sha256": sha256_file(p),
            }
            for p in canonical
        ],
        "benchmark": {
            "path": str(bench.relative_to(root)),
            "bytes": bench.stat().st_size,
            "sha256": sha256_file(bench),
        },
    }
    (out / "source_manifest.json").write_text(
        json.dumps(source_manifest, indent=2),
        encoding="utf-8",
    )

    con = duckdb.connect(str(work / "us3.duckdb"))
    con.execute(f"SET memory_limit='{args.memory_limit}'")
    con.execute(f"SET threads={int(args.threads)}")
    con.execute(f"SET temp_directory='{str(work / 'tmp')}'")

    price_glob = str(root / "canonical" / "year=*" / "us_stock_daily.parquet").replace("'", "''")
    bench_path = str(bench).replace("'", "''")
    ranked_path = str(work / "us3_ranked.parquet").replace("'", "''")

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
        LAG(close, 1) OVER w AS close_l1,
        LAG(close, 120) OVER w AS close_l120,
        LAG(close, 252) OVER w AS close_l252,
        LEAD(close, 120) OVER w AS close_f120,
        LEAD(close, 252) OVER w AS close_f252,
        AVG(close) OVER (
          PARTITION BY symbol ORDER BY dt
          ROWS BETWEEN 119 PRECEDING AND CURRENT ROW
        ) AS ma120
      FROM src
      WINDOW w AS (PARTITION BY symbol ORDER BY dt)
    ),
    w2 AS (
      SELECT
        *,
        close / NULLIF(close_l1, 0) - 1 AS ret1,
        close / NULLIF(close_l120, 0) - 1 AS ret120,
        close / NULLIF(close_l252, 0) - 1 AS ret252,
        ABS(close / NULLIF(close_l1, 0) - 1) / NULLIF(close * volume, 0) AS amihud1
      FROM w1
    ),
    w3 AS (
      SELECT
        *,
        STDDEV_SAMP(ret1) OVER (
          PARTITION BY symbol ORDER BY dt
          ROWS BETWEEN 59 PRECEDING AND CURRENT ROW
        ) * SQRT(252.0) AS vol60_ann,
        AVG(amihud1) OVER (
          PARTITION BY symbol ORDER BY dt
          ROWS BETWEEN 19 PRECEDING AND CURRENT ROW
        ) AS amihud20
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
        spy_close / NULLIF(LAG(spy_close, 1) OVER (ORDER BY dt), 0) - 1 AS spy_ret1,
        LEAD(spy_close, 120) OVER (ORDER BY dt) / NULLIF(spy_close, 0) - 1 AS spy_fwd120,
        LEAD(spy_close, 252) OVER (ORDER BY dt) / NULLIF(spy_close, 0) - 1 AS spy_fwd252
      FROM b0
    ),
    j AS (
      SELECT
        w3.*,
        b1.spy_ret1,
        b1.spy_fwd120,
        b1.spy_fwd252
      FROM w3
      LEFT JOIN b1 USING(dt)
    ),
    w4 AS (
      SELECT
        *,
        COVAR_SAMP(ret1, spy_ret1) OVER (
          PARTITION BY symbol ORDER BY dt
          ROWS BETWEEN 59 PRECEDING AND CURRENT ROW
        )
        / NULLIF(
            VAR_SAMP(spy_ret1) OVER (
              PARTITION BY symbol ORDER BY dt
              ROWS BETWEEN 59 PRECEDING AND CURRENT ROW
            ),
            0
          ) AS beta60_spy
      FROM j
    ),
    f AS (
      SELECT
        symbol,
        dt,
        ret120,
        ret252,
        close / NULLIF(ma120, 0) - 1 AS ma120_gap,
        vol60_ann,
        amihud20,
        beta60_spy,
        close_f120 / NULLIF(close, 0) - 1 AS fwd_ret_120,
        close_f252 / NULLIF(close, 0) - 1 AS fwd_ret_252,
        spy_fwd120 AS spy_fwd_120,
        spy_fwd252 AS spy_fwd_252
      FROM w4
      WHERE dt >= DATE '{EVAL_START}'
    ),
    eligible AS (
      SELECT *
      FROM f
      WHERE ret120 IS NOT NULL
        AND ret252 IS NOT NULL
        AND ma120_gap IS NOT NULL
        AND vol60_ann IS NOT NULL
        AND amihud20 IS NOT NULL
        AND beta60_spy IS NOT NULL
    )
    SELECT
      symbol,
      dt,
      PERCENT_RANK() OVER (PARTITION BY dt ORDER BY ret120) AS r_ret120,
      PERCENT_RANK() OVER (PARTITION BY dt ORDER BY ret252) AS r_ret252,
      1.0 - PERCENT_RANK() OVER (PARTITION BY dt ORDER BY vol60_ann) AS r_low_vol60,
      1.0 - PERCENT_RANK() OVER (PARTITION BY dt ORDER BY amihud20) AS r_low_amihud20,
      PERCENT_RANK() OVER (PARTITION BY dt ORDER BY ma120_gap) AS r_ma120_gap,
      PERCENT_RANK() OVER (PARTITION BY dt ORDER BY beta60_spy) AS r_beta60_spy,
      fwd_ret_120,
      fwd_ret_252,
      spy_fwd_120,
      spy_fwd_252
    FROM eligible
    """

    con.execute(
        f"COPY ({feature_sql}) TO '{ranked_path}' "
        "(FORMAT PARQUET, COMPRESSION ZSTD)"
    )

    qa = con.execute(
        f"""
        SELECT
          COUNT(*)::BIGINT AS rows,
          COUNT(DISTINCT symbol)::BIGINT AS symbols,
          MIN(dt) AS min_date,
          MAX(dt) AS max_date
        FROM read_parquet('{ranked_path}')
        """
    ).df()
    qa.to_csv(out / "common_sample_qa.csv", index=False)

    overall_rows: list[dict] = []
    yearly_frames: list[pd.DataFrame] = []
    turnover_rows: list[dict] = []

    for candidate, weights in CANDIDATES.items():
        expr = score_expr(weights)

        for horizon in (120, 252):
            target = f"fwd_ret_{horizon}"
            spy = f"spy_fwd_{horizon}"

            daily = con.execute(
                f"""
                WITH s AS (
                  SELECT
                    dt,
                    symbol,
                    {target} AS target,
                    {spy} AS spy_target,
                    ({expr}) AS score
                  FROM read_parquet('{ranked_path}')
                  WHERE {target} IS NOT NULL
                    AND {spy} IS NOT NULL
                ),
                r AS (
                  SELECT
                    *,
                    PERCENT_RANK() OVER (PARTITION BY dt ORDER BY score) AS score_pct,
                    PERCENT_RANK() OVER (PARTITION BY dt ORDER BY target) AS target_pct
                  FROM s
                )
                SELECT
                  dt,
                  COUNT(*)::BIGINT AS n,
                  CORR(score_pct, target_pct) AS rank_ic,
                  AVG(CASE WHEN score_pct >= 0.90 THEN target END) AS top10_return,
                  AVG(CASE WHEN score_pct >= 0.80 THEN target END) AS top20_return,
                  AVG(target) AS universe_return,
                  ANY_VALUE(spy_target) AS spy_return
                FROM r
                GROUP BY dt
                ORDER BY dt
                """
            ).df()

            daily["candidate"] = candidate
            daily["horizon"] = horizon
            daily["top10_excess_universe"] = daily["top10_return"] - daily["universe_return"]
            daily["top20_excess_universe"] = daily["top20_return"] - daily["universe_return"]
            daily["top10_excess_spy"] = daily["top10_return"] - daily["spy_return"]
            daily["top20_excess_spy"] = daily["top20_return"] - daily["spy_return"]
            daily["year"] = pd.to_datetime(daily["dt"]).dt.year

            ic_std = daily["rank_ic"].std(ddof=1)
            overall_rows.append(
                {
                    "candidate": candidate,
                    "horizon": horizon,
                    "days": int(daily["rank_ic"].notna().sum()),
                    "meanRankIC": safe_float(daily["rank_ic"].mean()),
                    "medianRankIC": safe_float(daily["rank_ic"].median()),
                    "rankIcIR": (
                        safe_float(daily["rank_ic"].mean() / ic_std)
                        if pd.notna(ic_std) and ic_std > 0
                        else None
                    ),
                    "positiveIcRatio": safe_float((daily["rank_ic"] > 0).mean()),
                    "meanTop10Return": safe_float(daily["top10_return"].mean()),
                    "meanTop10ExcessUniverse": safe_float(
                        daily["top10_excess_universe"].mean()
                    ),
                    "positiveTop10ExcessUniverse": safe_float(
                        (daily["top10_excess_universe"] > 0).mean()
                    ),
                    "meanTop10ExcessSpy": safe_float(daily["top10_excess_spy"].mean()),
                    "meanTop20ExcessUniverse": safe_float(
                        daily["top20_excess_universe"].mean()
                    ),
                    "meanTop20ExcessSpy": safe_float(daily["top20_excess_spy"].mean()),
                }
            )

            yearly = (
                daily.groupby("year", as_index=False)
                .agg(
                    days=("rank_ic", "count"),
                    meanRankIC=("rank_ic", "mean"),
                    meanTop10Return=("top10_return", "mean"),
                    meanTop10ExcessUniverse=("top10_excess_universe", "mean"),
                    meanTop10ExcessSpy=("top10_excess_spy", "mean"),
                    meanTop20ExcessUniverse=("top20_excess_universe", "mean"),
                )
            )
            yearly["candidate"] = candidate
            yearly["horizon"] = horizon
            yearly_frames.append(yearly)

        members = con.execute(
            f"""
            WITH s AS (
              SELECT
                dt,
                symbol,
                ({expr}) AS score
              FROM read_parquet('{ranked_path}')
            ),
            m AS (
              SELECT
                *,
                MAX(dt) OVER (
                  PARTITION BY DATE_TRUNC('month', dt)
                ) AS month_end
              FROM s
            ),
            r AS (
              SELECT
                dt,
                symbol,
                PERCENT_RANK() OVER (
                  PARTITION BY dt ORDER BY score
                ) AS score_pct
              FROM m
              WHERE dt = month_end
            )
            SELECT dt, symbol
            FROM r
            WHERE score_pct >= 0.90
            ORDER BY dt, symbol
            """
        ).df()

        turn = monthly_turnover_and_spells(members)
        turn["candidate"] = candidate
        turnover_rows.append(turn)

    overall = pd.DataFrame(overall_rows)
    yearly = pd.concat(yearly_frames, ignore_index=True)
    turnover = pd.DataFrame(turnover_rows)
    config = pd.DataFrame(
        [
            {"candidate": name, "weights": json.dumps(weights, sort_keys=True)}
            for name, weights in CANDIDATES.items()
        ]
    )

    overall.to_csv(out / "candidate_overall.csv", index=False)
    yearly.to_csv(out / "candidate_yearly.csv", index=False)
    turnover.to_csv(out / "candidate_turnover.csv", index=False)
    config.to_csv(out / "candidate_config.csv", index=False)

    summary = {
        "study": "CloudTrend US-3 Score Candidate Study",
        "version": STUDY_VERSION,
        "researchGrade": RESEARCH_GRADE,
        "finalOosAllowed": False,
        "evaluationStart": EVAL_START,
        "primaryHorizons": [120, 252],
        "candidateCount": len(CANDIDATES),
        "commonSample": {
            "rows": int(qa.iloc[0]["rows"]),
            "symbols": int(qa.iloc[0]["symbols"]),
            "minDate": str(qa.iloc[0]["min_date"]),
            "maxDate": str(qa.iloc[0]["max_date"]),
        },
        "candidateDefinitions": CANDIDATES,
        "selectionPolicy": (
            "Exploratory only. Compare incremental improvement over ret120/momentum "
            "baselines using 120D/252D Rank IC, Top10/20 excess return, annual "
            "stability, and monthly turnover. Do not promote any candidate to "
            "production until point-in-time historical universe OOS is available."
        ),
        "outputs": [
            "candidate_overall.csv",
            "candidate_yearly.csv",
            "candidate_turnover.csv",
            "candidate_config.csv",
            "common_sample_qa.csv",
            "source_manifest.json",
        ],
    }
    (out / "summary.json").write_text(
        json.dumps(summary, indent=2),
        encoding="utf-8",
    )

    print(
        json.dumps(
            {
                "ok": True,
                "output": str(out),
                "commonSample": summary["commonSample"],
            }
        )
    )


if __name__ == "__main__":
    main()
