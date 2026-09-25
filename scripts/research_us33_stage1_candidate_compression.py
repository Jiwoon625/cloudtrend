from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import duckdb
import pandas as pd

MOMENTUM = [
    ("ret60", "dr_ret60", "HIGHER"),
    ("residual_mom60", "dr_residual_mom60", "HIGHER"),
    ("rs_accel_spy", "dr_rs_accel_spy", "LOWER_RAW"),
]
TREND = [
    ("ichimoku_tk_gap", "dr_ichimoku_tk_gap", "HIGHER"),
    ("ma120_gap", "dr_ma120_gap", "HIGHER"),
]
HORIZONS = [120, 252]
CUTS = [0.70, 0.80, 0.90]
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


def evaluate(con, panel, group, feature, rank_col, direction):
    rows = []
    for h in HORIZONS:
        exprs = [
            f"AVG(CASE WHEN mom_pct>=0.90 THEN fwd_ret_{h} END) AS base",
            f"AVG(fwd_ret_{h}) AS univ",
            f"COUNT(*) FILTER(WHERE mom_pct>=0.90 AND fwd_ret_{h} IS NOT NULL) AS base_n",
        ]
        for cut in CUTS:
            tag = int(cut * 100)
            exprs += [
                f"AVG(CASE WHEN mom_pct>=0.90 AND {rank_col}>={cut} THEN fwd_ret_{h} END) AS c{tag}",
                f"COUNT(*) FILTER(WHERE mom_pct>=0.90 AND {rank_col}>={cut} AND fwd_ret_{h} IS NOT NULL) AS n{tag}",
            ]
        d = con.execute(f"""
            SELECT dt, period_bucket, {",".join(exprs)}
            FROM read_parquet('{panel}')
            GROUP BY dt, period_bucket
            ORDER BY dt
        """).df()

        for cut in CUTS:
            tag = int(cut * 100)
            z = d[d[f"n{tag}"] > 0].copy()
            rec = {
                "group": group,
                "feature": feature,
                "direction": direction,
                "horizon": h,
                "confirmCut": cut,
                "meanSelectedN": sf(z[f"n{tag}"].mean()),
                "deltaVsCore": sf((z[f"c{tag}"] - z["base"]).mean()),
                "excessUniverse": sf((z[f"c{tag}"] - z["univ"]).mean()),
                "positiveDailyDelta": sf(((z[f"c{tag}"] - z["base"]) > 0).mean()),
            }
            pos = 0
            for p in PERIODS:
                zz = z[z.period_bucket == p]
                v = sf((zz[f"c{tag}"] - zz["base"]).mean()) if len(zz) else None
                rec[f"delta_{p}"] = v
                if v is not None and v > 0:
                    pos += 1
            rec["periodPositiveCount"] = pos
            rows.append(rec)
    return rows


def main():
    a = parse_args()
    panel = str(Path(a.panel).resolve()).replace("'", "''")
    out = Path(a.output).resolve()
    out.mkdir(parents=True, exist_ok=True)

    con = duckdb.connect()
    con.execute(f"SET threads={a.threads}")
    con.execute(f"SET memory_limit='{a.memory_limit}'")

    rows = []
    for f, c, d in MOMENTUM:
        rows.extend(evaluate(con, panel, "MOMENTUM_CONFIRMATION", f, c, d))
    for f, c, d in TREND:
        rows.extend(evaluate(con, panel, "TREND_CONFIRMATION", f, c, d))

    df = pd.DataFrame(rows)
    df.to_csv(out / "stage1_candidate_compression.csv", index=False)

    # Primary decision uses 252D, fixed top-20% confirmation to avoid threshold overfit.
    primary = df[(df.horizon == 252) & (df.confirmCut == 0.80)].copy()
    decisions = {}
    for group in primary.group.unique():
        z = primary[primary.group == group].copy()
        z = z.sort_values(
            ["periodPositiveCount", "deltaVsCore", "excessUniverse"],
            ascending=[False, False, False],
        )
        best = z.iloc[0]
        decisions[group] = {
            "selected": best.feature,
            "direction": best.direction,
            "confirmCutPrimary": 0.80,
            "deltaVsCore252": sf(best.deltaVsCore),
            "excessUniverse252": sf(best.excessUniverse),
            "periodPositiveCount": int(best.periodPositiveCount),
            "meanSelectedN": sf(best.meanSelectedN),
        }

    # Sensitivity winner count across 120/252 and 70/80/90 cuts.
    sensitivity = {}
    for group in df.group.unique():
        z = df[df.group == group].copy()
        wins = {f: 0 for f in z.feature.unique()}
        details = []
        for (h, cut), g in z.groupby(["horizon", "confirmCut"]):
            gg = g.sort_values(
                ["periodPositiveCount", "deltaVsCore", "excessUniverse"],
                ascending=[False, False, False],
            )
            winner = gg.iloc[0]
            wins[winner.feature] += 1
            details.append({
                "horizon": int(h),
                "confirmCut": float(cut),
                "winner": winner.feature,
                "deltaVsCore": sf(winner.deltaVsCore),
                "periodPositiveCount": int(winner.periodPositiveCount),
            })
        sensitivity[group] = {"winnerCount": wins, "details": details}

    summary = {
        "study": "CloudTrend US-3.3 Stage 1 Candidate Compression",
        "researchGrade": "SURVIVOR_ONLY_EXPLORATORY",
        "finalOosAllowed": False,
        "coreMomentum": "0.5*rank(ret120)+0.5*rank(ret252)",
        "primaryRule": "252D, Core Momentum Top10%, confirmation top20%; period stability first",
        "decisions": decisions,
        "sensitivity": sensitivity,
    }
    (out / "stage1_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
