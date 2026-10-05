"""New approved comparison features; completed Stage2 shards remain immutable.

Uses complete symbol histories already aligned to SPY. Only price-dependent
features change. Original dollar volume/ADV and volume features are retained.
Amihud uses closeadj returns divided by original dollar volume.
"""
from pathlib import Path
import argparse, hashlib, json, time, shutil
import numpy as np
import pandas as pd
import pyarrow.parquet as pq

CHANGED = 'ret1 ret120 ret252 amihud_raw amihud20 tenkan9 kijun26 ichimoku_tk_gap spy_ret1 beta60_spy signal_close'.split()
PRESERVED = 'open high low close volume closeadj closeunadj dollar_volume adv20_usd adv20_prior vol20_avg relvol1_20 active20'.split()
BASIS = 'CLOSEADJ_FEATURES_AND_EXECUTION'

def sha(p):
    h=hashlib.sha256()
    with Path(p).open('rb') as f:
        for b in iter(lambda:f.read(1048576),b''):h.update(b)
    return h.hexdigest()

def save(p,v):
    with Path(p).open('x',encoding='utf-8') as f:json.dump(v,f,indent=2,allow_nan=False)

def transform(frame,spy):
    f=frame.sort_values(['symbol','date']).reset_index(drop=True).copy()
    if f.duplicated(['symbol','date']).any():raise ValueError('Duplicate symbol session')
    observed=f.source_observed.astype(bool)
    valid=np.isfinite(f[['open','high','low','close','closeadj']]).all(axis=1)&f[['open','high','low','close','closeadj']].gt(0).all(axis=1)
    if (observed & ~valid).any():raise ValueError('Observed adjusted quote invalid; no silent exclusion')
    ratio=(f.closeadj/f.close).where(valid)
    for c in CHANGED:
        if 'stage2_'+c in f:raise ValueError('Already transformed')
        f['stage2_'+c]=f[c]
    f['signal_close']=f.closeadj.where(valid)
    g=f.groupby('symbol',sort=False)
    for n,c in [(1,'ret1'),(120,'ret120'),(252,'ret252')]:
        f[c]=g.signal_close.pct_change(n,fill_method=None)
    f['amihud_raw']=f.ret1.abs()/f.dollar_volume.replace(0,np.nan)
    f['amihud20']=f.groupby('symbol').amihud_raw.transform(lambda s:s.rolling(20,min_periods=20).mean())
    hi=f.high*ratio;lo=f.low*ratio
    for n,c in [(9,'tenkan9'),(26,'kijun26')]:
        f[c]=(hi.groupby(f.symbol).transform(lambda s:s.rolling(n,min_periods=n).max())+lo.groupby(f.symbol).transform(lambda s:s.rolling(n,min_periods=n).min()))/2
    f['ichimoku_tk_gap']=f.tenkan9/f.kijun26-1
    s=spy.sort_values('date').set_index('date')
    sr=s.closeadj.pct_change(fill_method=None)
    f['spy_ret1']=f.date.map(sr)
    f['beta60_spy']=np.nan
    for _,indices in f.groupby('symbol',sort=False).groups.items():
        a=f.loc[indices,'ret1'];b=f.loc[indices,'spy_ret1']
        f.loc[indices,'beta60_spy']=a.rolling(60,min_periods=50).cov(b)/b.rolling(60,min_periods=50).var().replace(0,np.nan)
    f['signal_price_basis']=BASIS
    f['comparison_liquidity_basis']='ORIGINAL_DOLLAR_VOLUME_AND_ADV_UNCHANGED'
    original=frame.sort_values(['symbol','date']).reset_index(drop=True)
    pd.testing.assert_frame_equal(f[PRESERVED],original[PRESERVED],check_exact=True)
    if not f[['historical_eligibility_verified','raw_execution_verified']].eq(False).all().all():raise ValueError('Certification unexpectedly changed')
    return f

def run(root,output):
    root,output=Path(root),Path(output)
    source=root/'data/us/numeric_features_existing_v1'
    mp=source/'manifest.json';m=json.loads(mp.read_text())
    if m['status']!='NUMERIC_FEATURES_COMPLETE_GATES_STILL_OPEN':raise ValueError('Stage2 source incomplete')
    if output.exists():raise FileExistsError('Fresh output required; preserve all previous attempts')
    if shutil.disk_usage(root).free<8_000_000_000:raise ValueError('Insufficient comparison workspace')
    output.mkdir(parents=True)
    save(output/'contract.json',{'signal_price_basis':BASIS,'source_manifest_sha256':sha(mp),'implementation_sha256':sha(__file__),'original_stage2_modified':False,'cash_distributions_added':False,'historical_paths_completed':0})
    groups={}
    for item in m['outputs']:
        p=Path(item['path'])
        if p.is_absolute() or '..' in p.parts:raise ValueError('Unsafe source path')
        groups.setdefault(p.name,[]).append(item)
    audit=pd.read_csv(source/'symbol_audit.csv',keep_default_na=False,dtype={'symbol':str})
    symbols=sorted(audit.symbol)
    spy_batch=sorted(groups)[symbols.index('SPY')//16]
    def read(items,columns=None):
        frames=[]
        for item in items:
            p=source/item['path']
            if sha(p)!=item['sha256']:raise ValueError('Stage2 shard hash changed')
            frames.append(pq.ParquetFile(p).read(columns=columns).to_pandas())
        return pd.concat(frames,ignore_index=True)
    spy=read(groups[spy_batch],['symbol','date','closeadj']).loc[lambda x:x.symbol.eq('SPY')].sort_values('date')
    if len(spy)!=m['spy_sessions'] or spy.date.duplicated().any() or not np.isfinite(spy.closeadj).all() or not spy.closeadj.gt(0).all():raise ValueError('SPY comparison history invalid')
    receipts=[];seen=set();rows=0;changed_counts={c:0 for c in CHANGED};started=time.perf_counter()
    for idx,(batch,items) in enumerate(sorted(groups.items())):
        f=read(items)
        names=set(f.symbol)
        if names&seen:raise ValueError('Symbols span unexpected batches')
        seen.update(names)
        t=transform(f,spy)
        for c in CHANGED:
            changed_counts[c]+=int((~np.isclose(t[c].astype(float),t['stage2_'+c].astype(float),equal_nan=True,rtol=1e-10,atol=1e-12)).sum())
        batch_receipts=[]
        for year,part in t.groupby(t.date.str[:4],sort=True):
            rel=Path('year='+year)/batch;p=output/rel;p.parent.mkdir(exist_ok=True)
            part.to_parquet(p,index=False,compression='zstd')
            rec={'path':rel.as_posix(),'year':int(year),'rows':len(part),'size_bytes':p.stat().st_size,'sha256':sha(p)}
            receipts.append(rec);batch_receipts.append(rec);rows+=len(part)
        save(output/(batch+'.receipt.json'),{'symbols':sorted(names),'outputs':batch_receipts})
        if idx%20==0 or idx+1==len(groups):print(json.dumps({'stage':'closeadj_features','batches':idx+1,'total_batches':len(groups),'symbols':len(seen),'rows':rows,'elapsed_seconds':time.perf_counter()-started}),flush=True)
    if seen!=set(symbols) or rows!=m['counts']['output_rows']:raise ValueError('Entire universe row coverage mismatch')
    shutil.copyfile(source/'symbol_audit.csv',output/'symbol_audit.csv')
    result={'status':'COMPLETE_CLOSEADJ_COMPARISON_FEATURES','signal_price_basis':BASIS,'source_manifest_sha256':sha(mp),'implementation_sha256':sha(__file__),'outputs':receipts,'symbols':len(seen),'rows':rows,'changed_cells':changed_counts,'liquidity_preserved_exactly':True,'original_stage2_modified':False,'historical_paths_completed':0,'elapsed_seconds':time.perf_counter()-started}
    save(output/'manifest.json',result)
    print(json.dumps({k:v for k,v in result.items() if k!='outputs'}),flush=True)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--output',required=True);a=p.parse_args();run(a.root,a.output)
