"""Frozen US3.8 replay: baseline gate first, then non-promotable diagnostics.

Run in the authorized Colab runtime. Writes research artifacts only below US38.
No historical eligibility/sector snapshot is represented as certified PIT.
"""
from pathlib import Path
import ast, gc, hashlib, importlib.util, json, os, shutil, sys, time, zipfile
from dataclasses import asdict, replace
import numpy as np
import pandas as pd
import duckdb

ROOT = Path('/content/drive/MyDrive/미국주식데이터')
BASE = ROOT/'US38_robustness_gate_20260928'
RUN_ID = os.environ.get('US38_RUN_ID', time.strftime('replay_%Y%m%dT%H%M%SZ', time.gmtime()))
OUT = BASE/RUN_ID
OUT.mkdir(parents=True, exist_ok=True)
TMP = Path('/content/us38_gate'); TMP.mkdir(exist_ok=True)
REF = ROOT/'US34_sensitivity_20260927'/'final'
OLD = ROOT/'US33_validation_20260927'
PREV = ROOT/'US35_followup_20260928'
CONTROLLED = ROOT/'US37_start2023_controlled_20260928'
ANCHOR = 'b4d47858bccd5b732b88af9b14368ac9581e770a'
VARIANTS = ['A0_event','A0_quarter','A0_bimonth','A2_event','A2_quarter','A2_week','B3_w50','B3_w55','B3_beta60d3']
CANDIDATES = ['A0_quarter','A0_bimonth','A2_quarter','A2_week','B3_w55','B3_beta60d3']
def write_json(name, data):
    (OUT/name).write_text(json.dumps(data, indent=2, default=str, ensure_ascii=False))
def sha(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for b in iter(lambda:f.read(8*1024*1024),b''):h.update(b)
    return h.hexdigest()
print('US38_RUN_DIRECTORY', OUT, flush=True)
shutil.copy2(__file__,OUT/'run_us38_gate.py')
source=(CONTROLLED/'us37_controlled_core.py').read_text()
assert 'persist_orders:bool=False' in source and 'initial_capital:float=100000.' in source
(TMP/'us38_controlled_core.py').write_text(source)
spec=importlib.util.spec_from_file_location('us38_controlled_core',TMP/'us38_controlled_core.py')
module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
Config,Ledger,pool_for=module.Config,module.Ledger,module.pool_for
old_design=json.loads((PREV/'design_frozen.json').read_text())
assert old_design['sourceCommit']==ANCHOR
frozen={v:Config(**{**next(c for c in old_design['configs'] if c['id']==v),'persist_orders':True}) for v in VARIANTS}
for c in frozen.values():
    assert c.participation==.01 and c.cost==.0025 and c.initial_capital==100000.
source_paths=[PREV/'us35_core.py',PREV/'design_frozen.json',CONTROLLED/'us37_controlled_core.py',CONTROLLED/'run_us37_controlled.py',REF/'prepare_us34.py',REF/'run_us34.py',REF/'corporate_event_corrections.json',OLD/'run_validation.py',OLD/'verified_events.py',PREV/'mapping_v2.csv']
source_hashes={str(p.relative_to(ROOT)):sha(p) for p in source_paths}
write_json('source_provenance.json',dict(anchor=ANCHOR,researchCommit=os.environ.get('US38_CODE_COMMIT'),sourceHashes=source_hashes,corporateRevision=3,mapping='20260927_r2',strictPIT='NOT PASSED / PENDING'))

# Exact frozen US3.5 input preparation, isolated output and temporary directories.
prep=(REF/'prepare_us34.py').read_text().split("for version in ['v1','v2']:")[0]
assert "OUT=ROOT/'US34_sensitivity_20260927'" in prep
prep=prep.replace("OUT=ROOT/'US34_sensitivity_20260927'",f'OUT=Path({str(OUT)!r})').replace('/content/us34',str(TMP))
exec(compile(prep,'frozen_input_preparation','exec'),globals())
assert sha(OUT/'mapping_v2.csv')==sha(PREV/'mapping_v2.csv'), 'Mapping revision drift'
con.execute(f"CREATE OR REPLACE TABLE ranks_v2 AS SELECT *,{ranks} FROM features WHERE {allow} AND symbol IN (SELECT ticker FROM mapv2 WHERE commonEquityEligible) AND dt BETWEEN '2017-01-01' AND '2026-09-23'")
weights=[45,50,55,60]
(TMP/'v2').mkdir(exist_ok=True)
for year in range(2017,2027):
    scores=','.join(f'{w/100:.2f}*r_ret120+{(100-w)/100:.2f}*r_ret252 s{w}' for w in weights)
    moms=','.join(f'{pct("s"+str(w))} m{w}' for w in weights)
    path=TMP/'v2'/f'{year}.parquet'
    con.execute(f"COPY (WITH a AS (SELECT *,{scores} FROM ranks_v2 WHERE year(dt)={year}) SELECT symbol,dt,r_beta60_spy beta,r_ichimoku_tk_gap trend,r_relvol1_20 vol,r_log_dollarvol20 liq,r_amihud20 ami,{moms} FROM a ORDER BY dt,symbol) TO '{path}' (FORMAT PARQUET,COMPRESSION ZSTD)")
    print('RANKS_READY',year,flush=True)
con.close();gc.collect()
runner=(REF/'run_us34.py').read_text()
prefix=runner.split('configs=configurations()')[0].replace('from us34_core import Config,Ledger,configurations,pool_for','')
prefix=prefix.replace("OUT=ROOT/'US34_sensitivity_20260927'",f'OUT=Path({str(OUT)!r})').replace('/content/us34',str(TMP))
exec(compile(prefix,'frozen_price_preparation','exec'),globals())
for ev in json.loads((REF/'corporate_event_corrections.json').read_text()):
    k=ids[ev['symbol']];d=int(dates.searchsorted(pd.Timestamp(ev['date'])))
    assert dates[d]==pd.Timestamp(ev['date'])
    mark[d:,k]=ev['adjustedEquivalent']
    terminal[k]=dict(day=d,known=True,value=ev['adjustedEquivalent'],symbol=ev['symbol'],bankruptcy=False)
tree=ast.parse(runner.replace('st.nav-100000','st.nav-st.c.initial_capital'))
exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='end_fee'],type_ignores=[]),'frozen_end_fee','exec'),globals())
print('PRICE_ARRAYS_READY',mark.shape,flush=True)

def schedule(freq,d):
    cur=dates[d];prior=dates[d-1]
    if freq.startswith('d') and freq[1:].isdigit():return d>0 and (d-1)%int(freq[1:])==0
    if freq=='week':return cur.to_period('W-FRI')!=prior.to_period('W-FRI')
    if freq=='month':return cur.to_period('M')!=prior.to_period('M')
    if freq=='bimonth':return cur.to_period('M')!=prior.to_period('M') and cur.month%2==1
    if freq=='quarter':return cur.to_period('Q')!=prior.to_period('Q')
    return False

class AuditedLedger(Ledger):
    def __init__(self,c,meta):
        super().__init__(c);self.meta=meta;self.backlog=[];self.ages={};self.violations=0
        self.started=False;self.excluded=set(meta.get('exclude_ids',[]))
    def step(self,*args):
        if not self.started:
            assert not self.p and not self.pending and self.cash==self.c.initial_capital
            self.started=True;self.first_date=args[1]
        start=len(self.orders);super().step(*args);sums={}
        for _,k,reason,amount,fee,a,dv,route in self.orders[start:]:
            sums[k]=sums.get(k,0)+abs(amount)
            if self.c.participation and sums[k]>self.c.participation*min(a,dv)+1e-6:self.violations+=1
        pending=set(self.pending)|{k for k,p in self.p.items() if p.get('exit_pending')}
        self.ages={k:self.ages.get(k,0)+1 for k in pending}
        self.backlog.append((args[1],len(pending),max(self.ages.values(),default=0),sum(p['v'] for p in self.p.values() if p.get('exit_pending'))/self.nav,sum(abs(t-self.p[k]['v']) for k,t in self.pending.items() if k in self.p)/self.nav))

def metrics(g):
    r=g['return'].to_numpy(float);b=g.spyReturn.to_numpy(float);n=len(r)
    assert n and np.isfinite(r).all() and np.isfinite(b).all() and (r>-1).all()
    e=np.cumprod(1+r);cagr=e[-1]**(252/n)-1;spy_cagr=np.prod(1+b)**(252/n)-1
    return dict(days=n,CAGR=cagr,MDD=float(np.min(e/np.maximum.accumulate(np.r_[1.,e])[1:]-1)),Sharpe=float(r.mean()/r.std(ddof=1)*np.sqrt(252)) if n>1 and r.std(ddof=1)>0 else 0.,totalReturn=float(e[-1]-1),SPY_CAGR=spy_cagr,excessCAGR=cagr-spy_cagr,annualTurnover=float(g.turnover.sum()*252/n))

all_summary=[];all_audit=[];all_cases={};baseline_daily={};baseline_attr={}
def save_state(st,phase):
    residual=end_fee(st);cid=st.c.id
    folder=OUT/phase;folder.mkdir(exist_ok=True)
    cols=['date','return','spyReturn','equity','positions','turnover','cashWeight','lockedWeight','entries','exits','regime']
    df=pd.DataFrame(st.daily,columns=cols);df.date=pd.to_datetime(df.date)
    df.to_csv(folder/f'daily_{cid}.csv',index=False)
    attr=pd.DataFrame([(names[k],v) for k,v in st.attr.items()],columns=['symbol','netPnl']).sort_values('netPnl',ascending=False)
    attr.to_csv(folder/f'attr_{cid}.csv',index=False)
    detail=TMP/'case_details'/phase;detail.mkdir(parents=True,exist_ok=True)
    orders=pd.DataFrame(st.orders,columns=['date','k','reason','signedUsd','fee','adv20','sameDayDollarVolume','route'])
    if len(orders):orders['symbol']=orders.k.map(lambda k:names[k]);orders=orders.drop(columns='k')
    orders.to_csv(detail/f'orders_{cid}.csv.gz',index=False)
    backlog=pd.DataFrame(st.backlog,columns=['date','pendingCount','oldestDays','exitWeight','targetGapWeight'])
    backlog.to_csv(detail/f'backlog_{cid}.csv.gz',index=False)
    events=pd.DataFrame(st.events,columns=['date','k','valueUsd','event'])
    if len(events):events['symbol']=events.k.map(lambda k:names[k]);events=events.drop(columns='k')
    events.to_csv(detail/f'events_{cid}.csv.gz',index=False)
    all_audit.append(dict(case=cid,phase=phase,orders=len(orders),rejected=st.rejected,partialOrders=st.partial,feesUSD=st.fees,corporateSettlements=len(events),finalResidualUSD=residual,maxAccountingError=st.max_error,capacityViolations=st.violations,pendingDays=int((backlog.pendingCount>0).sum()),maxPendingAge=int(backlog.oldestDays.max()),maxExitWeight=float(backlog.exitWeight.max()),firstDate=st.first_date,initialCash=st.c.initial_capital,freshCashVerified=True))
    all_cases[cid]={'config':asdict(st.c),'diagnostic':st.meta,'phase':phase}
    for period,g in [('full',df),('2017_2022',df[df.date<'2023-01-01']),('2023_2026',df[df.date>='2023-01-01'])]+[(str(y),g) for y,g in df.groupby(df.date.dt.year)]:
        if len(g):all_summary.append(dict(case=cid,variant=st.meta['variant'],phase=phase,period=period,start=str(g.date.iloc[0].date()),end=str(g.date.iloc[-1].date()),**metrics(g)))
    if phase=='baseline':baseline_daily[cid]=df;baseline_attr[cid]=attr

def replay(cases,phase):
    states=[AuditedLedger(c,m) for c,m in cases];ws=sorted({s.c.weight for s in states});prev={w:{} for w in ws}
    print('PHASE_BEGIN',phase,'CASES',len(states),flush=True)
    for year in range(2017,2027):
        f=pd.read_parquet(TMP/'v2'/f'{year}.parquet');f['k']=f.symbol.map(ids);f['sec']=f.symbol.map(mapping).fillna('UNKNOWN')
        for day,g in f.groupby('dt',sort=True):
            i=di.get(pd.Timestamp(day));d=i+1 if i is not None else -1
            if i is None or i+2>=len(dates):continue
            data=g[['k','beta','trend','vol','liq','ami','sec']].to_numpy();rows={};eligible={};pools={}
            for w in ws:
                mm=g[f'm{w}'].to_numpy()
                rows[w]={int(r[0]):(float(m),float(r[1]),float(r[2]),float(r[3]),float(r[4]),float(r[5]),r[6]) for r,m in zip(data,mm) if np.isfinite(m)}
                eligible[w]={k:r for k,r in rows[w].items() if r[0]>=.8 and (prev[w].get(k,np.nan)<.8 or not np.isfinite(prev[w].get(k,np.nan))) and r[1]>=.9 and r[4]>=.1 and r[5]>=.1}
            for st in states:
                c=st.c
                if dates[d]<pd.Timestamp(st.meta.get('start','2017-01-01')):continue
                key=(c.weight,c.policy,c.mode)
                if key not in pools:pools[key]=pool_for(c,eligible[c.weight],prev[c.weight],adv[i])
                pool=pools[key] if not st.excluded else [(k,r) for k,r in pools[key] if k not in st.excluded]
                st.step(d,str(dates[d].date()),rows[c.weight],pool,mark[d],mark[d+1],ok[d],adv[i],active[i],rawopen[d],dvol[d],terminal,schedule(c.frequency,d),reg[i],spy[d+1]/spy[d]-1)
            for w in ws:prev[w].update({k:r[0] for k,r in rows[w].items()})
        print('SIMULATED_YEAR',phase,year,flush=True)
    for st in states:save_state(st,phase)
    assert sum(st.violations for st in states)==0,'Participation control violation'
    pd.DataFrame(all_summary).to_csv(OUT/'all_metrics.csv',index=False)
    pd.DataFrame(all_audit).to_csv(OUT/'execution_audit.csv',index=False)
    write_json('case_manifest.json',all_cases)
    print('PHASE_COMPLETE',phase,len(states),flush=True)
    del states,f;gc.collect()

replay([(frozen[v],dict(variant=v,kind='frozen_baseline')) for v in VARIANTS],'baseline')
parity=[]
for v in VARIANTS:
    a=baseline_daily[v];b=pd.read_csv(PREV/f'daily_v3_{v}.csv');b.date=pd.to_datetime(b.date)
    same=a.date.equals(b.date) and not a.date.duplicated().any()
    valid=bool(np.isfinite(a['return']).all() and np.isfinite(b['return']).all())
    err=float(np.max(abs(a['return'].to_numpy()-b['return'].to_numpy()))) if same and valid else float('inf')
    parity.append(dict(config=v,sameDates=same,finiteReturns=valid,days=len(a),maxDailyReturnError=err,tolerance=1e-10,passed=same and valid and err<1e-10))
pd.DataFrame(parity).to_csv(OUT/'us38_baseline_parity_us35.csv',index=False)
write_json('baseline_gate.json',dict(passed=all(p['passed'] for p in parity),checks=parity))
assert all(p['passed'] for p in parity),'BASELINE PARITY FAILED: all robustness calculations stopped'
print('BASELINE_PARITY_PASS',max(p['maxDailyReturnError'] for p in parity),flush=True)

# Freeze diagnostic cases before observing their results; none can be promoted.
extra=[]
def add(v,suffix,kind,**changes):
    meta=dict(variant=v,kind=kind);meta.update(changes.pop('meta',{}))
    extra.append((replace(frozen[v],id=f'{v}__{suffix}',**changes),meta))
for w in [45,60]:add('B3_w50',f'weight{w}','core_surface',weight=w)
for cut in [.55,.60,.65]:
    for days in [2,3,5]:
        if (cut,days)!=(.60,3):add('B3_beta60d3',f'beta{int(cut*100)}d{days}','beta_surface',beta_cut=cut,beta_days=days)
for v in ['A0_event','A2_event']:
    for n in [5,10,20,40,60]:add(v,f'd{n:02d}','fixed_session_surface',frequency=f'd{n:02d}')
for v in VARIANTS:
    for year in range(2018,2024):add(v,f'fresh{year}','fresh_cash',meta={'start':f'{year}-01-01'})
    for capital,value in [('USD100K',100000.),('KRW50M',50000000/1500),('KRW100M',100000000/1500)]:
        for mode,changes in [('R1',{}),('C50',{'cost':.005}),('R5',{'participation':.05,'entry_capacity':.05}),('UNLIMITED',{'participation':0,'entry_capacity':0})]:
            if capital=='USD100K' and mode=='R1':continue
            add(v,f'{capital}_{mode}','execution_stress',initial_capital=value,meta={'capital':capital,'mode':mode,'fxKRWperUSD':1500,'fxIsFixedAssumption':True},**changes)
write_json('diagnostic_design_frozen.json',dict(cases=[{'config':asdict(c),'meta':m} for c,m in extra],promotionAllowed=False,primary='REAL 1%, one-way 25bp',pending='US37 controlled core; persist_orders=True for every case',fixedCadence='d=1 then every N exchange sessions; distinct from calendar boundaries',freshCash='no holdings or pending orders; prior signals warm onset-crossing state',year2026='partial through 2026-09-23; daily return label ends one session before final mark'))
replay(extra,'diagnostics')

# Actual exclusion reruns use baseline ex-post contributors, with original signal
# ranks held fixed; candidates are skipped from the entry pool, freeing slots/cash.
jack=[];concentration=[];sector_rows=[];yearjack=[]
for v in VARIANTS:
    at=baseline_attr[v].copy();total=at.netPnl.sum();at['sector']=at.symbol.map(mapping).fillna('UNKNOWN')
    secs=at.groupby('sector').netPnl.sum().sort_values(ascending=False)
    for n in [1,3,5,10]:
        excluded=at.head(n).symbol.tolist()
        concentration.append(dict(variant=v,topN=n,netPnlUSD=at.head(n).netPnl.sum(),totalPnlUSD=total,share=at.head(n).netPnl.sum()/total,symbols='|'.join(excluded)))
        jack.append((replace(frozen[v],id=f'{v}__excludeTop{n}'),dict(variant=v,kind='actual_stock_exclusion_replay',exclude_ids=[ids[s] for s in excluded],exclude_symbols=excluded,ranksRecomputed=False,selection='ex-post baseline top net PNL; stress only')))
    for sector,pnl in secs.items():sector_rows.append(dict(variant=v,sector=sector,netPnlUSD=pnl,share=pnl/total,classification='mapping v2 snapshot, not historical PIT sector'))
    for sector in secs.head(3).index:
        excluded=[k for s,k in ids.items() if mapping.get(s,'UNKNOWN')==sector]
        jack.append((replace(frozen[v],id=f'{v}__excludeSector_{sector}'),dict(variant=v,kind='actual_sector_exclusion_replay',exclude_ids=excluded,sector=sector,ranksRecomputed=False,selection='ex-post baseline top 3 mapped sectors; stress only')))
    df=baseline_daily[v];logs=np.log1p(df['return']);growth=logs.sum()
    for y,g in df.groupby(df.date.dt.year):
        keep=df[df.date.dt.year!=y]
        yearjack.append(dict(variant=v,excludedYear=int(y),logGrowthShare=float(logs.loc[g.index].sum()/growth),method='contribution-chain removal only; NOT portfolio replay',**metrics(keep)))
pd.DataFrame(concentration).to_csv(OUT/'top_stock_concentration.csv',index=False)
pd.DataFrame(sector_rows).to_csv(OUT/'sector_contribution.csv',index=False)
pd.DataFrame(yearjack).to_csv(OUT/'leave_year_out_contribution_only.csv',index=False)
write_json('jackknife_design.json',[{'config':asdict(c),'meta':m} for c,m in jack])
replay(jack,'exclusion_replays')

# Analysis and PIT audit are separate from replay; use only gate-approved paths.
analysis_path=Path(__file__).with_name('analyze_us38_gate.py')
assert analysis_path.exists()
exec(compile(analysis_path.read_text(),str(analysis_path),'exec'),globals())
with zipfile.ZipFile(OUT/'case_execution_details.zip','w',zipfile.ZIP_STORED) as z:
    for p in sorted((TMP/'case_details').rglob('*.gz')):z.write(p,str(p.relative_to(TMP/'case_details')))
write_json('source_hashes_after.json',{str(p.relative_to(ROOT)):sha(p) for p in source_paths})
assert source_hashes==json.loads((OUT/'source_hashes_after.json').read_text()),'Reference source changed during run'
write_json('simulation_complete.json',dict(status='REPLAY_AND_DIAGNOSTICS_COMPLETE',cases=len(all_cases),baselineParity='PASS',strictPIT='NOT PASSED / PENDING',productionDecision='NO PROMOTION',output=str(OUT)))
write_json('artifact_sha256.json',{str(p.relative_to(OUT)):sha(p) for p in OUT.rglob('*') if p.is_file() and p.name!='artifact_sha256.json'})
print('US38_COMPLETE',OUT,flush=True)
