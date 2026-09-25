from __future__ import annotations

import argparse, json, math, os
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

import duckdb
import numpy as np
import pandas as pd

import research_us33_entry_exit_phases as base

TRAIN_END = pd.Timestamp("2022-12-31")
TEST_START = pd.Timestamp("2023-01-01")
ROUND_TRIP_COST = 0.003
ONE_WAY_COST = ROUND_TRIP_COST / 2.0
LIQUIDITY_FLOOR = 0.10
VOL_TARGET = 0.15

ARCH = {
    "AGGRESSIVE": {"entry":0.80,"exit":0.70,"architecture":"M+B+T"},
    "BALANCED": {"entry":0.80,"exit":0.50,"architecture":"M+B+V"},
}
HOLDINGS = [10,15,20]
SECTOR_CAPS = [2,3,4]
SIZINGS = ["EW","VOL60_T15"]

@dataclass(frozen=True)
class Config:
    label: str
    entry_cut: float
    exit_cut: float
    architecture: str
    max_positions: int
    sector_cap: int
    sizing: str
    stage: str

    @property
    def config_id(self):
        return (
            f"{self.stage}__{self.label}__E{int(self.entry_cut*100)}_X{int(self.exit_cut*100)}"
            f"__N{self.max_positions}_SC{self.sector_cap}__{self.sizing}"
        )

    def to_dict(self):
        d=asdict(self); d["configId"]=self.config_id; return d

@dataclass
class Position:
    symbol: str
    sector: str
    entry_signal_date: pd.Timestamp
    entry_date: pd.Timestamp
    entry_rank: float
    cumulative_return: float = 1.0
    holding_intervals: int = 0

@dataclass
class State:
    config: Config
    positions: dict[str,Position] = field(default_factory=dict)
    weights: dict[str,float] = field(default_factory=dict)
    cash_weight: float = 1.0
    daily: list[dict[str,Any]] = field(default_factory=list)
    trades: list[dict[str,Any]] = field(default_factory=list)
    attribution: dict[str,dict[str,float]] = field(default_factory=dict)
    equity: float = 1.0
    last_exit_dt: pd.Timestamp|None = None

def sf(v):
    try: x=float(v)
    except: return None
    return x if math.isfinite(x) else None

def arch_mask(g, arch):
    mask=pd.Series(True,index=g.index)
    if "+B" in arch: mask &= g["dr_beta60_spy"].fillna(-np.inf)>=0.90
    if "+T" in arch: mask &= g["dr_ichimoku_tk_gap"].fillna(-np.inf)>=0.80
    if "+V" in arch: mask &= g["dr_relvol1_20"].fillna(-np.inf)>=0.80
    return mask

def candidate_sort(g, arch):
    cols=["mom_pct"]; asc=[False]
    if "+B" in arch: cols.append("dr_beta60_spy"); asc.append(False)
    if "+T" in arch: cols.append("dr_ichimoku_tk_gap"); asc.append(False)
    if "+V" in arch: cols.append("dr_relvol1_20"); asc.append(False)
    cols.append("symbol"); asc.append(True)
    return g.sort_values(cols,ascending=asc)

def target_weights(indexed, symbols, sizing):
    if not symbols: return {}
    if sizing=="EW":
        return {s:1.0/len(symbols) for s in symbols}
    raw={}
    for s in symbols:
        row=indexed.loc[s]
        if isinstance(row,pd.DataFrame): row=row.iloc[0]
        vol=row.get("vol60_ann")
        mult=1.0 if pd.isna(vol) or float(vol)<=0 else float(np.clip(VOL_TARGET/float(vol),0.5,1.5))
        raw[s]=mult
    total=sum(raw.values())
    return {s:v/total for s,v in raw.items()}

def process_day(state: State, g: pd.DataFrame, previous_rank: dict[str,float|None]):
    cfg=state.config
    g=g.copy()
    signal_dt=pd.Timestamp(g["signal_dt"].iloc[0])
    entry_dt=pd.Timestamp(g["entry_dt"].iloc[0])
    exit_dt=pd.Timestamp(g["exit_dt"].iloc[0])
    state.last_exit_dt=exit_dt
    indexed=g.set_index("symbol",drop=False)

    exited=[]
    for s in list(state.positions):
        row=indexed.loc[s] if s in indexed.index else None
        if isinstance(row,pd.DataFrame): row=row.iloc[0]
        if row is None or pd.isna(row.get("mom_pct")) or float(row.get("mom_pct"))<cfg.exit_cut:
            exited.append((s,"RANK_EXIT" if row is not None else "DATA_MISSING"))

    for s,reason in exited:
        meta=state.positions.pop(s)
        row=indexed.loc[s] if s in indexed.index else None
        if isinstance(row,pd.DataFrame): row=row.iloc[0]
        state.trades.append({
            **cfg.to_dict(),"symbol":s,"sectorCode":meta.sector,
            "entrySignalDate":meta.entry_signal_date,"entryDate":meta.entry_date,
            "exitSignalDate":signal_dt,"exitDate":entry_dt,
            "entryRank":meta.entry_rank,"exitRank":sf(row.get("mom_pct")) if row is not None else None,
            "holdingIntervals":meta.holding_intervals,
            "grossTradeReturn":meta.cumulative_return-1.0,
            "exitReason":reason,
        })

    sector_counts={}
    for s,meta in state.positions.items():
        sector_counts[meta.sector]=sector_counts.get(meta.sector,0)+1

    pool=g[
        (g["mom_pct"].fillna(-np.inf)>=cfg.entry_cut)
        & (g["dr_log_dollarvol20"].fillna(-np.inf)>=LIQUIDITY_FLOOR)
        & (g["dr_amihud20"].fillna(-np.inf)>=LIQUIDITY_FLOOR)
    ].copy()
    prev=pool["symbol"].astype(str).map(previous_rank)
    onset=(prev.isna() | (prev<cfg.entry_cut))
    pool=pool[onset & arch_mask(pool,cfg.architecture)]
    pool=candidate_sort(pool,cfg.architecture)

    entries=[]
    for _,row in pool.iterrows():
        if len(state.positions)>=cfg.max_positions: break
        s=str(row.symbol)
        if s in state.positions: continue
        sec=str(row.sectorCode)
        if sector_counts.get(sec,0)>=cfg.sector_cap: continue
        state.positions[s]=Position(s,sec,signal_dt,entry_dt,float(row.mom_pct))
        sector_counts[sec]=sector_counts.get(sec,0)+1
        entries.append(s)

    symbols=list(state.positions)
    membership_changed=bool(exited or entries) or set(state.weights)!=set(symbols)
    if membership_changed:
        tgt=target_weights(indexed,symbols,cfg.sizing)
    else:
        tgt={s:state.weights.get(s,0.0) for s in symbols}
        total=sum(tgt.values())
        if total>0:
            tgt={s:w/total for s,w in tgt.items()}

    all_syms=set(state.weights)|set(tgt)
    abs_delta={s:abs(tgt.get(s,0)-state.weights.get(s,0)) for s in all_syms}
    turnover=sum(abs_delta.values())
    cost_rate=ONE_WAY_COST*turnover
    equity_start=state.equity
    cost_dollar=equity_start*cost_rate
    invested_equity=equity_start*(1-cost_rate)

    gross_ret=0.0
    realized={}
    missing=0.0
    for s,w in tgt.items():
        row=indexed.loc[s] if s in indexed.index else None
        if isinstance(row,pd.DataFrame): row=row.iloc[0]
        rr=row.get("o2o_ret") if row is not None else np.nan
        if pd.isna(rr):
            rr=0.0; missing+=w
        rr=float(rr); realized[s]=rr; gross_ret += w*rr

    # Exact dollar P&L attribution under engine accounting.
    if turnover>0:
        for s,dw in abs_delta.items():
            if dw<=0: continue
            a=state.attribution.setdefault(s,{"grossPnl":0.0,"cost":0.0,"netPnl":0.0,"daysHeld":0.0})
            c=cost_dollar*(dw/turnover)
            a["cost"] += c; a["netPnl"] -= c
    for s,w in tgt.items():
        a=state.attribution.setdefault(s,{"grossPnl":0.0,"cost":0.0,"netPnl":0.0,"daysHeld":0.0})
        pnl=invested_equity*w*realized.get(s,0.0)
        a["grossPnl"] += pnl; a["netPnl"] += pnl; a["daysHeld"] += 1

    net_ret=(1-cost_rate)*(1+gross_ret)-1
    state.equity=equity_start*(1+net_ret)

    denom=1+gross_ret
    if denom>0:
        state.weights={s:w*(1+realized.get(s,0.0))/denom for s,w in tgt.items()}
    else:
        state.weights={}
    state.cash_weight=max(0.0,1-sum(state.weights.values()))

    for s,meta in state.positions.items():
        meta.cumulative_return*=1+realized.get(s,0.0)
        meta.holding_intervals+=1

    spy=g["spy_return"].dropna()
    state.daily.append({
        **cfg.to_dict(),"signalDate":signal_dt,"entryDate":entry_dt,"exitDate":exit_dt,
        "grossReturn":gross_ret,"netReturn":net_ret,
        "spyReturn":float(spy.iloc[0]) if len(spy) else 0.0,
        "turnover":turnover,"costRate":cost_rate,
        "positions":len(tgt),"entries":len(entries),"exits":len(exited),
        "missingReturnWeight":missing,"equity":state.equity,
    })

def finalize(state:State):
    if not state.daily: return
    if state.weights:
        turnover=sum(state.weights.values())
        cost=state.equity*ONE_WAY_COST*turnover
        for s,w in state.weights.items():
            a=state.attribution.setdefault(s,{"grossPnl":0.0,"cost":0.0,"netPnl":0.0,"daysHeld":0.0})
            c=cost*(w/turnover) if turnover else 0
            a["cost"]+=c; a["netPnl"]-=c
        state.equity-=cost
        last=state.daily[-1]
        last["netReturn"]=(1+last["netReturn"])*(1-ONE_WAY_COST*turnover)-1
        last["turnover"]+=turnover; last["costRate"]+=ONE_WAY_COST*turnover
        last["equity"]=state.equity
    for s,meta in list(state.positions.items()):
        state.trades.append({
            **state.config.to_dict(),"symbol":s,"sectorCode":meta.sector,
            "entrySignalDate":meta.entry_signal_date,"entryDate":meta.entry_date,
            "exitSignalDate":pd.Timestamp(state.daily[-1]["signalDate"]),
            "exitDate":state.last_exit_dt,"entryRank":meta.entry_rank,"exitRank":None,
            "holdingIntervals":meta.holding_intervals,"grossTradeReturn":meta.cumulative_return-1,
            "exitReason":"END_OF_SAMPLE"
        })

def stats_for_window(daily, start=None, end=None):
    d=daily.copy()
    dates=pd.to_datetime(d["entryDate"])
    if start is not None: d=d[dates>=pd.Timestamp(start)]
    if end is not None: d=d[dates<=pd.Timestamp(end)]
    if d.empty: return {}
    return base.series_stats(d["netReturn"]) | {
        "spyCAGR":base.series_stats(d["spyReturn"])["CAGR"],
        "annualTurnover":float(d["turnover"].sum()/(len(d)/252)),
        "avgPositions":float(d["positions"].mean()),
    }

def score_train(summary):
    x=summary.copy()
    x["rankSharpe"]=x.trainSharpe.rank(pct=True)
    x["rankCAGR"]=x.trainCAGR.rank(pct=True)
    x["rankMDD"]=(-x.trainMDD.abs()).rank(pct=True)
    x["rankTurn"]=(-x.trainAnnualTurnover).rank(pct=True)
    x["trainScore"]=0.4*x.rankSharpe+0.3*x.rankCAGR+0.2*x.rankMDD+0.1*x.rankTurn
    return x.sort_values(["trainScore","trainSharpe","trainCAGR"],ascending=False)

def prepare(con,panel,input_root,sector_map,outdir):
    outdir.mkdir(parents=True,exist_ok=True)
    panelq=str(panel).replace("'","''"); secq=str(sector_map).replace("'","''")
    bench=str(input_root/"benchmark"/"us_benchmarks_adjusted.parquet").replace("'","''")
    for year in range(2017,2027):
        pxs=[input_root/"canonical"/f"year={year}"/"us_stock_daily.parquet"]
        nxt=input_root/"canonical"/f"year={year+1}"/"us_stock_daily.parquet"
        if nxt.exists(): pxs.append(nxt)
        plist=",".join("'" + str(p).replace("'","''") + "'" for p in pxs)
        outq=str(outdir/f"year={year}.parquet").replace("'","''")
        con.execute(f"""
        COPY (
          WITH px AS (
            SELECT CAST(symbol AS VARCHAR) symbol, CAST(tradeDateUsEastern AS DATE) dt, CAST(open AS DOUBLE) open
            FROM read_parquet([{plist}], union_by_name=true)
          ), b AS (
            SELECT CAST(dt AS DATE) dt, CAST(spy_close AS DOUBLE) spy_close FROM read_parquet('{bench}')
          ), cal AS (
            SELECT dt, LEAD(dt,1) OVER(ORDER BY dt) entry_dt, LEAD(dt,2) OVER(ORDER BY dt) exit_dt FROM b
          ), sig AS (
            SELECT symbol, CAST(dt AS DATE) signal_dt, mom_pct, ret120, ret252,
                   vol60_ann, dr_beta60_spy, dr_ichimoku_tk_gap, dr_relvol1_20,
                   dr_log_dollarvol20, dr_amihud20
            FROM read_parquet('{panelq}') WHERE YEAR(dt)={year} AND mom_pct IS NOT NULL
          ), sm AS (
            SELECT symbol, sectorCode, confidenceGrade FROM read_csv_auto('{secq}',header=true)
          )
          SELECT s.*,c.entry_dt,c.exit_dt,sm.sectorCode,sm.confidenceGrade,
                 CASE WHEN p1.open IS NULL OR p2.open IS NULL OR p1.open=0 THEN NULL ELSE p2.open/p1.open-1 END o2o_ret,
                 CASE WHEN b1.spy_close IS NULL OR b2.spy_close IS NULL OR b1.spy_close=0 THEN NULL ELSE b2.spy_close/b1.spy_close-1 END spy_return
          FROM sig s JOIN cal c ON c.dt=s.signal_dt JOIN sm USING(symbol)
          LEFT JOIN px p1 ON p1.symbol=s.symbol AND p1.dt=c.entry_dt
          LEFT JOIN px p2 ON p2.symbol=s.symbol AND p2.dt=c.exit_dt
          LEFT JOIN b b1 ON b1.dt=c.entry_dt LEFT JOIN b b2 ON b2.dt=c.exit_dt
          WHERE c.entry_dt IS NOT NULL AND c.exit_dt IS NOT NULL
          ORDER BY signal_dt,symbol
        ) TO '{outq}' (FORMAT PARQUET,COMPRESSION ZSTD,ROW_GROUP_SIZE 50000)
        """)

def stream(con,dir):
    for p in sorted(dir.glob("year=*.parquet")):
        reader=con.execute(f"SELECT * FROM read_parquet('{str(p).replace("'","''")}') ORDER BY signal_dt,symbol").fetch_record_batch(100000)
        pending=pd.DataFrame()
        for batch in reader:
            ch=batch.to_pandas()
            if len(pending): ch=pd.concat([pending,ch],ignore_index=True)
            last=ch.signal_dt.iloc[-1]
            comp=ch[ch.signal_dt!=last]; pending=ch[ch.signal_dt==last].copy()
            for _,g in comp.groupby("signal_dt",sort=False): yield g
        if len(pending):
            for _,g in pending.groupby("signal_dt",sort=False): yield g

def run(con,prepared,configs):
    states={c.config_id:State(c) for c in configs}
    prev={}
    for i,g in enumerate(stream(con,prepared),1):
        for st in states.values(): process_day(st,g,prev)
        for r in g.itertuples(index=False): prev[str(r.symbol)]=sf(r.mom_pct)
        if i%250==0: print(json.dumps({"dates":i,"configs":len(configs)}))
    for st in states.values(): finalize(st)
    rows=[]
    for st in states.values():
        d=pd.DataFrame(st.daily)
        tr=stats_for_window(d,end=TRAIN_END)
        te=stats_for_window(d,start=TEST_START)
        full=stats_for_window(d)
        rows.append({
            **st.config.to_dict(),
            "trainCAGR":tr.get("CAGR"),"trainSharpe":tr.get("Sharpe"),"trainMDD":tr.get("MDD"),
            "trainAnnualTurnover":tr.get("annualTurnover"),"trainAvgPositions":tr.get("avgPositions"),
            "testCAGR":te.get("CAGR"),"testSharpe":te.get("Sharpe"),"testMDD":te.get("MDD"),
            "testSpyCAGR":te.get("spyCAGR"),
            "testExcessCAGR":(te.get("CAGR")-te.get("spyCAGR")) if te.get("CAGR") is not None else None,
            "testAnnualTurnover":te.get("annualTurnover"),"testAvgPositions":te.get("avgPositions"),
            "fullCAGR":full.get("CAGR"),"fullSharpe":full.get("Sharpe"),"fullMDD":full.get("MDD"),
            "fullAnnualTurnover":full.get("annualTurnover"),
        })
    return states,pd.DataFrame(rows)

def attribution_frame(state):
    total_net=state.equity-1.0
    rows=[]
    sector_map={s:m.sector for s,m in state.positions.items()}
    for t in state.trades: sector_map.setdefault(t["symbol"],t["sectorCode"])
    for s,a in state.attribution.items():
        rows.append({
            "configId":state.config.config_id,"symbol":s,"sectorCode":sector_map.get(s),
            **a,"shareOfFinalNetPnl":a["netPnl"]/total_net if total_net!=0 else None
        })
    return pd.DataFrame(rows).sort_values("netPnl",ascending=False)

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--panel",required=True); ap.add_argument("--input-root",required=True)
    ap.add_argument("--sector-map",required=True); ap.add_argument("--output",required=True)
    ap.add_argument("--memory-limit",default="4GB")
    a=ap.parse_args()
    out=Path(a.output).resolve(); out.mkdir(parents=True,exist_ok=True)
    tmp=Path(os.environ.get("RUNNER_TEMP",str(out/".tmp")))/"us33-stage4"; tmp.mkdir(parents=True,exist_ok=True)
    con=duckdb.connect(str(tmp/"stage4.duckdb")); con.execute(f"SET memory_limit='{a.memory_limit}'"); con.execute("SET threads=1"); con.execute("SET preserve_insertion_order=false")
    prepared=tmp/"prepared"; prepare(con,Path(a.panel).resolve(),Path(a.input_root).resolve(),Path(a.sector_map).resolve(),prepared)

    # 1-2: holdings x sector cap, EW only.
    constraint=[]
    for label,v in ARCH.items():
        for n in HOLDINGS:
            for sc in SECTOR_CAPS:
                constraint.append(Config(label,v["entry"],v["exit"],v["architecture"],n,sc,"EW","CONSTRAINT"))
    states1,res1=run(con,prepared,constraint)
    ranked1=[]
    winners={}
    for label in ARCH:
        r=score_train(res1[res1.label==label]).copy(); ranked1.append(r)
        winners[label]=r.iloc[0].to_dict()
    ranked1=pd.concat(ranked1,ignore_index=True)
    ranked1.to_csv(out/"01_02_holdings_sectorcap_results.csv",index=False)

    # 3: sizing on train-selected constraint per architecture.
    sizing=[]
    for label,w in winners.items():
        v=ARCH[label]
        for sz in SIZINGS:
            sizing.append(Config(label,v["entry"],v["exit"],v["architecture"],int(w["max_positions"]),int(w["sector_cap"]),sz,"SIZING"))
    states2,res2=run(con,prepared,sizing)
    ranked2=[]; final_cfg={}
    for label in ARCH:
        r=score_train(res2[res2.label==label]).copy(); ranked2.append(r)
        best=r.iloc[0]
        final_cfg[label]=next(c for c in sizing if c.config_id==best.configId)
    ranked2=pd.concat(ranked2,ignore_index=True)
    ranked2.to_csv(out/"03_sizing_results.csv",index=False)

    # 4: exact contribution: already tracked for final selected states.
    for label,cfg in final_cfg.items():
        st=states2[cfg.config_id]
        af=attribution_frame(st)
        af.to_csv(out/f"04_exact_pnl_attribution_{label.lower()}.csv",index=False)
        if not af.empty:
            sec=af.groupby("sectorCode",dropna=False)[["grossPnl","cost","netPnl"]].sum().sort_values("netPnl",ascending=False)
            sec["shareOfFinalNetPnl"]=sec.netPnl/(st.equity-1.0) if st.equity!=1 else np.nan
            sec.reset_index().to_csv(out/f"04_sector_pnl_attribution_{label.lower()}.csv",index=False)

    decision={
        "study":"US-3.3 Stage4 Portfolio Constraints, Sizing, Attribution",
        "trainWindow":"2017-01-01..2022-12-31",
        "holdoutWindow":"2023-01-01..2026-09",
        "selectionPrinciple":"Select holdings/sector cap on train only; then sizing on train only; report frozen-config holdout.",
        "constraintWinners":winners,
        "sizingWinners":{k:v.to_dict() for k,v in final_cfg.items()},
        "holdoutResults":{
            label:res2[res2.configId==cfg.config_id].iloc[0].to_dict()
            for label,cfg in final_cfg.items()
        },
        "pitStatus":"HOLDOUT_IS_NOT_TRUE_PIT_OOS: architecture was selected earlier on survivor-only full sample; delisted historical securities are absent.",
        "researchGrade":"SURVIVOR_ONLY_POST_SELECTION_HOLDOUT",
        "finalOosAllowed":False,
    }
    (out/"stage4_decision.json").write_text(json.dumps(decision,ensure_ascii=False,indent=2,default=str),encoding="utf-8")
    res2.to_csv(out/"03_all_sizing_raw.csv",index=False)
    print(json.dumps(decision,ensure_ascii=False,default=str))

if __name__=="__main__": main()
