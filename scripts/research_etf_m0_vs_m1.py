#!/usr/bin/env python3
import argparse
import hashlib
import json
import math
import re
from pathlib import Path

import numpy as np
import pandas as pd

HORIZONS = [5, 10, 20, 30, 40]
THRESHOLDS = [60, 70, 80]
WEIGHTS = {"technical": 0.55, "priority": 0.15, "health": 0.15, "rotation": 0.15}

BASE_COLS = [
    "symbol","name","market","securityType","date","open","high","low","close","volume",
    "tradingValue","marketCap","foreignNetBuyValue","institutionNetBuyValue",
]
ETF_EXTRA = [
    "etfNav","etfTradingValue","etfMarketCap","etfNetAssetTotalAmount","etfListedUnits",
    "etfUnderlyingIndexName","etfUnderlyingIndexClose",
]


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--source-manifest", required=True)
    p.add_argument("--source-cache-dir", required=True)
    p.add_argument("--etf-parquet", required=True)
    p.add_argument("--sector-map", required=True)
    p.add_argument("--output", required=True)
    return p.parse_args()


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return "sha256:" + h.hexdigest()


def norm_symbol(s):
    s = str(s).strip().upper()
    if re.fullmatch(r"A\d{6}", s):
        s = s[1:]
    if re.fullmatch(r"\d+(\.0)?", s):
        s = s.split(".")[0].zfill(6)
    return s


def read_csv_cols(path: Path, wanted):
    kwargs = dict(usecols=lambda c: c in set(wanted), low_memory=False)
    try:
        df = pd.read_csv(path, encoding="utf-8", **kwargs)
    except UnicodeDecodeError:
        df = pd.read_csv(path, encoding="cp949", **kwargs)
    return df


def rolling_transform(df, col, window, func="mean", min_periods=None):
    if min_periods is None:
        min_periods = window
    g = df.groupby("symbol", sort=False)[col]
    if func == "mean":
        return g.transform(lambda s: s.rolling(window, min_periods=min_periods).mean())
    if func == "sum":
        return g.transform(lambda s: s.rolling(window, min_periods=min_periods).sum())
    if func == "max":
        return g.transform(lambda s: s.rolling(window, min_periods=min_periods).max())
    if func == "min":
        return g.transform(lambda s: s.rolling(window, min_periods=min_periods).min())
    if func == "std0":
        return g.transform(lambda s: s.rolling(window, min_periods=min_periods).std(ddof=0))
    raise ValueError(func)


def enrich_price(df, flows=False):
    df = df.sort_values(["symbol", "date"]).reset_index(drop=True)
    g = df.groupby("symbol", sort=False)
    df["prevClose"] = g["close"].shift(1)
    df["dayReturn"] = df["close"] / df["prevClose"] - 1.0
    for n in [5, 20, 60, 120]:
        df[f"r{n}"] = df["close"] / g["close"].shift(n) - 1.0

    for n in [20, 60, 120]:
        df[f"ma{n}"] = rolling_transform(df, "close", n, "mean")

    for n in [9, 26, 52]:
        hi = rolling_transform(df, "high", n, "max")
        lo = rolling_transform(df, "low", n, "min")
        df[f"mid{n}"] = (hi + lo) / 2.0

    df["srcMid9"] = g["mid9"].shift(26)
    df["srcMid26"] = g["mid26"].shift(26)
    df["srcMid52"] = g["mid52"].shift(26)
    senkou_a = (df["srcMid9"] + df["srcMid26"]) / 2.0
    df["cloudTop"] = np.maximum(senkou_a, df["srcMid52"])
    cloud_valid = senkou_a.notna() & df["srcMid52"].notna()
    df["cloudAbove"] = np.where(cloud_valid, df["close"] > df["cloudTop"], np.nan)
    tenkan_valid = df["mid9"].notna() & df["mid26"].notna()
    df["tenkanAbove"] = np.where(tenkan_valid, df["mid9"] > df["mid26"], np.nan)
    ma_valid = df[["ma20","ma60","ma120"]].notna().all(axis=1)
    df["maAligned"] = np.where(ma_valid, (df["ma20"] > df["ma60"]) & (df["ma60"] > df["ma120"]), np.nan)
    df["aboveMa20"] = np.where(df["ma20"].notna(), df["close"] > df["ma20"], np.nan)
    df["aboveMa60"] = np.where(df["ma60"].notna(), df["close"] > df["ma60"], np.nan)
    df["aboveMa120"] = np.where(df["ma120"].notna(), df["close"] > df["ma120"], np.nan)

    sd20 = rolling_transform(df, "close", 20, "std0")
    bb_mid = df["ma20"]
    bb_upper = bb_mid + 2.0 * sd20
    df["bbWidth"] = np.where(bb_mid != 0, (4.0 * sd20 / bb_mid) * 100.0, np.nan)
    df["bbBreakoutRaw"] = np.where(bb_upper.notna(), df["close"] > bb_upper, np.nan)
    df["prevBbBreakoutRaw"] = g["bbBreakoutRaw"].shift(1)
    df["prevBbWidth"] = g["bbWidth"].shift(1)
    df["_priorWidth"] = g["bbWidth"].shift(1)
    df["avgPrior20Width"] = rolling_transform(df, "_priorWidth", 20, "mean")
    expanding = (
        df["bbWidth"].notna()
        & df["prevBbWidth"].notna()
        & df["avgPrior20Width"].notna()
        & (df["bbWidth"] > df["prevBbWidth"])
        & (df["bbWidth"] > df["avgPrior20Width"])
    )
    headfake = (
        df["prevBbBreakoutRaw"].fillna(False).astype(bool)
        & (~df["bbBreakoutRaw"].fillna(False).astype(bool))
        & (~expanding)
    )
    bb_valid = bb_upper.notna()
    df["bbBreakout"] = np.where(bb_valid, np.where(headfake, False, df["bbBreakoutRaw"].fillna(False)), np.nan)

    df["_priorVolume"] = g["volume"].shift(1)
    prior_vol_avg = rolling_transform(df, "_priorVolume", 20, "mean")
    prior_vol_pos = df.groupby("symbol", sort=False)["_priorVolume"].transform(
        lambda s: (s > 0).rolling(20, min_periods=20).sum()
    )
    vol_ratio = np.where((prior_vol_avg > 0) & (prior_vol_pos >= 10), (df["volume"] / prior_vol_avg) * 100.0, np.nan)
    df["volumeRatio20"] = np.minimum(vol_ratio, 9999.0)
    rng = df["high"] - df["low"]
    df["clv"] = np.where(rng > 0, (df["close"] - df["low"]) / rng, np.nan)
    hv_valid = pd.Series(df["volumeRatio20"]).notna() & df["clv"].notna()
    df["highCloseVolume"] = np.where(hv_valid, (df["volumeRatio20"] >= 150) & (df["clv"] >= 0.7), np.nan)

    tech_parts = [
        ("cloudAbove", 1.0),
        ("maAligned", 1.0),
        ("tenkanAbove", 1.0),
        ("bbBreakout", 1.5),
        ("highCloseVolume", 0.5),
    ]
    pts = np.zeros(len(df), dtype=float)
    avail = np.zeros(len(df), dtype=float)
    for col, w in tech_parts:
        valid = df[col].notna().to_numpy()
        truth = df[col].fillna(False).astype(bool).to_numpy()
        pts += np.where(truth, w, 0.0)
        avail += np.where(valid, w, 0.0)
    df["technical"] = np.where(avail > 0, pts / avail * 100.0, np.nan)

    high252 = rolling_transform(df, "high", 252, "max", min_periods=252)
    df["nearHighMS"] = np.where(high252.notna(), df["close"] >= high252 * 0.90, False)
    high250 = rolling_transform(df, "high", 250, "max", min_periods=60)
    df["nearHighRot"] = np.where(high250.notna(), df["close"] >= high250 * 0.95, np.nan)
    df["advancing"] = np.where(df["prevClose"].notna(), df["close"] > df["prevClose"], np.nan)
    df["up5"] = np.where(df["r5"].notna(), df["r5"] > 0, np.nan)
    df["up20"] = np.where(df["r20"].notna(), df["r20"] > 0, np.nan)
    df["avgTv5"] = rolling_transform(df, "tradingValue", 5, "mean")
    df["avgTv20"] = rolling_transform(df, "tradingValue", 20, "mean")

    if flows:
        for c in ["foreignNetBuyValue","institutionNetBuyValue"]:
            if c not in df:
                df[c] = np.nan
            df[c] = pd.to_numeric(df[c], errors="coerce")
        for n in [5, 20, 60]:
            df[f"f{n}"] = rolling_transform(df, "foreignNetBuyValue", n, "sum")
            df[f"i{n}"] = rolling_transform(df, "institutionNetBuyValue", n, "sum")
        both_valid = df["f5"].notna() & df["i5"].notna()
        df["bothBuy5"] = np.where(both_valid, (df["f5"] > 0) & (df["i5"] > 0), np.nan)

    df.drop(columns=[c for c in ["_priorWidth","_priorVolume"] if c in df], inplace=True)
    return df


def pct_below(s: pd.Series) -> pd.Series:
    n = int(s.count())
    if n == 0:
        return pd.Series(np.nan, index=s.index, dtype=float)
    rank = s.rank(method="min")
    return (rank - 1.0) / float(n)


def weighted_row(df, pairs):
    num = np.zeros(len(df), dtype=float)
    den = np.zeros(len(df), dtype=float)
    for col, w in pairs:
        v = pd.to_numeric(df[col], errors="coerce")
        ok = v.notna().to_numpy()
        arr = v.fillna(0).to_numpy(dtype=float)
        num += arr * w
        den += ok * w
    return np.where(den > 0, num / den, np.nan)


def build_market_sector(stock, etf, kospi):
    cols = ["date","sectorCode","r20","r60","aboveMa20","aboveMa60","cloudAbove","maAligned","nearHighMS","advancing"]
    members = pd.concat([stock[cols], etf[cols]], ignore_index=True)
    members["aligned0"] = members["maAligned"].fillna(False).astype(float)
    members["near0"] = members["nearHighMS"].fillna(False).astype(float)
    members["adv0"] = members["advancing"].fillna(False).astype(float)

    breadth = members.groupby(["date","sectorCode"], sort=False).agg(
        above20=("aboveMa20","mean"),
        above60=("aboveMa60","mean"),
        cloud=("cloudAbove","mean"),
        aligned=("aligned0","mean"),
        near=("near0","mean"),
        advancing=("adv0","mean"),
        memberCount=("sectorCode","size"),
    ).reset_index()

    sr = stock.groupby(["date","sectorCode"], sort=False).agg(
        sectorR20=("r20","median"),
        sectorR60=("r60","median"),
    ).reset_index()
    out = breadth.merge(sr, on=["date","sectorCode"], how="left")
    out = out.merge(kospi[["date","r20","r60"]].rename(columns={"r20":"m20","r60":"m60"}), on="date", how="left")
    out["sectorR20"] = out["sectorR20"].fillna(out["m20"])
    out["sectorR60"] = out["sectorR60"].fillna(out["m60"])
    out["rs20"] = (out["sectorR20"] - out["m20"]) * 100.0
    out["rs60"] = (out["sectorR60"] - out["m60"]) * 100.0
    out["p20"] = out.groupby("date", sort=False)["rs20"].transform(pct_below)
    out["p60"] = out.groupby("date", sort=False)["rs60"].transform(pct_below)
    trend = (
        (out["above20"].fillna(-1) > 0.5).astype(float)
        + (out["above60"].fillna(-1) > 0.5).astype(float)
        + (out["cloud"].fillna(-1) > 0.5).astype(float)
    ) / 3.0 * 20.0
    breadth_score = (out["aligned"] + out["near"] + out["advancing"]) / 3.0 * 20.0
    out["marketSectorScore"] = out["p20"] * 35.0 + out["p60"] * 25.0 + trend + breadth_score
    return out[["date","sectorCode","marketSectorScore"]]


def build_rotation(stock, kospi):
    s = stock.copy()
    g = s.groupby(["date","sectorCode"], sort=False)
    base = g.agg(
        eq20=("r20","median"), eq60=("r60","median"), eq120=("r120","median"),
        t1=("tradingValue","sum"), t5=("avgTv5","sum"), t20=("avgTv20","sum"),
        advancing=("advancing","mean"), above20=("aboveMa20","mean"), above60=("aboveMa60","mean"),
        above120=("aboveMa120","mean"), maAligned=("maAligned","mean"), nearHigh=("nearHighRot","mean"),
        bothBuy5=("bothBuy5","mean"),
    ).reset_index()

    fsum = g[["f5","i5"]].sum(min_count=1).reset_index()
    base = base.merge(fsum, on=["date","sectorCode"], how="left")
    totals = s.groupby("date", sort=False).agg(
        total1=("tradingValue","sum"), total5=("avgTv5","sum"), total20=("avgTv20","sum")
    ).reset_index()
    base = base.merge(totals, on="date", how="left")
    base = base.merge(
        kospi[["date","r20","r60","r120"]].rename(columns={"r20":"m20","r60":"m60","r120":"m120"}),
        on="date", how="left"
    )
    base["rs20"] = (base["eq20"] - base["m20"]) * 100.0
    base["rs60"] = (base["eq60"] - base["m60"]) * 100.0
    base["rs120"] = (base["eq120"] - base["m120"]) * 100.0
    base["share5"] = np.where(base["total5"] > 0, base["t5"] / base["total5"] * 100.0, 0.0)
    base["share20"] = np.where(base["total20"] > 0, base["t20"] / base["total20"] * 100.0, 0.0)
    base["shareChange"] = base["share5"] - base["share20"]
    base["relativeTurnover"] = np.where(base["t20"] > 0, base["t5"] / base["t20"], np.nan)

    for c in ["rs20","rs60","rs120"]:
        base["pct_" + c] = base.groupby("date", sort=False)[c].transform(pct_below)
    trend = base[["above20","above60","above120"]].mean(axis=1, skipna=True)
    price_breadth = base[["advancing","above20","maAligned"]].mean(axis=1, skipna=True)
    base["relTurnScore"] = np.clip((base["relativeTurnover"] - 0.7) / 0.8, 0, 1)
    base["priceScore"] = weighted_row(base, [
        ("pct_rs20",20),("pct_rs60",20),("pct_rs120",10),
        ("trendTmp",15),("breadthTmp",20),("nearHigh",10),("relTurnScore",5)
    ]) if False else np.nan
    base["trendTmp"] = trend
    base["breadthTmp"] = price_breadth
    base["priceScore"] = weighted_row(base, [
        ("pct_rs20",20),("pct_rs60",20),("pct_rs120",10),
        ("trendTmp",15),("breadthTmp",20),("nearHigh",10),("relTurnScore",5)
    ]) * 100.0

    base["fIntensity"] = np.where(base["t20"] > 0, base["f5"] / base["t20"], np.nan)
    base["iIntensity"] = np.where(base["t20"] > 0, base["i5"] / base["t20"], np.nan)
    base["pct_f"] = base.groupby("date", sort=False)["fIntensity"].transform(pct_below)
    base["pct_i"] = base.groupby("date", sort=False)["iIntensity"].transform(pct_below)
    base["pct_share"] = base.groupby("date", sort=False)["shareChange"].transform(pct_below)
    base["flowScore"] = weighted_row(base, [
        ("pct_f",25),("pct_i",20),("bothBuy5",10),("pct_share",15)
    ]) * 100.0

    base = base.sort_values(["sectorCode","date"]).reset_index(drop=True)
    gb = base.groupby("sectorCode", sort=False)
    base["pricePrev5"] = gb["priceScore"].shift(5)
    base["flowPrev5"] = gb["flowScore"].shift(5)
    base["bothPrev5"] = gb["bothBuy5"].shift(5)
    base["priceChange"] = base["priceScore"] - base["pricePrev5"]
    base["flowChange"] = base["flowScore"] - base["flowPrev5"]
    base["bothChange"] = base["bothBuy5"] - base["bothPrev5"]

    for c in ["priceChange","flowChange","shareChange","bothChange"]:
        base["mom_" + c] = base.groupby("date", sort=False)[c].transform(pct_below)
    base["momentum"] = base[["mom_priceChange","mom_flowChange","mom_shareChange","mom_bothChange"]].mean(axis=1, skipna=True) * 100.0
    base["rotationScore"] = weighted_row(base, [
        ("priceScore",0.40),("flowScore",0.45),("momentum",0.15)
    ])
    return base[["date","sectorCode","rotationScore"]]


def peer_key(row):
    code = str(row.get("sectorCode","ETC"))
    if code not in {"MARKET_IDX","ETC","nan","None"}:
        return "SECTOR:" + code
    text = (str(row.get("name","")) + " " + str(row.get("etfUnderlyingIndexName",""))).upper()
    if re.search(r"채권|국고채|회사채|단기채|장기채|KOFR|CD.?금리|금리액티브|BOND|TREASURY", text):
        return "ASSET:BOND"
    if re.search(r"금현물|골드|GOLD|은선물|SILVER|원유|OIL|구리|COPPER|농산물|팔라듐|원자재|COMMOD", text):
        return "ASSET:COMMODITY"
    if re.search(r"달러|엔선물|유로|USD|JPY|EUR|환율", text):
        return "ASSET:FX"
    if re.search(r"리츠|REIT|부동산|INFRA|인프라", text):
        return "ASSET:REIT_INFRA"
    if re.search(r"미국|S&P|NASDAQ|나스닥|중국|차이나|CHINA|일본|인도|베트남|유럽|글로벌|선진국|신흥국|WORLD|MSCI", text):
        return "ASSET:GLOBAL_BROAD"
    return "ASSET:DOMESTIC_BROAD"


def peer_percentile(df, col):
    valid = df[col].notna()
    result = pd.Series(np.nan, index=df.index, dtype=float)
    if valid.sum() == 0:
        return result
    tmp = df.loc[valid, ["date","peerKey",col]].copy()
    counts = tmp.groupby(["date","peerKey"], sort=False)[col].transform("count")
    peer_rank = tmp.groupby(["date","peerKey"], sort=False)[col].rank(method="min")
    peer_pct = (peer_rank - 1.0) / counts
    global_counts = tmp.groupby("date", sort=False)[col].transform("count")
    global_rank = tmp.groupby("date", sort=False)[col].rank(method="min")
    global_pct = (global_rank - 1.0) / global_counts
    tmp["pct"] = np.where(counts >= 3, peer_pct, global_pct)
    result.loc[tmp.index] = tmp["pct"]
    return result


def build_m1(etf):
    e = etf.copy()
    g = e.groupby("symbol", sort=False)
    for n in [20,60,120]:
        e[f"uR{n}"] = e["etfUnderlyingIndexClose"] / g["etfUnderlyingIndexClose"].shift(n) - 1.0
        e[f"rs{n}Own"] = (e[f"r{n}"] - e[f"uR{n}"]) * 100.0
    g = e.groupby("symbol", sort=False)
    e["dRs20_5"] = e["rs20Own"] - g["rs20Own"].shift(5)
    e["dRs20_10"] = e["rs20Own"] - g["rs20Own"].shift(10)
    e["dRs60_10"] = e["rs60Own"] - g["rs60Own"].shift(10)
    e["peerKey"] = e.apply(peer_key, axis=1)

    for c in ["rs20Own","rs60Own","rs120Own","dRs20_5","dRs20_10","dRs60_10"]:
        e["pct_" + c] = peer_percentile(e, c)
    e["rsScore"] = e[["pct_rs20Own","pct_rs60Own","pct_rs120Own"]].mean(axis=1, skipna=True) * 100.0
    e["velocityScore"] = e[["pct_dRs20_5","pct_dRs20_10","pct_dRs60_10"]].mean(axis=1, skipna=True) * 100.0

    e["breadthAbove20"] = np.where(e["ma20"].notna(), e["close"] > e["ma20"], np.nan)
    e["breadthMa20Gt60"] = np.where(e[["ma20","ma60"]].notna().all(axis=1), e["ma20"] > e["ma60"], np.nan)
    e["breadthRs20Pos"] = np.where(e["rs20Own"].notna(), e["rs20Own"] > 0, np.nan)
    pgrp = e.groupby(["date","peerKey"], sort=False)
    e["peerCount"] = pgrp["symbol"].transform("count")
    for src, dst in [
        ("breadthAbove20","b1"),("breadthMa20Gt60","b2"),("breadthRs20Pos","b3")
    ]:
        peer = pgrp[src].transform("mean")
        glob = e.groupby("date", sort=False)[src].transform("mean")
        e[dst] = np.where(e["peerCount"] >= 3, peer, glob)
    e["breadthScore"] = e[["b1","b2","b3"]].mean(axis=1, skipna=True) * 100.0

    e["uMa20"] = e.groupby("symbol", sort=False)["etfUnderlyingIndexClose"].transform(
        lambda s: s.rolling(20, min_periods=20).mean()
    )
    e["uMa60"] = e.groupby("symbol", sort=False)["etfUnderlyingIndexClose"].transform(
        lambda s: s.rolling(60, min_periods=60).mean()
    )
    e["reg1"] = np.where(e[["etfUnderlyingIndexClose","uMa60"]].notna().all(axis=1), e["etfUnderlyingIndexClose"] > e["uMa60"], np.nan)
    e["reg2"] = np.where(e[["uMa20","uMa60"]].notna().all(axis=1), e["uMa20"] > e["uMa60"], np.nan)
    e["regimeScore"] = e[["reg1","reg2"]].mean(axis=1, skipna=True) * 100.0
    e["m1Block"] = weighted_row(e, [
        ("rsScore",6),("velocityScore",4),("breadthScore",3),("regimeScore",2)
    ])
    return e


def total_weighted(df, cols_weights):
    return weighted_row(df, cols_weights)


def summarize_slice(df, score_col, label):
    d = df[df[score_col].notna()].copy()
    d = d.sort_values(["symbol","date"])
    d["prevScore"] = d.groupby("symbol", sort=False)[score_col].shift(1)
    summary = {"label": label, "observations": int(len(d)), "symbols": int(d["symbol"].nunique())}

    states = {}
    onsets = {}
    for t in THRESHOLDS:
        st = d[d[score_col] >= t]
        onset = d[(d["prevScore"] < t) & (d[score_col] >= t)]
        states[str(t)] = horizon_stats(st)
        onsets[str(t)] = horizon_stats(onset)
    summary["states"] = states
    summary["onsets"] = onsets

    rank = d.groupby("date", sort=False)[score_col].rank(method="first", pct=True)
    d["decile"] = np.minimum(9, np.floor(rank * 10).astype(int))
    deciles = {}
    for dec, g in d.groupby("decile"):
        deciles[str(int(dec))] = horizon_stats(g)
    summary["deciles"] = deciles

    tops = {}
    d["rankDesc"] = d.groupby("date", sort=False)[score_col].rank(method="first", ascending=False)
    for n in [10,20]:
        tops[str(n)] = horizon_stats(d[d["rankDesc"] <= n])
    summary["topN"] = tops

    yrows = []
    onset80 = d[(d["prevScore"] < 80) & (d[score_col] >= 80)].copy()
    onset80["year"] = onset80["date"].str[:4]
    for year, g in onset80.groupby("year"):
        row = {"year": year, "count": int(len(g))}
        for h in HORIZONS:
            row[f"excess{h}"] = mean_or_none(g[f"excess{h}"])
            row[f"raw{h}"] = mean_or_none(g[f"fwd{h}"])
        yrows.append(row)
    summary["yearlyOnset80"] = yrows

    mono = {}
    for h in HORIZONS:
        means = []
        xs = []
        for dec in range(10):
            g = d[d["decile"] == dec]
            m = g[f"excess{h}"].mean()
            if pd.notna(m):
                xs.append(dec)
                means.append(float(m))
        corr = float(np.corrcoef(xs, means)[0,1]) if len(xs) >= 3 else None
        d0 = deciles.get("0",{}).get(str(h),{}).get("excessMean")
        d9 = deciles.get("9",{}).get(str(h),{}).get("excessMean")
        mono[str(h)] = {
            "decileCorrelation": corr,
            "topMinusBottomExcess": None if d0 is None or d9 is None else d9 - d0,
        }
    summary["monotonicity"] = mono
    return summary


def mean_or_none(s):
    m = pd.to_numeric(s, errors="coerce").mean()
    return None if pd.isna(m) else float(m)


def horizon_stats(g):
    out = {"count": int(len(g))}
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

    print(json.dumps({
        "stage":"loaded",
        "stockRows":len(stock),"stockSymbols":stock["symbol"].nunique(),
        "etfRows":len(etf),"etfSymbols":etf["symbol"].nunique(),
        "firstDate":min(etf["date"].min(), stock["date"].min()),
        "lastDate":max(etf["date"].max(), stock["date"].max()),
    }, ensure_ascii=False), flush=True)

    stock = enrich_price(stock, flows=True)
    etf = enrich_price(etf, flows=False)
    kospi_day = kospi[["date","dayReturn"]].rename(columns={"dayReturn":"kospiDay"})
    etf = etf.merge(kospi_day, on="date", how="left")

    market_sector = build_market_sector(stock, etf, kospi)
    rotation = build_rotation(stock, kospi)
    etf = etf.merge(market_sector, on=["date","sectorCode"], how="left")
    etf = etf.merge(rotation, on=["date","sectorCode"], how="left")

    # ETF Health, historical and leak-free: total fee excluded.
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
    health_valid = (
        etf["etfNetAssetTotalAmount"].notna()
        & etf["healthTv20"].notna()
        & etf["derivedPremium"].notna()
    )
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
    etf["scoreM0"] = total_weighted(etf, [
        ("technical",0.55),("priorityM0",0.15),("health",0.15),("marketSectorScore",0.15)
    ])
    etf["scoreM1"] = total_weighted(etf, [
        ("technical",0.55),("priorityM1",0.15),("health",0.15),("m1Block",0.15)
    ])

    g = etf.groupby("symbol", sort=False)
    for h in HORIZONS:
        etf[f"fwd{h}"] = g["close"].shift(-h) / etf["close"] - 1.0
        u_now = pd.to_numeric(etf["etfUnderlyingIndexClose"], errors="coerce").where(
            pd.to_numeric(etf["etfUnderlyingIndexClose"], errors="coerce") > 0
        )
        u_future = g["etfUnderlyingIndexClose"].shift(-h)
        u_future = pd.to_numeric(u_future, errors="coerce").where(pd.to_numeric(u_future, errors="coerce") > 0)
        u_fwd = u_future / u_now - 1.0
        etf[f"excess{h}"] = (etf[f"fwd{h}"] - u_fwd).replace([np.inf, -np.inf], np.nan)

    # Stable research window; 2026 is partial and is still reported separately.
    eligible = etf[(etf["date"] >= "2018-01-01") & etf["technical"].notna() & etf["health"].notna()].copy()
    eligible["plain"] = ~(eligible["isLeveraged"].fillna(False) | eligible["isInverse"].fillna(False))

    result = {
        "version": "ETF Screener V0 M0-vs-M1 research v1",
        "asOfDate": str(etf["date"].max()),
        "design": {
            "M0": "Technical 55 + current Priority 15 (Stock Rotation included) + fee-excluded ETF Health 15 + current Stock Market/Sector 15",
            "M1": "Technical 55 + Priority 15 with Rotation removed + same fee-excluded ETF Health 15 + ETF-native RS/Velocity/Breadth/Underlying-Regime 15",
            "M1Block": {
                "relativeStrength": "6/15: own-underlying-index RS20/60/120 peer percentiles",
                "velocity": "4/15: ΔRS20 5D, ΔRS20 10D, ΔRS60 10D peer percentiles",
                "peerBreadth": "3/15: Close>MA20, MA20>MA60, RS20>0 peer breadth",
                "underlyingRegime": "2/15: underlying close>MA60 and underlying MA20>MA60",
                "peerFallback": "sectorCode peers; MARKET_IDX/ETC use broad asset-class peers; peer size <3 falls back to whole-ETF cross-section",
            },
            "health": "AUM 30 + 20D ETF trading value 20 + derived premium/discount 20 + plain structure 10; total fee excluded",
            "derivedPremium": "(KRX ETF market cap / listed units) / NAV - 1; used only for historical health score",
            "primaryBenchmark": "each ETF underlying index close",
            "horizons": HORIZONS,
            "thresholds": THRESHOLDS,
            "caveat": "Current-list based 393 ETF history remains subject to unresolved survivorship bias; no parameter tuning was performed on forward returns.",
        },
        "data": {
            "stockRows": int(len(stock)),
            "stockSymbols": int(stock["symbol"].nunique()),
            "etfRows": int(len(etf)),
            "etfSymbols": int(etf["symbol"].nunique()),
            "eligibleRows": int(len(eligible)),
            "plainEligibleRows": int(eligible["plain"].sum()),
            "underlyingCoverage": float(etf["etfUnderlyingIndexClose"].notna().mean()),
            "m0Coverage": float(etf["scoreM0"].notna().mean()),
            "m1Coverage": float(etf["scoreM1"].notna().mean()),
        },
        "all": {
            "M0": summarize_slice(eligible, "scoreM0", "M0 all ETFs"),
            "M1": summarize_slice(eligible, "scoreM1", "M1 all ETFs"),
        },
        "plain": {
            "M0": summarize_slice(eligible[eligible["plain"]], "scoreM0", "M0 plain ETFs"),
            "M1": summarize_slice(eligible[eligible["plain"]], "scoreM1", "M1 plain ETFs"),
        },
    }

    out = Path(a.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    compact = {
        "output": str(out),
        "asOfDate": result["asOfDate"],
        "data": result["data"],
        "plain": {
            m: {
                "onset80": result["plain"][m]["onsets"]["80"],
                "state80": result["plain"][m]["states"]["80"],
                "monotonicity": result["plain"][m]["monotonicity"],
                "yearlyOnset80": result["plain"][m]["yearlyOnset80"],
            } for m in ["M0","M1"]
        }
    }
    print(json.dumps(compact, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
