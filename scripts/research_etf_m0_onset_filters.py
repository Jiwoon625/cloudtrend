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


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--source-manifest", required=True)
    p.add_argument("--source-cache-dir", required=True)
    p.add_argument("--etf-parquet", required=True)
    p.add_argument("--sector-map", required=True)
    p.add_argument("--output-json", required=True)
    p.add_argument("--output-csv", required=True)
    return p.parse_args()


def metric_block(g: pd.DataFrame):
    out = {"count": int(len(g)), "symbols": int(g["symbol"].nunique()) if len(g) else 0}
    for h in HORIZONS:
        raw = pd.to_numeric(g[f"fwd{h}"], errors="coerce")
        ex = pd.to_numeric(g[f"excess{h}"], errors="coerce")
        out[str(h)] = {
            "n": int(ex.notna().sum()),
            "rawMean": None if raw.notna().sum() == 0 else float(raw.mean()),
            "excessMean": None if ex.notna().sum() == 0 else float(ex.mean()),
            "excessWinRate": None if ex.notna().sum() == 0 else float((ex > 0).mean()),
        }
    return out


def row_metric(label: str, scope: str, g: pd.DataFrame):
    mb = metric_block(g)
    row = {"scope": scope, "filter": label, "count": mb["count"], "symbols": mb["symbols"]}
    for h in HORIZONS:
        x = mb[str(h)]
        row[f"n{h}"] = x["n"]
        row[f"raw{h}"] = x["rawMean"]
        row[f"excess{h}"] = x["excessMean"]
        row[f"win{h}"] = x["excessWinRate"]
    return row


def summarize_filters(base: pd.DataFrame, scope: str):
    filters = [
        ("base_m0_onset80", lambda d: pd.Series(True, index=d.index)),
        ("rs_ge_50", lambda d: d["rsScore"] >= 50),
        ("rs_ge_60", lambda d: d["rsScore"] >= 60),
        ("rs_ge_70", lambda d: d["rsScore"] >= 70),
        ("velocity_ge_50", lambda d: d["velocityScore"] >= 50),
        ("velocity_ge_60", lambda d: d["velocityScore"] >= 60),
        ("velocity_ge_70", lambda d: d["velocityScore"] >= 70),
        ("rs50_velocity50", lambda d: (d["rsScore"] >= 50) & (d["velocityScore"] >= 50)),
        ("rs60_velocity50", lambda d: (d["rsScore"] >= 60) & (d["velocityScore"] >= 50)),
        ("rs60_velocity60", lambda d: (d["rsScore"] >= 60) & (d["velocityScore"] >= 60)),
        ("rs70_velocity50", lambda d: (d["rsScore"] >= 70) & (d["velocityScore"] >= 50)),
        ("rs50_velocity60", lambda d: (d["rsScore"] >= 50) & (d["velocityScore"] >= 60)),
        ("m1block_ge_50", lambda d: d["m1Block"] >= 50),
        ("m1block_ge_60", lambda d: d["m1Block"] >= 60),
        ("m1block_ge_70", lambda d: d["m1Block"] >= 70),
        ("rs_ge_50_and_m1block_ge_50", lambda d: (d["rsScore"] >= 50) & (d["m1Block"] >= 50)),
        ("rs_ge_60_and_m1block_ge_50", lambda d: (d["rsScore"] >= 60) & (d["m1Block"] >= 50)),
        ("rs_ge_50_and_velocity_positive", lambda d: (d["rsScore"] >= 50) & (d["dRs20_5"] > 0) & (d["dRs20_10"] > 0)),
        ("exclude_rs_below_40", lambda d: d["rsScore"] >= 40),
        ("exclude_m1block_below_40", lambda d: d["m1Block"] >= 40),
    ]
    rows = []
    details = {}
    for label, fn in filters:
        mask = fn(base).fillna(False)
        subset = base[mask].copy()
        rows.append(row_metric(label, scope, subset))
        details[label] = metric_block(subset)
    return rows, details


def yearly_onset(g: pd.DataFrame):
    z = g.copy()
    z["year"] = z["date"].str[:4]
    rows = []
    for year, part in z.groupby("year", sort=True):
        row = {"year": year, "count": int(len(part)), "symbols": int(part["symbol"].nunique())}
        for h in [20, 30, 40]:
            ex = pd.to_numeric(part[f"excess{h}"], errors="coerce")
            row[f"excess{h}"] = None if ex.notna().sum() == 0 else float(ex.mean())
            row[f"win{h}"] = None if ex.notna().sum() == 0 else float((ex > 0).mean())
        rows.append(row)
    return rows


def main():
    a = parse_args()
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
    raw["date"] = raw["date"].astype(str).str.slice(0, 10)
    for col in [x for x in BASE_COLS + ETF_EXTRA if x not in {"symbol", "name", "market", "securityType", "date", "etfUnderlyingIndexName"}]:
        if col in raw:
            raw[col] = pd.to_numeric(raw[col], errors="coerce")

    etf = raw[raw["symbol"].isin(etf_symbols)].copy()
    etf = etf.drop_duplicates(["symbol", "date"], keep="first")
    etf = etf.merge(
        etf_meta[["symbol", "name", "sectorCode", "sectorName", "isLeveraged", "isInverse"]],
        on="symbol", how="left", suffixes=("", "_meta"),
    )
    etf["name"] = etf["name_meta"].fillna(etf["name"])
    etf.drop(columns=["name_meta"], inplace=True)

    stock_parts = []
    index_parts = []
    for p in stock_paths:
        x = read_csv_cols(p, BASE_COLS)
        x["symbol"] = x["symbol"].map(norm_symbol)
        ix = x[x["symbol"].isin(["KOSPI", "KOSDAQ"])][["symbol", "date", "close"]].copy()
        if len(ix):
            index_parts.append(ix)
        sx = x[x["symbol"].isin(stock_symbols)]
        if len(sx):
            stock_parts.append(sx)
    stock = pd.concat(stock_parts, ignore_index=True)
    idx = pd.concat(index_parts, ignore_index=True).dropna().drop_duplicates(["symbol", "date"], keep="first")
    idx["date"] = idx["date"].astype(str).str.slice(0, 10)
    idx["close"] = pd.to_numeric(idx["close"], errors="coerce")
    kospi = idx[idx["symbol"] == "KOSPI"].sort_values("date").copy()
    kg = kospi.groupby("symbol", sort=False)
    for n in [20, 60, 120]:
        kospi[f"r{n}"] = kospi["close"] / kg["close"].shift(n) - 1.0
    kospi["dayReturn"] = kospi["close"] / kg["close"].shift(1) - 1.0

    stock["date"] = stock["date"].astype(str).str.slice(0, 10)
    for c in ["open", "high", "low", "close", "volume", "tradingValue", "marketCap", "foreignNetBuyValue", "institutionNetBuyValue"]:
        stock[c] = pd.to_numeric(stock[c], errors="coerce")
    stock = stock.drop_duplicates(["symbol", "date"], keep="first")
    stock = stock.merge(
        stock_meta[["symbol", "name", "sectorCode", "sectorName", "isLeveraged", "isInverse"]],
        on="symbol", how="left", suffixes=("", "_meta"),
    )
    stock["name"] = stock["name_meta"].fillna(stock["name"])
    stock.drop(columns=["name_meta"], inplace=True)

    stock = enrich_price(stock, flows=True)
    etf = enrich_price(etf, flows=False)
    kospi_day = kospi[["date", "dayReturn"]].rename(columns={"dayReturn": "kospiDay"})
    etf = etf.merge(kospi_day, on="date", how="left")

    market_sector = build_market_sector(stock, etf, kospi)
    rotation = build_rotation(stock, kospi)
    etf = etf.merge(market_sector, on=["date", "sectorCode"], how="left")
    etf = etf.merge(rotation, on=["date", "sectorCode"], how="left")

    etf["etfTradingValue"] = pd.to_numeric(etf["etfTradingValue"], errors="coerce")
    etf["healthTv20"] = etf.groupby("symbol", sort=False)["etfTradingValue"].transform(lambda s: s.rolling(20, min_periods=20).mean())
    implied_price = etf["etfMarketCap"] / etf["etfListedUnits"]
    etf["derivedPremium"] = (implied_price / etf["etfNav"] - 1.0) * 100.0
    aum_pts = np.where(etf["etfNetAssetTotalAmount"] >= 50_000_000_000, 20.0, 0.0) + np.where(etf["etfNetAssetTotalAmount"] >= 100_000_000_000, 10.0, 0.0)
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
    etf["priorityM1"] = np.where(rel_valid & etf["marketCap"].notna(), base_pts / 4.0 * 100.0, np.nan)
    rot_ok = etf["rotationScore"].notna()
    etf["priorityM0"] = np.where(
        rel_valid & etf["marketCap"].notna(),
        (base_pts + etf["rotationScore"].fillna(0.0) / 100.0) / np.where(rot_ok, 5.0, 4.0) * 100.0,
        np.nan,
    )

    etf = build_m1(etf)
    etf["scoreM0"] = total_weighted(etf, [("technical", 0.55), ("priorityM0", 0.15), ("health", 0.15), ("marketSectorScore", 0.15)])
    etf["scoreM1"] = total_weighted(etf, [("technical", 0.55), ("priorityM1", 0.15), ("health", 0.15), ("m1Block", 0.15)])

    g = etf.groupby("symbol", sort=False)
    for h in HORIZONS:
        etf[f"fwd{h}"] = g["close"].shift(-h) / etf["close"] - 1.0
        u_now = pd.to_numeric(etf["etfUnderlyingIndexClose"], errors="coerce").where(pd.to_numeric(etf["etfUnderlyingIndexClose"], errors="coerce") > 0)
        u_future = pd.to_numeric(g["etfUnderlyingIndexClose"].shift(-h), errors="coerce").where(pd.to_numeric(g["etfUnderlyingIndexClose"].shift(-h), errors="coerce") > 0)
        etf[f"excess{h}"] = (etf[f"fwd{h}"] - (u_future / u_now - 1.0)).replace([np.inf, -np.inf], np.nan)

    eligible = etf[(etf["date"] >= "2018-01-01") & etf["technical"].notna() & etf["health"].notna() & etf["scoreM0"].notna()].copy()
    eligible["plain"] = ~(eligible["isLeveraged"].fillna(False) | eligible["isInverse"].fillna(False))
    eligible = eligible.sort_values(["symbol", "date"])
    eligible["prevScoreM0"] = eligible.groupby("symbol", sort=False)["scoreM0"].shift(1)
    onset = eligible[(eligible["prevScoreM0"] < 80) & (eligible["scoreM0"] >= 80)].copy()

    rows = []
    details = {}
    for scope, part in [("all", onset), ("plain", onset[onset["plain"]])]:
        r, d = summarize_filters(part, scope)
        rows.extend(r)
        details[scope] = d

    rows_df = pd.DataFrame(rows)
    rows_df.to_csv(a.output_csv, index=False)

    # Pick candidates that improve 30D win rate while retaining at least 60% of base count.
    picks = {}
    for scope in ["all", "plain"]:
        scoped = rows_df[rows_df["scope"] == scope].copy()
        base_count = int(scoped[scoped["filter"] == "base_m0_onset80"]["count"].iloc[0])
        base_win = float(scoped[scoped["filter"] == "base_m0_onset80"]["win30"].iloc[0])
        base_ex = float(scoped[scoped["filter"] == "base_m0_onset80"]["excess30"].iloc[0])
        cand = scoped[scoped["count"] >= base_count * 0.60].copy()
        cand["win30Lift"] = cand["win30"] - base_win
        cand["excess30Lift"] = cand["excess30"] - base_ex
        cand = cand.sort_values(["win30Lift", "excess30Lift", "count"], ascending=[False, False, False])
        picks[scope] = cand.head(5).to_dict(orient="records")

    output = {
        "version": "ETF M0 onset80 with M1 RS/Velocity filters v1",
        "asOfDate": str(etf["date"].max()),
        "data": {
            "etfRows": int(len(etf)),
            "eligibleRows": int(len(eligible)),
            "m0Onset80All": int(len(onset)),
            "m0Onset80Plain": int(onset["plain"].sum()),
        },
        "design": {
            "baseSignal": "M0 score upward crossing 80",
            "filters": "M1 ETF-native rsScore, velocityScore and m1Block as secondary filters only",
            "benchmark": "each ETF underlying index close",
            "selectionRuleForRecommendation": "prefer filters that improve 30D excess win rate while retaining at least 60% of base M0 onset count",
        },
        "details": details,
        "recommendedCandidates": picks,
        "yearly": {
            "allBase": yearly_onset(onset),
            "plainBase": yearly_onset(onset[onset["plain"]]),
        },
    }
    Path(a.output_json).write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"outputJson": a.output_json, "outputCsv": a.output_csv, "data": output["data"], "recommendedCandidates": picks}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
