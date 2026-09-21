#!/usr/bin/env python3
"""Sequential preregistered V0.1 improvements. No production deployment."""
import argparse,hashlib,json,re
from pathlib import Path
from collections import defaultdict
import numpy as np
import pandas as pd
from research_etf_m0_clean import events,save_json
from research_etf_m0_enhance import portfolio,curve_stats

DESIGN={
 'cutoff':'2026-09-11','weights':[62.5,7.5,15,15],'slots':10,'entry':'M0 80 onset next open','exit':'underlying MA60 next open, no time cap',
 'steps':{'1':['BASE','FOREIGN_PROXY','NO_RELATIVE'],'2':['NO_CAP','CAP_SYMBOL','LIQUIDITY_CONTROL','CAP_LIQUIDITY'],'3':['BASE','DROP_PRIORITY_SIZE','DROP_HEALTH_SIZE','ADD_LIQUIDITY_GATE','HEALTH_TO_FILTER']},
 'benchmark':'KR-listed plain broad ETF daily adjusted-close returns, same KR session, same explicit market/hedge class; median of available trackers; own exact underlying group excluded. No foreign official same-date close. Unsupported rows retain disabled relative term, not a fabricated benchmark return.',
 'family':'strict normalized underlying index, PR/TR variants grouped; active strategies separated by symbol; cash/futures separated, hedge share classes share economic group; no broad KOSPI200 substring grouping',
 'selection':'Train AND validation CAGR and Sharpe strictly improve vs entering-stage baseline, MDD deterioration <=3pp, >=25 executed entries each; same gates at30bp; no advantage chosen from full or test. CAP_LIQUIDITY must additionally pass vs LIQUIDITY_CONTROL. Passing candidates require >=60% of20 paired full-history order trials to improve CAGR/Sharpe with MDD deterioration<=3pp. Highest validation Sharpe among eligible; else retain baseline.',
 'orderTrials':'SHA256(seed,entryDate,symbol), same ranks for overlapping events; for liquidity-ranked strategy random keys break equal-liquidity ties only',
 'normalizationDiagnostic':'DROP_PRIORITY_SIZE and DROP_HEALTH_SIZE also evaluated without active-slot renormalization; descriptive only, not additional selectable candidates',
 'frequencyDiagnostic':'train-only threshold search70..90 by0.25 nearest BASE eligible onset count; evaluate at frozen threshold, never eligible for adoption',
 'splits':{'train':['2017-01-03','2022-12-31'],'validation':['2023-01-01','2024-12-31'],'test':['2025-01-01','2026-09-11']},
 'limitations':['Reused historical test, not independent OOS','current-universe and snapshot classification','adjusted price/dividend consistency unverified','unmarked currency hedge assumed unhedged; no hedge history','proxy broad ETF returns are not official market index returns','conservative unmatched regional proxy coverage remains incomplete'],
 'sourceRuns':[35567515449,35564981988], 'productionDeployment':False}

def strict_family(r):
    s=str(r.underlyingIndexName).upper();s=re.sub(r'[^A-Z0-9가-힣]','',s)
    for term in ['PRICERETURN','TOTALRETURN','시장가격지수','시장가격','INDEX','지수']:s=s.replace(term,'')
    s=re.sub(r'(PR|TR|ER)$','',s)
    if '액티브' in r['name'] or 'ACTIVE' in r['name'].upper():s+='__ACTIVE_'+r.symbol
    if '선물' in r['name'] and 'FUTURE' not in s:s+='FUTURES'
    return str(r.region)+'|'+s

def routes(m):
    m=m.copy();m['duplicateFamily']=m.apply(strict_family,axis=1)
    m['hedgeClass']=np.where(m['name'].str.contains(r'(?:\(|\s)H(?:\)|\s)|환헤지',regex=True),'H','U_assumed')
    m['benchmarkMarket']='unsupported';m['benchmarkPool']=False
    for i,r in m.iterrows():
        name=r.underlyingIndexName.upper();region=r.region
        # Snapshot mapping has ASIA50 incorrectly marked US; do not propagate to proxy.
        if r.symbol=='277540':market='unsupported_ASIA50_mapping_conflict'
        elif region in ['US','JP','IN','EU']:market=region
        elif region=='CN' and re.search('HANG SENG',name):market='CN_HK'
        elif region=='CN' and re.search('CSI|FTSE CHINA|SZSE',name):market='CN_A'
        else:market='unsupported'
        m.at[i,'benchmarkMarket']=market
        plain=not re.search('액티브|ACTIVE',r['name'].upper())
        pool=(market=='US' and bool(re.search(r'S&P 500(?:$| FUTURES)',name))) or (market=='CN_A' and name=='CSI 300 INDEX') or (market=='CN_HK' and name=='HANG SENG CHINA H') or (market=='JP' and name in ['TOPIX','TOPIX100']) or (market=='IN' and name=='NIFTY 50 INDEX') or (market=='EU' and name=='EURO STOXX 50 INDEX')
        # U cash SP500 and H futures SP500 are explicit separate hedge pools.
        m.at[i,'benchmarkPool']=bool(plain and pool)
    m['benchmarkKey']=m.benchmarkMarket+'|'+m.hedgeClass
    assert m.loc[m.symbol=='223190','duplicateFamily'].iloc[0]!=m.loc[m.symbol=='069500','duplicateFamily'].iloc[0]
    assert m.loc[m.symbol=='101280','duplicateFamily'].iloc[0]!=m.loc[m.symbol=='195920','duplicateFamily'].iloc[0]
    return m

class Study:
    def __init__(self,d,out):
        self.d=d;self.out=out;self.start=d.loc[d.eligible,'date'].min();self.cal=sorted(d.loc[d.date>=self.start,'date'].unique());assert self.cal[-1]=='2026-09-11'
        self.prices={(r.symbol,r.date):dict(open=r.open,close=r.close) for r in d[['symbol','date','open','close']].itertuples(index=False)}
        self.spans=[('train',self.start,'2022-12-31'),('validation','2023-01-01','2024-12-31'),('test','2025-01-01',self.cal[-1]),('all',self.start,self.cal[-1]),('legacy_window','2018-01-01',self.cal[-1])]
        self.rows=[];self.curves=[];self.fills=[];self.audit=[];self.random=[];self.decisions=[];self.config={};self.trades={};self.schedules={};self.freq=[];self.signals=[]
    def build(self,cid,priority,health,cap=False,order='symbol',gate=None,tech_weight=.625,priority_weight=.075,health_weight=.15,threshold=80,diagnostic=False):
        d=self.d.copy();score=tech_weight*d.techContinuous+priority_weight*priority+health_weight*health+.15*d.environmentScore
        prev=score.groupby(d.symbol).shift(1);mask=d.eligible if gate is None else d.eligible&gate
        d['onset']=(prev<threshold)&(score>=threshold)&mask;d['signalScore']=score
        t=events(d,cid,self.start).merge(d[['symbol','date','signalScore','healthTv20','duplicateFamily','mappedSectorCode','region']],left_on=['symbol','signalDate'],right_on=['symbol','date'],validate='many_to_one').drop(columns='date')
        self.config[cid]=dict(cap=cap,order=order,threshold=threshold,diagnostic=diagnostic,techWeight=tech_weight,priorityWeight=priority_weight,healthWeight=health_weight)
        self.trades[cid]=t;self.schedules[cid]={day:g.to_dict('records') for day,g in t.groupby('entryDate',sort=True)}
        for year,g in d[d.eligible].groupby(d.date.str[:4]):self.signals.append(dict(candidate=cid,year=year,onsets=int(g.onset.sum()),foreignOnsets=int((g.onset&g.region.ne('KR')).sum())))
        return score
    def sim(self,cid,begin,end,scope='all',cost=.0015,seed=None,force_order=None):
        cfg=self.config[cid];order=force_order or cfg['order'];held={};cash=1.;rows=[];fills=[];blockedcap=0;blockedslots=0;turn=0
        dates=[x for x in self.cal if begin<=x<=end]
        for day in dates:
            quote=lambda s,f,last:self.prices.get((s,day),{}).get(f,last)
            for sym,p in list(held.items()):
                if p['exitDate']==day:cash+=p['units']*p['exitOpen']*(1-cost);del held[sym]
            opening=cash+sum(p['units']*quote(s,'open',p['last']) for s,p in held.items())
            q=[r for r in self.schedules[cid].get(day,[]) if r['signalDate']>=begin and (scope=='all' or (r['region']=='KR')==(scope=='domestic'))]
            rank=lambda r: hashlib.sha256(f'{seed}|{day}|{r["symbol"]}'.encode()).hexdigest() if seed is not None else r['symbol']
            if order=='liquidity':q=sorted(q,key=lambda r:(-r['healthTv20'],rank(r)))
            elif order=='reverse':q=sorted(q,key=lambda r:r['symbol'],reverse=True)
            elif order=='score':q=sorted(q,key=lambda r:(-r['signalScore'],rank(r)))
            else:q=sorted(q,key=rank)
            for r in q:
                if r['symbol'] in held:continue
                if cfg['cap'] and any(p['duplicateFamily']==r['duplicateFamily'] for p in held.values()):blockedcap+=1;continue
                if len(held)>=10:blockedslots+=1;continue
                amount=min(opening/10,cash)
                if amount<1e-10:continue
                cash-=amount;turn+=amount/opening;p=dict(r,units=amount/(r['entryOpen']*(1+cost)),last=r['entryOpen']);held[r['symbol']]=p;fills.append(dict(r,entryWeight=amount/opening,allocated=amount))
            for s,p in held.items():p['last']=quote(s,'close',p['last'])
            value=cash+sum(p['units']*p['last'] for p in held.values());fw=defaultdict(float);sw=defaultdict(float)
            for p in held.values():fw[p['duplicateFamily']]+=p['units']*p['last']/value;sw[p['mappedSectorCode']]+=p['units']*p['last']/value
            if cfg['cap']:assert len(fw)==len(held)
            assert cash>=-1e-10 and len(held)<=10
            rows.append((day,value,(value-cash)/value,len(held),len(fw),max(fw.values(),default=0),max(sw.values(),default=0),len(held)>len(fw)))
        c=pd.DataFrame(rows,columns=['date','equity','exposure','positions','families','largestFamilyWeight','largestSectorWeight','duplicateHeld'])
        s=dict(**curve_stats(c),entries=len(fills),meanPositions=c.positions.mean(),meanFamilies=c.families.mean(),duplicateDays=int(c.duplicateHeld.sum()),maxFamilyWeight=c.largestFamilyWeight.max(),meanLargestFamilyWeight=c.largestFamilyWeight.mean(),meanLargestSectorWeight=c.largestSectorWeight.mean(),blockedFamilyEvents=blockedcap,blockedSlotEvents=blockedslots,annualEntryTurnover=turn/(len(c)/252),dataErrorExits=sum(r['reason']=='data_unavailable' and r['exitDate']<=end for r in fills))
        return c,s,pd.DataFrame(fills)
    def evaluate(self,cid,diagnostic=False):
        for scope in (['all'] if diagnostic else ['all','domestic','foreign']):
            for split,begin,end in self.spans:
                for cost in ([.0015,.003] if scope=='all' and not diagnostic else [.0015]):
                    c,s,f=self.sim(cid,begin,end,scope,cost);self.rows.append(dict(candidate=cid,scope=scope,split=split,costPerSide=cost,diagnostic=diagnostic,**s))
                    if scope=='all' and split=='all' and cost==.0015:
                        c['candidate']=cid;f['candidate']=cid;self.curves.append(c);self.fills.append(f)
        print(json.dumps({'evaluated':cid}),flush=True);self.checkpoint()
    def row(self,cid,split,cost=.0015):
        return next(r for r in self.rows if r['candidate']==cid and r['split']==split and r['scope']=='all' and r['costPerSide']==cost)
    def passes(self,cid,base,stage):
        ok=True
        for cost in [.0015,.003]:
            for split in ['train','validation']:
                a=self.row(cid,split,cost);b=self.row(base,split,cost)
                ck=dict(cagr=a['cagr']>b['cagr'],sharpe=a['sharpe']>b['sharpe'],mdd=a['mdd']>=b['mdd']-.03,entries=a['entries']>=25)
                self.audit.append(dict(stage=stage,candidate=cid,baseline=base,split=split,costPerSide=cost,**ck));ok &= all(ck.values())
        return ok
    def choose(self,stage,base,candidates,control=None):
        preliminary=[];passed=[]
        for cid in candidates:
            ok=self.passes(cid,base,stage)
            if control and cid in control:ok=self.passes(cid,control[cid],stage) and ok
            if ok:preliminary.append(cid)
        for cid in preliminary:
            win=0
            for seed in range(20):
                pairs=[]
                for x in [base,cid]:
                    _,s,_=self.sim(x,self.start,self.cal[-1],seed=seed);self.random.append(dict(stage=stage,candidate=x,challenger=cid,seed=seed,**s));pairs.append(s)
                b,a=pairs;win+=a['cagr']>b['cagr'] and a['sharpe']>b['sharpe'] and a['mdd']>=b['mdd']-.03
            if win>=12:passed.append(cid)
            self.audit.append(dict(stage=stage,candidate=cid,baseline=base,split='random20',wins=win,requiredWins=12))
        pick=max(passed,key=lambda x:self.row(x,'validation')['sharpe']) if passed else base
        self.decisions.append(dict(stage=stage,baseline=base,candidates=candidates,preliminaryPass=preliminary,passed=passed,selected=pick));self.checkpoint();print(json.dumps(self.decisions[-1]),flush=True);return pick
    def frequency(self,cid,base,score,priority,health,**kwargs):
        prev=score.groupby(self.d.symbol).shift(1);mask=self.d.eligible&(self.d.date>=self.start)&(self.d.date<='2022-12-31')
        target=int(self.trades[base].signalDate.le('2022-12-31').sum());choices=[]
        # Count signals with an executable next open, matching baseline event convention.
        nxt=self.d.groupby('symbol').open.shift(-1);mask=mask&nxt.notna()&nxt.gt(0)
        for th in np.arange(70,90.001,.25):choices.append((abs(int(((prev<th)&(score>=th)&mask).sum())-target),abs(th-80),float(th)))
        error,_,th=min(choices);self.freq.append(dict(candidate=cid,baseline=base,trainTargetEvents=target,threshold=th,eventCountError=error,adoptionEligible=False))
        diag=cid+'_FREQ';self.build(diag,priority,health,threshold=th,diagnostic=True,**kwargs);self.evaluate(diag,True)
    def checkpoint(self):
        pd.DataFrame(self.rows).to_csv(self.out/'comparison.csv',index=False);pd.DataFrame(self.audit).to_csv(self.out/'selection-audit.csv',index=False);pd.DataFrame(self.random).to_csv(self.out/'order-sensitivity.csv',index=False);pd.DataFrame(self.freq).to_csv(self.out/'frequency-diagnostic.csv',index=False);pd.DataFrame(self.signals).to_csv(self.out/'onset-counts.csv',index=False)
        save_json(self.out/'decisions.json',self.decisions)
    def finish(self):
        curves=pd.concat(self.curves);curves.to_csv(self.out/'portfolio-curves.csv.gz',index=False);pd.concat(self.fills).to_csv(self.out/'executed-trades.csv.gz',index=False)
        annual=[]
        for cid,g in curves.groupby('candidate'):
            r=g.equity.pct_change();r.iloc[0]=g.equity.iloc[0]-1
            for year,idx in g.groupby(g.date.str[:4]).groups.items():annual.append(dict(candidate=cid,year=year,returnNet=float((1+r.loc[idx]).prod()-1),partialYear=year=='2026'))
        pd.DataFrame(annual).to_csv(self.out/'annual-returns.csv',index=False);save_json(self.out/'candidate-configs.json',self.config);self.checkpoint()

def main():
    ap=argparse.ArgumentParser()
    for k in ['base','clean','mapping','output']:ap.add_argument('--'+k,required=True)
    a=ap.parse_args();out=Path(a.output);out.mkdir(parents=True,exist_ok=True);base=Path(a.base);clean=Path(a.clean)
    design=dict(DESIGN,inputHashes={str(p.name):hashlib.sha256(p.read_bytes()).hexdigest() for p in [base/'adopted-environment-panel.parquet',clean/'clean-input-panel.parquet',Path(a.mapping)]});save_json(out/'design.json',design)
    d=pd.read_parquet(base/'adopted-environment-panel.parquet').merge(pd.read_parquet(clean/'clean-input-panel.parquet')[['symbol','date','etfMarketCap','healthTv20']],on=['symbol','date'],validate='one_to_one').sort_values(['symbol','date']).reset_index(drop=True)
    m=routes(pd.read_csv(a.mapping,dtype={'symbol':str},keep_default_na=False));m.to_csv(out/'benchmark-and-duplicate-reference.csv',index=False)
    d=d.merge(m[['symbol','duplicateFamily','benchmarkMarket','hedgeClass','benchmarkKey','benchmarkPool']],on='symbol',validate='many_to_one').sort_values(['symbol','date']).reset_index(drop=True)
    cal=sorted(d.date.unique());previous=dict(zip(cal[1:],cal[:-1]));g=d.groupby('symbol');d['dayReturn']=g.close.pct_change(fill_method=None);d.loc[g.date.shift(1)!=d.date.map(previous),'dayReturn']=np.nan
    pool=d[d.benchmarkPool&d.dayReturn.notna()];pool_records={k:q[['symbol','duplicateFamily','dayReturn']].to_dict('records') for k,q in pool.groupby(['benchmarkKey','date'])}
    benchmark=[];npeers=[]
    for r in d[['benchmarkKey','date','duplicateFamily']].itertuples(index=False):
        peers=[p['dayReturn'] for p in pool_records.get((r.benchmarkKey,r.date),[]) if p['duplicateFamily']!=r.duplicateFamily];benchmark.append(float(np.median(peers)) if peers else np.nan);npeers.append(len(peers))
    d['benchmarkReturn']=benchmark;d['benchmarkTrackers']=npeers;foreign=d.region.ne('KR');available=foreign&d.dayReturn.notna()&d.benchmarkReturn.notna();d['proxyAvailable']=available
    size=d.etfMarketCap.ge(300e9).astype(float);oldrel=(d.priorityTwo/50-size).round();assert oldrel.dropna().between(0,1).all();assert oldrel[foreign].dropna().eq(0).all()
    proxyrel=oldrel.copy();proxyrel.loc[available]=(d.loc[available,'dayReturn']-d.loc[available,'benchmarkReturn']>=.02).astype(float)
    d['priorityProxy']=(size+proxyrel)/2*100
    coverage=[]
    for (region,year),q in d[foreign&d.eligible].groupby(['region',d.date.str[:4]]):coverage.append(dict(region=region,year=year,rows=len(q),symbols=q.symbol.nunique(),availableRows=int(q.proxyAvailable.sum()),availableShare=q.proxyAvailable.mean(),relativeBonusRows=int(q.priorityProxy.gt(q.priorityTwo).sum())))
    pd.DataFrame(coverage).to_csv(out/'benchmark-coverage.csv',index=False)
    d[['symbol','date','benchmarkKey','duplicateFamily','dayReturn','benchmarkReturn','benchmarkTrackers','proxyAvailable','priorityTwo','priorityProxy']].to_parquet(out/'benchmark-daily-audit.parquet',compression='zstd',index=False)
    s=Study(d,out);p=d.priorityTwo;h=d.healthClean;s.build('V01',p,h);s.evaluate('V01')
    c,_,_=s.sim('V01',s.start,s.cal[-1]);ref=portfolio(s.trades['V01'],s.prices,s.cal);assert np.allclose(c.equity,ref.equity,rtol=1e-12,atol=1e-12)
    original=pd.read_csv(base/'portfolio-summary.csv');r=original[(original.candidate=='P7.5')&(original.scope=='all')&(original.split=='all')].iloc[0];assert np.allclose([s.row('V01','all')[k] for k in ['cagr','mdd','sharpe']],r[['cagr','mdd','sharpe']].astype(float),atol=1e-10)
    stage1={}
    for cid,pp in [('S1_FOREIGN_PROXY',d.priorityProxy),('S1_NO_RELATIVE',size*100)]:
        score=s.build(cid,pp,h);stage1[cid]=pp;s.evaluate(cid);s.frequency(cid,'V01',score,pp,h)
    winner1=s.choose(1,'V01',list(stage1));p=stage1.get(winner1,p);relative=proxyrel if winner1=='S1_FOREIGN_PROXY' else pd.Series(0.,index=d.index) if winner1=='S1_NO_RELATIVE' else oldrel
    for cid,cap,order in [('S2_CAP_SYMBOL',True,'symbol'),('S2_LIQUIDITY_CONTROL',False,'liquidity'),('S2_CAP_LIQUIDITY',True,'liquidity')]:s.build(cid,p,h,cap,order);s.evaluate(cid)
    winner2=s.choose(2,winner1,['S2_CAP_SYMBOL','S2_CAP_LIQUIDITY'],{'S2_CAP_LIQUIDITY':'S2_LIQUIDITY_CONTROL'});cfg=s.config[winner2];common=dict(cap=cfg['cap'],order=cfg['order'])
    changes={}
    if winner1=='S1_NO_RELATIVE':changes['S3_DROP_PRIORITY_SIZE']=dict(priority=p*0,health=h,tech_weight=.7,priority_weight=0,**common)
    else:changes['S3_DROP_PRIORITY_SIZE']=dict(priority=relative*100,health=h,**common)
    nohealthsize=(20*d.healthTv20.ge(1e9).astype(float)+10)/30*100
    changes['S3_DROP_HEALTH_SIZE']=dict(priority=p,health=nohealthsize,**common)
    changes['S3_ADD_LIQUIDITY_GATE']=dict(priority=p,health=h,gate=d.healthTv20.ge(1e9),**common)
    changes['S3_HEALTH_TO_FILTER']=dict(priority=p,health=h*0,tech_weight=.775,health_weight=0,gate=d.etfMarketCap.ge(50e9)&d.healthTv20.ge(1e9),**common)
    for cid,kw in changes.items():
        score=s.build(cid,**kw);s.evaluate(cid)
        if 'gate' not in kw:s.frequency(cid,winner2,score,**kw)
    winner3=s.choose(3,winner2,list(changes))
    if winner1!='S1_NO_RELATIVE':
        s.build('DIAG_PSIZE_FIXED_DENOM',relative*50,h,diagnostic=True,**common);s.evaluate('DIAG_PSIZE_FIXED_DENOM',True)
    s.build('DIAG_HSIZE_FIXED_DENOM',p,nohealthsize/2,diagnostic=True,**common);s.evaluate('DIAG_HSIZE_FIXED_DENOM',True)
    # Final winners are also contrasted directly with frozen V0.1; deterministic sensitivity for all main challengers.
    sens=[]
    for cid in [k for k,v in s.config.items() if not v['diagnostic']]:
        for order in ['reverse','score']:
            for split,begin,end in s.spans[:4]:
                _,r,_=s.sim(cid,begin,end,force_order=order);sens.append(dict(candidate=cid,order=order,split=split,**r))
    pd.DataFrame(sens).to_csv(out/'deterministic-order-sensitivity.csv',index=False)
    qa=dict(eligiblePriorityReconstruction=bool(np.allclose(((size+oldrel)/2*100)[d.eligible],d.loc[d.eligible,'priorityTwo'])),eligibleHealthReconstruction=bool(np.allclose(((20*d.etfMarketCap.ge(50e9)+10*d.etfMarketCap.ge(100e9)+20*d.healthTv20.ge(1e9)+10)/60*100)[d.eligible],d.loc[d.eligible,'healthClean'])),environmentUnchanged=True)
    assert all(qa.values());save_json(out/'component-reconstruction.json',qa)
    s.finish();policy=json.loads((Path(__file__).resolve().parents[1]/'research/etf-m0-provisional-policy.json').read_text());policy['sequentialImprovementStudy']=dict(source='results/etf-m0-v01-improvements/20260911',stages=s.decisions,selected=winner3,productionDeployment=False)
    if winner3!='V01':policy['status']='research_challenger_selected_not_deployed';policy['challengerConfig']=s.config[winner3]
    save_json(out/'research-policy.json',policy)
    save_json(out/'verification.json',dict(baselineNAVReproduced=True,baselineMetricsReproduced=True,capInvariantEnforced=True,positiveCashEnforced=True,stepsCompleted=3,selected=winner3,rows=len(d),eligibleSymbols=int(d.loc[d.eligible,'symbol'].nunique()),foreignProxyAvailableRows=int((available&d.eligible).sum()),foreignEligibleRows=int((foreign&d.eligible).sum()),productionDeployment=False))
    print(json.dumps({'stepsComplete':3,'selected':winner3}),flush=True)
if __name__=='__main__':main()
