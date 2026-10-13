"""Bounded, private CM05 source reconciliation, sector panels and candidate labels."""
import gc,hashlib,io,json,os,re,resource,time
from pathlib import Path
import numpy as np
import pandas as pd
import pyarrow.parquet as pq
from core import require,prices,sector_panel,event_labels
from probe import ExpandedReader,KRReader,CM05Store
from cmresearchengine.storage import SupabaseCMStore
from cmresearchengine.ingest import restore_archives

ROOT=Path(__file__).resolve().parent
CONTRACT=json.loads((ROOT/'CONTRACT.json').read_text())
R2=CONTRACT['mapping_r2_sha256']
KR_MANIFEST='78e59c019a579b704a40c1d9a6a5de414dfaad8e71da1312f583327c2306ca89'

def sha(b):return hashlib.sha256(b).hexdigest()
def clean_json(x):
    return json.dumps(x,sort_keys=True,ensure_ascii=False,default=str,allow_nan=False).encode()

def mapping_kr():
    repo=ROOT.parent.parent
    old=(repo/'src/lib/engine/sectors.ts').read_text();new=(repo/'src/lib/engine/stockSectorMaster.ts').read_text()
    codes={};basis={}
    for code,body in re.findall(r'\[\s*"([A-Z_]+)",\s*\[([^\]]*)\]',old):
        for s in re.findall(r'"(\d{6})"',body):
            if s not in codes:codes[s]=code;basis[s]='STATIC_CODE'
    for code,body in re.findall(r'\b([A-Z_]+):\s*"([0-9 ]+)"',new):
        for s in body.split():codes[s]=code;basis[s]='REVIEWED_20260909'
    require(len(codes)>=613,'KR mapping parse incomplete')
    return codes,basis,{'static_sha':sha(old.encode()),'reviewed_sha':sha(new.encode())}

class Output:
    def __init__(self):
        self.store=CM05Store.from_env();self.run=os.environ['GITHUB_RUN_ID'];self.root='results/build-'+self.run;self.files=[]
    def save(self,name,data):
        raw=data if isinstance(data,bytes) else clean_json(data)
        self.store.put_object(self.root+'/'+name,raw)
        self.files.append({'name':name,'bytes':len(raw),'sha256':sha(raw)})
    def frame(self,name,df):
        b=io.BytesIO();df.to_parquet(b,index=False,compression='zstd');self.save(name,b.getvalue())

def main():
    start=time.monotonic();out=Output();work=Path(os.environ['RUNNER_TEMP'])/'cm05-build';work.mkdir(exist_ok=True)
    code_hashes={p.name:sha(p.read_bytes()) for p in ROOT.glob('*.py')}
    out.save('contract.json',CONTRACT);out.save('code_hashes.json',code_hashes)
    cm=SupabaseCMStore.from_env();us=ExpandedReader.from_env();kr=KRReader.from_env()
    raw=out.store.get_object('results/inputs/mapping_r2_'+R2+'.csv',max_bytes=6*1024**2)
    require(sha(raw)==R2,'R2 mapping hash mismatch')
    m=pd.read_csv(io.BytesIO(raw),keep_default_na=False,dtype={'ticker':str,'permaticker':str})
    require(not m.ticker.duplicated().any(),'ambiguous ticker in r2')
    require(not m.permaticker.duplicated().any(),'ambiguous issuer in r2')
    m.commonEquityEligible=m.commonEquityEligible.astype(str).str.lower().eq('true')
    oldraw=us.get_object('reference/sector_map_extended.csv',max_bytes=6*1024**2)
    old=pd.read_csv(io.BytesIO(oldraw),dtype={'ticker':str,'permaticker':str})
    diff=m.merge(old[['ticker','sectorCode']],on='ticker',how='outer',suffixes=('_r2','_old'),validate='1:1')
    out.frame('mapping_diff.parquet',diff)
    mapdict=m.set_index('ticker').sectorCode.to_dict();allowed=set(m.loc[m.commonEquityEligible,'ticker'])
    kmap,kbasis,khash=mapping_kr()
    inventory=[{'source':'Drive mapping r2','sha256':R2,'rows':len(m)}, {'source':'expanded prior mapping','sha256':sha(oldraw),'rows':len(old)}]
    summary={'mapping_rows':len(m),'mapping_common':len(allowed),'mapping_changed':int((diff.sectorCode_r2!=diff.sectorCode_old).sum()),'historical_mapping':'STATIC_VINTAGE','kr_mapping_hashes':khash,'stages':{},'counts':{}}
    out.save('mapping_summary.json',summary)
    print('CM05_STAGE A_RESTORE_STARTED',flush=True)
    restored=restore_archives(cm,work)
    out.save('cm_input_manifest.json',restored)
    ref=work/'outputs/colab_stage2_v1/reference_time/data'
    calendars={e:pd.DataFrame(json.loads((ref/'reference_time'/f'{e}_calendar.json').read_text())) for e in ['K','U']}
    dates={e:sorted(calendars[e].loc[calendars[e].session_date<=CONTRACT['end'],'session_date']) for e in calendars}
    for e in calendars:out.frame(f'calendar_{e}.parquet',calendars[e])
    for p in (ref/'reference_time').glob('*events.csv'):
        out.save(p.name,p.read_bytes());summary.setdefault('fx_schemas',{})[p.name]=list(pd.read_csv(p,nrows=1).columns)
    # Full 29-file canonical source QA. Only index rows and inventory persist as derived inputs.
    raw=kr.get_object(KR_MANIFEST+'/source-manifest.json',max_bytes=1024**2)
    require(sha(raw)==KR_MANIFEST,'canonical catalog hash mismatch')
    catalog=json.loads(raw);idx=[];raw_count=0;stock_keys=[]
    for rec in catalog['orderedFiles']:
        if rec['sourceGroup']!='STOCK_KR':continue
        key=rec['sha256']+'/'+rec['sourcePath'];data=kr.get_object(key,max_bytes=32*1024**2)
        require(len(data)==rec['bytes'] and sha(data)==rec['sha256'],'KR canonical hash mismatch')
        f=pd.read_parquet(io.BytesIO(data));raw_count+=len(f)
        require(not f.duplicated(['date','symbol']).any(),'duplicate within KR source')
        inventory.append({'source':key,'bytes':len(data),'sha256':sha(data),'rows':len(f),'columns':len(f.columns),'min_date':str(f.date.min()),'max_date':str(f.date.max())})
        idx.append(f.loc[f.symbol.isin(['KOSPI','KOSDAQ']),['date','symbol','open','close','volume']])
        stock_keys.append(f[['date','symbol']])
    keys=pd.concat(stock_keys,ignore_index=True);summary['counts']['kr_canonical_rows']=raw_count;summary['counts']['kr_duplicate_keys']=int(keys.duplicated().sum());del keys,stock_keys
    indexes=pd.concat(idx,ignore_index=True);require(not indexes.duplicated(['date','symbol']).any(),'duplicate KR benchmark keys')
    benchmarks={mk:indexes.loc[indexes.symbol.eq(mk)].set_index('date').reindex(dates['K'])[['open','close']] for mk in ['KOSPI','KOSDAQ']}
    for mk,b in benchmarks.items():out.frame('benchmark_'+mk+'.parquet',b.reset_index())
    # Normalized K already contains frozen current-policy features; preserve these for D.
    normalized=work/'data/comparison_inputs_closeadj_v2'
    kparts=[]
    for p in sorted((normalized/'K').glob('*.parquet')):
        f=pd.read_parquet(p);f=f.loc[f.session_date<=CONTRACT['end']].copy()
        f['symbol']=f.symbol.astype(str).str.replace(r'\.0$','',regex=True).str.zfill(6)
        f['frozen_sector']=f.sector
        f['sector']=f.symbol.map(kmap).fillna(f.sector)
        f['mapping_basis']=f.symbol.map(kbasis).fillna('FROZEN_NORMALIZED_FALLBACK')
        kparts.append(f)
    k=pd.concat(kparts,ignore_index=True);del kparts
    require(not k.duplicated(['session_date','symbol']).any(),'duplicate K normalized key')
    summary['counts']['kr_normalized_rows']=len(k);summary['counts']['kr_sector_reconciled_rows']=int((k.sector!=k.frozen_sector).sum())
    out.frame('kr_mapping_crosswalk.parquet',k[['symbol','sector','frozen_sector','mapping_basis']].drop_duplicates())
    # Feature and event routines are frozen to the existing CM input provenance.
    from cmresearchengine import runtime
    runtime.activate()
    from cm06_comparison_signals import kospi_confirmation,kr_operational_signals,us_session_analysis
    events=[];history={}
    def obs(r):
        if r is None:return None
        return {'date':r['session_date'],'score':r.get('score'),'eligible':bool(r.get('eligible')),'observed':bool(r.get('observed')),'rsAccel':r.get('rs_accel'),'marketGate':r.get('market_gate')}
    for day,frame in k.groupby('session_date',sort=True):
        present={r['symbol']:r for r in frame.astype(object).where(frame.notna(),None).to_dict('records')}
        for symbol in set(history)-set(present):
            present[symbol]={'symbol':symbol,'session_date':day,'observed':False,'eligible':False,'market':history[symbol][-1]['market']}
        for symbol,row in present.items():
            h=history.get(symbol,[]);prev=h[-1] if h else None;before=h[-2] if len(h)>1 else None
            gate=row.get('market_gate')
            if isinstance(gate,str):row['market_gate']=json.loads(gate)
            if row['market']=='KOSPI':
                c=kospi_confirmation(obs(row),obs(prev),obs(before),True);entry=c['eligible'] and c['state']=='confirmed';origin=c['originDate']
            else:
                entry=kr_operational_signals(row['market'],prev.get('score') if prev else None,row.get('score'),bool(row.get('eligible')))['kosdaq80Onset'];origin=day
            if entry and day>=CONTRACT['start']:
                events.append({'date':day,'symbol':symbol,'market':row['market'],'sector':row.get('sector'),'origin':origin,'decision_at':row['available_at']})
            history[symbol]=(h+[row])[-2:]
    kr_events=pd.DataFrame(events);summary['counts']['kr_candidates']=len(kr_events)
    out.frame('kr_candidates.parquet',kr_events)
    panels=[];labels=[]
    ksimple=k[['session_date','symbol','comparison_open','comparison_close','source_volume','market','sector']].rename(columns={'session_date':'date','comparison_open':'open','comparison_close':'close','source_volume':'volume'})
    for mk in ['KOSPI','KOSDAQ']:
        f=ksimple.loc[ksimple.market.eq(mk)]
        p=prices(f,dates['K']);ev=kr_events.loc[kr_events.market.eq(mk)]
        for h in CONTRACT['D_horizons']:labels.append(event_labels(ev,p,benchmarks[mk],dates['K'],h))
    for sec in CONTRACT['sectors']:
        f=ksimple.loc[ksimple.sector.eq(sec)]
        if f.empty:continue
        p=prices(f,dates['K']);sm=f.drop_duplicates('symbol').set_index('symbol').market
        bm={col:pd.DataFrame({s:benchmarks[sm[s]][col] for s in p['close'].columns}) for col in ['open','close']}
        panel=sector_panel(p,bm,calendars['K']);panel['market']='KR';panel['sector']=sec;panels.append(panel)
    del k,ksimple,history;gc.collect()
    # Download US expanded prices once. All years are hashed before any performance estimate.
    paths=[]
    for year in range(2015,2027):
        key=f'prices/year={year}/data_0.parquet';raw=us.get_object(key,max_bytes=64*1024**2)
        f=pd.read_parquet(io.BytesIO(raw));require(not f.duplicated(['date','ticker']).any(),'duplicate expanded US price key')
        inventory.append({'source':key,'bytes':len(raw),'sha256':sha(raw),'rows':len(f),'min_date':str(f.date.min()),'max_date':str(f.date.max())})
        ratio=f.closeadj/f.close.where(f.close>0)
        f['open']=f.open*ratio;f['close']=f.closeadj;f=f.rename(columns={'ticker':'symbol'})
        f=f.loc[f.symbol.isin(allowed)&f.date.le(CONTRACT['end']),['date','symbol','open','close','volume']].copy();f['sector']=f.symbol.map(mapdict)
        p=work/f'us-{year}.parquet';f.to_parquet(p,index=False);paths.append(p)
        print('CM05_US_YEAR_VERIFIED',year,len(f),flush=True)
    raw=us.get_object('benchmark/spy.parquet',max_bytes=1024**2);spy=pd.read_parquet(io.BytesIO(raw))
    spy['open']=spy.open*spy.closeadj/spy.close;spy['close']=spy.closeadj
    spy=spy.set_index('date').reindex(dates['U'])[['open','close']];out.frame('benchmark_US.parquet',spy.reset_index())
    # A0 all candidates before portfolio cash/slots; state matches frozen universe exactly.
    state={};uevents=[]
    for p in sorted((normalized/'U').glob('*.parquet')):
        f=pd.read_parquet(p);f=f.loc[f.session_date.le(CONTRACT['end'])]
        for day,g in f.groupby('session_date',sort=True):
            records=g.astype(object).where(g.notna(),None).to_dict('records');a=us_session_analysis(records,state);state=a['state']
            if day<CONTRACT['start']:continue
            known=max(g.available_at)
            for r in a['rows']:
                if r['a0Entry']:uevents.append({'date':day,'symbol':r['symbol'],'market':'US','sector':mapdict.get(r['symbol']),'origin':day,'decision_at':known})
        if p.stem.endswith('-12'):print('CM05_A0_SIGNALS_YEAR',p.stem[:4],len(uevents),flush=True)
    ue=pd.DataFrame(uevents);out.frame('us_candidates.parquet',ue);summary['counts']['us_candidates']=len(ue)
    for sec in CONTRACT['sectors']:
        f=pd.concat([pd.read_parquet(p,filters=[('sector','==',sec)]) for p in paths],ignore_index=True)
        if f.empty:continue
        p=prices(f,dates['U']);panel=sector_panel(p,spy,calendars['U']);panel['market']='US';panel['sector']=sec;panels.append(panel)
        ev=ue.loc[ue.sector.eq(sec)]
        if len(ev):
            for h in CONTRACT['D_horizons']:labels.append(event_labels(ev,p,spy,dates['U'],h))
        del f,p;gc.collect();print('CM05_SECTOR_COMPLETED',sec,flush=True)
    panel=pd.concat(panels,ignore_index=True);require(not panel.duplicated(['market','sector','date']).any(),'duplicate final sector key')
    out.frame('sector_panel.parquet',panel)
    lab=pd.concat(labels,ignore_index=True);out.frame('candidate_labels.parquet',lab)
    coverage=panel.assign(year=panel.date.str[:4]).groupby(['market','sector','year']).agg(sessions=('date','size'),ready_sessions=('ready','sum'),min_n=('n','min'),mean_n=('n','mean'),mean_coverage=('coverage','mean')).reset_index()
    out.frame('coverage.parquet',coverage);out.save('source_inventory.json',inventory)
    summary['counts'].update(panel_rows=len(panel),labels=len(lab),label_statuses=lab.status.value_counts().to_dict(),ready_panel_rows=int(panel.ready.sum()))
    summary.update(status='A_B_AND_D_LABELS_COMPLETE_NOT_STATISTICAL_CONCLUSION',elapsed_seconds=time.monotonic()-start,peak_rss_kib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
    summary['stages']={'A':'SOURCE_RECONCILIATION_COMPLETE_LIMITS_RETAINED','B':'PANELS_COMPLETE','C':'PENDING_STATISTICS','D':'CANDIDATES_LABELS_READY_STATISTICS_PENDING','E':'NOT_RUN'}
    out.save('summary.json',summary);out.save('completion.json',{'files':out.files,'status':summary['status'],'code_hashes':code_hashes})
    print('CM05_BUILD_SUMMARY '+json.dumps(summary,sort_keys=True),flush=True)
if __name__=='__main__':main()
