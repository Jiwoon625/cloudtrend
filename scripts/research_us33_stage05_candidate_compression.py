from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import duckdb
import pandas as pd

HORIZONS = [120, 252]
MOM_POOLS = [0.80, 0.90]
CONF_CUTS = [0.70, 0.80, 0.90]
PERIODS = ["EARLY_2017_2019", "MID_2020_2022", "RECENT_2023_2026"]

CANDIDATES = {
    "ret60": {"group": "MOMENTUM_CONFIRMATION", "direction": 1},
    "residual_mom60": {"group": "MOMENTUM_CONFIRMATION", "direction": 1},
    "rs_accel_spy": {"group": "MOMENTUM_CONFIRMATION", "direction": -1},
    "ichimoku_tk_gap": {"group": "TREND_CONFIRMATION", "direction": 1},
    "ma120_gap": {"group": "TREND_CONFIRMATION", "direction": 1},
}


def sf(v):
    try:
        v = float(v)
    except Exception:
        return None
    return v if math.isfinite(v) else None


def args():
    p = argparse.ArgumentParser()
    p.add_argument("--panel", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--threads", type=int, default=2)
    p.add_argument("--memory-limit", default="5GB")
    return p.parse_args()


def main():
    a = args()
    panel = str(Path(a.panel).resolve()).replace("'", "''")
    out = Path(a.output).resolve()
    out.mkdir(parents=True, exist_ok=True)

    con = duckdb.connect()
    con.execute(f"SET threads={a.threads}")
    con.execute(f"SET memory_limit='{a.memory_limit}'")

    rows = []
    corr_rows = []
    latest_rows = []

    for feat, meta in CANDIDATES.items():
        order = "ASC" if meta["direction"] == 1 else "DESC"
        sql = f"""
        WITH x AS (
          SELECT *,
            CASE WHEN {feat} IS NULL THEN NULL
                 ELSE PERCENT_RANK() OVER(PARTITION BY dt ORDER BY {feat} {order} NULLS LAST)
            END AS conf_rank
          FROM read_parquet('{panel}')
        ),
        d AS (
          SELECT dt, period_bucket,
            CORR(conf_rank, mom_pct) AS corr_with_core,
            AVG(fwd_ret_120) AS univ120,
            AVG(fwd_ret_252) AS univ252,
            {",".join(
              [
                f"AVG(CASE WHEN mom_pct>={m} THEN fwd_ret_{h} END) AS b_{int(m*100)}_{h},"
                f"COUNT(*) FILTER(WHERE mom_pct>={m} AND fwd_ret_{h} IS NOT NULL) AS bn_{int(m*100)}_{h},"
                + ",".join(
                  [
                    f"AVG(CASE WHEN mom_pct>={m} AND conf_rank>={q} THEN fwd_ret_{h} END) AS s_{int(m*100)}_{int(q*100)}_{h},"
                    f"COUNT(*) FILTER(WHERE mom_pct>={m} AND conf_rank>={q} AND fwd_ret_{h} IS NOT NULL) AS n_{int(m*100)}_{int(q*100)}_{h}"
                    for q in CONF_CUTS
                  ]
                )
                for m in MOM_POOLS for h in HORIZONS
              ]
            )}
          FROM x
          GROUP BY dt, period_bucket
          ORDER BY dt
        )
        SELECT * FROM d
        """
        d = con.execute(sql).df()

        corr_rows.append({
            "feature": feat,
            "group": meta["group"],
            "direction": meta["direction"],
            "meanDailyCorrWithCore": sf(d.corr_with_core.mean()),
            "medianDailyCorrWithCore": sf(d.corr_with_core.median()),
        })

        for m in MOM_POOLS:
            tm = int(m * 100)
            for q in CONF_CUTS:
                tq = int(q * 100)
                for h in HORIZONS:
                    base = f"b_{tm}_{h}"
                    sel = f"s_{tm}_{tq}_{h}"
                    n = f"n_{tm}_{tq}_{h}"
                    z = d[d[n] > 0].copy()

                    rec = {
                        "feature": feat,
                        "group": meta["group"],
                        "direction": meta["direction"],
                        "momentumPool": m,
                        "confirmCut": q,
                        "horizon": h,
                        "days": int(len(z)),
                        "meanSelectedN": sf(z[n].mean()) if len(z) else None,
                        "meanBaseN": sf(z[f"bn_{tm}_{h}"].mean()) if len(z) else None,
                        "meanReturn": sf(z[sel].mean()) if len(z) else None,
                        "meanExcessUniverse": sf((z[sel] - z[f"univ{h}"]).mean()) if len(z) else None,
                        "deltaVsMomentumBase": sf((z[sel] - z[base]).mean()) if len(z) else None,
                        "positiveDailyDelta": sf(((z[sel] - z[base]) > 0).mean()) if len(z) else None,
                    }

                    pos = 0
                    for p in PERIODS:
                        zz = z[z.period_bucket == p]
                        val = sf((zz[sel] - zz[base]).mean()) if len(zz) else None
                        rec[f"delta_{p}"] = val
                        if val is not None and val > 0:
                            pos += 1
                    rec["periodPositiveCount"] = pos
                    rows.append(rec)

        latest = con.execute(f"""
        WITH x AS (
          SELECT *,
            CASE WHEN {feat} IS NULL THEN NULL
                 ELSE PERCENT_RANK() OVER(PARTITION BY dt ORDER BY {feat} {order} NULLS LAST)
            END AS conf_rank
          FROM read_parquet('{panel}')
        ),
        m AS (SELECT MAX(dt) AS dt FROM x)
        SELECT '{feat}' AS feature, '{meta["group"]}' AS group_name,
               x.dt, symbol, {feat} AS raw_value, conf_rank, mom_pct, ret120, ret252
        FROM x, m
        WHERE x.dt=m.dt AND mom_pct>=0.90 AND conf_rank>=0.80
        ORDER BY mom_pct DESC, conf_rank DESC
        LIMIT 40
        """).df()
        latest_rows.append(latest)

    df = pd.DataFrame(rows)
    corr = pd.DataFrame(corr_rows)
    latest = pd.concat(latest_rows, ignore_index=True)

    df.to_csv(out / "stage05_candidate_grid.csv", index=False)
    corr.to_csv(out / "stage05_core_correlation.csv", index=False)
    latest.to_csv(out / "stage05_latest_selected_symbols.csv", index=False)

    # Conservative shortlist: 252D, Momentum Top10 pool, at least 20 names on average.
    shortlist = {}
    for group in sorted(df.group.unique()):
        z = df[
            (df.group == group)
            & (df.horizon == 252)
            & (df.momentumPool == 0.90)
            & (df.meanSelectedN >= 20)
        ].copy()
        # Best cut within feature: period stability first, then return delta.
        best_per_feature = []
        for feat, g in z.groupby("feature"):
            g = g.sort_values(
                ["periodPositiveCount", "deltaVsMomentumBase", "positiveDailyDelta"],
                ascending=[False, False, False],
            )
            best_per_feature.append(g.iloc[0])
        b = pd.DataFrame(best_per_feature)
        b = b.sort_values(
            ["periodPositiveCount", "deltaVsMomentumBase", "positiveDailyDelta"],
            ascending=[False, False, False],
        )
        shortlist[group] = [
            {
                "feature": r.feature,
                "confirmCut": sf(r.confirmCut),
                "meanSelectedN": sf(r.meanSelectedN),
                "deltaVsMomentumBase252": sf(r.deltaVsMomentumBase),
                "meanExcessUniverse252": sf(r.meanExcessUniverse),
                "positiveDailyDelta": sf(r.positiveDailyDelta),
                "periodPositiveCount": int(r.periodPositiveCount),
                "deltaEarly": sf(r.delta_EARLY_2017_2019),
                "deltaMid": sf(r.delta_MID_2020_2022),
                "deltaRecent": sf(r.delta_RECENT_2023_2026),
            }
            for _, r in b.iterrows()
        ]

    summary = {
        "study": "CloudTrend US-3.3 Stage 0.5 Candidate Compression",
        "researchGrade": "SURVIVOR_ONLY_EXPLORATORY",
        "finalOosAllowed": False,
        "coreMomentum": "0.5*rank(ret120)+0.5*rank(ret252)",
        "momentumCandidates": ["ret60", "residual_mom60", "rs_accel_spy"],
        "trendCandidates": ["ichimoku_tk_gap", "ma120_gap"],
        "momentumPools": MOM_POOLS,
        "confirmationCuts": CONF_CUTS,
        "shortlist": shortlist,
        "note": "Shortlist ranking prioritizes period stability before mean incremental return; final interpretation should also consider redundancy with core momentum and recent-period behavior.",
    }
    (out / "stage05_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
