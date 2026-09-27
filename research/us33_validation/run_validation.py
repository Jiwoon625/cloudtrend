"""Frozen US3.3 validation; original arithmetic replay plus executable-quote ledger."""
from pathlib import Path
import json,gc,math,os
import numpy as np
import pandas as pd
import duckdb

OUT=Path(os.environ.get('US33_DATA_ROOT','/content/drive/MyDrive/미국주식데이터'))/'US33_validation_20260927'
RUNTIME=Path(os.environ.get('US33_RUNTIME_ROOT','/content'))
LOCAL=RUNTIME/'us33_work'
CONFIGS=[dict(style=s,n=n,cap=c,id=f'{s}_N{n}_SC{c if c else "NONE"}')
         for s in ['AGGRESSIVE','BALANCED'] for n in [15,20] for c in [2 if s=='AGGRESSIVE' else 3,None]]

def log(x):print(json.dumps(x,ensure_ascii=False,default=str),flush=True)
def stats(r):
    r=np.asarray(r,float);e=np.cumprod(1+r);vol=np.std(r,ddof=1)
    return dict(days=len(r),CAGR=e[-1]**(252/len(r))-1,Sharpe=np.mean(r)/vol*np.sqrt(252) if vol else 0,
                MDD=np.min(e/np.maximum.accumulate(np.r_[1,e])[1:]-1),totalReturn=e[-1]-1)

class State:
    def __init__(self,c,mode,cost=.0015,stress=False):
        self.c=c;self.mode=mode;self.cost=cost;self.stress=stress
        self.id=c['id']+('_ZERO' if stress else '')+('_COST2' if cost>.0015 else '')
        self.nav=1.;self.cash=1.;self.p={};self.daily=[];self.trades=[];self.attr={};self.events=[]
    def pnl(self,k,x):self.attr[k]=self.attr.get(k,0.)+x

def prepare_prices(con,legacy=False):
    dates=pd.DatetimeIndex(con.sql("SELECT dt FROM old_bench WHERE dt>='2017-01-01' ORDER BY dt").df().dt)
    # Signals on day t, execution at t+1, valuation at t+2. Same calendar as prior research.
    names=con.sql('SELECT DISTINCT symbol FROM old_prices ORDER BY symbol' if legacy else 'SELECT symbol FROM shar_prices UNION SELECT ticker FROM security ORDER BY 1').df().iloc[:,0].tolist()
    ids={s:i for i,s in enumerate(names)};ds={d.date():i for i,d in enumerate(dates)}
    op=np.full((len(dates),len(names)),np.nan);cl=op.copy();ok=np.zeros(op.shape,dtype=bool)
    for year in range(2017,dates[-1].year+1):
        query=(f"SELECT symbol,dt,open op,close cl,volume FROM old_prices WHERE year(dt)={year}" if legacy else
               f"SELECT symbol,dt,open*closeadj/NULLIF(close,0) op,closeadj cl,volume FROM shar_prices WHERE year(dt)={year}")
        p=con.sql(query).df();p=p[p.dt.isin(dates)]
        ii=p.dt.map(lambda x:ds[x.date()]);jj=p.symbol.map(ids)
        assert ii.notna().all() and jj.notna().all(), 'Unmapped price identity or calendar date'
        ii=ii.to_numpy(dtype=np.int64);jj=jj.to_numpy(dtype=np.int64)
        oo=p.op.to_numpy(float);cc=p.cl.to_numpy(float)
        op[ii,jj]=np.where(np.isfinite(oo)&(oo>0),oo,np.nan)
        cl[ii,jj]=np.where(np.isfinite(cc)&(cc>0),cc,np.nan)
        ok[ii,jj]=np.isfinite(oo)&(oo>0)&(p.volume.to_numpy()>0)
    # Daily valuation uses executable open, otherwise most recent observed close.
    mark=np.empty_like(op);last=np.full(len(names),np.nan)
    for i in range(len(dates)):
        mark[i]=np.where(ok[i],op[i],last)
        last=np.where(np.isfinite(cl[i]),cl[i],last)
    terminal={};terminal_rows=[]
    if not legacy:
        actions=con.sql("SELECT * FROM actions WHERE action IN ('delisted','bankruptcyliquidation','acquisitioncash','acquisitionstock','acquisitionelectcash','acquisitionelectstock')").df()
        lastpx=con.sql('SELECT symbol,arg_max(closeadj,dt) ca,arg_max(closeunadj,dt) cu,max(dt) last_dt FROM shar_prices GROUP BY symbol').df().set_index('symbol')
        acqpx=con.sql("SELECT a.ticker,a.date,a.action,a.value,p.closeunadj FROM actions a LEFT JOIN prices p ON a.contraticker=p.ticker AND a.date=p.date WHERE a.action IN ('acquisitionstock','acquisitionelectstock')").df()
        stockval={(r.ticker,pd.Timestamp(r.date),r.action):r.value*r.closeunadj for r in acqpx.itertuples()}
        for symbol,g in actions.groupby('ticker'):
            if symbol not in ids or symbol not in lastpx.index:continue
            lp=lastpx.loc[symbol];end=pd.Timestamp(lp['last_dt'])
            d=int(dates.searchsorted(end,side='right'))
            if d==0 or d>=len(dates):continue
            g=g[g.date==end]
            if not len(g) or not g.action.isin(['delisted','bankruptcyliquidation']).any():continue
            cash=g[g.action=='acquisitioncash'].value.sum()
            stocks=[stockval.get((symbol,end,'acquisitionstock'),np.nan)] if (g.action=='acquisitionstock').any() else []
            known=((g.action=='acquisitioncash').any() or len(stocks)) and all(np.isfinite(stocks))
            consideration=cash+sum(stocks)
            # Election/proration is unresolved: never assume both alternatives are received.
            if g.action.str.contains('elect').any():known=False
            k=ids[symbol]
            if known and lp.cu>0:
                value=consideration*lp.ca/lp.cu;mark[d:,k]=value
            else:value=float(mark[d,k])
            terminal[k]=dict(day=d,known=bool(known),value=value,symbol=symbol,bankruptcy=bool((g.action=='bankruptcyliquidation').any()))
            terminal_rows.append(dict(symbol=symbol,last_trade=end,effective_model_date=dates[d],known_consideration=bool(known),adjusted_value=value,
                                      assumption='next_session_cash_equivalent' if known else 'locked_last_mark_or_zero_stress'))
        pd.DataFrame(terminal_rows).to_csv(OUT/'terminal_event_assumptions.csv',index=False)
    del cl;gc.collect()
    spyold=con.sql("SELECT dt,spy_close FROM old_bench WHERE dt>='2017-01-01' ORDER BY dt").df().set_index('dt').reindex(dates).spy_close.to_numpy()
    spynew=con.sql("SELECT date dt,open*closeadj/close op FROM bench_prices WHERE ticker='SPY'").df().set_index('dt').reindex(dates).op.to_numpy()
    return dates,names,ids,op,mark,ok,terminal,spyold,spynew

def replay(st,i,rows,pools,op,dates,spy,names):
    cfg=st.c;cut=.7 if cfg['style']=='AGGRESSIVE' else .5
    oldw={k:v['w'] for k,v in st.p.items()};removed=[];added=[]
    for k in list(st.p):
        if k not in rows or not np.isfinite(rows[k][0]) or rows[k][0]<cut:
            p=st.p.pop(k);removed.append(k)
            st.trades.append(dict(symbol=names[k],entryDate=p['date'],exitDate=dates[i+1],exitReason='RANK_OR_MISSING',grossTradeReturn=p['cum']-1))
    counts={}
    for p in st.p.values():counts[p['sec']]=counts.get(p['sec'],0)+1
    for k in pools[cfg['style']]:
        if len(st.p)>=cfg['n']:break
        if k in st.p:continue
        sec=rows[k][1]
        if cfg['cap'] and counts.get(sec,0)>=cfg['cap']:continue
        st.p[k]=dict(sec=sec,w=0.,date=dates[i+1],cum=1.);added.append(k);counts[sec]=counts.get(sec,0)+1
    tgt={k:1/len(st.p) for k in st.p} if added or removed else {k:p['w'] for k,p in st.p.items()}
    if tgt:
        sm=sum(tgt.values());tgt={k:v/sm for k,v in tgt.items()}
    dw={k:abs(tgt.get(k,0)-oldw.get(k,0)) for k in set(tgt)|set(oldw)}
    turn=sum(dw.values());cost=turn*st.cost;before=st.nav;gross=0.;miss=0.;rr={}
    for k,w in tgt.items():
        r=op[i+2,k]/op[i+1,k]-1
        if not np.isfinite(r):r=0.;miss+=w
        rr[k]=r;gross+=w*r;st.p[k]['cum']*=1+r;st.pnl(k,before*(1-cost)*w*r)
    for k,v in dw.items():st.pnl(k,-before*st.cost*v)
    st.nav=before*(1-cost)*(1+gross)
    for k in st.p:st.p[k]['w']=tgt[k]*(1+rr[k])/(1+gross)
    st.daily.append(dict(date=dates[i+1],netReturn=st.nav/before-1,spyReturn=spy[i+2]/spy[i+1]-1,equity=st.nav,
                         positions=len(st.p),turnover=turn,missingWeight=miss,lockedWeight=0.,entries=len(added),exits=len(removed)))

def ledger(st,i,rows,pools,mark,ok,terminal,dates,spy,names):
    # Holdings are marked dollar amounts, cash is explicit; no sale at an absent quote.
    cfg=st.c;cut=.7 if cfg['style']=='AGGRESSIVE' else .5;d=i+1
    before=st.nav;changed=False;entries=0;exits=0;turn=0.
    for k in list(st.p):
        p=st.p[k];t=terminal.get(k)
        if t and d>=t['day'] and (t['known'] or st.stress):
            st.cash+=p['v'];st.p.pop(k);changed=True;exits+=1
            st.events.append(dict(symbol=names[k],date=dates[d],kind='known_consideration' if t['known'] else 'zero_recovery_stress',value=p['v']))
            st.trades.append(dict(symbol=names[k],entryDate=p['date'],exitDate=dates[d],exitReason='CORPORATE_TERMINAL',grossTradeReturn=p['cum']-1))
            continue
        rank=rows[k][0] if k in rows else np.nan
        if (not np.isfinite(rank) or rank<cut) and ok[d,k]:
            fee=p['v']*st.cost;st.cash+=p['v']-fee;turn+=p['v']/before;st.pnl(k,-fee)
            st.p.pop(k);changed=True;exits+=1
            st.trades.append(dict(symbol=names[k],entryDate=p['date'],exitDate=dates[d],exitReason='RANK_OR_UNIVERSE',grossTradeReturn=p['cum']-1))
    counts={}
    for k,p in st.p.items():
        if k in rows:p['sec']=rows[k][1]
        counts[p['sec']]=counts.get(p['sec'],0)+1
    for k in pools[cfg['style']]:
        if len(st.p)>=cfg['n']:break
        if k in st.p or not ok[d,k]:continue
        sec=rows[k][1]
        if cfg['cap'] and counts.get(sec,0)>=cfg['cap']:continue
        st.p[k]=dict(v=0.,sec=sec,date=dates[d],cum=1.);entries+=1;changed=True;counts[sec]=counts.get(sec,0)+1
    live=[k for k in st.p if ok[d,k]]
    if changed and live:
        available=st.cash+sum(st.p[k]['v'] for k in live);target=available/len(live)
        for _ in range(15):target=(available-st.cost*sum(abs(target-st.p[k]['v']) for k in live))/len(live)
        fees=st.cost*sum(abs(target-st.p[k]['v']) for k in live)
        for k in live:
            dv=abs(target-st.p[k]['v']);turn+=dv/before;st.pnl(k,-st.cost*dv);st.p[k]['v']=target
        st.cash=max(0.,available-target*len(live)-fees)
    locked=sum(p['v'] for k,p in st.p.items() if not ok[d,k])/before
    for k,p in st.p.items():
        t=terminal.get(k)
        if st.stress and t and not t['known'] and d+1>=t['day']:r=-1. if d<t['day'] else 0.
        else:r=mark[d+1,k]/mark[d,k]-1 if mark[d,k]>0 else 0.
        if not np.isfinite(r):raise RuntimeError(f'Unvalued held security {names[k]} {dates[d]}')
        pnl=p['v']*r;p['v']+=pnl;p['cum']*=1+r;st.pnl(k,pnl)
    st.nav=st.cash+sum(p['v'] for p in st.p.values())
    assert st.nav>=-1e-10 and st.cash>=-1e-10
    st.daily.append(dict(date=dates[d],netReturn=st.nav/before-1,spyReturn=spy[d+1]/spy[d]-1,equity=st.nav,
                         positions=len(st.p),turnover=turn,missingWeight=0.,lockedWeight=locked,entries=entries,exits=exits))

def finish(st,names,dataset):
    # Prior engine has terminal sale fee; corrected ledger charges only executable positions in run().
    d=pd.DataFrame(st.daily);d['config']=st.id;d['dataset']=dataset;d['engine']=st.mode
    d.to_csv(OUT/f'daily_{dataset}_{st.mode}_{st.id}.csv',index=False)
    t=pd.DataFrame(st.trades);t.to_csv(OUT/f'trades_{dataset}_{st.mode}_{st.id}.csv',index=False)
    pd.DataFrame([dict(symbol=names[k],netPnl=v) for k,v in sorted(st.attr.items(),key=lambda x:-x[1])]).to_csv(OUT/f'attribution_{dataset}_{st.mode}_{st.id}.csv',index=False)
    if st.events:pd.DataFrame(st.events).to_csv(OUT/f'events_{dataset}_{st.id}.csv',index=False)
    assert abs(sum(st.attr.values())-(st.nav-1))<1e-7*max(1,st.nav),('attribution',dataset,st.id,st.nav,sum(st.attr.values()))
    summaries=[]
    for period,mask in [('full',np.ones(len(d),bool)),('train',d.date<'2023-01-01'),('reviewed',d.date>='2023-01-01')]+[(str(y),d.date.dt.year==y) for y in sorted(d.date.dt.year.unique())]:
        g=d[mask]
        summaries.append(dict(dataset=dataset,engine=st.mode,config=st.id,style=st.c['style'],n=st.c['n'],cap=st.c['cap'],period=period,
                              **stats(g.netReturn),spyCAGR=stats(g.spyReturn)['CAGR'],avgPositions=g.positions.mean(),annualTurnover=g.turnover.sum()*252/len(g),
                              lockedDays=int((g.lockedWeight>0).sum()),maxLockedWeight=g.lockedWeight.max(),missingDays=int((g.missingWeight>0).sum())))
    return summaries

def run():
    con=duckdb.connect(str(RUNTIME/'us33_validation.duckdb'));con.execute("SET memory_limit='3GB'");con.execute('SET threads=2')
    log({'RUNNER_REVISION':4})
    # Same matched IDs in old and new feeds: isolate feed/history coverage from the 56 unmatched securities.
    def pct(col,reverse=False):
        e=f'(RANK() OVER(PARTITION BY dt ORDER BY {col} NULLS LAST)-1)::DOUBLE/NULLIF(COUNT({col}) OVER(PARTITION BY dt)-1,0)'
        return f'CASE WHEN {col} IS NULL THEN NULL ELSE '+(f'1-({e})' if reverse else e)+' END'
    feats=['ret120','ret252','beta60_spy','ichimoku_tk_gap','relvol1_20','log_dollarvol20','amihud20']
    ranks=','.join(f'{pct(f,f=="amihud20")} dr_{f}' for f in feats)
    if not (LOCAL/'legacy_matched'/'year=2026.parquet').exists():
        con.execute(f'''CREATE OR REPLACE TABLE ranked_legacy_matched AS WITH u AS (
      SELECT f.*,s.sectorCode FROM old_features f JOIN old_sectors s USING(symbol)
      WHERE f.symbol IN (SELECT old_symbol FROM security WHERE old_symbol IS NOT NULL) AND dt>=DATE '2017-01-01'),
      r AS(SELECT *,{ranks} FROM u),m AS(SELECT *,0.5*dr_ret120+0.5*dr_ret252 mom_score FROM r)
      SELECT *,{pct('mom_score')} mom_pct FROM m''')
    folder=LOCAL/'legacy_matched';folder.mkdir(exist_ok=True)
    for year in range(2017,2027):
        if (folder/f'year={year}.parquet').exists():continue
        con.execute(f"COPY(SELECT symbol,dt,sectorCode,mom_pct,dr_beta60_spy,dr_ichimoku_tk_gap,dr_relvol1_20,dr_log_dollarvol20,dr_amihud20 FROM ranked_legacy_matched WHERE year(dt)={year} ORDER BY dt,symbol) TO '{folder/f'year={year}.parquet'}' (FORMAT PARQUET,COMPRESSION ZSTD)")
    only_new=os.environ.get('US33_ONLY_NEW')=='1'
    summaries=pd.read_csv(OUT/'validation_summary.csv').query("dataset in ['legacy','legacy_matched']").to_dict('records') if only_new else []
    for legacy in ([False] if only_new else [True,False]):
        dates,names,ids,op,mark,ok,terminal,spyold,spynew=prepare_prices(con,legacy)
        di={d:i for i,d in enumerate(dates)}
        datasets=['legacy','legacy_matched'] if legacy else ['matched_source','matched_pit','survivor_pit','full_pit']
        for dataset in datasets:
            states=[State(c,'replay') for c in CONFIGS] if legacy else []
            states += [State(c,'ledger') for c in CONFIGS]
            if dataset=='full_pit':states += [State(c,'ledger',stress=True) for c in CONFIGS]+[State(c,'ledger',cost=.003) for c in CONFIGS]
            prev={}
            for path in sorted((LOCAL/dataset).glob('year=*.parquet')):
                f=pd.read_parquet(path);f['dt']=pd.to_datetime(f['dt']);f=f[f.mom_pct.notna()];f['k']=f.symbol.map(ids)
                for day,g in f.groupby('dt',sort=True):
                    i=di.get(day)
                    if i is None or i+2>=len(dates):continue
                    rows={r.k:(r.mom_pct,r.sectorCode) for r in g.itertuples(index=False)}
                    p=g[(g.mom_pct>=.8)&(g.dr_beta60_spy>=.9)&(g.dr_log_dollarvol20>=.1)&(g.dr_amihud20>=.1)].copy()
                    pp=p.k.map(prev);p=p[pp.isna()|(pp<.8)]
                    pools={}
                    for style,fc in [('AGGRESSIVE','dr_ichimoku_tk_gap'),('BALANCED','dr_relvol1_20')]:
                        pools[style]=p[p[fc]>=.8].sort_values(['mom_pct','dr_beta60_spy',fc,'symbol'],ascending=[False,False,False,True]).k.to_list()
                    for st in states:
                        if st.mode=='replay':replay(st,i,rows,pools,op,dates,spyold,names)
                        else:ledger(st,i,rows,pools,mark,ok,terminal,dates,spynew,names)
                    prev.update({k:v[0] for k,v in rows.items()})
                log({'dataset':dataset,'year':path.name,'nav':{s.id+':'+s.mode:round(s.nav,4) for s in states}})
            for st in states:
                last=len(dates)-1;fee=0.;turn=0.
                for k,p in st.p.items():
                    value=st.nav*p['w'] if st.mode=='replay' else p['v']
                    if st.mode=='replay' or ok[last,k]:
                        fee+=st.cost*value;turn+=value/st.nav;st.pnl(k,-st.cost*value)
                    st.trades.append(dict(symbol=names[k],entryDate=p['date'],exitDate=dates[last],exitReason='END_MARK' if not ok[last,k] else 'END_OF_SAMPLE',grossTradeReturn=p['cum']-1))
                before=st.nav;st.nav-=fee;st.daily[-1]['netReturn']=(1+st.daily[-1]['netReturn'])*(st.nav/before)-1
                st.daily[-1]['equity']=st.nav;st.daily[-1]['turnover']+=turn
                summaries+=finish(st,names,dataset)
            pd.DataFrame(summaries).to_csv(OUT/'validation_summary.csv',index=False)
            log({'COMPLETE_DATASET':dataset})
        del op,mark,ok;gc.collect()
    con.close();log({'VALIDATION_COMPLETE':str(OUT)})

if __name__=='__main__':run()
