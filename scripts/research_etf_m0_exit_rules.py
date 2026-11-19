#!/usr/bin/env python3
import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

from research_etf_m0_vs_m1 import (
    BASE_COLS,
    ETF_EXTRA,
    HORIZONS,
    build_m1,
    build_market_sector,
    build_rotation,
    enrich_price,
    norm_symbol,
    read_csv_cols,
    sha256,
    total_weighted,
)

MAX_HOLD = 60
FIXED_HOLDS = [10, 20, 30, 40, 60]


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--source-manifest", required=True)
    p.add_argument("--source-cache-dir", required=True)
    p.add_argument("--etf-parquet", required=True)
    p.add_argument("--sector-map", required=True)
    p.add_argument("--output-json", required=True)
    p.add_argument("--output-csv", required=True)
    p.add_argument("--output-trades", required=True)
    return p.parse_args()


def load_and_score(a):
    stock_manifest = json.loads(Path(a.source_manifest).read_text())
    stock_dir = Path(a.source_cache_dir)
    stock_paths = []
    for f in stock_manifest["files"]:
        p = stock_dir / f["cacheFile"]
        if p.stat().st_size != f["bytes"] or sha256(p) != f["fileHash"]:
            raise RuntimeError("Stock cache integrity failure: " + f["fileName"])
        stock_paths.append(p)

    sector_doc = json.loads(Path(a.sector_map).read_text())
    meta = pd.DataFrame(sector_doc["instruments"])
    meta["symbol"] = meta["symbol"].map(norm_symbol)
    etf_meta = meta[meta["instrumentType"] == "ETF"].copy()
    stock_meta = meta[meta["instrumentType"] == "STOCK"].copy()
    etf_symbols = set(etf_meta["symbol"])
    stock_symbols = set(stock_meta["symbol"])

    raw = pd.read_parquet(a.etf_parquet, columns=BASE_COLS + ETF_EXTRA)
    raw["symbol"] = raw["symbol"].map(norm_symbol)
    raw["date"] = raw["date"].astype(str).str.slice(0,10)
    for col in [x for x in BASE_COLS + ETF_EXTRA if x not in {"symbol","name","market","securityType","date","etfUnderlyingIndexName"}]:
        if col in raw:
            raw[col] = pd.to_numeric(raw[col], errors="coerce")

    etf = raw[raw["symbol"].isin(etf_symbols)].copy()
    etf = etf.drop_duplicates(["symbol","date"], keep="first")
    etf = etf.merge(
        etf_meta[["symbol","name","sectorCode","sectorName","isLeveraged","isInverse"]],
        on="symbol", how="left", suffixes=("","_meta")
    )
    etf["name"] = etf["name_meta"].fillna(etf["name"])
    etf.drop(columns=["name_meta"], inplace=True)

    stock_parts = []
    index_parts = []
    for p in stock_paths:
        x = read_csv_cols(p, BASE_COLS)
        x["symbol"] = x["symbol"].map(norm_symbol)
        ix = x[x["symbol"].isin(["KOSPI","KOSDAQ"])][["symbol","date","close"]].copy()
        if len(ix):
            index_parts.append(ix)
        sx = x[x["symbol"].isin(stock_symbols)]
        if len(sx):
            stock_parts.append(sx)
    stock = pd.concat(stock_parts, ignore_index=True)
    idx = pd.concat(index_parts, ignore_index=True).dropna().drop_duplicates(["symbol","date"], keep="first")
    idx["date"] = idx["date"].astype(str).str.slice(0,10)
    idx["close"] = pd.to_numeric(idx["close"], errors="coerce")
    kospi = idx[idx["symbol"] == "KOSPI"].sort_values("date").copy()
    kg = kospi.groupby("symbol", sort=False)
    for n in [20,60,120]:
        kospi[f"r{n}"] = kospi["close"] / kg["close"].shift(n) - 1.0
    kospi["dayReturn"] = kospi["close"] / kg["close"].shift(1) - 1.0

    stock["date"] = stock["date"].astype(str).str.slice(0,10)
    for c in ["open","high","low","close","volume","tradingValue","marketCap","foreignNetBuyValue","institutionNetBuyValue"]:
        stock[c] = pd.to_numeric(stock[c], errors="coerce")
    stock = stock.drop_duplicates(["symbol","date"], keep="first")
    stock = stock.merge(
        stock_meta[["symbol","name","sectorCode","sectorName","isLeveraged","isInverse"]],
        on="symbol", how="left", suffixes=("","_meta")
    )
    stock["name"] = stock["name_meta"].fillna(stock["name"])
    stock.drop(columns=["name_meta"], inplace=True)

    stock = enrich_price(stock, flows=True)
    etf = enrich_price(etf, flows=False)
    kospi_day = kospi[["date","dayReturn"]].rename(columns={"dayReturn":"kospiDay"})
    etf = etf.merge(kospi_day, on="date", how="left")

    market_sector = build_market_sector(stock, etf, kospi)
    rotation = build_rotation(stock, kospi)
    etf = etf.merge(market_sector, on=["date","sectorCode"], how="left")
    etf = etf.merge(rotation, on=["date","sectorCode"], how="left")

    etf["etfTradingValue"] = pd.to_numeric(etf["etfTradingValue"], errors="coerce")
    etf["healthTv20"] = etf.groupby("symbol", sort=False)["etfTradingValue"].transform(
        lambda s: s.rolling(20, min_periods=20).mean()
    )
    implied_price = etf["etfMarketCap"] / etf["etfListedUnits"]
    etf["derivedPremium"] = (implied_price / etf["etfNav"] - 1.0) * 100.0
    aum_pts = np.where(etf["etfNetAssetTotalAmount"] >= 50_000_000_000, 20.0, 0.0) + np.where(
        etf["etfNetAssetTotalAmount"] >= 100_000_000_000, 10.0, 0.0
    )
    tv_pts = np.where(etf["healthTv20"] >= 1_000_000_000, 20.0, 0.0)
    pd_abs = etf["derivedPremium"].abs()
    pd_pts = np.where(pd_abs <= 0.5, 20.0, np.where(pd_abs <= 1.0, 10.0, 0.0))
    plain = ~(etf["isLeveraged"].fillna(False) | etf["isInverse"].fillna(False))
    plain_pts = np.where(plain, 10.0, 0.0)
    health_valid = etf["etfNetAssetTotalAmount"].notna() & etf["healthTv20"].notna() & etf["derivedPremium"].notna()
    etf["health"] = np.where(health_valid, (aum_pts + tv_pts + pd_pts + plain_pts) / 80.0 * 100.0, np.nan)

    size_pts = np.where(etf["marketCap"] >= 300_000_000_000, 1.0, 0.0)
    rel_valid = etf["dayReturn"].notna() & etf["kospiDay"].notna()
    rel_pts = np.where(rel_valid & ((etf["dayReturn"] - etf["kospiDay"]) * 100.0 >= 2.0), 1.0, 0.0)
    base_pts = size_pts + rel_pts
    rot_ok = etf["rotationScore"].notna()
    etf["priorityM0"] = np.where(
        rel_valid & etf["marketCap"].notna(),
        (base_pts + etf["rotationScore"].fillna(0.0) / 100.0) / np.where(rot_ok, 5.0, 4.0) * 100.0,
        np.nan,
    )
    etf = build_m1(etf)
    etf["scoreM0"] = total_weighted(etf, [
        ("technical",0.55),("priorityM0",0.15),("health",0.15),("marketSectorScore",0.15)
    ])
    return etf


def exit_mask(df, rule):
    if rule == "score_below_70":
        return df["scoreM0"] < 70
    if rule == "score_below_60":
        return df["scoreM0"] < 60
    if rule == "technical_below_60":
        return df["technical"] < 60
    if rule == "technical_below_50":
        return df["technical"] < 50
    if rule == "close_below_ma20":
        return df["close"] < df["ma20"]
    if rule == "close_below_ma60":
        return df["close"] < df["ma60"]
    if rule == "underlying_below_ma60":
        return df["etfUnderlyingIndexClose"] < df["uMa60"]
    if rule == "underlying_ma20_below_ma60":
        return df["uMa20"] < df["uMa60"]
    if rule == "score70_or_underlying_ma60_break":
        return (df["scoreM0"] < 70) | (df["etfUnderlyingIndexClose"] < df["uMa60"])
    if rule == "tech60_or_ma20_break":
        return (df["technical"] < 60) | (df["close"] < df["ma20"])
    raise ValueError(rule)


def simulate(etf, rule, scope):
    d = etf[(etf["date"] >= "2018-01-01") & etf["technical"].notna() & etf["health"].notna() & etf["scoreM0"].notna()].copy()
    d["plain"] = ~(d["isLeveraged"].fillna(False) | d["isInverse"].fillna(False))
    if scope == "plain":
        d = d[d["plain"]]
    d = d.sort_values(["symbol", "date"]).reset_index(drop=True)
    d["prevScoreM0"] = d.groupby("symbol", sort=False)["scoreM0"].shift(1)
    entries = d[(d["prevScoreM0"] < 80) & (d["scoreM0"] >= 80)].copy()
    by_symbol = {s: g.reset_index(drop=True) for s, g in d.groupby("symbol", sort=False)}
    rows = []
    for e in entries.itertuples(index=False):
        hist = by_symbol[e.symbol]
        pos_arr = np.flatnonzero(hist["date"].to_numpy() == e.date)
        if len(pos_arr) == 0:
            continue
        pos = int(pos_arr[0])
        if pos + 1 >= len(hist):
            continue
        if rule.startswith("fixed_"):
            hold = int(rule.split("_")[1])
            exit_pos = pos + hold
            if exit_pos >= len(hist):
                continue
            reason = rule
        else:
            future = hist.iloc[pos+1:min(len(hist), pos + MAX_HOLD + 1)].copy()
            m = exit_mask(future, rule).fillna(False).to_numpy()
            if m.any():
                exit_pos = pos + 1 + int(np.flatnonzero(m)[0])
                reason = rule
            else:
                exit_pos = min(len(hist) - 1, pos + MAX_HOLD)
                if exit_pos <= pos:
                    continue
                reason = "max_hold_60"
        x = hist.iloc[exit_pos]
        u0 = e.etfUnderlyingIndexClose if pd.notna(e.etfUnderlyingIndexClose) and e.etfUnderlyingIndexClose > 0 else np.nan
        u1 = x["etfUnderlyingIndexClose"] if pd.notna(x["etfUnderlyingIndexClose"]) and x["etfUnderlyingIndexClose"] > 0 else np.nan
        raw = x["close"] / e.close - 1.0 if pd.notna(x["close"]) and pd.notna(e.close) and e.close > 0 else np.nan
        bench = u1 / u0 - 1.0 if pd.notna(u0) and pd.notna(u1) else np.nan
        path = hist.iloc[pos:exit_pos+1]
        path_raw = path["close"] / e.close - 1.0
        max_dd = float(path_raw.min()) if path_raw.notna().any() else np.nan
        rows.append({
            "scope": scope,
            "rule": rule,
            "symbol": e.symbol,
            "name": e.name,
            "entryDate": e.date,
            "exitDate": x["date"],
            "exitReason": reason,
            "holdDays": int(exit_pos - pos),
            "entryScore": float(e.scoreM0),
            "exitScore": float(x["scoreM0"]) if pd.notna(x["scoreM0"]) else np.nan,
            "entryTechnical": float(e.technical) if pd.notna(e.technical) else np.nan,
            "exitTechnical": float(x["technical"]) if pd.notna(x["technical"]) else np.nan,
            "rawReturn": raw,
            "benchmarkReturn": bench,
            "excessReturn": raw - bench if pd.notna(raw) and pd.notna(bench) else np.nan,
            "maxDrawdown": max_dd,
        })
    return pd.DataFrame(rows)


def summarize(trades):
    rows = []
    for (scope, rule), g in trades.groupby(["scope", "rule"], sort=False):
        ex = pd.to_numeric(g["excessReturn"], errors="coerce")
        raw = pd.to_numeric(g["rawReturn"], errors="coerce")
        dd = pd.to_numeric(g["maxDrawdown"], errors="coerce")
        rows.append({
            "scope": scope,
            "rule": rule,
            "count": int(len(g)),
            "symbols": int(g["symbol"].nunique()),
            "avgHoldDays": float(g["holdDays"].mean()),
            "rawMean": None if raw.notna().sum() == 0 else float(raw.mean()),
            "excessMean": None if ex.notna().sum() == 0 else float(ex.mean()),
            "excessWinRate": None if ex.notna().sum() == 0 else float((ex > 0).mean()),
            "rawWinRate": None if raw.notna().sum() == 0 else float((raw > 0).mean()),
            "avgMaxDrawdown": None if dd.notna().sum() == 0 else float(dd.mean()),
            "medianExcess": None if ex.notna().sum() == 0 else float(ex.median()),
        })
    return pd.DataFrame(rows)


def yearly_summary(trades):
    z = trades.copy()
    z["year"] = z["entryDate"].str[:4]
    out = []
    for (scope, rule, year), g in z.groupby(["scope","rule","year"], sort=False):
        ex = pd.to_numeric(g["excessReturn"], errors="coerce")
        raw = pd.to_numeric(g["rawReturn"], errors="coerce")
        out.append({
            "scope": scope,
            "rule": rule,
            "year": year,
            "count": int(len(g)),
            "avgHoldDays": float(g["holdDays"].mean()),
            "rawMean": None if raw.notna().sum() == 0 else float(raw.mean()),
            "excessMean": None if ex.notna().sum() == 0 else float(ex.mean()),
            "excessWinRate": None if ex.notna().sum() == 0 else float((ex > 0).mean()),
        })
    return out


def main():
    a = parse_args()
    etf = load_and_score(a)
    rules = [f"fixed_{h}" for h in FIXED_HOLDS] + [
        "score_below_70",
        "score_below_60",
        "technical_below_60",
        "technical_below_50",
        "close_below_ma20",
        "close_below_ma60",
        "underlying_below_ma60",
        "underlying_ma20_below_ma60",
        "score70_or_underlying_ma60_break",
        "tech60_or_ma20_break",
    ]
    all_trades = []
    for scope in ["all", "plain"]:
        for rule in rules:
            all_trades.append(simulate(etf, rule, scope))
    trades = pd.concat(all_trades, ignore_index=True)
    summary = summarize(trades)
    summary.to_csv(a.output_csv, index=False)
    trades.to_csv(a.output_trades, index=False)

    picks = {}
    for scope in ["all", "plain"]:
        s = summary[summary["scope"] == scope].copy()
        base = s[s["rule"] == "fixed_30"].iloc[0]
        s["excessLiftVsFixed30"] = s["excessMean"] - base["excessMean"]
        s["winLiftVsFixed30"] = s["excessWinRate"] - base["excessWinRate"]
        # Prefer higher win rate first; require at least 80% of fixed_30 trade count.
        cand = s[s["count"] >= int(base["count"] * 0.80)].copy()
        cand = cand.sort_values(["excessWinRate", "excessMean", "avgHoldDays"], ascending=[False, False, True])
        picks[scope] = cand.head(5).to_dict(orient="records")

    result = {
        "version": "ETF M0 onset80 exit rule study v1",
        "asOfDate": str(etf["date"].max()),
        "design": {
            "entry": "M0 score upward crossing 80",
            "benchmark": "each ETF underlying index close",
            "eventUnit": "one entry event equals one trade; repeated state-days are not counted as separate trades",
            "rules": rules,
            "maxHoldForDynamicRules": MAX_HOLD,
            "selectionHeuristic": "rank by excess win rate, then excess mean; compare to fixed_30 baseline",
        },
        "data": {
            "etfRows": int(len(etf)),
            "etfSymbols": int(etf["symbol"].nunique()),
            "tradeRows": int(len(trades)),
        },
        "summary": summary.to_dict(orient="records"),
        "recommendedCandidates": picks,
        "yearly": yearly_summary(trades),
    }
    Path(a.output_json).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"outputJson": a.output_json, "outputCsv": a.output_csv, "outputTrades": a.output_trades, "recommendedCandidates": picks}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
