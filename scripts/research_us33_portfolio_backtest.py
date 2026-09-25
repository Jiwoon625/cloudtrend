from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

STRATEGIES = {
    "M": lambda g: pd.Series(True, index=g.index),
    "M+B": lambda g: g["dr_beta60_spy"] >= 0.90,
    "M+T": lambda g: g["dr_ichimoku_tk_gap"] >= 0.80,
    "M+V": lambda g: g["dr_relvol1_20"] >= 0.80,
    "M+T+V": lambda g: (g["dr_ichimoku_tk_gap"] >= 0.80) & (g["dr_relvol1_20"] >= 0.80),
    "M+B+T": lambda g: (g["dr_beta60_spy"] >= 0.90) & (g["dr_ichimoku_tk_gap"] >= 0.80),
    "M+B+V": lambda g: (g["dr_beta60_spy"] >= 0.90) & (g["dr_relvol1_20"] >= 0.80),
}

CORE_CUTS = [0.80, 0.90]
SECTOR_MODES = ["NONE", "CAP3_FULL14"]
MAX_POSITIONS = 15
SECTOR_CAP_COUNT = 3
LIQUIDITY_RANK_FLOOR = 0.10
ROUND_TRIP_COST = 0.003
ONE_WAY_COST = ROUND_TRIP_COST / 2.0

def sf(v):
    try: v=float(v)
    except Exception: return None
    return v if math.isfinite(v) else None

def max_drawdown(returns: pd.Series) -> float:
    eq=(1+returns.fillna(0)).cumprod()
    peak=eq.cummax()
    dd=eq/peak-1
    return float(dd.min()) if len(dd) else float("nan")

def series_stats(r: pd.Series):
    r=r.fillna(0)
    n=len(r)
    if n==0:
        return dict(totalReturn=None,CAGR=None,annualizedVol=None,Sharpe=None,MDD=None,positiveDayRate=None)
    total=float((1+r).prod()-1)
    cagr=float((1+total)**(252/max(n,1))-1) if total>-1 else -1
    vol=float(r.std(ddof=1)*np.sqrt(252)) if n>1 else np.nan
    sharpe=float(r.mean()/r.std(ddof=1)*np.sqrt(252)) if n>1 and r.std(ddof=1)>0 else np.nan
    return dict(totalReturn=total,CAGR=cagr,annualizedVol=vol,Sharpe=sharpe,
                MDD=max_drawdown(r),positiveDayRate=float((r>0).mean()))

def annualized_stats(d: pd.DataFrame):
    net=series_stats(d["net_return"])
    gross=series_stats(d["gross_return"])
    spy=series_stats(d["spy_return"])
    n=len(d)
    return dict(
        days=n,
        totalReturn=net["totalReturn"],CAGR=net["CAGR"],annualizedVol=net["annualizedVol"],
        Sharpe=net["Sharpe"],MDD=net["MDD"],positiveDayRate=net["positiveDayRate"],
        grossTotalReturn=gross["totalReturn"],grossCAGR=gross["CAGR"],grossSharpe=gross["Sharpe"],
        grossMDD=gross["MDD"],
        spyTotalReturn=spy["totalReturn"],spyCAGR=spy["CAGR"],spySharpe=spy["Sharpe"],spyMDD=spy["MDD"],
        excessCAGRVsSpy=(net["CAGR"]-spy["CAGR"]) if net["CAGR"] is not None and spy["CAGR"] is not None else None,
        grossExcessCAGRVsSpy=(gross["CAGR"]-spy["CAGR"]) if gross["CAGR"] is not None and spy["CAGR"] is not None else None,
        avgDailyCost=float(d["cost"].mean()),
        annualizedCostDragApprox=float(d["cost"].mean()*252),
        avgDailyTurnover=float(d["turnover"].mean()),
        annualTurnover=float(d["turnover"].mean()*252),
        avgPositions=float(d["positions"].mean()),
        avgLowConfidencePositions=float(d["low_conf_positions"].mean()),
        avgLowConfidenceWeight=float(d["low_conf_weight"].mean()),
        avgMissingReturnWeight=float(d["missing_return_weight"].mean()),
    )

def select_names(g: pd.DataFrame, strategy: str, sector_mode: str):
    z=g[STRATEGIES[strategy](g)].copy()
    z=z.sort_values(["mom_pct","dr_beta60_spy","dr_ichimoku_tk_gap","dr_relvol1_20","symbol"],
                    ascending=[False,False,False,False,True])
    if sector_mode=="NONE":
        return z.head(MAX_POSITIONS)
    out=[]
    counts={}
    for idx,row in z.iterrows():
        sec=row["sectorCode"]
        if counts.get(sec,0)>=SECTOR_CAP_COUNT:
            continue
        out.append(idx)
        counts[sec]=counts.get(sec,0)+1
        if len(out)>=MAX_POSITIONS:
            break
    return z.loc[out] if out else z.head(0)

def run_config(candidates: pd.DataFrame, core_cut: float, strategy: str, sector_mode: str):
    prev={}
    recs=[]
    date_groups=candidates[candidates["mom_pct"]>=core_cut].groupby("signal_dt", sort=True)
    for signal_dt,g in date_groups:
        # Eligibility is point-in-time, based only on signal-date ranks.
        elig=g[(g["dr_log_dollarvol20"]>=LIQUIDITY_RANK_FLOOR) &
               (g["dr_amihud20"]>=LIQUIDITY_RANK_FLOOR)].copy()
        sel=select_names(elig,strategy,sector_mode)
        n=len(sel)
        target={} if n==0 else {s:1.0/n for s in sel["symbol"]}
        all_syms=set(prev)|set(target)
        traded=sum(abs(target.get(s,0)-prev.get(s,0)) for s in all_syms)
        cost=ONE_WAY_COST*traded

        ret_by_symbol=dict(zip(sel["symbol"],sel["o2o_ret"]))
        gross=0.0
        missing_w=0.0
        low_n=0
        low_w=0.0
        sectors={}
        for _,row in sel.iterrows():
            w=target[row.symbol]
            rr=row.o2o_ret
            if pd.isna(rr):
                missing_w += w
                rr=0.0
            gross += w*float(rr)
            if row.confidenceGrade=="C3":
                low_n += 1
                low_w += w
            sectors[row.sectorCode]=sectors.get(row.sectorCode,0)+1

        entry_dt=sel["entry_dt"].dropna().iloc[0] if n and sel["entry_dt"].notna().any() else pd.NaT
        regime=elig["market_regime"].dropna().iloc[0] if len(elig) and elig["market_regime"].notna().any() else None
        spy_return=float(elig["spy_return"].dropna().iloc[0]) if len(elig) and elig["spy_return"].notna().any() else 0.0
        recs.append(dict(
            signal_dt=signal_dt,entry_dt=entry_dt,gross_return=gross,cost=cost,net_return=gross-cost,spy_return=spy_return,
            turnover=traded,positions=n,low_conf_positions=low_n,low_conf_weight=low_w,
            missing_return_weight=missing_w,market_regime=regime,
            maxSectorCount=max(sectors.values()) if sectors else 0,
            sectorCount=len(sectors),
        ))
        prev=target
    return pd.DataFrame(recs)

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--panel",required=True)
    p.add_argument("--input-root",required=True)
    p.add_argument("--sector-map",required=True)
    p.add_argument("--output",required=True)
    p.add_argument("--threads",type=int,default=2)
    p.add_argument("--memory-limit",default="5GB")
    a=p.parse_args()

    panel=str(Path(a.panel).resolve()).replace("'","''")
    root=Path(a.input_root).resolve()
    price_glob=str(root/"canonical"/"year=*"/"us_stock_daily.parquet").replace("'","''")
    bench=str(root/"benchmark"/"us_benchmarks_adjusted.parquet").replace("'","''")
    sector_map=Path(a.sector_map).resolve()
    out=Path(a.output).resolve(); out.mkdir(parents=True,exist_ok=True)

    sm=pd.read_csv(sector_map)
    if len(sm)!=5032 or sm.symbol.nunique()!=5032 or sm.sectorCode.nunique()!=14:
        raise RuntimeError(f"sector map QA failed rows={len(sm)} unique={sm.symbol.nunique()} sectors={sm.sectorCode.nunique()}")

    con=duckdb.connect()
    con.execute(f"SET threads={a.threads}")
    con.execute(f"SET memory_limit='{a.memory_limit}'")
    con.execute("CREATE TABLE sector_map AS SELECT * FROM read_csv_auto(?)",[str(sector_map)])

    # Create global market calendar and next-open return, then join to signal-date features.
    q=f"""
    WITH px AS (
      SELECT CAST(symbol AS VARCHAR) symbol, CAST(tradeDateUsEastern AS DATE) dt, CAST(open AS DOUBLE) open
      FROM read_parquet('{price_glob}', union_by_name=true)
    ),
    cal AS (
      SELECT dt,
             LEAD(dt,1) OVER(ORDER BY dt) entry_dt,
             LEAD(dt,2) OVER(ORDER BY dt) exit_dt
      FROM (SELECT DISTINCT dt FROM px)
    ),
    b AS (
      SELECT CAST(dt AS DATE) dt, CAST(spy_close AS DOUBLE) spy_close
      FROM read_parquet('{bench}')
    ),
    sig AS (
      SELECT symbol,dt AS signal_dt,market_regime,mom_pct,
             dr_beta60_spy,dr_ichimoku_tk_gap,dr_relvol1_20,
             dr_log_dollarvol20,dr_amihud20
      FROM read_parquet('{panel}')
      WHERE mom_pct>=0.80
    )
    SELECT s.*,c.entry_dt,c.exit_dt,m.sectorCode,m.mapMethod,m.confidenceGrade,m.confidence,m.mappingVersion,
           CASE WHEN p1.open IS NULL OR p2.open IS NULL OR p1.open=0 THEN NULL
                ELSE p2.open/p1.open-1 END AS o2o_ret,
           CASE WHEN b1.spy_close IS NULL OR b2.spy_close IS NULL OR b1.spy_close=0 THEN NULL
                ELSE b2.spy_close/b1.spy_close-1 END AS spy_return
    FROM sig s
    JOIN cal c ON c.dt=s.signal_dt
    JOIN sector_map m USING(symbol)
    LEFT JOIN px p1 ON p1.symbol=s.symbol AND p1.dt=c.entry_dt
    LEFT JOIN px p2 ON p2.symbol=s.symbol AND p2.dt=c.exit_dt
    LEFT JOIN b b1 ON b1.dt=c.entry_dt
    LEFT JOIN b b2 ON b2.dt=c.exit_dt
    WHERE c.entry_dt IS NOT NULL AND c.exit_dt IS NOT NULL
    ORDER BY s.signal_dt,s.symbol
    """
    candidates=con.execute(q).df()
    candidates["signal_dt"]=pd.to_datetime(candidates["signal_dt"])
    candidates["entry_dt"]=pd.to_datetime(candidates["entry_dt"])
    candidates["exit_dt"]=pd.to_datetime(candidates["exit_dt"])

    qa={
      "candidateRows":int(len(candidates)),
      "signalDates":int(candidates.signal_dt.nunique()),
      "symbols":int(candidates.symbol.nunique()),
      "sectorMapRows":int(len(sm)),
      "sectorCounts":sm.sectorCode.value_counts().to_dict(),
      "mapMethodCounts":sm.mapMethod.value_counts().to_dict(),
      "confidenceGradeCounts":sm.confidenceGrade.value_counts().to_dict(),\n      "mappingVersions":sm.mappingVersion.value_counts().to_dict() if "mappingVersion" in sm.columns else {},
      "cost":{"roundTrip":ROUND_TRIP_COST,"oneWay":ONE_WAY_COST},
      "liquidityRankFloor":LIQUIDITY_RANK_FLOOR,
      "maxPositions":MAX_POSITIONS,
      "sectorCapCount":SECTOR_CAP_COUNT,
      "researchGrade":"SURVIVOR_ONLY_EXPLORATORY",
      "finalOosAllowed":False,
    }
    (out/"qa.json").write_text(json.dumps(qa,ensure_ascii=False,indent=2),encoding="utf-8")

    summaries=[]; annual=[]; regimes=[]; daily_all=[]
    for core in CORE_CUTS:
      for strat in STRATEGIES:
        for smode in SECTOR_MODES:
          d=run_config(candidates,core,strat,smode)
          if d.empty: continue
          met=annualized_stats(d)
          rec={"coreCut":core,"strategy":strat,"sectorMode":smode,**met}
          summaries.append(rec)

          d=d.copy()
          d["coreCut"]=core; d["strategy"]=strat; d["sectorMode"]=smode
          d["year"]=d["entry_dt"].dt.year
          d["equity"]=(1+d["net_return"]).cumprod()
          daily_all.append(d)

          for yr,g in d.groupby("year"):
              annual.append({"coreCut":core,"strategy":strat,"sectorMode":smode,"year":int(yr),
                             "return":float((1+g.net_return).prod()-1),
                             "turnover":float(g.turnover.sum()),
                             "avgPositions":float(g.positions.mean())})
          for rg,g in d.groupby("market_regime",dropna=False):
              regimes.append({"coreCut":core,"strategy":strat,"sectorMode":smode,
                              "marketRegime":str(rg),"days":len(g),
                              "meanDailyReturn":float(g.net_return.mean()),
                              "annualizedApprox":float(g.net_return.mean()*252),
                              "positiveDayRate":float((g.net_return>0).mean())})

    sdf=pd.DataFrame(summaries).sort_values(["sectorMode","Sharpe","CAGR"],ascending=[True,False,False])
    sdf.to_csv(out/"strategy_summary.csv",index=False)
    pd.DataFrame(annual).to_csv(out/"annual_returns.csv",index=False)
    pd.DataFrame(regimes).to_csv(out/"regime_summary.csv",index=False)
    pd.concat(daily_all,ignore_index=True).to_parquet(out/"daily_portfolio.parquet",index=False)

    # Architecture deltas caused by sector cap.
    piv=sdf.pivot_table(index=["coreCut","strategy"],columns="sectorMode",
                        values=["CAGR","Sharpe","MDD","annualTurnover","avgPositions","avgLowConfidenceWeight"])
    piv.columns=["__".join(c) for c in piv.columns]
    piv.reset_index().to_csv(out/"sector_cap_sensitivity.csv",index=False)

    primary=sdf[sdf.sectorMode=="CAP3_FULL14"].copy()
    summary={
      "study":"CloudTrend US-3.3 Actual Portfolio Backtest — Stage 2A/2B",
      "execution":"t close signal -> t+1 open rebalance -> next open return",
      "strategies":list(STRATEGIES),
      "coreCuts":CORE_CUTS,
      "primarySectorMode":"CAP3_FULL14",
      "sensitivitySectorMode":"NONE",
      "topPrimaryBySharpe":primary.sort_values(["Sharpe","CAGR"],ascending=False).head(10).to_dict(orient="records"),
      "topPrimaryByCAGR":primary.sort_values(["CAGR","Sharpe"],ascending=False).head(10).to_dict(orient="records"),
      "limitations":[
        "Current survivor-only universe; production decision prohibited.",
        "Sector mapping v1 prioritizes Yahoo/yfinance sector+industry and uses the prior map only as an explicit fallback; SEC SIC cross-check is used when SEC access is available.",
        "This stage uses daily target rebalancing only to compare signal architecture; final entry/exit/holding rules belong to US-4/US-5."
      ]
    }
    (out/"summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2,default=str),encoding="utf-8")
    print(json.dumps({"ok":True,"configs":len(sdf),"qa":qa,
                      "primaryTop":summary["topPrimaryBySharpe"][:3]},ensure_ascii=False,default=str))

if __name__=="__main__":
    main()
