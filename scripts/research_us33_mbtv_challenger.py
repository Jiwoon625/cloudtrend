from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
from urllib.parse import quote

import duckdb
import numpy as np
import pandas as pd
import requests

BUCKET = "cloudtrend-data"
USER = "bdfc8818-33a7-4030-9dbd-ecad39f223ac"
SECTOR_OBJECT = f"{USER}/research/us/v0/sector/v1.1/us_stock_sector_map_14_v1.csv"

CONFIGS = [
    {"style": "AGGRESSIVE", "n": 15, "cap": 2, "id": "AGGRESSIVE_N15_SC2"},
    {"style": "AGGRESSIVE", "n": 15, "cap": None, "id": "AGGRESSIVE_N15_SCNONE"},
    {"style": "AGGRESSIVE", "n": 20, "cap": 2, "id": "AGGRESSIVE_N20_SC2"},
    {"style": "AGGRESSIVE", "n": 20, "cap": None, "id": "AGGRESSIVE_N20_SCNONE"},
    {"style": "BALANCED", "n": 15, "cap": 3, "id": "BALANCED_N15_SC3"},
    {"style": "BALANCED", "n": 15, "cap": None, "id": "BALANCED_N15_SCNONE"},
    {"style": "BALANCED", "n": 20, "cap": 3, "id": "BALANCED_N20_SC3"},
    {"style": "BALANCED", "n": 20, "cap": None, "id": "BALANCED_N20_SCNONE"},
]

EXPECTED_BASELINE = {
    "AGGRESSIVE_N15_SC2": 0.3025224098835073,
    "AGGRESSIVE_N20_SC2": 0.29278454747789007,
    "BALANCED_N15_SC3": 0.24664171561516213,
    "BALANCED_N20_SC3": 0.29347439672924724,
}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True)
    p.add_argument("--panel", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--threads", type=int, default=2)
    p.add_argument("--memory-limit", default="5GB")
    return p.parse_args()


def supabase_env() -> tuple[str, str]:
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")
    return url, key


def download_sector_map(destination: Path) -> None:
    if destination.exists() and destination.stat().st_size > 0:
        return
    url, key = supabase_env()
    endpoint = (
        f"{url}/storage/v1/object/authenticated/{quote(BUCKET, safe='')}/"
        f"{quote(SECTOR_OBJECT, safe='/=._-')}"
    )
    headers = {"Authorization": f"Bearer {key}", "apikey": key}
    destination.parent.mkdir(parents=True, exist_ok=True)
    with requests.get(endpoint, headers=headers, stream=True, timeout=(20, 300)) as response:
        response.raise_for_status()
        with destination.open("wb") as f:
            for chunk in response.iter_content(1024 * 1024):
                if chunk:
                    f.write(chunk)


def perf_stats(returns: pd.Series) -> dict[str, float]:
    r = pd.to_numeric(returns, errors="coerce").dropna().to_numpy(float)
    if len(r) == 0:
        return {"CAGR": np.nan, "Sharpe": np.nan, "MDD": np.nan, "TotalReturn": np.nan}
    eq = np.cumprod(1.0 + r)
    years = len(r) / 252.0
    cagr = eq[-1] ** (1.0 / years) - 1.0 if years > 0 and eq[-1] > 0 else np.nan
    vol = np.std(r, ddof=1)
    sharpe = np.mean(r) / vol * math.sqrt(252.0) if vol > 0 else 0.0
    peak = np.maximum.accumulate(np.r_[1.0, eq])[1:]
    mdd = np.min(eq / peak - 1.0)
    return {"CAGR": cagr, "Sharpe": sharpe, "MDD": mdd, "TotalReturn": eq[-1] - 1.0}


class State:
    def __init__(self, cfg: dict, gate: str, cost: float = 0.0015):
        self.cfg = cfg
        self.gate = gate
        self.cost = cost
        self.id = f"{cfg['id']}__{gate.upper()}"
        self.nav = 1.0
        self.positions: dict[str, dict] = {}
        self.daily: list[dict] = []
        self.trades: list[dict] = []
        self.pnl: dict[str, float] = {}

    def add_pnl(self, symbol: str, value: float) -> None:
        self.pnl[symbol] = self.pnl.get(symbol, 0.0) + float(value)


def architecture_pool(day: pd.DataFrame, style: str, gate: str) -> list[str]:
    p = day[
        (day["mom_pct"] >= 0.80)
        & (day["dr_beta60_spy"] >= 0.90)
        & (day["dr_log_dollarvol20"] >= 0.10)
        & (day["dr_amihud20"] >= 0.10)
        & (day["onset"])
    ].copy()

    if style == "AGGRESSIVE":
        p = p[p["dr_ichimoku_tk_gap"] >= 0.80]
        if gate == "both":
            p = p[p["dr_relvol1_20"] >= 0.80]
        sort_cols = ["mom_pct", "dr_beta60_spy", "dr_ichimoku_tk_gap", "symbol"]
    else:
        p = p[p["dr_relvol1_20"] >= 0.80]
        if gate == "both":
            p = p[p["dr_ichimoku_tk_gap"] >= 0.80]
        sort_cols = ["mom_pct", "dr_beta60_spy", "dr_relvol1_20", "symbol"]

    return p.sort_values(sort_cols, ascending=[False, False, False, True])["symbol"].tolist()


def step_state(
    st: State,
    day: pd.DataFrame,
    pool: list[str],
    exec_date: pd.Timestamp,
    seq: int,
) -> None:
    cfg = st.cfg
    exit_cut = 0.70 if cfg["style"] == "AGGRESSIVE" else 0.50

    valid_rank = day.dropna(subset=["mom_pct"]).set_index("symbol")
    price_map = day.set_index("symbol")[["open1", "open2"]].to_dict("index")

    oldw = {s: p["w"] for s, p in st.positions.items()}
    removed: list[str] = []
    added: list[str] = []

    for symbol in list(st.positions):
        rank = np.nan
        if symbol in valid_rank.index:
            rank = float(valid_rank.at[symbol, "mom_pct"])
        if not np.isfinite(rank) or rank < exit_cut:
            p = st.positions.pop(symbol)
            removed.append(symbol)
            st.trades.append(
                {
                    "strategy": st.id,
                    "symbol": symbol,
                    "entryDate": p["entryDate"],
                    "exitDate": exec_date,
                    "exitReason": "RANK_OR_MISSING",
                    "grossTradeReturn": p["cum"] - 1.0,
                    "holdingSessions": seq - p["entrySeq"],
                }
            )

    counts: dict[str, int] = {}
    for p in st.positions.values():
        counts[p["sector"]] = counts.get(p["sector"], 0) + 1

    day_sector = day.set_index("symbol")["sectorCode"].to_dict()
    for symbol in pool:
        if len(st.positions) >= cfg["n"]:
            break
        if symbol in st.positions:
            continue
        sector = day_sector.get(symbol, "UNKNOWN")
        if cfg["cap"] and counts.get(sector, 0) >= cfg["cap"]:
            continue
        st.positions[symbol] = {
            "sector": sector,
            "w": 0.0,
            "entryDate": exec_date,
            "entrySeq": seq,
            "cum": 1.0,
        }
        counts[sector] = counts.get(sector, 0) + 1
        added.append(symbol)

    if added or removed:
        target = {s: 1.0 / len(st.positions) for s in st.positions} if st.positions else {}
    else:
        target = {s: p["w"] for s, p in st.positions.items()}

    if target:
        total = sum(target.values())
        target = {s: w / total for s, w in target.items()}

    all_symbols = set(target) | set(oldw)
    dw = {s: abs(target.get(s, 0.0) - oldw.get(s, 0.0)) for s in all_symbols}
    turnover = sum(dw.values())
    cost = turnover * st.cost
    before = st.nav
    gross = 0.0
    rr: dict[str, float] = {}
    missing_weight = 0.0

    for symbol, w in target.items():
        px = price_map.get(symbol)
        r = 0.0
        if px is None or not np.isfinite(px["open1"]) or not np.isfinite(px["open2"]) or px["open1"] <= 0:
            missing_weight += w
        else:
            r = float(px["open2"] / px["open1"] - 1.0)
        rr[symbol] = r
        gross += w * r
        st.positions[symbol]["cum"] *= 1.0 + r
        st.add_pnl(symbol, before * (1.0 - cost) * w * r)

    for symbol, delta in dw.items():
        st.add_pnl(symbol, -before * st.cost * delta)

    st.nav = before * (1.0 - cost) * (1.0 + gross)

    if st.positions and (1.0 + gross) != 0:
        for symbol in st.positions:
            st.positions[symbol]["w"] = target[symbol] * (1.0 + rr[symbol]) / (1.0 + gross)

    st.daily.append(
        {
            "strategy": st.id,
            "date": exec_date,
            "netReturn": st.nav / before - 1.0,
            "equity": st.nav,
            "positions": len(st.positions),
            "turnover": turnover,
            "entries": len(added),
            "exits": len(removed),
            "missingWeight": missing_weight,
        }
    )


def finish_state(st: State, final_date: pd.Timestamp, seq: int) -> tuple[pd.DataFrame, pd.DataFrame]:
    before = st.nav
    fee = 0.0
    turn = 0.0
    for symbol, p in list(st.positions.items()):
        value = st.nav * p["w"]
        fee += st.cost * value
        turn += value / st.nav if st.nav else 0.0
        st.add_pnl(symbol, -st.cost * value)
        st.trades.append(
            {
                "strategy": st.id,
                "symbol": symbol,
                "entryDate": p["entryDate"],
                "exitDate": final_date,
                "exitReason": "END_OF_SAMPLE",
                "grossTradeReturn": p["cum"] - 1.0,
                "holdingSessions": seq - p["entrySeq"],
            }
        )
    st.nav -= fee
    if st.daily:
        st.daily[-1]["netReturn"] = (1.0 + st.daily[-1]["netReturn"]) * (st.nav / before) - 1.0
        st.daily[-1]["equity"] = st.nav
        st.daily[-1]["turnover"] += turn
    return pd.DataFrame(st.daily), pd.DataFrame(st.trades)


def period_rows(strategy_id: str, daily: pd.DataFrame) -> list[dict]:
    masks = {
        "FULL": np.ones(len(daily), dtype=bool),
        "2017_2019": daily["date"].dt.year <= 2019,
        "2020_2022": (daily["date"].dt.year >= 2020) & (daily["date"].dt.year <= 2022),
        "2023_2026": daily["date"].dt.year >= 2023,
        "TRAIN_2017_2022": daily["date"] < pd.Timestamp("2023-01-01"),
    }
    out = []
    for name, mask in masks.items():
        g = daily.loc[mask]
        s = perf_stats(g["netReturn"])
        out.append(
            {
                "strategy": strategy_id,
                "period": name,
                **s,
                "annualTurnover": g["turnover"].sum() * 252.0 / len(g) if len(g) else np.nan,
                "avgPositions": g["positions"].mean() if len(g) else np.nan,
                "entries": int(g["entries"].sum()) if len(g) else 0,
            }
        )
    return out


def trade_stats(strategy_id: str, trades: pd.DataFrame) -> dict:
    if trades.empty:
        return {"strategy": strategy_id, "tradeCount": 0}
    r = trades["grossTradeReturn"].astype(float)
    pos = r[r > 0]
    pos_sum = pos.sum()
    top10_mass = pos.nlargest(10).sum() / pos_sum if pos_sum > 0 else np.nan
    return {
        "strategy": strategy_id,
        "tradeCount": len(trades),
        "winRate": float((r > 0).mean()),
        "meanTradeReturn": float(r.mean()),
        "medianTradeReturn": float(r.median()),
        "winners100pct": int((r >= 1.0).sum()),
        "top10PositiveReturnMass": float(top10_mass) if np.isfinite(top10_mass) else np.nan,
        "avgHoldingSessions": float(trades["holdingSessions"].mean()),
        "medianHoldingSessions": float(trades["holdingSessions"].median()),
    }


def main() -> None:
    a = parse_args()
    input_root = Path(a.input).resolve()
    panel = Path(a.panel).resolve()
    out = Path(a.output).resolve()
    out.mkdir(parents=True, exist_ok=True)
    tmp = Path(os.environ.get("RUNNER_TEMP", out / ".tmp")) / "us33-mbtv"
    tmp.mkdir(parents=True, exist_ok=True)

    sector = tmp / "sector_map.csv"
    download_sector_map(sector)

    price_glob = str(input_root / "canonical" / "year=*" / "us_stock_daily.parquet").replace("'", "''")
    bench = str(input_root / "benchmark" / "us_benchmarks_adjusted.parquet").replace("'", "''")
    panel_sql = str(panel).replace("'", "''")
    sector_sql = str(sector).replace("'", "''")

    con = duckdb.connect(str(tmp / "work.duckdb"))
    con.execute(f"SET memory_limit='{a.memory_limit}'")
    con.execute(f"SET threads={a.threads}")
    con.execute(f"SET temp_directory='{str(tmp)}'")

    con.execute(
        f"""
        CREATE OR REPLACE TABLE px AS
        SELECT
          CAST(symbol AS VARCHAR) symbol,
          CAST(tradeDateUsEastern AS DATE) dt,
          CAST(open AS DOUBLE) open
        FROM read_parquet('{price_glob}', union_by_name=true)
        """
    )
    con.execute(
        f"""
        CREATE OR REPLACE TABLE cal AS
        WITH b AS (
          SELECT CAST(dt AS DATE) dt
          FROM read_parquet('{bench}')
          WHERE dt >= DATE '2017-01-01'
          ORDER BY dt
        )
        SELECT dt,
               LEAD(dt,1) OVER(ORDER BY dt) exec1,
               LEAD(dt,2) OVER(ORDER BY dt) exec2
        FROM b
        """
    )
    con.execute(
        f"""
        CREATE OR REPLACE TABLE sig AS
        SELECT
          p.symbol,
          CAST(p.dt AS DATE) dt,
          COALESCE(s.sectorCode,'UNKNOWN') sectorCode,
          p.mom_pct,
          p.dr_beta60_spy,
          p.dr_ichimoku_tk_gap,
          p.dr_relvol1_20,
          p.dr_log_dollarvol20,
          p.dr_amihud20,
          c.exec1,
          c.exec2,
          p1.open open1,
          p2.open open2
        FROM read_parquet('{panel_sql}') p
        JOIN cal c ON CAST(p.dt AS DATE)=c.dt
        LEFT JOIN read_csv_auto('{sector_sql}', header=true) s USING(symbol)
        LEFT JOIN px p1 ON p1.symbol=p.symbol AND p1.dt=c.exec1
        LEFT JOIN px p2 ON p2.symbol=p.symbol AND p2.dt=c.exec2
        WHERE c.exec1 IS NOT NULL AND c.exec2 IS NOT NULL
        """
    )

    states = [State(cfg, gate) for cfg in CONFIGS for gate in ("anchor", "both")]
    prev: dict[str, float] = {}
    candidate_gate_rows: list[dict] = []
    seq = 0
    final_exec_date = None

    for year in range(2017, 2027):
        f = con.execute(
            """
            SELECT * FROM sig
            WHERE YEAR(dt)=?
            ORDER BY dt,symbol
            """,
            [year],
        ).df()
        if f.empty:
            continue
        f["dt"] = pd.to_datetime(f["dt"])
        f["exec1"] = pd.to_datetime(f["exec1"])
        for dt, g0 in f.groupby("dt", sort=True):
            g = g0.copy()
            g["onset"] = [
                (symbol not in prev) or (not np.isfinite(prev[symbol])) or (prev[symbol] < 0.80)
                for symbol in g["symbol"]
            ]
            pools = {
                ("AGGRESSIVE", "anchor"): architecture_pool(g, "AGGRESSIVE", "anchor"),
                ("AGGRESSIVE", "both"): architecture_pool(g, "AGGRESSIVE", "both"),
                ("BALANCED", "anchor"): architecture_pool(g, "BALANCED", "anchor"),
                ("BALANCED", "both"): architecture_pool(g, "BALANCED", "both"),
            }
            candidate_gate_rows.append(
                {
                    "date": dt,
                    "aggressiveAnchorCandidates": len(pools[("AGGRESSIVE", "anchor")]),
                    "aggressiveBothCandidates": len(pools[("AGGRESSIVE", "both")]),
                    "balancedAnchorCandidates": len(pools[("BALANCED", "anchor")]),
                    "balancedBothCandidates": len(pools[("BALANCED", "both")]),
                }
            )
            exec_date = g["exec1"].iloc[0]
            final_exec_date = exec_date
            for st in states:
                step_state(st, g, pools[(st.cfg["style"], st.gate)], exec_date, seq)
            for row in g.dropna(subset=["mom_pct"])[["symbol", "mom_pct"]].itertuples(index=False):
                prev[row.symbol] = float(row.mom_pct)
            seq += 1
        print({"year": year, "nav": {st.id: round(st.nav, 4) for st in states}})

    if final_exec_date is None:
        raise RuntimeError("no executable dates")

    period_all = []
    trade_stat_all = []
    daily_map = {}
    trade_map = {}
    for st in states:
        daily, trades = finish_state(st, final_exec_date, seq)
        daily["date"] = pd.to_datetime(daily["date"])
        daily.to_csv(out / f"daily_{st.id}.csv", index=False)
        trades.to_csv(out / f"trades_{st.id}.csv", index=False)
        daily_map[st.id] = daily
        trade_map[st.id] = trades
        period_all += period_rows(st.id, daily)
        trade_stat_all.append(trade_stats(st.id, trades))

    periods = pd.DataFrame(period_all)
    trade_stats_df = pd.DataFrame(trade_stat_all)
    periods.to_csv(out / "period_metrics.csv", index=False)
    trade_stats_df.to_csv(out / "trade_metrics.csv", index=False)
    pd.DataFrame(candidate_gate_rows).to_csv(out / "candidate_gate_daily.csv", index=False)

    pair_rows = []
    blocked_rows = []
    for cfg in CONFIGS:
        anchor_id = f"{cfg['id']}__ANCHOR"
        both_id = f"{cfg['id']}__BOTH"
        a = periods[(periods.strategy == anchor_id) & (periods.period == "FULL")].iloc[0]
        b = periods[(periods.strategy == both_id) & (periods.period == "FULL")].iloc[0]
        ta = trade_map[anchor_id].copy()
        tb = trade_map[both_id].copy()
        key_b = set(zip(tb["symbol"], tb["entryDate"].astype(str))) if not tb.empty else set()
        ta["blockedAtOriginalEntry"] = [
            (s, str(d)) not in key_b for s, d in zip(ta["symbol"], ta["entryDate"])
        ]
        blocked = ta[ta["blockedAtOriginalEntry"]]
        blocked_winners = blocked[blocked["grossTradeReturn"] >= 1.0]
        pair_rows.append(
            {
                "config": cfg["id"],
                "style": cfg["style"],
                "n": cfg["n"],
                "cap": cfg["cap"],
                "anchorArchitecture": "M+B+T" if cfg["style"] == "AGGRESSIVE" else "M+B+V",
                "challengerArchitecture": "M+B+T+V",
                "anchorCAGR": a.CAGR,
                "challengerCAGR": b.CAGR,
                "deltaCAGRpp": (b.CAGR - a.CAGR) * 100.0,
                "anchorSharpe": a.Sharpe,
                "challengerSharpe": b.Sharpe,
                "deltaSharpe": b.Sharpe - a.Sharpe,
                "anchorMDD": a.MDD,
                "challengerMDD": b.MDD,
                "deltaMDDpp": (b.MDD - a.MDD) * 100.0,
                "anchorAnnualTurnover": a.annualTurnover,
                "challengerAnnualTurnover": b.annualTurnover,
                "anchorAvgPositions": a.avgPositions,
                "challengerAvgPositions": b.avgPositions,
                "anchorEntries": int(a.entries),
                "challengerEntries": int(b.entries),
                "blockedAnchorTrades": len(blocked),
                "blockedAnchor100pctWinners": len(blocked_winners),
            }
        )
        for row in blocked_winners.itertuples(index=False):
            blocked_rows.append(
                {
                    "config": cfg["id"],
                    "symbol": row.symbol,
                    "entryDate": row.entryDate,
                    "exitDate": row.exitDate,
                    "anchorGrossTradeReturn": row.grossTradeReturn,
                    "holdingSessions": row.holdingSessions,
                }
            )

    pair_df = pd.DataFrame(pair_rows)
    pair_df.to_csv(out / "paired_comparison.csv", index=False)
    pd.DataFrame(blocked_rows).to_csv(out / "blocked_100pct_winners.csv", index=False)

    parity_rows = []
    parity_ok = True
    for config_id, expected in EXPECTED_BASELINE.items():
        actual = pair_df.loc[pair_df.config == config_id, "anchorCAGR"].iloc[0]
        diff = float(actual - expected)
        ok = abs(diff) <= 0.01
        parity_ok = parity_ok and ok
        parity_rows.append(
            {
                "config": config_id,
                "expectedAnchorCAGR": expected,
                "actualAnchorCAGR": actual,
                "diff": diff,
                "within1pp": ok,
            }
        )
    pd.DataFrame(parity_rows).to_csv(out / "parity_check.csv", index=False)

    gate = pd.DataFrame(candidate_gate_rows)
    gate_summary = {
        "aggressiveAnchorCandidateDays": int(gate["aggressiveAnchorCandidates"].sum()),
        "aggressiveBothCandidateDays": int(gate["aggressiveBothCandidates"].sum()),
        "balancedAnchorCandidateDays": int(gate["balancedAnchorCandidates"].sum()),
        "balancedBothCandidateDays": int(gate["balancedBothCandidates"].sum()),
    }
    decision = {
        "researchQuestion": "Does adding the missing confirmation gate improve the frozen US3.3 architectures?",
        "comparison": {
            "aggressive": "M+B+T versus M+B+T+V",
            "balanced": "M+B+V versus M+B+T+V",
        },
        "frozen": {
            "entry": 0.80,
            "aggressiveExit": 0.70,
            "balancedExit": 0.50,
            "beta": 0.90,
            "confirmation": 0.80,
            "liquidityRanksMin": 0.10,
            "oneWayCost": 0.0015,
            "signal": "t close features",
            "execution": "t+1 open",
        },
        "parityPassed": bool(parity_ok),
        "gateSummary": gate_summary,
        "paired": pair_df.to_dict("records"),
    }
    (out / "summary.json").write_text(json.dumps(decision, indent=2, default=str), encoding="utf-8")

    print(json.dumps({"parityPassed": parity_ok, "paired": pair_df.to_dict("records")}, indent=2, default=str))
    if not parity_ok:
        raise RuntimeError("anchor reproduction parity failed; challenger results must not be used")


if __name__ == "__main__":
    main()
