from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

TRADING_DAYS = 252
MAX_POSITIONS = 15
COST_BPS_SET = [0, 20, 50]
POOL_CUTS = {"TOP10": 0.90, "TOP20": 0.80}

STRATEGIES = {
    "M": "TRUE",
    "M+B": "dr_beta60_spy >= 0.90",
    "M+T": "dr_ichimoku_tk_gap >= 0.80",
    "M+V": "dr_relvol1_20 >= 0.80",
    "M+T+V": "dr_ichimoku_tk_gap >= 0.80 AND dr_relvol1_20 >= 0.80",
    "M+B+T": "dr_beta60_spy >= 0.90 AND dr_ichimoku_tk_gap >= 0.80",
    "M+B+V": "dr_beta60_spy >= 0.90 AND dr_relvol1_20 >= 0.80",
}


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--panel", required=True)
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--threads", type=int, default=2)
    p.add_argument("--memory-limit", default="5GB")
    return p.parse_args()


def safe(v):
    try:
        x = float(v)
    except Exception:
        return None
    return x if math.isfinite(x) else None


def compound(x):
    arr = np.asarray(x, dtype=float)
    return float(np.prod(1.0 + arr)) if len(arr) else 1.0


def max_dd(x):
    eq = np.cumprod(1.0 + np.asarray(x, dtype=float))
    if not len(eq):
        return None
    peaks = np.maximum.accumulate(eq)
    return float(np.min(eq / peaks - 1.0))


def calc_spells(targets: pd.DataFrame) -> tuple[float | None, float | None]:
    if targets.empty:
        return None, None
    x = targets[["entry_date", "symbol"]].drop_duplicates().copy()
    x["entry_date"] = pd.to_datetime(x["entry_date"])
    dates = sorted(x.entry_date.unique())
    date_idx = {d: i for i, d in enumerate(dates)}
    spells = []
    for _, g in x.sort_values(["symbol", "entry_date"]).groupby("symbol"):
        idxs = [date_idx[d] for d in g.entry_date]
        cur = 1
        for a, b in zip(idxs, idxs[1:]):
            if b == a + 1:
                cur += 1
            else:
                spells.append(cur)
                cur = 1
        spells.append(cur)
    return float(np.mean(spells)), float(np.median(spells))


def simulate(targets: pd.DataFrame, bench_daily: pd.DataFrame, cost_bps: int):
    t = targets.copy()
    t["entry_date"] = pd.to_datetime(t["entry_date"])
    t["next_date"] = pd.to_datetime(t["next_date"])
    t = t[t["open_ret"].notna()].copy()
    counts = t.groupby(["strategy", "pool", "entry_date"]).symbol.transform("count")
    t["weight"] = 1.0 / counts

    rows = []
    turnover_rows = []
    all_keys = sorted(set(zip(t.strategy, t.pool)))
    bench = bench_daily.copy()
    bench["entry_date"] = pd.to_datetime(bench["entry_date"])
    bench_map = dict(zip(bench.entry_date, bench.spy_ret))

    for strategy, pool in all_keys:
        z = t[(t.strategy == strategy) & (t.pool == pool)].copy()
        by_date = {d: g for d, g in z.groupby("entry_date")}
        dates = sorted(by_date)
        prev_w: dict[str, float] = {}
        daily = []
        for d in dates:
            g = by_date[d]
            cur_w = dict(zip(g.symbol.astype(str), g.weight.astype(float)))
            # Half of round-trip cost per one-way traded notional.
            l1_stock = sum(abs(cur_w.get(s, 0.0) - prev_w.get(s, 0.0)) for s in set(cur_w) | set(prev_w))
            cost = l1_stock * (cost_bps / 2.0 / 10000.0)
            gross = float((g.weight * g.open_ret).sum())
            net = gross - cost
            one_way_turnover = l1_stock / 2.0 if prev_w else sum(cur_w.values())
            daily.append({
                "strategy": strategy, "pool": pool, "entry_date": d,
                "gross_return": gross, "net_return": net,
                "turnover": one_way_turnover,
                "positions": len(g), "cost": cost,
                "spy_return": safe(bench_map.get(d)) or 0.0,
            })
            prev_w = cur_w
        if not daily:
            continue
        ddf = pd.DataFrame(daily)
        ddf["year"] = ddf.entry_date.dt.year
        ddf["period"] = pd.cut(
            ddf["year"], bins=[2016, 2019, 2022, 2026],
            labels=["EARLY_2017_2019", "MID_2020_2022", "RECENT_2023_2026"],
        )
        rows.append(ddf)

    daily_all = pd.concat(rows, ignore_index=True) if rows else pd.DataFrame()
    metrics = []
    yearly = []
    periods = []
    if daily_all.empty:
        return metrics, yearly, periods, daily_all

    for (strategy, pool), d in daily_all.groupby(["strategy", "pool"]):
        d = d.sort_values("entry_date")
        r = d.net_return.to_numpy(float)
        spy = d.spy_return.to_numpy(float)
        years = len(d) / TRADING_DAYS
        eq = compound(r)
        spy_eq = compound(spy)
        std = np.std(r, ddof=1) if len(r) > 1 else np.nan
        ann_mean = np.mean(r) * TRADING_DAYS if len(r) else np.nan
        mdd = max_dd(r)
        mean_spell, median_spell = calc_spells(
            t[(t.strategy == strategy) & (t.pool == pool)]
        )
        metrics.append({
            "strategy": strategy,
            "pool": pool,
            "costBps": cost_bps,
            "days": len(d),
            "cagr": eq ** (1 / years) - 1 if years > 0 and eq > 0 else np.nan,
            "spyCagrProxy": spy_eq ** (1 / years) - 1 if years > 0 and spy_eq > 0 else np.nan,
            "excessCagrProxy": (eq ** (1 / years) - 1) - (spy_eq ** (1 / years) - 1) if years > 0 and eq > 0 and spy_eq > 0 else np.nan,
            "sharpeRf0": ann_mean / (std * math.sqrt(TRADING_DAYS)) if std and std > 0 else np.nan,
            "mdd": mdd,
            "cagrOverAbsMdd": (eq ** (1 / years) - 1) / abs(mdd) if years > 0 and eq > 0 and mdd and mdd < 0 else np.nan,
            "meanDailyTurnover": d.turnover.mean(),
            "annualizedTurnover": d.turnover.mean() * TRADING_DAYS,
            "meanPositions": d.positions.mean(),
            "full15DayRatio": (d.positions >= MAX_POSITIONS).mean(),
            "meanHoldingSpellSessions": mean_spell,
            "medianHoldingSpellSessions": median_spell,
            "meanDailyCost": d.cost.mean(),
        })
        for y, gy in d.groupby("year"):
            yearly.append({
                "strategy": strategy, "pool": pool, "costBps": cost_bps, "year": int(y),
                "return": compound(gy.net_return) - 1,
                "spyReturnProxy": compound(gy.spy_return) - 1,
                "mdd": max_dd(gy.net_return.to_numpy(float)),
                "sharpeRf0": (
                    gy.net_return.mean() * TRADING_DAYS /
                    (gy.net_return.std(ddof=1) * math.sqrt(TRADING_DAYS))
                    if len(gy) > 1 and gy.net_return.std(ddof=1) > 0 else np.nan
                ),
                "meanTurnover": gy.turnover.mean(),
                "meanPositions": gy.positions.mean(),
            })
        for p, gp in d.dropna(subset=["period"]).groupby("period", observed=True):
            periods.append({
                "strategy": strategy, "pool": pool, "costBps": cost_bps, "period": str(p),
                "return": compound(gp.net_return) - 1,
                "spyReturnProxy": compound(gp.spy_return) - 1,
                "mdd": max_dd(gp.net_return.to_numpy(float)),
                "meanTurnover": gp.turnover.mean(),
                "meanPositions": gp.positions.mean(),
            })
    return metrics, yearly, periods, daily_all


def main():
    a = parse_args()
    panel = str(Path(a.panel).resolve()).replace("'", "''")
    root = Path(a.input).resolve()
    out = Path(a.output).resolve()
    out.mkdir(parents=True, exist_ok=True)

    price_glob = str(root / "canonical" / "year=*" / "us_stock_daily.parquet").replace("'", "''")
    bench = str(root / "benchmark" / "us_benchmarks_adjusted.parquet").replace("'", "''")

    con = duckdb.connect()
    con.execute(f"SET threads={a.threads}")
    con.execute(f"SET memory_limit='{a.memory_limit}'")

    # Market calendar dates are taken from SPY benchmark. Benchmark parquet has close-only
    # fields, so SPY comparison below is a close-to-close proxy, while stocks use open-to-open.
    con.execute(f"""
    CREATE OR REPLACE TEMP VIEW cal AS
    SELECT CAST(dt AS DATE) AS dt,
           LEAD(CAST(dt AS DATE),1) OVER(ORDER BY CAST(dt AS DATE)) AS next_dt,
           CAST(spy_close AS DOUBLE) AS spy_close,
           LEAD(CAST(spy_close AS DOUBLE),1) OVER(ORDER BY CAST(dt AS DATE)) AS spy_next_close
    FROM read_parquet('{bench}')
    """)

    con.execute(f"""
    CREATE OR REPLACE TEMP VIEW px AS
    SELECT CAST(symbol AS VARCHAR) AS symbol,
           CAST(tradeDateUsEastern AS DATE) AS dt,
           CAST(open AS DOUBLE) AS open
    FROM read_parquet('{price_glob}', union_by_name=true)
    """)

    target_parts = []
    count_parts = []
    for pool, cut in POOL_CUTS.items():
        for strategy, cond in STRATEGIES.items():
            label = strategy.replace("'", "''")
            eligible = f"mom_pct >= {cut} AND ({cond})"
            target_parts.append(f"""
              SELECT '{label}' AS strategy, '{pool}' AS pool, dt AS signal_date,
                     symbol, mom_score,
                     ROW_NUMBER() OVER(PARTITION BY dt ORDER BY mom_score DESC, symbol ASC) AS pick_rank
              FROM read_parquet('{panel}')
              WHERE {eligible}
            """)
            count_parts.append(f"""
              SELECT '{label}' AS strategy, '{pool}' AS pool, dt AS signal_date,
                     COUNT(*) AS eligible_count
              FROM read_parquet('{panel}')
              WHERE {eligible}
              GROUP BY dt
            """)

    union_targets = " UNION ALL ".join(target_parts)
    union_counts = " UNION ALL ".join(count_parts)

    targets = con.execute(f"""
    WITH ranked AS ({union_targets}),
    chosen AS (
      SELECT * FROM ranked WHERE pick_rank <= {MAX_POSITIONS}
    ),
    mapped AS (
      SELECT c.strategy, c.pool, c.signal_date, cal.next_dt AS entry_date,
             cal2.next_dt AS next_date, c.symbol, c.mom_score, c.pick_rank
      FROM chosen c
      JOIN cal ON cal.dt=c.signal_date
      JOIN cal cal2 ON cal2.dt=cal.next_dt
      WHERE cal.next_dt IS NOT NULL AND cal2.next_dt IS NOT NULL
    )
    SELECT m.*, p1.open AS entry_open, p2.open AS next_open,
           p2.open / NULLIF(p1.open,0) - 1 AS open_ret
    FROM mapped m
    LEFT JOIN px p1 ON p1.symbol=m.symbol AND p1.dt=m.entry_date
    LEFT JOIN px p2 ON p2.symbol=m.symbol AND p2.dt=m.next_date
    WHERE p1.open > 0 AND p2.open > 0
    ORDER BY strategy,pool,entry_date,pick_rank
    """).df()

    counts = con.execute(f"SELECT * FROM ({union_counts}) ORDER BY strategy,pool,signal_date").df()
    bench_daily = con.execute("""
      SELECT next_dt AS entry_date,
             spy_next_close / NULLIF(spy_close,0) - 1 AS spy_ret
      FROM cal
      WHERE next_dt IS NOT NULL AND spy_close>0 AND spy_next_close>0
      ORDER BY entry_date
    """).df()

    targets.to_csv(out / "stage2a_executed_targets.csv", index=False)
    counts.to_csv(out / "stage2a_eligible_counts.csv", index=False)

    all_metrics, all_yearly, all_periods = [], [], []
    daily_primary = None
    for cost in COST_BPS_SET:
        metrics, yearly, periods, daily = simulate(targets, bench_daily, cost)
        all_metrics.extend(metrics)
        all_yearly.extend(yearly)
        all_periods.extend(periods)
        if cost == 20:
            daily_primary = daily

    mdf = pd.DataFrame(all_metrics)
    ydf = pd.DataFrame(all_yearly)
    pdf = pd.DataFrame(all_periods)
    mdf.to_csv(out / "stage2a_metrics.csv", index=False)
    ydf.to_csv(out / "stage2a_yearly.csv", index=False)
    pdf.to_csv(out / "stage2a_periods.csv", index=False)
    if daily_primary is not None:
        daily_primary.to_csv(out / "stage2a_daily_20bps.csv", index=False)

    primary = mdf[mdf.costBps == 20].copy()
    primary["stabilityScore"] = 0
    if not pdf.empty:
        pp = pdf[pdf.costBps == 20].copy()
        pp["excessProxy"] = pp["return"] - pp["spyReturnProxy"]
        pos = pp.groupby(["strategy","pool"]).excessProxy.apply(lambda s: int((s>0).sum())).rename("positivePeriodCount")
        primary = primary.merge(pos, on=["strategy","pool"], how="left")
    else:
        primary["positivePeriodCount"] = 0

    primary = primary.sort_values(
        ["positivePeriodCount","sharpeRf0","cagr","mdd"],
        ascending=[False,False,False,False]
    )
    primary.to_csv(out / "stage2a_primary_ranking.csv", index=False)

    summary = {
      "study": "CloudTrend US-3.3 Stage 2A Signal Architecture Portfolio",
      "researchGrade": "SURVIVOR_ONLY_EXPLORATORY",
      "finalOosAllowed": False,
      "execution": {
        "signal": "t close",
        "entry": "t+1 regular-session open",
        "holdingReturn": "t+1 open to t+2 open, daily target portfolio",
        "rebalance": "daily to equal-weight target; no turnover cap",
        "maxPositions": MAX_POSITIONS,
        "primaryRoundTripCostBps": 20,
        "costSensitivityBps": COST_BPS_SET,
        "benchmark": "SPY close-to-close proxy because benchmark cache has close-only fields",
      },
      "candidatePools": POOL_CUTS,
      "strategies": STRATEGIES,
      "sectorCap": {
        "applied": False,
        "reason": "Current US master has no sector field. Do not fabricate mapping.",
        "requiredFollowup": "Stage 2B rerun with verified US sector mapping and cap=3.",
      },
      "liquidityEligibility": {
        "appliedHardCutoff": False,
        "reason": "Role is fixed as Eligibility, but cutoff is intentionally left for later sensitivity instead of choosing an arbitrary alpha-optimizing threshold.",
      },
      "primaryRanking": [
        {
          "strategy": r.strategy, "pool": r.pool,
          "positivePeriodCount": int(r.positivePeriodCount) if pd.notna(r.positivePeriodCount) else 0,
          "cagr": safe(r.cagr), "sharpeRf0": safe(r.sharpeRf0), "mdd": safe(r.mdd),
          "annualizedTurnover": safe(r.annualizedTurnover),
          "meanPositions": safe(r.meanPositions), "full15DayRatio": safe(r.full15DayRatio),
          "meanHoldingSpellSessions": safe(r.meanHoldingSpellSessions),
        }
        for _, r in primary.head(14).iterrows()
      ],
    }
    (out / "stage2a_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
