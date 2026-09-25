from __future__ import annotations

import argparse
import json
import math
from itertools import combinations
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

MOM_CUTS=[0.80,0.90,0.95]
CONF_CUTS=[0.50,0.60,0.70,0.80,0.90]
HORIZONS=[120,252]
PERIODS=["EARLY_2017_2019","MID_2020_2022","RECENT_2023_2026"]

BLOCK_DEDUP={
 "TECHNICAL":["ret120","ret252","ma120_gap","high252_gap","donchian20_gap","ichimoku_tk_gap","efficiency20","up_day_pct20"],
 "RELATIVE_STRENGTH":["rs_spy20","rs_spy60","rs_spy120","rs_accel_spy"],
 "VOLUME_LIQUIDITY":["relvol1_20","log_dollarvol20","amihud20","price_volume5"],
 "RISK_QUALITY":["vol60_ann","drawdown60","beta60_spy","residual_mom60","gap_vol20_ann","tail_loss20"],
}

def parse_args():
    p=argparse.ArgumentParser()
    p.add_argument("--panel",required=True)
    p.add_argument("--registry",required=True)
    p.add_argument("--input-root",required=True)
    p.add_argument("--output",required=True)
    p.add_argument("--threads",type=int,default=2)
    p.add_argument("--memory-limit",default="5GB")
    return p.parse_args()

def sf(v):
    try: v=float(v)
    except: return None
    return v if math.isfinite(v) else None

def mean_or_none(s):
    s=pd.Series(s).dropna()
    return sf(s.mean()) if len(s) else None

def metrics_from_daily(d, retcol, basecol, univcol, spycol, countcol):
    z=d[d[countcol].fillna(0)>0].copy()
    if z.empty:
        return dict(days=0,meanSelectedN=None,meanReturn=None,meanExcessUniverse=None,meanExcessSpy=None,
                    deltaVsBaseline=None,positiveExcessUniverse=None)
    return dict(
      days=int(len(z)),
      meanSelectedN=sf(z[countcol].mean()),
      meanReturn=sf(z[retcol].mean()),
      meanExcessUniverse=sf((z[retcol]-z[univcol]).mean()),
      meanExcessSpy=sf((z[retcol]-z[spycol]).mean()),
      deltaVsBaseline=sf((z[retcol]-z[basecol]).mean()) if basecol in z else None,
      positiveExcessUniverse=sf(((z[retcol]-z[univcol])>0).mean()),
    )

def add_periods(rec,d,retcol,basecol,countcol):
    pos=0
    for p in PERIODS:
        z=d[(d["period_bucket"]==p)&(d[countcol].fillna(0)>0)]
        val=sf((z[retcol]-z[basecol]).mean()) if len(z) else None
        rec[f"delta_{p}"]=val
        if val is not None and val>0: pos+=1
    rec["periodPositiveCount"]=pos

def feature_daily(con,panel,feat):
    combo_cols=[]
    for h in HORIZONS:
      for m in MOM_CUTS:
        tagm=int(m*100)
        combo_cols.append(f"AVG(CASE WHEN mom_pct>={m} THEN fwd_ret_{h} END) AS base_m{tagm}_r{h}")
        combo_cols.append(f"COUNT(*) FILTER(WHERE mom_pct>={m} AND fwd_ret_{h} IS NOT NULL) AS base_m{tagm}_n{h}")
        for q in CONF_CUTS:
          tagq=int(q*100)
          combo_cols.append(f"AVG(CASE WHEN mom_pct>={m} AND dr_{feat}>={q} THEN fwd_ret_{h} END) AS m{tagm}_q{tagq}_r{h}")
          combo_cols.append(f"COUNT(*) FILTER(WHERE mom_pct>={m} AND dr_{feat}>={q} AND fwd_ret_{h} IS NOT NULL) AS m{tagm}_q{tagq}_n{h}")
      combo_cols += [
        f"CORR(dr_{feat},target_pct_{h}) AS rankic_{h}",
        f"AVG(CASE WHEN dr_{feat}>=0.90 THEN fwd_ret_{h} END) AS stand10_r{h}",
        f"COUNT(*) FILTER(WHERE dr_{feat}>=0.90 AND fwd_ret_{h} IS NOT NULL) AS stand10_n{h}",
        f"AVG(CASE WHEN dr_{feat}>=0.80 THEN fwd_ret_{h} END) AS stand20_r{h}",
        f"AVG(fwd_ret_{h}) AS univ_r{h}",
        f"ANY_VALUE(spy_fwd_{h}) AS spy_r{h}",
      ]
    sql=f"""
      SELECT dt,period_bucket,market_regime,growth_regime,smallcap_regime,
             {",".join(combo_cols)}
      FROM read_parquet('{panel}')
      GROUP BY dt,period_bucket,market_regime,growth_regime,smallcap_regime
      ORDER BY dt
    """
    return con.execute(sql).df()

def natural_daily(con,panel,feat):
    cols=[]
    for h in HORIZONS:
      for mode,cond in [
        ("state",f"nat_{feat}=1"),
        ("onset",f"nat_{feat}=1 AND COALESCE(prev_nat,0)=0"),
        ("mom10_state",f"mom_pct>=0.90 AND nat_{feat}=1"),
        ("mom10_onset",f"mom_pct>=0.90 AND nat_{feat}=1 AND COALESCE(prev_nat,0)=0"),
      ]:
        cols += [
          f"AVG(CASE WHEN {cond} THEN fwd_ret_{h} END) AS {mode}_r{h}",
          f"COUNT(*) FILTER(WHERE {cond} AND fwd_ret_{h} IS NOT NULL) AS {mode}_n{h}",
        ]
      cols += [
        f"AVG(CASE WHEN mom_pct>=0.90 THEN fwd_ret_{h} END) AS base_r{h}",
        f"AVG(fwd_ret_{h}) AS univ_r{h}",
        f"ANY_VALUE(spy_fwd_{h}) AS spy_r{h}",
      ]
    sql=f"""
      WITH x AS (
        SELECT *,LAG(nat_{feat}) OVER(PARTITION BY symbol ORDER BY dt) AS prev_nat
        FROM read_parquet('{panel}')
      )
      SELECT dt,period_bucket,market_regime,growth_regime,smallcap_regime,
             {",".join(cols)}
      FROM x
      GROUP BY dt,period_bucket,market_regime,growth_regime,smallcap_regime
      ORDER BY dt
    """
    return con.execute(sql).df()

def eval_score(con,panel,name,expr):
    rows=[]
    for h in HORIZONS:
      d=con.execute(f"""
        WITH s AS (
          SELECT dt,period_bucket,({expr}) AS score,fwd_ret_{h} AS target,spy_fwd_{h} AS spy,
                 target_pct_{h} AS target_pct
          FROM read_parquet('{panel}')
          WHERE fwd_ret_{h} IS NOT NULL
        ), r AS (
          SELECT *,PERCENT_RANK() OVER(PARTITION BY dt ORDER BY score) score_pct
          FROM s
        )
        SELECT dt,period_bucket,
          CORR(score_pct,target_pct) rank_ic,
          AVG(CASE WHEN score_pct>=0.90 THEN target END) top10,
          COUNT(*) FILTER(WHERE score_pct>=0.90) top10_n,
          AVG(CASE WHEN score_pct>=0.80 THEN target END) top20,
          AVG(target) univ,ANY_VALUE(spy) spy
        FROM r GROUP BY dt,period_bucket ORDER BY dt
      """).df()
      rec={"model":name,"horizon":h,"meanRankIC":sf(d.rank_ic.mean()),
           "meanTop10ExcessUniverse":sf((d.top10-d.univ).mean()),
           "meanTop10ExcessSpy":sf((d.top10-d.spy).mean()),
           "meanTop20ExcessUniverse":sf((d.top20-d.univ).mean()),
           "meanTop10N":sf(d.top10_n.mean()),
           "positiveTop10ExcessUniverse":sf(((d.top10-d.univ)>0).mean())}
      for p in PERIODS:
        z=d[d.period_bucket==p]
        rec[f"top10Excess_{p}"]=sf((z.top10-z.univ).mean()) if len(z) else None
      rows.append(rec)
    return rows

def select_unique_top(df,block,corr):
    z=df[(df.block==block)&(df.horizon==252)&(df.momCut==0.90)].copy()
    z=z.sort_values(["periodPositiveCount","deltaVsBaseline"],ascending=[False,False])
    picked=[]
    for _,r in z.iterrows():
      f=r.feature
      if r.meanSelectedN is None or r.meanSelectedN<20: continue
      duplicate=False
      for p in picked:
        a=corr[((corr.featureA==f)&(corr.featureB==p))|((corr.featureA==p)&(corr.featureB==f))]
        if len(a) and float(a.absCorr.max())>=0.95:
          duplicate=True; break
      if not duplicate:
        picked.append(f)
      if len(picked)>=2: break
    return picked

def main():
    a=parse_args()
    panel=str(Path(a.panel).resolve()).replace("'","''")
    out=Path(a.output).resolve(); out.mkdir(parents=True,exist_ok=True)
    reg=pd.read_csv(a.registry)
    features=reg.feature.tolist()
    block_map=dict(zip(reg.feature,reg.block))
    root=Path(a.input_root).resolve()
    turnover=pd.read_csv(root/"results"/"turnover_summary.csv") if (root/"results"/"turnover_summary.csv").exists() else pd.DataFrame()
    corr=pd.read_csv(root/"results"/"feature_redundancy_pairs.csv") if (root/"results"/"feature_redundancy_pairs.csv").exists() else pd.DataFrame()

    con=duckdb.connect()
    con.execute(f"SET memory_limit='{a.memory_limit}'")
    con.execute(f"SET threads={a.threads}")

    standalone=[]; grid=[]; natural=[]; regime=[]; daily_best={}
    for i,feat in enumerate(features,1):
      d=feature_daily(con,panel,feat)
      for h in HORIZONS:
        rec={"feature":feat,"block":block_map[feat],"horizon":h,
             "meanRankIC":sf(d[f"rankic_{h}"].mean()),
             "meanTop10Return":sf(d[f"stand10_r{h}"].mean()),
             "meanTop10ExcessUniverse":sf((d[f"stand10_r{h}"]-d[f"univ_r{h}"]).mean()),
             "meanTop10ExcessSpy":sf((d[f"stand10_r{h}"]-d[f"spy_r{h}"]).mean()),
             "meanTop20ExcessUniverse":sf((d[f"stand20_r{h}"]-d[f"univ_r{h}"]).mean())}
        for p in PERIODS:
          z=d[d.period_bucket==p]
          rec[f"top10Excess_{p}"]=sf((z[f"stand10_r{h}"]-z[f"univ_r{h}"]).mean()) if len(z) else None
        standalone.append(rec)

        feat_grid=[]
        for m in MOM_CUTS:
          tm=int(m*100)
          for q in CONF_CUTS:
            tq=int(q*100); rc=f"m{tm}_q{tq}_r{h}"; nc=f"m{tm}_q{tq}_n{h}"; bc=f"base_m{tm}_r{h}"
            recg={"feature":feat,"block":block_map[feat],"horizon":h,"momCut":m,"confirmCut":q}
            recg.update(metrics_from_daily(d,rc,bc,f"univ_r{h}",f"spy_r{h}",nc))
            add_periods(recg,d,rc,bc,nc)
            grid.append(recg); feat_grid.append(recg)

        if h==252:
          cand=[x for x in feat_grid if x["momCut"]==0.90 and x["meanSelectedN"] is not None and x["meanSelectedN"]>=20]
          cand=sorted(cand,key=lambda x:(x["periodPositiveCount"],x["deltaVsBaseline"] if x["deltaVsBaseline"] is not None else -999),reverse=True)
          if cand:
            best=cand[0]; q=best["confirmCut"]; tq=int(q*100); rc=f"m90_q{tq}_r252"; nc=f"m90_q{tq}_n252"
            z=d[d[nc].fillna(0)>0].copy()
            for dim in ["market_regime","growth_regime","smallcap_regime"]:
              for key,g in z.groupby(dim):
                regime.append({"feature":feat,"block":block_map[feat],"dimension":dim,"regime":key,
                  "confirmCut":q,"days":len(g),"meanSelectedN":sf(g[nc].mean()),
                  "deltaVsBaseline":sf((g[rc]-g["base_m90_r252"]).mean()),
                  "meanExcessUniverse":sf((g[rc]-g["univ_r252"]).mean())})

      nd=natural_daily(con,panel,feat)
      for h in HORIZONS:
        for mode in ["state","onset","mom10_state","mom10_onset"]:
          rc=f"{mode}_r{h}"; nc=f"{mode}_n{h}"
          base=f"base_r{h}" if mode.startswith("mom10") else f"univ_r{h}"
          recn={"feature":feat,"block":block_map[feat],"horizon":h,"mode":mode}
          recn.update(metrics_from_daily(nd,rc,base,f"univ_r{h}",f"spy_r{h}",nc))
          add_periods(recn,nd,rc,base,nc)
          natural.append(recn)
      print(json.dumps({"feature":feat,"done":i,"total":len(features)}))

    sdf=pd.DataFrame(standalone); gdf=pd.DataFrame(grid); ndf=pd.DataFrame(natural); rdf=pd.DataFrame(regime)
    sdf.to_csv(out/"feature_standalone.csv",index=False)
    gdf.to_csv(out/"confirmation_grid.csv",index=False)
    ndf.to_csv(out/"natural_state_onset.csv",index=False)
    rdf.to_csv(out/"confirmation_regime.csv",index=False)

    # Block and full-universe composite models.
    blocks={b:reg[reg.block==b].feature.tolist() for b in reg.block.unique()}
    models={}
    for b,fs in blocks.items():
      models[f"{b}_ALL"]= "("+"+".join(f"dr_{f}" for f in fs)+f")/{len(fs)}"
      ds=BLOCK_DEDUP[b]
      models[f"{b}_DEDUP"]="("+"+".join(f"dr_{f}" for f in ds)+f")/{len(ds)}"
    models["ALL37_EQUAL"]="("+"+".join(f"dr_{f}" for f in features)+f")/{len(features)}"
    dedup=sum(BLOCK_DEDUP.values(),[])
    models["ALL_DEDUP_EQUAL"]="("+"+".join(f"dr_{f}" for f in dedup)+f")/{len(dedup)}"
    models["MOM_PLUS_4BLOCKS"]="0.50*mom_score+0.125*("+")+0.125*(".join(models[f"{b}_DEDUP"] for b in blocks)+")"
    score_rows=[]
    for name,expr in models.items():
      score_rows.extend(eval_score(con,panel,name,expr))
    pd.DataFrame(score_rows).to_csv(out/"block_composites.csv",index=False)

    # Cross-block pair confirmation: top two non-redundant signals per block from broad stage.
    shortlist={b:select_unique_top(gdf,b,corr) for b in blocks}
    (out/"pair_shortlist.json").write_text(json.dumps(shortlist,indent=2),encoding="utf-8")
    pair_rows=[]
    for b1,b2 in combinations(blocks.keys(),2):
      for f1 in shortlist[b1]:
        for f2 in shortlist[b2]:
          r1=gdf[(gdf.feature==f1)&(gdf.horizon==252)&(gdf.momCut==0.90)].sort_values(["periodPositiveCount","deltaVsBaseline"],ascending=False).iloc[0]
          r2=gdf[(gdf.feature==f2)&(gdf.horizon==252)&(gdf.momCut==0.90)].sort_values(["periodPositiveCount","deltaVsBaseline"],ascending=False).iloc[0]
          q1=float(r1.confirmCut); q2=float(r2.confirmCut)
          for h in HORIZONS:
            dd=con.execute(f"""
              SELECT dt,period_bucket,
                AVG(CASE WHEN mom_pct>=0.90 THEN fwd_ret_{h} END) base,
                AVG(CASE WHEN mom_pct>=0.90 AND dr_{f1}>={q1} AND dr_{f2}>={q2} THEN fwd_ret_{h} END) sel,
                COUNT(*) FILTER(WHERE mom_pct>=0.90 AND dr_{f1}>={q1} AND dr_{f2}>={q2} AND fwd_ret_{h} IS NOT NULL) n,
                AVG(fwd_ret_{h}) univ,ANY_VALUE(spy_fwd_{h}) spy
              FROM read_parquet('{panel}') GROUP BY dt,period_bucket ORDER BY dt
            """).df()
            z=dd[dd.n>0]
            rec={"featureA":f1,"featureB":f2,"blockA":b1,"blockB":b2,"cutA":q1,"cutB":q2,"horizon":h,
                 "days":len(z),"meanSelectedN":sf(z.n.mean()) if len(z) else None,
                 "deltaVsBaseline":sf((z.sel-z.base).mean()) if len(z) else None,
                 "meanExcessUniverse":sf((z.sel-z.univ).mean()) if len(z) else None,
                 "meanExcessSpy":sf((z.sel-z.spy).mean()) if len(z) else None}
            pos=0
            for p in PERIODS:
              zz=z[z.period_bucket==p]; val=sf((zz.sel-zz.base).mean()) if len(zz) else None
              rec[f"delta_{p}"]=val
              if val is not None and val>0: pos+=1
            rec["periodPositiveCount"]=pos; pair_rows.append(rec)
    pd.DataFrame(pair_rows).to_csv(out/"cross_block_pairs.csv",index=False)

    # Risk / sizing role tests on Momentum Top10.
    sizing=con.execute(f"""
      WITH x AS (
        SELECT *,
          GREATEST(0.5,LEAST(1.5,0.15/NULLIF(vol60_ann,0))) w_v60_15,
          GREATEST(0.5,LEAST(1.5,0.20/NULLIF(vol60_ann,0))) w_v60_20,
          GREATEST(0.5,LEAST(1.5,0.20/NULLIF(vol20_ann,0))) w_v20_20,
          GREATEST(0.5,LEAST(1.5,1.0/NULLIF(beta60_spy,0))) w_beta
        FROM read_parquet('{panel}')
      )
      SELECT dt,period_bucket,
        AVG(CASE WHEN mom_pct>=0.90 THEN fwd_ret_120 END) eq120,
        AVG(CASE WHEN mom_pct>=0.90 THEN fwd_ret_252 END) eq252,
        SUM(CASE WHEN mom_pct>=0.90 THEN w_v60_15*fwd_ret_120 END)/NULLIF(SUM(CASE WHEN mom_pct>=0.90 THEN w_v60_15 END),0) v6015_120,
        SUM(CASE WHEN mom_pct>=0.90 THEN w_v60_15*fwd_ret_252 END)/NULLIF(SUM(CASE WHEN mom_pct>=0.90 THEN w_v60_15 END),0) v6015_252,
        SUM(CASE WHEN mom_pct>=0.90 THEN w_v60_20*fwd_ret_120 END)/NULLIF(SUM(CASE WHEN mom_pct>=0.90 THEN w_v60_20 END),0) v6020_120,
        SUM(CASE WHEN mom_pct>=0.90 THEN w_v60_20*fwd_ret_252 END)/NULLIF(SUM(CASE WHEN mom_pct>=0.90 THEN w_v60_20 END),0) v6020_252,
        SUM(CASE WHEN mom_pct>=0.90 THEN w_v20_20*fwd_ret_120 END)/NULLIF(SUM(CASE WHEN mom_pct>=0.90 THEN w_v20_20 END),0) v2020_120,
        SUM(CASE WHEN mom_pct>=0.90 THEN w_v20_20*fwd_ret_252 END)/NULLIF(SUM(CASE WHEN mom_pct>=0.90 THEN w_v20_20 END),0) v2020_252,
        SUM(CASE WHEN mom_pct>=0.90 THEN w_beta*fwd_ret_120 END)/NULLIF(SUM(CASE WHEN mom_pct>=0.90 THEN w_beta END),0) beta_120,
        SUM(CASE WHEN mom_pct>=0.90 THEN w_beta*fwd_ret_252 END)/NULLIF(SUM(CASE WHEN mom_pct>=0.90 THEN w_beta END),0) beta_252,
        AVG(fwd_ret_120) univ120,AVG(fwd_ret_252) univ252,
        ANY_VALUE(spy_fwd_120) spy120,ANY_VALUE(spy_fwd_252) spy252
      FROM x GROUP BY dt,period_bucket ORDER BY dt
    """).df()
    srows=[]
    for name,prefix in [("EQUAL","eq"),("VOL60_TARGET15","v6015"),("VOL60_TARGET20","v6020"),("VOL20_TARGET20","v2020"),("BETA_NEUTRAL_TILT","beta")]:
      for h in HORIZONS:
        col=f"{prefix}{h}" if name=="EQUAL" else f"{prefix}_{h}"
        rec={"model":name,"horizon":h,"meanReturn":sf(sizing[col].mean()),
             "meanExcessUniverse":sf((sizing[col]-sizing[f'univ{h}']).mean()),
             "meanExcessSpy":sf((sizing[col]-sizing[f'spy{h}']).mean()),
             "deltaVsEqual":0.0 if name=="EQUAL" else sf((sizing[col]-sizing[f'eq{h}']).mean())}
        for p in PERIODS:
          z=sizing[sizing.period_bucket==p]
          rec[f"delta_{p}"]=0.0 if name=="EQUAL" else sf((z[col]-z[f'eq{h}']).mean())
        srows.append(rec)
    pd.DataFrame(srows).to_csv(out/"sizing_tests.csv",index=False)

    # Preliminary role map. This is classification for follow-up, not a production decision.
    roles=[]
    for feat in features:
      st=sdf[(sdf.feature==feat)&(sdf.horizon==252)].iloc[0]
      gg=gdf[(gdf.feature==feat)&(gdf.horizon==252)&(gdf.momCut==0.90)].copy()
      gg=gg[gg.meanSelectedN.fillna(0)>=20].sort_values(["periodPositiveCount","deltaVsBaseline"],ascending=[False,False])
      best=gg.iloc[0] if len(gg) else None
      nn=ndf[(ndf.feature==feat)&(ndf.horizon==252)&(ndf["mode"]=="mom10_state")]
      nat=nn.iloc[0] if len(nn) else None
      turn=None
      if len(turnover):
        tt=turnover[(turnover.feature==feat)&(turnover.topPct==0.1)]
        if len(tt): turn=sf(tt.iloc[0].meanMonthlyTurnover)
      tags=[]
      stand=sf(st.meanTop10ExcessUniverse)
      ic=sf(st.meanRankIC)
      bd=sf(best.deltaVsBaseline) if best is not None else None
      npcnt=int(best.periodPositiveCount) if best is not None else 0
      ndelta=sf(nat.deltaVsBaseline) if nat is not None else None
      if stand is not None and stand>=0.04: tags.append("ALPHA_CANDIDATE")
      if bd is not None and bd>0 and npcnt>=2: tags.append("CONFIRMATION_CANDIDATE")
      if ndelta is not None and ndelta>0 and nat.periodPositiveCount>=2: tags.append("NATURAL_FILTER_CANDIDATE")
      if feat in {"vol20_ann","vol60_ann","downside_vol20_ann","beta60_spy","gap_vol20_ann","amihud20","log_dollarvol20"}: tags.append("RISK_OR_SIZING_TESTED")
      if ic is not None and abs(ic)>=0.10 and (stand is None or stand<=0): tags.append("NONLINEAR_DIAGNOSTIC")
      if not tags: tags=["DIAGNOSTIC_OR_DROP"]
      roles.append({"feature":feat,"block":block_map[feat],"standalone252Excess":stand,"rankIC252":ic,
                    "bestConfirmCut":float(best.confirmCut) if best is not None else None,
                    "bestConfirmDelta":bd,"confirmPeriodPositiveCount":npcnt,
                    "naturalMom10Delta":ndelta,"top10MonthlyTurnover":turn,
                    "preliminaryRoles":"|".join(tags)})
    pd.DataFrame(roles).to_csv(out/"signal_role_map.csv",index=False)

    summary={"study":"CloudTrend US-3.2 Broad Signal Map","version":"us3.2-broad-signal-map-v0",
      "researchGrade":"SURVIVOR_ONLY_EXPLORATORY","finalOosAllowed":False,
      "featuresTested":len(features),"featureBlocks":sorted(reg.block.unique()),
      "confirmationGrid":{"momentumCuts":MOM_CUTS,"featureCuts":CONF_CUTS,"horizons":HORIZONS},
      "periodBuckets":PERIODS,
      "tests":["standalone alpha","momentum confirmation grid","natural state/onset","market/growth/smallcap regimes",
               "block composites","all-37 composite","cross-block pairs","volatility/beta sizing"],
      "pairShortlist":shortlist,
      "note":"Every registered US-2 feature is evaluated at least once. Pair search is staged after exhaustive single-signal testing to reduce combinatorial overfit."}
    (out/"summary.json").write_text(json.dumps(summary,indent=2),encoding="utf-8")
    print(json.dumps({"ok":True,"features":len(features),"outputs":len(list(out.glob('*'))),"pairShortlist":shortlist}))

if __name__=="__main__":
    main()
