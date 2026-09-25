from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import duckdb
import pandas as pd

FEATURES = ["price_volume5", "rs_accel_spy"]
HORIZONS = [120, 252]
PERIODS = ["EARLY_2017_2019", "MID_2020_2022", "RECENT_2023_2026"]


def sf(v):
    try:
        v = float(v)
    except Exception:
        return None
    return v if math.isfinite(v) else None


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--panel", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--threads", type=int, default=2)
    p.add_argument("--memory-limit", default="5GB")
    return p.parse_args()


def main():
    a = parse_args()
    panel = str(Path(a.panel).resolve()).replace("'", "''")
    out = Path(a.output).resolve()
    out.mkdir(parents=True, exist_ok=True)

    con = duckdb.connect()
    con.execute(f"SET threads={a.threads}")
    con.execute(f"SET memory_limit='{a.memory_limit}'")

    rows = []
    latest_rows = []

    for feat in FEATURES:
        for direction, order in [("+1_HIGHER_BETTER", "ASC"), ("-1_LOWER_BETTER", "DESC")]:
            q = f"""
            WITH x AS (
              SELECT *,
                CASE WHEN {feat} IS NULL THEN NULL
                     ELSE PERCENT_RANK() OVER(PARTITION BY dt ORDER BY {feat} {order} NULLS LAST)
                END AS qa_rank
              FROM read_parquet('{panel}')
            ),
            d AS (
              SELECT dt, period_bucket,
                CORR(qa_rank, target_pct_120) AS rankic120,
                CORR(qa_rank, target_pct_252) AS rankic252,
                AVG(CASE WHEN qa_rank>=0.90 THEN fwd_ret_120 END) AS stand10_120,
                AVG(CASE WHEN qa_rank>=0.90 THEN fwd_ret_252 END) AS stand10_252,
                AVG(CASE WHEN mom_pct>=0.90 THEN fwd_ret_120 END) AS base_120,
                AVG(CASE WHEN mom_pct>=0.90 THEN fwd_ret_252 END) AS base_252,
                AVG(CASE WHEN mom_pct>=0.90 AND qa_rank>=0.80 THEN fwd_ret_120 END) AS conf20_120,
                AVG(CASE WHEN mom_pct>=0.90 AND qa_rank>=0.80 THEN fwd_ret_252 END) AS conf20_252,
                AVG(CASE WHEN mom_pct>=0.90 AND qa_rank>=0.90 THEN fwd_ret_120 END) AS conf10_120,
                AVG(CASE WHEN mom_pct>=0.90 AND qa_rank>=0.90 THEN fwd_ret_252 END) AS conf10_252,
                COUNT(*) FILTER(WHERE mom_pct>=0.90 AND qa_rank>=0.80 AND fwd_ret_120 IS NOT NULL) AS n20_120,
                COUNT(*) FILTER(WHERE mom_pct>=0.90 AND qa_rank>=0.80 AND fwd_ret_252 IS NOT NULL) AS n20_252,
                COUNT(*) FILTER(WHERE mom_pct>=0.90 AND qa_rank>=0.90 AND fwd_ret_120 IS NOT NULL) AS n10_120,
                COUNT(*) FILTER(WHERE mom_pct>=0.90 AND qa_rank>=0.90 AND fwd_ret_252 IS NOT NULL) AS n10_252,
                AVG(fwd_ret_120) AS univ_120,
                AVG(fwd_ret_252) AS univ_252
              FROM x
              GROUP BY dt, period_bucket
            )
            SELECT * FROM d ORDER BY dt
            """
            d = con.execute(q).df()

            for h in HORIZONS:
                valid = d[d[f"base_{h}"].notna()].copy()
                rec = {
                    "feature": feat,
                    "direction": direction,
                    "horizon": h,
                    "meanRankIC": sf(valid[f"rankic{h}"].mean()),
                    "standaloneTop10ExcessUniverse": sf((valid[f"stand10_{h}"] - valid[f"univ_{h}"]).mean()),
                    "mom10Confirm20Delta": sf((valid[f"conf20_{h}"] - valid[f"base_{h}"]).mean()),
                    "mom10Confirm10Delta": sf((valid[f"conf10_{h}"] - valid[f"base_{h}"]).mean()),
                    "meanSelectedNConfirm20": sf(valid[f"n20_{h}"].replace(0, pd.NA).mean()),
                    "meanSelectedNConfirm10": sf(valid[f"n10_{h}"].replace(0, pd.NA).mean()),
                    "positiveDailyDeltaConfirm20": sf(((valid[f"conf20_{h}"] - valid[f"base_{h}"]) > 0).mean()),
                    "positiveDailyDeltaConfirm10": sf(((valid[f"conf10_{h}"] - valid[f"base_{h}"]) > 0).mean()),
                }
                pos20 = 0
                pos10 = 0
                for p in PERIODS:
                    z = valid[valid.period_bucket == p]
                    v20 = sf((z[f"conf20_{h}"] - z[f"base_{h}"]).mean()) if len(z) else None
                    v10 = sf((z[f"conf10_{h}"] - z[f"base_{h}"]).mean()) if len(z) else None
                    rec[f"confirm20Delta_{p}"] = v20
                    rec[f"confirm10Delta_{p}"] = v10
                    if v20 is not None and v20 > 0:
                        pos20 += 1
                    if v10 is not None and v10 > 0:
                        pos10 += 1
                rec["confirm20PeriodPositiveCount"] = pos20
                rec["confirm10PeriodPositiveCount"] = pos10
                rows.append(rec)

            latest = con.execute(f"""
                WITH x AS (
                  SELECT *,
                    CASE WHEN {feat} IS NULL THEN NULL
                         ELSE PERCENT_RANK() OVER(PARTITION BY dt ORDER BY {feat} {order} NULLS LAST)
                    END AS qa_rank
                  FROM read_parquet('{panel}')
                ),
                m AS (SELECT MAX(dt) AS dt FROM x)
                SELECT '{feat}' AS feature, '{direction}' AS direction, x.dt, symbol,
                       {feat} AS raw_value, qa_rank, mom_pct, ret120, ret252
                FROM x, m
                WHERE x.dt=m.dt AND mom_pct>=0.90 AND qa_rank>=0.80
                ORDER BY mom_pct DESC, qa_rank DESC
                LIMIT 30
            """).df()
            latest_rows.append(latest)

    result = pd.DataFrame(rows)
    result.to_csv(out / "stage0_direction_qa.csv", index=False)
    pd.concat(latest_rows, ignore_index=True).to_csv(out / "stage0_latest_selected_symbols.csv", index=False)

    decision = {}
    for feat in FEATURES:
        z = result[(result.feature == feat) & (result.horizon == 252)].copy()
        z = z.sort_values(
            ["confirm20PeriodPositiveCount", "mom10Confirm20Delta", "standaloneTop10ExcessUniverse"],
            ascending=[False, False, False],
        )
        best = z.iloc[0]
        decision[feat] = {
            "bestDirection": best.direction,
            "rankIC252": sf(best.meanRankIC),
            "standaloneTop10ExcessUniverse252": sf(best.standaloneTop10ExcessUniverse),
            "mom10Confirm20Delta252": sf(best.mom10Confirm20Delta),
            "confirm20PeriodPositiveCount": int(best.confirm20PeriodPositiveCount),
            "interpretation": (
                "higher raw values preferred" if best.direction == "+1_HIGHER_BETTER"
                else "lower raw values preferred"
            ),
        }

    summary = {
        "study": "CloudTrend US-3.3 Stage 0 Direction QA",
        "researchGrade": "SURVIVOR_ONLY_EXPLORATORY",
        "finalOosAllowed": False,
        "features": FEATURES,
        "directionsCompared": ["+1_HIGHER_BETTER", "-1_LOWER_BETTER"],
        "decision": decision,
        "note": "Direction QA only. price_volume5 remains excluded from the default US-3.3 architecture unless a separate challenger is explicitly justified.",
    }
    (out / "stage0_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
