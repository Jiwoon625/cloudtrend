"""US3.5: preregistered local neighborhoods of US3.4 revision 3."""
from pathlib import Path
import os, sys, json, hashlib, ast, gc, shutil
import numpy as np, pandas as pd, duckdb
from dataclasses import asdict, replace

ROOT=Path('/content/drive/MyDrive/미국주식데이터')
REF=ROOT/'US34_sensitivity_20260927'/'final'
OLD=ROOT/'US33_validation_20260927'
OUT=ROOT/'US38_robustness_gate_20260928'; OUT.mkdir(exist_ok=True)
TMP=Path('/content/us38'); TMP.mkdir(exist_ok=True)

source=(REF/'us34_core.py').read_text()
source=source.replace('    risk_off:bool=False','    risk_off:bool=False\n    beta_cut:float=.5\n    beta_days:int=3')
source=source.replace("if c.mode=='exit_beta':weak=row[1]<.5", "if c.mode=='exit_beta':weak=row[1]<c.beta_cut")
source=source.replace("p['weak']>=3", "p['weak']>=(c.beta_days if c.mode=='exit_beta' else 3)")
(TMP/'us35_core.py').write_text(source)
sys.path.insert(0,str(TMP))
from us35_core import Config, Ledger, pool_for

REAL=dict(adv_floor=500000,active_days=20,entry_capacity=.01,participation=.01,realized_cap=True,integer=True,min_order=10,settlement_delay=5,cost=.0025)
primary=[]; groups={}
def add(id,group,**kw):
    primary.append(Config(id=id,**REAL,**kw));groups[id]=group
for p in ['A0','A2']:
    for f in ['event','week','biweek','month','bimonth','quarter']:
        add(p+'_'+f,p+'_rebalance',policy=p,frequency=f,weight=50)
for w in [25,30,35,40]:add('A2_w'+str(w),'A2_core',policy='A2',weight=w)
for w in [45,50,55,60,65,70]:add('B3_w'+str(w),'B3_core',policy='B3',weight=w)
# Frozen diagnostic surface only: no selection or promotion from these values.
for cut in [.55,.60,.65]:
    for days in [2,3,5]:
        add(f'B3_beta{int(cut*100)}d{days}','B3_beta_surface',policy='B3',weight=50,mode='exit_beta',beta_cut=cut,beta_days=days)
for f in ['week','quarter']:add('A2_w30_'+f,'A2_interaction',policy='A2',weight=30,frequency=f)
# Fixed trading-session cadence diagnostics anchored to first execution session.
for p in ['A0','A2']:
    for n in [5,10,20,40,60]:
        add(f'{p}_d{n:02d}',p+'_trading_day_surface',policy=p,weight=50,frequency=f'd{n:02d}')
add('B3_w60_beta50d3','B3_interaction',policy='B3',weight=60,mode='exit_beta')
# US3.8 surface runs retain only the pre-registered REAL 1% primary conditions.
# Execution/cost stress outputs from US3.5 remain the reference; no stress mode is substituted here.
configs=list(primary)
design=dict(version='US3.8 Robustness Gate — diagnostics only',created=pd.Timestamp.now(tz='UTC').isoformat(),sourceCommit='b4d47858bccd5b732b88af9b14368ac9581e770a',sourceRevision=3,primaryCount=len(primary),runCount=len(configs),groups=groups,configs=[asdict(c) for c in configs],end='2026-09-23',newOOS=False,
    selection='Diagnostic surface only. Do not rank, select, promote, or retune any point. First assert frozen candidate/control daily parity against US3.5; if parity fails, stop interpretation.',
    bootstrap='No new bootstrap is run by this surface script. Use the pre-existing US3.8 paired-bootstrap diagnostics for saved paths; rerun only if input returns change after baseline parity review.',
    schedules='Fixed-session surface d05/d10/d20/d40/d60 is anchored to the first executable session. First exchange session of week/month/quarter. Biweekly: alternating W-FRI periods anchored to first sample week. Bimonthly: Jan/Mar/May/Jul/Sep/Nov. Entry and exit remain daily.',
    beta='Strict rank < cut, consecutive observed portfolio days, reset on non-weak or missing rows; core missing itself triggers exit; pending sell persists after recovery.',
    cost='Every run in this surface is REAL1 with 25bp one-way costs. Existing US3.5 REAL5 and C50 outputs remain the execution/cost stress references; this diagnostic script does not rerun those stress modes.')
(OUT/'design_frozen.json').write_text(json.dumps(design,indent=2))
shutil.copy2(__file__,OUT/'run_us38_surfaces.py');shutil.copy2(TMP/'us35_core.py',OUT/'us35_core.py')
print('DESIGN_FROZEN',len(primary),len(configs),flush=True)

# Load the same prepared feature snapshot and raw prices; previous results stay untouched.
prep=(REF/'prepare_us34.py').read_text().split("for version in ['v1','v2']:")[0]
prep=prep.replace("OUT=ROOT/'US34_sensitivity_20260927'", "OUT=ROOT/'US38_robustness_gate_20260928'").replace('/content/us34','/content/us38')
exec(compile(prep,'prepare_us34_adapted','exec'),globals())
con.execute(f"CREATE OR REPLACE TABLE ranks_v2 AS SELECT *,{ranks} FROM features WHERE {allow} AND symbol IN (SELECT ticker FROM mapv2 WHERE commonEquityEligible) AND dt BETWEEN '2017-01-01' AND '2026-09-23'")
weights=sorted({c.weight for c in configs})
folder=TMP/'v2';folder.mkdir(exist_ok=True)
for year in range(2017,2027):
    scores=','.join(f'{w/100:.2f}*r_ret120+{(100-w)/100:.2f}*r_ret252 s{w}' for w in weights)
    moms=','.join(f'{pct("s"+str(w))} m{w}' for w in weights)
    path=folder/f'{year}.parquet'
    con.execute(f"COPY (WITH a AS (SELECT *,{scores} FROM ranks_v2 WHERE year(dt)={year}) SELECT symbol,dt,r_beta60_spy beta,r_ichimoku_tk_gap trend,r_relvol1_20 vol,r_log_dollarvol20 liq,r_amihud20 ami,{moms} FROM a ORDER BY dt,symbol) TO '{path}' (FORMAT PARQUET,COMPRESSION ZSTD)")
    print('RANKS',year,flush=True)
con.close();gc.collect()

# Reuse original price construction, calendars, ADV, and ending liquidation fee.
runner=(REF/'run_us34.py').read_text()
prefix=runner.split('configs=configurations()')[0]
prefix=prefix.replace('from us34_core import Config,Ledger,configurations,pool_for','')
prefix=prefix.replace("OUT=ROOT/'US34_sensitivity_20260927'", "OUT=ROOT/'US38_robustness_gate_20260928'").replace('/content/us34','/content/us38')
exec(compile(prefix,'price_setup','exec'),globals())
for s in json.loads((REF/'corporate_event_corrections.json').read_text()):
    k=ids[s['symbol']];d=int(dates.searchsorted(pd.Timestamp(s['date'])))
    assert dates[d]==pd.Timestamp(s['date'])
    mark[d:,k]=s['adjustedEquivalent'];terminal[k]=dict(day=d,known=True,value=s['adjustedEquivalent'],symbol=s['symbol'],bankruptcy=False)
tree=ast.parse(runner)
nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in ['end_fee','metrics','finish']]
exec(compile(ast.Module(body=nodes,type_ignores=[]),'original_metrics','exec'),globals())
def schedule(freq,d):
    cur=dates[d];prevdate=dates[d-1]
    if freq.startswith('d') and freq[1:].isdigit():
        n=int(freq[1:]);return d>0 and (d-1)%n==0
    if freq=='week':return cur.to_period('W-FRI')!=prevdate.to_period('W-FRI')
    if freq=='biweek':return cur.to_period('W-FRI')!=prevdate.to_period('W-FRI') and (cur.to_period('W-FRI').ordinal-dates[0].to_period('W-FRI').ordinal)%2==0
    if freq=='month':return cur.to_period('M')!=prevdate.to_period('M')
    if freq=='bimonth':return cur.to_period('M')!=prevdate.to_period('M') and cur.month%2==1
    if freq=='quarter':return cur.to_period('Q')!=prevdate.to_period('Q')
    return False

class AuditedLedger(Ledger):
    def __init__(self,c):
        super().__init__(c);self.backlog=[];self.ages={};self.violations=0;self.unknown_held=set()
    def step(self,*args):
        start=len(self.orders);super().step(*args)
        d=args[0];term=args[11]
        sums={}
        for o in self.orders[start:]:
            _,k,reason,amount,fee,a,dv,route=o;sums[k]=sums.get(k,0)+abs(amount)
            if sums[k]>self.c.participation*min(a,dv)+1e-6:self.violations+=1
        pending=set(self.pending)|{k for k,p in self.p.items() if p.get('exit_pending')}
        self.ages={k:self.ages.get(k,0)+1 for k in pending}
        exitvalue=sum(p['v'] for k,p in self.p.items() if p.get('exit_pending'))
        targetvalue=sum(abs(t-self.p[k]['v']) for k,t in self.pending.items() if k in self.p)
        self.backlog.append((args[1],len(pending),max(self.ages.values(),default=0),exitvalue/self.nav,targetvalue/self.nav))
        self.unknown_held.update(k for k in self.p if k in term and not term[k]['known'] and d>=term[k]['day'])

summaries=[];regimes=[];states=[AuditedLedger(c) for c in configs];prev={w:{} for w in weights}
for year in range(2017,2027):
    f=pd.read_parquet(TMP/'v2'/f'{year}.parquet');f['k']=f.symbol.map(ids);f['sec']=f.symbol.map(mapping).fillna('UNKNOWN')
    for day,g in f.groupby('dt',sort=True):
        i=di.get(pd.Timestamp(day));d=i+1 if i is not None else -1
        if i is None or i+2>=len(dates):continue
        data=g[['k','beta','trend','vol','liq','ami','sec']].to_numpy();rows={};eligible={};pools={}
        for w in weights:
            mm=g[f'm{w}'].to_numpy()
            rows[w]={int(r[0]):(float(m),float(r[1]),float(r[2]),float(r[3]),float(r[4]),float(r[5]),r[6]) for r,m in zip(data,mm) if np.isfinite(m)}
            eligible[w]={k:r for k,r in rows[w].items() if r[0]>=.8 and (prev[w].get(k,np.nan)<.8 or not np.isfinite(prev[w].get(k,np.nan))) and r[1]>=.9 and r[4]>=.1 and r[5]>=.1}
        for st in states:
            c=st.c;key=(c.weight,c.policy)
            if key not in pools:pools[key]=pool_for(c,eligible[c.weight],prev[c.weight],adv[i])
            st.step(d,str(dates[d].date()),rows[c.weight],pools[key],mark[d],mark[d+1],ok[d],adv[i],active[i],rawopen[d],dvol[d],terminal,schedule(c.frequency,d),reg[i],spy[d+1]/spy[d]-1)
        for w in weights:prev[w].update({k:r[0] for k,r in rows[w].items()})
    print('SIMULATED_YEAR',year,flush=True)
audit=[]
for st in states:
    finish(st,'v3')
    b=pd.DataFrame(st.backlog,columns=['date','pendingCount','oldestDays','exitWeight','targetGapWeight']);b.to_csv(OUT/f'backlog_{st.c.id}.csv',index=False)
    audit.append(dict(config=st.c.id,capacityViolations=st.violations,pendingDays=int((b.pendingCount>0).sum()),maxPendingAge=int(b.oldestDays.max()),meanExitWeight=b.exitWeight.mean(),maxExitWeight=b.exitWeight.max(),maxTargetGapWeight=b.targetGapWeight.max(),unknownHeld='|'.join(names[k] for k in sorted(st.unknown_held))))
pd.DataFrame(summaries).to_csv(OUT/'summary.csv',index=False);pd.DataFrame(audit).to_csv(OUT/'backlog_audit.csv',index=False)
parity=[]
matches={**{f'{p}_{f}':f'{p}_REAL_{f}_P0.01' for p in ['A0','A2'] for f in ['event','week','month','quarter']},'A2_w30':'A2_REAL_W3_N20','A2_w40':'A2_REAL_W4_N20','B3_w50':'B3_REAL_event_P0.01','B3_w60':'B3_REAL_W6_N20','B3_w70':'B3_REAL_W7_N20'}
for new,old in matches.items():
    a=pd.read_csv(OUT/f'daily_v3_{new}.csv');b=pd.read_csv(REF/f'daily_v2_{old}.csv')
    assert a.date.equals(b.date)
    err=float(np.max(abs(a['return']-b['return'])));parity.append(dict(config=new,reference=old,maxDailyError=err))
pd.DataFrame(parity).to_csv(OUT/'baseline_parity.csv',index=False)
assert max(x['maxDailyError'] for x in parity)<1e-10,parity
assert sum(x['capacityViolations'] for x in audit)==0
(OUT/'simulation_complete.json').write_text(json.dumps(dict(runs=len(states),days=len(states[0].daily),maxParity=max(x['maxDailyError'] for x in parity),capacityViolations=0),indent=2))
print('US38_SURFACE_SIMULATION_COMPLETE',str(OUT),flush=True)
