from __future__ import annotations

import argparse
import gc
import json
import math
import os
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

EXPECTED = {
    "A_N15_SC2": 0.1407951226152044,
    "A_N15_SCNONE": 0.1582469201685212,
    "A_N20_SC2": 0.2039563363017162,
    "A_N20_SCNONE": 0.1982142370450761,
    "B_N15_SC3__MBV": 0.1794893481270951,
    "B_N15_SCNONE__MBV": 0.1567503650508839,
    "B_N20_SC3__MBV": 0.1964312692701519,
    "B_N20_SCNONE__MBV": 0.1729950540730569,
}
ALLOWED_EXCHANGES = {
    "NYSE", "NASDAQ", "NYSEMKT", "NYSEARCA", "BATS", "AMEX", "NYSEAMERICAN"
}


def args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--threads", type=int, default=2)
    p.add_argument("--memory-limit", default="5GB")
    return p.parse_args()


def stats(returns) -> dict:
    r = pd.to_numeric(pd.Series(returns), errors="coerce").dropna().to_numpy(float)
    if len(r) == 0:
        return dict(days=0, CAGR=np.nan, Sharpe=np.nan, MDD=np.nan, totalReturn=np.nan)
    eq = np.cumprod(1.0 + r)
    vol = np.std(r, ddof=1)
    peak = np.maximum.accumulate(np.r_[1.0, eq])[1:]
    return dict(
        days=len(r),
        CAGR=eq[-1] ** (252.0 / len(r)) - 1.0,
        Sharpe=(np.mean(r) / vol * np.sqrt(252.0)) if vol > 0 else 0.0,
        MDD=np.min(eq / peak - 1.0),
        totalReturn=eq[-1] - 1.0,
    )


def pct(col: str, reverse: bool = False) -> str:
    expr = (
        f"(RANK() OVER(PARTITION BY dt ORDER BY {col} NULLS LAST)-1)::DOUBLE/"
        f"NULLIF(COUNT({col}) OVER(PARTITION BY dt)-1,0)"
    )
    return (
        f"CASE WHEN {col} IS NULL THEN NULL ELSE "
        + (f"1-({expr})" if reverse else expr)
        + " END"
    )


def build_exchange_history(master: pd.DataFrame, actions: pd.DataFrame) -> pd.DataFrame:
    acts = {s: g for s, g in actions.groupby("ticker")}
    empty = actions.iloc[:0]
    rows = []
    for r in master.itertuples(index=False):
        aa = acts.get(r.ticker, empty)
        changes = aa[aa.action.eq("exchangeto")].sort_values("date")
        current = getattr(r, "exchange", None)
        if len(changes):
            first = changes.iloc[0]["date"]
            fr = aa[(aa.action.eq("exchangefrom")) & (aa.date.eq(first))]
            initial = fr.iloc[0].contraname if len(fr) else "UNKNOWN"
        else:
            initial = current
        rows.append(dict(symbol=r.ticker, dt=pd.Timestamp("1900-01-01"), exchange=initial))
        for c in changes.itertuples(index=False):
            rows.append(dict(symbol=r.ticker, dt=pd.Timestamp(c.date), exchange=c.contraname))
    return pd.DataFrame(rows)


def build_features(con: duckdb.DuckDBPyConnection, root: Path, tmp: Path) -> Path:
    prices = str(root / "prices" / "year=*" / "data_0.parquet").replace("'", "''")
    spy = str(root / "benchmark" / "spy.parquet").replace("'", "''")
    tickers = root / "reference" / "tickers.csv"
    actions_path = root / "reference" / "actions.csv"
    sectors = root / "reference" / "sector_map_extended.csv"

    master = pd.read_csv(tickers, low_memory=False)
    if "table" in master.columns:
        master = master[master["table"].eq("SEP")].copy()
    master["ticker"] = master["ticker"].astype(str)
    master["is_common"] = master["category"].astype(str).str.contains("Common Stock", na=False)

    actions = pd.read_csv(actions_path, low_memory=False, parse_dates=["date"])
    actions["ticker"] = actions["ticker"].astype(str)
    exchange_history = build_exchange_history(master, actions)

    sector = pd.read_csv(sectors, low_memory=False)
    sector = sector[["ticker", "sectorCode"]].drop_duplicates("ticker")
    sector["ticker"] = sector["ticker"].astype(str)

    con.register("master_df", master)
    con.register("exchange_history_df", exchange_history)
    con.register("sector_df", sector)
    con.execute("CREATE OR REPLACE TABLE security AS SELECT * FROM master_df")
    con.execute("CREATE OR REPLACE TABLE exchange_history AS SELECT symbol,CAST(dt AS DATE) dt,exchange FROM exchange_history_df")
    con.execute("CREATE OR REPLACE TABLE sector_map AS SELECT ticker symbol,sectorCode FROM sector_df")

    con.execute(
        f"""
        CREATE OR REPLACE TABLE prices AS
        SELECT
          CAST(ticker AS VARCHAR) symbol,
          CAST(date AS DATE) dt,
          CAST("open" AS DOUBLE) AS px_open,
          CAST("high" AS DOUBLE) AS px_high,
          CAST("low" AS DOUBLE) AS px_low,
          CAST("close" AS DOUBLE) AS px_close,
          CAST(volume AS DOUBLE) AS volume,
          CAST(closeadj AS DOUBLE) AS closeadj,
          CAST(closeunadj AS DOUBLE) AS closeunadj
        FROM read_parquet('{prices}', union_by_name=true)
        WHERE CAST(date AS DATE) >= DATE '2015-01-01'
        """
    )

    bench_cols = {r[0].lower() for r in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{spy}')").fetchall()}
    if "date" not in bench_cols or "ticker" not in bench_cols:
        raise RuntimeError(f"SPY parquet schema unexpected: {sorted(bench_cols)}")
    bench_px = "closeadj" if "closeadj" in bench_cols else "close"
    con.execute(
        f"""
        CREATE OR REPLACE TABLE bench AS
        SELECT CAST(date AS DATE) dt,CAST("{bench_px}" AS DOUBLE) AS spy_close
        FROM read_parquet('{spy}')
        WHERE ticker='SPY'
        ORDER BY dt
        """
    )

    con.execute(
        """
        CREATE OR REPLACE TABLE feature_base AS
        WITH b AS (
          SELECT dt,spy_close/LAG(spy_close) OVER(ORDER BY dt)-1 spy_ret1
          FROM bench
        ),
        a AS (
          SELECT *,
            px_close/LAG(px_close) OVER w-1 ret1,
            px_close/LAG(px_close,120) OVER w-1 ret120,
            px_close/LAG(px_close,252) OVER w-1 ret252,
            volume/NULLIF(AVG(volume) OVER w20,0)-1 relvol1_20,
            LN(AVG(px_close*volume) OVER w20+1) log_dollarvol20,
            ((MAX(px_high) OVER w9+MIN(px_low) OVER w9)/2)/
              NULLIF((MAX(px_high) OVER w26+MIN(px_low) OVER w26)/2,0)-1 ichimoku_tk_gap
          FROM prices
          WINDOW
            w AS(PARTITION BY symbol ORDER BY dt),
            w20 AS(PARTITION BY symbol ORDER BY dt ROWS BETWEEN 19 PRECEDING AND CURRENT ROW),
            w9 AS(PARTITION BY symbol ORDER BY dt ROWS BETWEEN 8 PRECEDING AND CURRENT ROW),
            w26 AS(PARTITION BY symbol ORDER BY dt ROWS BETWEEN 25 PRECEDING AND CURRENT ROW)
        ),
        x AS (
          SELECT a.*,b.spy_ret1,ABS(ret1)/NULLIF(px_close*volume,0) amihud1
          FROM a LEFT JOIN b USING(dt)
        )
        SELECT
          symbol,dt,ret120,ret252,relvol1_20,log_dollarvol20,ichimoku_tk_gap,
          AVG(amihud1) OVER(PARTITION BY symbol ORDER BY dt ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) amihud20,
          COVAR_SAMP(ret1,spy_ret1) OVER w60/
            NULLIF(VAR_SAMP(spy_ret1) OVER w60,0) beta60_spy
        FROM x
        WINDOW w60 AS(PARTITION BY symbol ORDER BY dt ROWS BETWEEN 59 PRECEDING AND CURRENT ROW)
        """
    )

    allowed = ",".join("'" + x + "'" for x in sorted(ALLOWED_EXCHANGES))
    con.execute(
        f"""
        CREATE OR REPLACE TABLE universe AS
        SELECT
          f.*,
          COALESCE(sm.sectorCode,'UNKNOWN') sectorCode,
          h.exchange,
          s.is_common
        FROM feature_base f
        JOIN security s ON s.ticker=f.symbol
        ASOF LEFT JOIN exchange_history h
          ON f.symbol=h.symbol AND f.dt>=h.dt
        LEFT JOIN sector_map sm ON sm.symbol=f.symbol
        WHERE s.is_common
          AND UPPER(COALESCE(h.exchange,'')) IN ({allowed})
          AND f.dt BETWEEN DATE '2017-01-01' AND DATE '2026-09-23'
        """
    )

    feats = ["ret120","ret252","beta60_spy","ichimoku_tk_gap","relvol1_20","log_dollarvol20","amihud20"]
    ranks = ",".join(f"{pct(f, f=='amihud20')} dr_{f}" for f in feats)
    con.execute(
        f"""
        CREATE OR REPLACE TABLE ranked AS
        WITH r AS (
          SELECT *,{ranks}
          FROM universe
        ),
        m AS (
          SELECT *,0.5*dr_ret120+0.5*dr_ret252 mom_score
          FROM r
        )
        SELECT *,{pct('mom_score')} mom_pct
        FROM m
        """
    )

    panel = tmp / "ranked"
    panel.mkdir(parents=True, exist_ok=True)
    for year in range(2017, 2027):
        out = panel / f"year={year}.parquet"
        con.execute(
            f"""
            COPY (
              SELECT symbol,dt,sectorCode,mom_pct,
                     dr_beta60_spy,dr_ichimoku_tk_gap,dr_relvol1_20,
                     dr_log_dollarvol20,dr_amihud20
              FROM ranked
              WHERE YEAR(dt)={year}
              ORDER BY dt,symbol
            ) TO '{out}' (FORMAT PARQUET,COMPRESSION ZSTD)
            """
        )
        q = con.execute(
            "SELECT COUNT(*),COUNT(DISTINCT symbol) FROM ranked WHERE YEAR(dt)=?",
            [year],
        ).fetchone()
        print({"featureYear": year, "rows": q[0], "symbols": q[1]}, flush=True)
    return panel


def prepare_prices(con: duckdb.DuckDBPyConnection, root: Path):
    dates = pd.DatetimeIndex(
        con.execute("SELECT dt FROM bench WHERE dt>=DATE '2017-01-01' AND dt<=DATE '2026-09-23' ORDER BY dt").df().dt
    )
    names = con.execute("SELECT DISTINCT symbol FROM prices ORDER BY symbol").df().iloc[:,0].tolist()
    ids = {s:i for i,s in enumerate(names)}
    ds = {d.date():i for i,d in enumerate(dates)}
    shape = (len(dates), len(names))
    op = np.full(shape, np.nan)
    cl = np.full(shape, np.nan)
    ok = np.zeros(shape, dtype=bool)

    for year in range(2017, 2027):
        p = con.execute(
            """
            SELECT symbol,dt,
                   px_open*closeadj/NULLIF(px_close,0) AS op,
                   closeadj cl,
                   volume
            FROM prices
            WHERE YEAR(dt)=?
            """,
            [year],
        ).df()
        p = p[p.dt.isin(dates)]
        ii = p.dt.map(lambda x: ds[x.date()])
        jj = p.symbol.map(ids)
        ii = ii.to_numpy(dtype=np.int64)
        jj = jj.to_numpy(dtype=np.int64)
        oo = p.op.to_numpy(float)
        cc = p.cl.to_numpy(float)
        vv = p.volume.to_numpy(float)
        op[ii,jj] = np.where(np.isfinite(oo) & (oo>0), oo, np.nan)
        cl[ii,jj] = np.where(np.isfinite(cc) & (cc>0), cc, np.nan)
        ok[ii,jj] = np.isfinite(oo) & (oo>0) & np.isfinite(vv) & (vv>0)

    mark = np.empty_like(op)
    last = np.full(len(names), np.nan)
    for i in range(len(dates)):
        mark[i] = np.where(ok[i], op[i], last)
        last = np.where(np.isfinite(cl[i]), cl[i], last)

    terminal = {}
    actions = con.execute(
        """
        SELECT * FROM read_csv_auto(?,sample_size=100000)
        WHERE action IN (
          'delisted','bankruptcyliquidation','acquisitioncash',
          'acquisitionstock','acquisitionelectcash','acquisitionelectstock'
        )
        """,
        [str(root/"reference"/"actions.csv")],
    ).df()
    actions["date"] = pd.to_datetime(actions["date"])
    lastpx = con.execute(
        """
        SELECT symbol,arg_max(closeadj,dt) ca,arg_max(closeunadj,dt) cu,max(dt) last_dt
        FROM prices GROUP BY symbol
        """
    ).df().set_index("symbol")
    acqpx = con.execute(
        """
        SELECT a.ticker,a.date,a.action,a.value,p.closeunadj
        FROM read_csv_auto(?,sample_size=100000) a
        LEFT JOIN prices p ON a.contraticker=p.symbol AND CAST(a.date AS DATE)=p.dt
        WHERE a.action IN ('acquisitionstock','acquisitionelectstock')
        """,
        [str(root/"reference"/"actions.csv")],
    ).df()
    stockval = {
        (r.ticker,pd.Timestamp(r.date),r.action): r.value*r.closeunadj
        for r in acqpx.itertuples(index=False)
        if pd.notna(r.closeunadj)
    }

    for symbol,g in actions.groupby("ticker"):
        if symbol not in ids or symbol not in lastpx.index:
            continue
        lp = lastpx.loc[symbol]
        end = pd.Timestamp(lp["last_dt"])
        d = int(dates.searchsorted(end, side="right"))
        if d == 0 or d >= len(dates):
            continue
        g = g[g.date.eq(end)]
        if not len(g) or not g.action.isin(["delisted","bankruptcyliquidation"]).any():
            continue
        cash = pd.to_numeric(g[g.action.eq("acquisitioncash")].value, errors="coerce").fillna(0).sum()
        stocks = []
        if g.action.eq("acquisitionstock").any():
            stocks = [stockval.get((symbol,end,"acquisitionstock"), np.nan)]
        known = ((g.action.eq("acquisitioncash").any()) or len(stocks)) and all(np.isfinite(stocks))
        consideration = float(cash + sum(stocks))
        if g.action.astype(str).str.contains("elect").any():
            known = False
        k = ids[symbol]
        if known and float(lp.cu) > 0:
            value = consideration * float(lp.ca) / float(lp.cu)
            mark[d:,k] = value
        else:
            value = float(mark[d,k])
        terminal[k] = dict(day=d,known=bool(known),value=value,symbol=symbol)

    overrides = pd.read_csv(root/"reference"/"verified_event_overrides.csv")
    for r in overrides.itertuples(index=False):
        symbol = str(r.symbol)
        if symbol not in ids:
            continue
        d = int(dates.searchsorted(pd.Timestamp(r.model_settlement)))
        if d >= len(dates):
            continue
        value = float(r.adjusted_equivalent)
        k = ids[symbol]
        mark[d:,k] = value
        terminal[k] = dict(day=d,known=True,value=value,symbol=symbol)

    spy = con.execute(
        "SELECT dt,spy_close FROM bench WHERE dt>=DATE '2017-01-01' AND dt<=DATE '2026-09-23' ORDER BY dt"
    ).df().set_index("dt").reindex(dates).spy_close.to_numpy(float)

    return dates,names,ids,op,mark,ok,terminal,spy


class State:
    def __init__(self, sid: str, n: int, cap, style: str, gate: str):
        self.id=sid; self.n=n; self.cap=cap; self.style=style; self.gate=gate
        self.cost=.0015
        self.nav=1.0; self.cash=1.0; self.p={}
        self.daily=[]; self.trades=[]; self.entry_events=[]

    @property
    def cut(self):
        return .7 if self.style=="A" else .5


def ledger(st: State, i: int, rows: dict, pool: list[int], mark, ok, terminal, dates, names):
    d=i+1
    before=st.nav
    changed=False
    entries=0
    exits=0
    turn=0.0

    for k in list(st.p):
        p=st.p[k]
        t=terminal.get(k)
        if t and d>=t["day"] and t["known"]:
            st.cash += p["v"]
            st.p.pop(k)
            changed=True; exits+=1
            st.trades.append(dict(
                symbol=names[k],entryDate=p["date"],exitDate=dates[d],
                exitReason="CORPORATE_TERMINAL",grossTradeReturn=p["cum"]-1
            ))
            continue
        rank=rows[k][0] if k in rows else np.nan
        if (not np.isfinite(rank) or rank<st.cut) and ok[d,k]:
            fee=p["v"]*st.cost
            st.cash += p["v"]-fee
            turn += p["v"]/before
            st.p.pop(k)
            changed=True; exits+=1
            st.trades.append(dict(
                symbol=names[k],entryDate=p["date"],exitDate=dates[d],
                exitReason="RANK_OR_UNIVERSE",grossTradeReturn=p["cum"]-1
            ))

    counts={}
    for k,p in st.p.items():
        if k in rows:
            p["sec"]=rows[k][1]
        counts[p["sec"]]=counts.get(p["sec"],0)+1

    for k in pool:
        if len(st.p)>=st.n:
            break
        if k in st.p or not ok[d,k]:
            continue
        sec=rows[k][1]
        if st.cap and counts.get(sec,0)>=st.cap:
            continue
        st.p[k]=dict(v=0.0,sec=sec,date=dates[d],cum=1.0)
        counts[sec]=counts.get(sec,0)+1
        changed=True; entries+=1
        st.entry_events.append((str(dates[d].date()), names[k]))

    live=[k for k in st.p if ok[d,k]]
    if changed and live:
        available=st.cash+sum(st.p[k]["v"] for k in live)
        target=available/len(live)
        for _ in range(15):
            target=(available-st.cost*sum(abs(target-st.p[k]["v"]) for k in live))/len(live)
        fees=st.cost*sum(abs(target-st.p[k]["v"]) for k in live)
        for k in live:
            dv=abs(target-st.p[k]["v"])
            turn += dv/before
            st.p[k]["v"]=target
        st.cash=max(0.0,available-target*len(live)-fees)

    locked=sum(p["v"] for k,p in st.p.items() if not ok[d,k])/before
    for k,p in st.p.items():
        r=mark[d+1,k]/mark[d,k]-1 if mark[d,k]>0 else 0.0
        if not np.isfinite(r):
            raise RuntimeError(f"Unvalued held security {names[k]} {dates[d]}")
        p["v"] += p["v"]*r
        p["cum"] *= 1.0+r

    st.nav=st.cash+sum(p["v"] for p in st.p.values())
    st.daily.append(dict(
        date=dates[d],netReturn=st.nav/before-1,equity=st.nav,
        positions=len(st.p),turnover=turn,entries=entries,exits=exits,lockedWeight=locked
    ))


def finish(st: State, dates, ok, names):
    last=len(dates)-1
    fee=0.0; turn=0.0
    for k,p in st.p.items():
        if ok[last,k]:
            fee += st.cost*p["v"]
            turn += p["v"]/st.nav
        st.trades.append(dict(
            symbol=names[k],entryDate=p["date"],exitDate=dates[last],
            exitReason="END_MARK" if not ok[last,k] else "END_OF_SAMPLE",
            grossTradeReturn=p["cum"]-1
        ))
    before=st.nav
    st.nav -= fee
    if st.daily:
        st.daily[-1]["netReturn"]=(1+st.daily[-1]["netReturn"])*(st.nav/before)-1
        st.daily[-1]["equity"]=st.nav
        st.daily[-1]["turnover"] += turn


def pool_for(g: pd.DataFrame, prev: dict, style: str, gate: str) -> list[int]:
    p=g[
        (g.mom_pct>=.8)
        & (g.dr_beta60_spy>=.9)
        & (g.dr_log_dollarvol20>=.1)
        & (g.dr_amihud20>=.1)
    ].copy()
    pp=p.k.map(prev)
    p=p[pp.isna()|(pp<.8)]

    if style=="A":
        p=p[p.dr_ichimoku_tk_gap>=.8]
        sort=["mom_pct","dr_beta60_spy","dr_ichimoku_tk_gap","symbol"]
    else:
        p=p[p.dr_relvol1_20>=.8]
        if gate=="MBTV":
            p=p[p.dr_ichimoku_tk_gap>=.8]
        # Preserve MBV anchor ordering so the test isolates the added T gate.
        sort=["mom_pct","dr_beta60_spy","dr_relvol1_20","symbol"]
    return p.sort_values(sort,ascending=[False,False,False,True]).k.to_list()


def summarize(st: State) -> tuple[list[dict], dict]:
    d=pd.DataFrame(st.daily)
    t=pd.DataFrame(st.trades)
    rows=[]
    periods={
        "FULL": np.ones(len(d),dtype=bool),
        "TRAIN_2017_2022": d.date<pd.Timestamp("2023-01-01"),
        "RECENT_2023_2026": d.date>=pd.Timestamp("2023-01-01"),
    }
    for name,mask in periods.items():
        g=d.loc[mask]
        s=stats(g.netReturn)
        rows.append(dict(
            strategy=st.id,period=name,**s,
            avgPositions=g.positions.mean(),
            annualTurnover=g.turnover.sum()*252/len(g),
            entries=int(g.entries.sum()),
            lockedDays=int((g.lockedWeight>0).sum()),
        ))
    if len(t):
        r=pd.to_numeric(t.grossTradeReturn,errors="coerce")
        pos=r[r>0]
        tm=dict(
            strategy=st.id,tradeCount=len(t),winRate=float((r>0).mean()),
            medianTradeReturn=float(r.median()),winners100pct=int((r>=1).sum()),
            top10PositiveReturnMass=float(pos.nlargest(10).sum()/pos.sum()) if pos.sum()>0 else np.nan,
        )
    else:
        tm=dict(strategy=st.id,tradeCount=0)
    return rows,tm


def main() -> None:
    a=args()
    root=Path(a.input).resolve()
    out=Path(a.output).resolve()
    out.mkdir(parents=True,exist_ok=True)
    details=out/"details";details.mkdir(exist_ok=True)
    tmp=Path(os.environ.get("RUNNER_TEMP",str(out/".tmp")))/"us33-expanded-mbtv"
    tmp.mkdir(parents=True,exist_ok=True)

    con=duckdb.connect(str(tmp/"work.duckdb"))
    con.execute(f"SET memory_limit='{a.memory_limit}'")
    con.execute(f"SET threads={a.threads}")
    con.execute(f"SET temp_directory='{str(tmp)}'")

    panel=build_features(con,root,tmp)
    dates,names,ids,op,mark,ok,terminal,spy=prepare_prices(con,root)
    di={d:i for i,d in enumerate(dates)}

    states=[
        State("A_N15_SC2",15,2,"A","MBT"),
        State("A_N15_SCNONE",15,None,"A","MBT"),
        State("A_N20_SC2",20,2,"A","MBT"),
        State("A_N20_SCNONE",20,None,"A","MBT"),
        State("B_N15_SC3__MBV",15,3,"B","MBV"),
        State("B_N15_SC3__MBTV",15,3,"B","MBTV"),
        State("B_N15_SCNONE__MBV",15,None,"B","MBV"),
        State("B_N15_SCNONE__MBTV",15,None,"B","MBTV"),
        State("B_N20_SC3__MBV",20,3,"B","MBV"),
        State("B_N20_SC3__MBTV",20,3,"B","MBTV"),
        State("B_N20_SCNONE__MBV",20,None,"B","MBV"),
        State("B_N20_SCNONE__MBTV",20,None,"B","MBTV"),
    ]

    prev={}
    gate_diag=[]
    for path in sorted(panel.glob("year=*.parquet")):
        f=pd.read_parquet(path)
        f["dt"]=pd.to_datetime(f["dt"])
        f=f[f.mom_pct.notna()].copy()
        f["k"]=f.symbol.map(ids)
        f=f[f.k.notna()].copy()
        f["k"]=f.k.astype(int)
        for day,g in f.groupby("dt",sort=True):
            i=di.get(day)
            if i is None or i+2>=len(dates):
                continue
            rows={r.k:(r.mom_pct,r.sectorCode) for r in g.itertuples(index=False)}
            pools={
                ("A","MBT"):pool_for(g,prev,"A","MBT"),
                ("B","MBV"):pool_for(g,prev,"B","MBV"),
                ("B","MBTV"):pool_for(g,prev,"B","MBTV"),
            }
            gate_diag.append(dict(
                date=day,
                MBV_candidates=len(pools[("B","MBV")]),
                MBTV_candidates=len(pools[("B","MBTV")]),
            ))
            for st in states:
                ledger(st,i,rows,pools[(st.style,st.gate)],mark,ok,terminal,dates,names)
            prev.update({k:v[0] for k,v in rows.items()})
        print({"yearDone":path.name,"nav":{s.id:round(s.nav,4) for s in states}},flush=True)

    summary_rows=[];trade_rows=[]
    for st in states:
        finish(st,dates,ok,names)
        sr,tm=summarize(st)
        summary_rows+=sr;trade_rows.append(tm)
        pd.DataFrame(st.daily).to_csv(details/f"daily_{st.id}.csv",index=False)
        pd.DataFrame(st.trades).to_csv(details/f"trades_{st.id}.csv",index=False)

    summary=pd.DataFrame(summary_rows)
    trades=pd.DataFrame(trade_rows)
    summary.to_csv(out/"summary.csv",index=False)
    trades.to_csv(out/"trade_metrics.csv",index=False)
    pd.DataFrame(gate_diag).to_csv(out/"candidate_gate_daily.csv",index=False)

    parity=[]
    parity_ok=True
    full=summary[summary.period.eq("FULL")].set_index("strategy")
    for sid,expected in EXPECTED.items():
        actual=float(full.loc[sid,"CAGR"])
        diff=actual-expected
        okp=abs(diff)<=.01
        parity_ok = parity_ok and okp
        parity.append(dict(
            strategy=sid,expectedCAGR=expected,actualCAGR=actual,
            difference=diff,within1pp=okp
        ))
    pd.DataFrame(parity).to_csv(out/"parity_check.csv",index=False)

    pairs=[
        ("B_N15_SC3__MBV","B_N15_SC3__MBTV","N15_SC3"),
        ("B_N15_SCNONE__MBV","B_N15_SCNONE__MBTV","N15_SCNONE"),
        ("B_N20_SC3__MBV","B_N20_SC3__MBTV","N20_SC3"),
        ("B_N20_SCNONE__MBV","B_N20_SCNONE__MBTV","N20_SCNONE"),
    ]
    comp=[]
    blocked=[]
    for anchor,challenger,label in pairs:
        for period in ["FULL","TRAIN_2017_2022","RECENT_2023_2026"]:
            A=summary[(summary.strategy.eq(anchor))&(summary.period.eq(period))].iloc[0]
            C=summary[(summary.strategy.eq(challenger))&(summary.period.eq(period))].iloc[0]
            comp.append(dict(
                config=label,period=period,
                anchor="M+B+V",challenger="M+B+T+V",
                anchorCAGR=A.CAGR,challengerCAGR=C.CAGR,deltaCAGRpp=(C.CAGR-A.CAGR)*100,
                anchorSharpe=A.Sharpe,challengerSharpe=C.Sharpe,deltaSharpe=C.Sharpe-A.Sharpe,
                anchorMDD=A.MDD,challengerMDD=C.MDD,deltaMDDpp=(C.MDD-A.MDD)*100,
                anchorTurnover=A.annualTurnover,challengerTurnover=C.annualTurnover,
                anchorAvgPositions=A.avgPositions,challengerAvgPositions=C.avgPositions,
                anchorEntries=A.entries,challengerEntries=C.entries,
            ))
        ae=set(next(s for s in states if s.id==anchor).entry_events)
        ce=set(next(s for s in states if s.id==challenger).entry_events)
        atr=pd.DataFrame(next(s for s in states if s.id==anchor).trades)
        if len(atr):
            atr["entryKey"]=list(zip(atr.entryDate.astype(str),atr.symbol.astype(str)))
            filtered=atr[~atr.entryKey.isin({(d,s) for d,s in ce})]
            for r in filtered[filtered.grossTradeReturn>=1].itertuples(index=False):
                blocked.append(dict(
                    config=label,symbol=r.symbol,entryDate=r.entryDate,exitDate=r.exitDate,
                    anchorGrossTradeReturn=r.grossTradeReturn
                ))
    comparison=pd.DataFrame(comp)
    comparison.to_csv(out/"balanced_comparison.csv",index=False)
    pd.DataFrame(blocked).to_csv(out/"blocked_100pct_winners.csv",index=False)

    fullcomp=comparison[comparison.period.eq("FULL")]
    robust_count=int(((fullcomp.deltaCAGRpp>0)&(fullcomp.deltaSharpe>0)).sum())
    decision={
        "researchQuestion":"Expanded-universe validation of adding T to Balanced M+B+V while Aggressive stays frozen at M+B+T.",
        "aggressiveDecision":"M+B+T frozen; used only as reproduction control.",
        "balancedComparison":"M+B+V versus M+B+T+V",
        "sorting":"Challenger preserves MBV candidate ordering; T is an added gate only.",
        "universe":"Sharadar expanded universe including delisted securities, common-stock and point-in-time exchange eligibility.",
        "execution":"ledger, t+1 adjusted open, 15bp one-way cost, corporate-terminal handling, verified event overrides",
        "parityPassed":bool(parity_ok),
        "positiveCAGRAndSharpeConfigs":robust_count,
        "requiresREAL1Followup":bool(parity_ok and robust_count>=3),
        "comparison":fullcomp.to_dict("records"),
    }
    (out/"decision.json").write_text(json.dumps(decision,indent=2,default=str),encoding="utf-8")
    print(json.dumps(decision,indent=2,default=str),flush=True)

    con.close();gc.collect()
    if not parity_ok:
        raise RuntimeError("Expanded-universe anchor parity failed; challenger results are not valid.")


if __name__=="__main__":
    main()
