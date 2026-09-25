from __future__ import annotations

import argparse
from pathlib import Path
import os

import duckdb

FEATURES = [
    ("ret5","TECHNICAL",1),("ret20","TECHNICAL",1),("ret60","TECHNICAL",1),("ret120","TECHNICAL",1),("ret252","TECHNICAL",1),
    ("ma20_gap","TECHNICAL",1),("ma60_gap","TECHNICAL",1),("ma120_gap","TECHNICAL",1),
    ("ma20_slope5","TECHNICAL",1),("ma60_slope5","TECHNICAL",1),
    ("high252_gap","TECHNICAL",1),("donchian20_gap","TECHNICAL",1),("ichimoku_tk_gap","TECHNICAL",1),
    ("efficiency20","TECHNICAL",1),("up_day_pct20","TECHNICAL",1),
    ("rs_spy20","RELATIVE_STRENGTH",1),("rs_spy60","RELATIVE_STRENGTH",1),("rs_spy120","RELATIVE_STRENGTH",1),
    ("rs_qqq20","RELATIVE_STRENGTH",1),("rs_qqq60","RELATIVE_STRENGTH",1),
    ("rs_iwm20","RELATIVE_STRENGTH",1),("rs_iwm60","RELATIVE_STRENGTH",1),("rs_accel_spy","RELATIVE_STRENGTH",-1),
    ("relvol1_20","VOLUME_LIQUIDITY",1),("relvol5_20","VOLUME_LIQUIDITY",1),("log_dollarvol20","VOLUME_LIQUIDITY",1),
    ("dollarvol_growth5_20","VOLUME_LIQUIDITY",1),("amihud20","VOLUME_LIQUIDITY",-1),("price_volume5","VOLUME_LIQUIDITY",-1),
    ("vol20_ann","RISK_QUALITY",-1),("vol60_ann","RISK_QUALITY",-1),("downside_vol20_ann","RISK_QUALITY",-1),
    ("drawdown60","RISK_QUALITY",1),("beta60_spy","RISK_QUALITY",1),("residual_mom60","RISK_QUALITY",1),
    ("gap_vol20_ann","RISK_QUALITY",-1),("tail_loss20","RISK_QUALITY",-1),
]

NATURAL_RULES = {
    "ret5":"ret5 > 0","ret20":"ret20 > 0","ret60":"ret60 > 0","ret120":"ret120 > 0","ret252":"ret252 > 0",
    "ma20_gap":"ma20_gap > 0","ma60_gap":"ma60_gap > 0","ma120_gap":"ma120_gap > 0",
    "ma20_slope5":"ma20_slope5 > 0","ma60_slope5":"ma60_slope5 > 0",
    "high252_gap":"high252_gap >= -0.10","donchian20_gap":"donchian20_gap >= 0",
    "ichimoku_tk_gap":"ichimoku_tk_gap > 0","efficiency20":"dr_efficiency20 >= 0.70","up_day_pct20":"up_day_pct20 >= 0.55",
    "rs_spy20":"rs_spy20 > 0","rs_spy60":"rs_spy60 > 0","rs_spy120":"rs_spy120 > 0",
    "rs_qqq20":"rs_qqq20 > 0","rs_qqq60":"rs_qqq60 > 0","rs_iwm20":"rs_iwm20 > 0","rs_iwm60":"rs_iwm60 > 0",
    "rs_accel_spy":"rs_accel_spy <= 0",
    "relvol1_20":"relvol1_20 >= 0.50","relvol5_20":"relvol5_20 >= 0.25",
    "log_dollarvol20":"dr_log_dollarvol20 >= 0.70","dollarvol_growth5_20":"dollarvol_growth5_20 >= 0.25",
    "amihud20":"dr_amihud20 >= 0.70","price_volume5":"dr_price_volume5 >= 0.70",
    "vol20_ann":"dr_vol20_ann >= 0.70","vol60_ann":"dr_vol60_ann >= 0.70","downside_vol20_ann":"dr_downside_vol20_ann >= 0.70",
    "drawdown60":"drawdown60 >= -0.10","beta60_spy":"beta60_spy >= 1.0","residual_mom60":"residual_mom60 > 0",
    "gap_vol20_ann":"dr_gap_vol20_ann >= 0.70","tail_loss20":"tail_loss20 = 0",
}

def args():
    p=argparse.ArgumentParser()
    p.add_argument("--input",required=True)
    p.add_argument("--output",required=True)
    p.add_argument("--threads",type=int,default=2)
    p.add_argument("--memory-limit",default="5GB")
    return p.parse_args()

def main():
    a=args()
    root=Path(a.input).resolve()
    out=Path(a.output).resolve()
    out.parent.mkdir(parents=True,exist_ok=True)
    tmp=Path(os.environ.get("RUNNER_TEMP",str(out.parent/".us32-tmp")))/"cloudtrend-us32"
    tmp.mkdir(parents=True,exist_ok=True)
    price_glob=str(root/"canonical"/"year=*"/"us_stock_daily.parquet").replace("'","''")
    bench=str(root/"benchmark"/"us_benchmarks_adjusted.parquet").replace("'","''")
    con=duckdb.connect(str(tmp/"us32.duckdb"))
    con.execute(f"SET memory_limit='{a.memory_limit}'")
    con.execute(f"SET threads={a.threads}")
    con.execute(f"SET temp_directory='{str(tmp)}'")

    cols={r[0] for r in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{bench}')").fetchall()}
    required={"dt","spy_close","qqq_close","iwm_close"}
    missing=sorted(required-cols)
    if missing:
        raise RuntimeError(f"benchmark missing columns: {missing}; available={sorted(cols)}")

    raw_sql=f"""
    WITH b0 AS (
      SELECT CAST(dt AS DATE) dt,
             CAST(spy_close AS DOUBLE) spy_close,
             CAST(qqq_close AS DOUBLE) qqq_close,
             CAST(iwm_close AS DOUBLE) iwm_close
      FROM read_parquet('{bench}')
    ),
    b1 AS (
      SELECT *,
        LAG(spy_close,1) OVER(ORDER BY dt) spy_l1,
        LAG(spy_close,20) OVER(ORDER BY dt) spy_l20,
        LAG(spy_close,60) OVER(ORDER BY dt) spy_l60,
        LAG(spy_close,120) OVER(ORDER BY dt) spy_l120,
        LAG(spy_close,252) OVER(ORDER BY dt) spy_l252,
        LAG(qqq_close,20) OVER(ORDER BY dt) qqq_l20,
        LAG(qqq_close,60) OVER(ORDER BY dt) qqq_l60,
        LAG(iwm_close,20) OVER(ORDER BY dt) iwm_l20,
        LAG(iwm_close,60) OVER(ORDER BY dt) iwm_l60,
        AVG(spy_close) OVER(ORDER BY dt ROWS BETWEEN 199 PRECEDING AND CURRENT ROW) spy_ma200,
        LEAD(spy_close,120) OVER(ORDER BY dt) spy_f120,
        LEAD(spy_close,252) OVER(ORDER BY dt) spy_f252
      FROM b0
    ),
    b2 AS (
      SELECT *,
        spy_close/NULLIF(spy_l1,0)-1 spy_ret1,
        spy_close/NULLIF(spy_l20,0)-1 spy_ret20,
        spy_close/NULLIF(spy_l60,0)-1 spy_ret60,
        spy_close/NULLIF(spy_l120,0)-1 spy_ret120,
        spy_close/NULLIF(spy_l252,0)-1 spy_ret252,
        qqq_close/NULLIF(qqq_l20,0)-1 qqq_ret20,
        qqq_close/NULLIF(qqq_l60,0)-1 qqq_ret60,
        iwm_close/NULLIF(iwm_l20,0)-1 iwm_ret20,
        iwm_close/NULLIF(iwm_l60,0)-1 iwm_ret60,
        spy_f120/NULLIF(spy_close,0)-1 spy_fwd120,
        spy_f252/NULLIF(spy_close,0)-1 spy_fwd252
      FROM b1
    ),
    b3 AS (
      SELECT *,
        STDDEV_SAMP(spy_ret1) OVER(ORDER BY dt ROWS BETWEEN 19 PRECEDING AND CURRENT ROW)*SQRT(252.0) spy_vol20_ann,
        CASE WHEN spy_close>spy_ma200 AND spy_ret60>0 THEN 'RISK_ON'
             WHEN spy_close<spy_ma200 AND spy_ret60<0 THEN 'RISK_OFF'
             ELSE 'NEUTRAL' END market_regime,
        CASE WHEN qqq_ret60>spy_ret60 THEN 'GROWTH_LEAD' ELSE 'GROWTH_LAG' END growth_regime,
        CASE WHEN iwm_ret60>spy_ret60 THEN 'SMALL_LEAD' ELSE 'SMALL_LAG' END smallcap_regime
      FROM b2
    ),
    s0 AS (
      SELECT CAST(symbol AS VARCHAR) symbol,
             CAST(tradeDateUsEastern AS DATE) dt,
             CAST(open AS DOUBLE) open,
             CAST(high AS DOUBLE) high,
             CAST(low AS DOUBLE) low,
             CAST(close AS DOUBLE) close,
             CAST(volume AS DOUBLE) volume
      FROM read_parquet('{price_glob}',union_by_name=true)
    ),
    s1 AS (
      SELECT *,
        LAG(close,1) OVER w close_l1,
        LAG(close,5) OVER w close_l5,
        LAG(close,20) OVER w close_l20,
        LAG(close,60) OVER w close_l60,
        LAG(close,120) OVER w close_l120,
        LAG(close,252) OVER w close_l252,
        LEAD(close,120) OVER w close_f120,
        LEAD(close,252) OVER w close_f252,
        AVG(close) OVER(PARTITION BY symbol ORDER BY dt ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) ma20,
        AVG(close) OVER(PARTITION BY symbol ORDER BY dt ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) ma60,
        AVG(close) OVER(PARTITION BY symbol ORDER BY dt ROWS BETWEEN 119 PRECEDING AND CURRENT ROW) ma120,
        AVG(volume) OVER(PARTITION BY symbol ORDER BY dt ROWS BETWEEN 4 PRECEDING AND CURRENT ROW) avgvol5,
        AVG(volume) OVER(PARTITION BY symbol ORDER BY dt ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) avgvol20,
        AVG(close*volume) OVER(PARTITION BY symbol ORDER BY dt ROWS BETWEEN 4 PRECEDING AND CURRENT ROW) avgdvol5,
        AVG(close*volume) OVER(PARTITION BY symbol ORDER BY dt ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) avgdvol20,
        MAX(high) OVER(PARTITION BY symbol ORDER BY dt ROWS BETWEEN 8 PRECEDING AND CURRENT ROW) high9,
        MIN(low) OVER(PARTITION BY symbol ORDER BY dt ROWS BETWEEN 8 PRECEDING AND CURRENT ROW) low9,
        MAX(high) OVER(PARTITION BY symbol ORDER BY dt ROWS BETWEEN 25 PRECEDING AND CURRENT ROW) high26,
        MIN(low) OVER(PARTITION BY symbol ORDER BY dt ROWS BETWEEN 25 PRECEDING AND CURRENT ROW) low26,
        MAX(high) OVER(PARTITION BY symbol ORDER BY dt ROWS BETWEEN 251 PRECEDING AND CURRENT ROW) high252,
        MAX(high) OVER(PARTITION BY symbol ORDER BY dt ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) prior20_high,
        MAX(close) OVER(PARTITION BY symbol ORDER BY dt ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) maxclose60
      FROM s0
      WINDOW w AS (PARTITION BY symbol ORDER BY dt)
    ),
    s2 AS (
      SELECT s1.*,b3.spy_ret1,b3.spy_ret20,b3.spy_ret60,b3.spy_ret120,b3.spy_ret252,
             b3.qqq_ret20,b3.qqq_ret60,b3.iwm_ret20,b3.iwm_ret60,
             b3.spy_fwd120,b3.spy_fwd252,b3.market_regime,b3.growth_regime,b3.smallcap_regime,b3.spy_vol20_ann,
        close/NULLIF(close_l1,0)-1 ret1,
        close/NULLIF(close_l5,0)-1 ret5,
        close/NULLIF(close_l20,0)-1 ret20,
        close/NULLIF(close_l60,0)-1 ret60,
        close/NULLIF(close_l120,0)-1 ret120,
        close/NULLIF(close_l252,0)-1 ret252,
        open/NULLIF(close_l1,0)-1 gap_ret1,
        ABS(close-close_l1) abs_price_change,
        ABS(close/NULLIF(close_l1,0)-1)/NULLIF(close*volume,0) amihud1,
        close/NULLIF(ma20,0)-1 ma20_gap,
        close/NULLIF(ma60,0)-1 ma60_gap,
        close/NULLIF(ma120,0)-1 ma120_gap,
        close/NULLIF(high252,0)-1 high252_gap,
        close/NULLIF(prior20_high,0)-1 donchian20_gap,
        ((high9+low9)/2.0)/NULLIF((high26+low26)/2.0,0)-1 ichimoku_tk_gap,
        volume/NULLIF(avgvol20,0)-1 relvol1_20,
        avgvol5/NULLIF(avgvol20,0)-1 relvol5_20,
        LN(avgdvol20+1) log_dollarvol20,
        avgdvol5/NULLIF(avgdvol20,0)-1 dollarvol_growth5_20,
        ret5*(avgvol5/NULLIF(avgvol20,0)) price_volume5,
        close/NULLIF(maxclose60,0)-1 drawdown60,
        ret20-b3.spy_ret20 rs_spy20,
        ret60-b3.spy_ret60 rs_spy60,
        ret120-b3.spy_ret120 rs_spy120,
        ret20-b3.qqq_ret20 rs_qqq20,
        ret60-b3.qqq_ret60 rs_qqq60,
        ret20-b3.iwm_ret20 rs_iwm20,
        ret60-b3.iwm_ret60 rs_iwm60,
        (ret20-b3.spy_ret20)-(ret60-b3.spy_ret60) rs_accel_spy,
        close_f120/NULLIF(close,0)-1 fwd_ret_120,
        close_f252/NULLIF(close,0)-1 fwd_ret_252
      FROM s1 LEFT JOIN b3 USING(dt)
    ),
    s3 AS (
      SELECT *,
        LAG(ma20,5) OVER(PARTITION BY symbol ORDER BY dt) ma20_l5,
        LAG(ma60,5) OVER(PARTITION BY symbol ORDER BY dt) ma60_l5,
        SUM(abs_price_change) OVER(PARTITION BY symbol ORDER BY dt ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) abschange20,
        AVG(CASE WHEN ret1>0 THEN 1.0 ELSE 0.0 END) OVER(PARTITION BY symbol ORDER BY dt ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) up_day_pct20,
        AVG(amihud1) OVER(PARTITION BY symbol ORDER BY dt ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) amihud20,
        STDDEV_SAMP(ret1) OVER(PARTITION BY symbol ORDER BY dt ROWS BETWEEN 19 PRECEDING AND CURRENT ROW)*SQRT(252.0) vol20_ann,
        STDDEV_SAMP(ret1) OVER(PARTITION BY symbol ORDER BY dt ROWS BETWEEN 59 PRECEDING AND CURRENT ROW)*SQRT(252.0) vol60_ann,
        STDDEV_SAMP(CASE WHEN ret1<0 THEN ret1 END) OVER(PARTITION BY symbol ORDER BY dt ROWS BETWEEN 19 PRECEDING AND CURRENT ROW)*SQRT(252.0) downside_vol20_ann,
        STDDEV_SAMP(gap_ret1) OVER(PARTITION BY symbol ORDER BY dt ROWS BETWEEN 19 PRECEDING AND CURRENT ROW)*SQRT(252.0) gap_vol20_ann,
        AVG(CASE WHEN ret1<=-0.05 THEN 1.0 ELSE 0.0 END) OVER(PARTITION BY symbol ORDER BY dt ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) tail_loss20,
        COVAR_SAMP(ret1,spy_ret1) OVER(PARTITION BY symbol ORDER BY dt ROWS BETWEEN 59 PRECEDING AND CURRENT ROW)
          /NULLIF(VAR_SAMP(spy_ret1) OVER(PARTITION BY symbol ORDER BY dt ROWS BETWEEN 59 PRECEDING AND CURRENT ROW),0) beta60_spy
      FROM s2
    ),
    s4 AS (
      SELECT *,
        ma20/NULLIF(ma20_l5,0)-1 ma20_slope5,
        ma60/NULLIF(ma60_l5,0)-1 ma60_slope5,
        ABS(close-close_l20)/NULLIF(abschange20,0) efficiency20,
        ret60-beta60_spy*spy_ret60 residual_mom60,
        CASE WHEN YEAR(dt)<=2019 THEN 'EARLY_2017_2019'
             WHEN YEAR(dt)<=2022 THEN 'MID_2020_2022'
             ELSE 'RECENT_2023_2026' END period_bucket
      FROM s3
      WHERE dt>=DATE '2017-01-01'
    )
    SELECT symbol,dt,period_bucket,market_regime,growth_regime,smallcap_regime,spy_vol20_ann,
      ret5,ret20,ret60,ret120,ret252,ma20_gap,ma60_gap,ma120_gap,ma20_slope5,ma60_slope5,
      high252_gap,donchian20_gap,ichimoku_tk_gap,efficiency20,up_day_pct20,
      rs_spy20,rs_spy60,rs_spy120,rs_qqq20,rs_qqq60,rs_iwm20,rs_iwm60,rs_accel_spy,
      relvol1_20,relvol5_20,log_dollarvol20,dollarvol_growth5_20,amihud20,price_volume5,
      vol20_ann,vol60_ann,downside_vol20_ann,drawdown60,beta60_spy,residual_mom60,gap_vol20_ann,tail_loss20,
      fwd_ret_120,fwd_ret_252,spy_fwd120 AS spy_fwd_120,spy_fwd252 AS spy_fwd_252
    FROM s4
    """
    con.execute("DROP TABLE IF EXISTS raw_panel")
    con.execute(f"CREATE TABLE raw_panel AS {raw_sql}")

    rank_expr=[]
    for feat,_,direction in FEATURES:
        if direction==1:
            rank_expr.append(f"PERCENT_RANK() OVER(PARTITION BY dt ORDER BY {feat}) AS dr_{feat}")
        else:
            rank_expr.append(f"1.0-PERCENT_RANK() OVER(PARTITION BY dt ORDER BY {feat}) AS dr_{feat}")
    con.execute("DROP TABLE IF EXISTS ranked_panel")
    con.execute("CREATE TABLE ranked_panel AS SELECT *, "+", ".join(rank_expr)+" FROM raw_panel")

    con.execute("DROP TABLE IF EXISTS scored_panel")
    con.execute("""
      CREATE TABLE scored_panel AS
      WITH x AS (
        SELECT *,0.5*dr_ret120+0.5*dr_ret252 AS mom_score
        FROM ranked_panel
      )
      SELECT *,
        PERCENT_RANK() OVER(PARTITION BY dt ORDER BY mom_score) AS mom_pct,
        PERCENT_RANK() OVER(PARTITION BY dt ORDER BY fwd_ret_120) AS target_pct_120,
        PERCENT_RANK() OVER(PARTITION BY dt ORDER BY fwd_ret_252) AS target_pct_252
      FROM x
    """)

    nat_expr=[f"CASE WHEN {NATURAL_RULES[f]} THEN 1 ELSE 0 END AS nat_{f}" for f,_,_ in FEATURES]
    final_path=str(out).replace("'","''")
    con.execute(
      "COPY (SELECT *,"+", ".join(nat_expr)+" FROM scored_panel) "
      f"TO '{final_path}' (FORMAT PARQUET,COMPRESSION ZSTD)"
    )
    qa=con.execute("SELECT COUNT(*) rows,COUNT(DISTINCT symbol) symbols,MIN(dt) min_date,MAX(dt) max_date FROM scored_panel").fetchone()
    print({"ok":True,"rows":qa[0],"symbols":qa[1],"minDate":str(qa[2]),"maxDate":str(qa[3]),"output":str(out)})

if __name__=="__main__":
    main()
