"""Read-only bounded research export to an existing private Drive research folder.

No database/storage write API exists in this script. No credentials or raw universe
are uploaded. Date-local sector labels remain attached to their original source.
"""
import csv,hashlib,importlib.util,io,json,os,pathlib,sys,urllib.parse,urllib.request,zipfile
import pandas as pd
import numpy as np

SYMBOLS=set('AGPU CEVA CHPT DNA ECG ENTG FSLY GLW MTSI NCPL NOK PLTR POET PRME RDWR RKLB SECZ TBCH VLN SPY'.split())
OWNER='bdfc8818-33a7-4030-9dbd-ecad39f223ac'
FOLDER='1pw3xCHAO4GjAzhiMngrmQV58HJWu4HHh'
def sha(b):return hashlib.sha256(b).hexdigest()
def get(path,limit=32*1024**2):
    if not (path.startswith('/rest/v1/us_screening_ingest?') or path.startswith('/storage/v1/object/cloudtrend-data/'+OWNER+'/source/us-screening/')):
        raise ValueError('Only allowlisted read paths')
    key=os.environ['SUPABASE_SERVICE_ROLE_KEY']
    req=urllib.request.Request(os.environ['SUPABASE_URL'].rstrip('/')+path,headers={'apikey':key,'Authorization':'Bearer '+key},method='GET')
    with urllib.request.urlopen(req,timeout=60) as r:b=r.read(limit+1)
    if len(b)>limit:raise ValueError('Read bound exceeded')
    return b
def main():
    s=importlib.util.spec_from_file_location('drive_transport',pathlib.Path(__file__).parents[2]/'scripts/drive-screening-transfer.py')
    mod=importlib.util.module_from_spec(s);s.loader.exec_module(mod)
    drive=mod.Drive(mod.get_token())
    existing=drive.children(FOLDER)
    if any(r['name']=='bounded-us-inputs-r3.zip' for r in existing):
        print('Bounded research export already present; no duplicate write');return
    history_bytes=drive.download('1cWHJeNCPBSZVa0fWfXqO6en5SX-GKcOY')
    hist=pd.read_parquet(io.BytesIO(history_bytes));hist['date']=pd.to_datetime(hist.date).dt.strftime('%Y-%m-%d')
    if hist.duplicated(['date','symbol']).any():raise ValueError('Cached price duplicate')
    query=urllib.parse.urlencode({'user_id':'eq.'+OWNER,'as_of_date':'gte.2026-09-25','select':'as_of_date,storage_path,data_hash,collected_at','order':'as_of_date.asc'})
    records=json.loads(get('/rest/v1/us_screening_ingest?'+query))
    frames=[];receipts=[]
    for r in records:
        day=r['as_of_date']
        if day>'2026-11-06':continue
        prefix=OWNER+'/source/us-screening/'+day+'/'
        if not r['storage_path'].startswith(prefix):raise ValueError('Source prefix mismatch')
        raw=get('/storage/v1/object/cloudtrend-data/'+urllib.parse.quote(r['storage_path'],safe='/'))
        expected=r['data_hash'].removeprefix('sha256:')
        if sha(raw)!=expected:raise ValueError('Source byte hash mismatch')
        f=pd.read_csv(io.BytesIO(raw),dtype={'symbol':str,'date':str})
        if f.date.nunique()!=1 or f.date.iloc[0]!=day or f.symbol.duplicated().any():raise ValueError('Source date/key mismatch')
        receipts.append({'date':day,'path':r['storage_path'],'sha256':sha(raw),'bytes':len(raw),'symbols':len(f),'collected_at':r['collected_at']})
        frames.append(f)
    if not frames or max(f.date.iloc[0] for f in frames)<'2026-11-06':raise ValueError('Latest complete input not obtained')
    pricecols=['date','symbol','open','high','low','close','volume']
    delta=pd.concat([f[pricecols] for f in frames],ignore_index=True)
    prices=pd.concat([hist[pricecols],delta],ignore_index=True).drop_duplicates(['date','symbol'],keep='last').sort_values(['date','symbol'])
    closes=prices.pivot(index='date',columns='symbol',values='close').sort_index()
    sessions=closes.index[closes['SPY'].notna()]
    closes=closes.reindex(sessions)
    ret20=closes/closes.shift(20)-1
    sectors=[]
    for f in frames:
        day=f.date.iloc[0]
        if day not in ret20.index:continue
        valid=f[f.is_common_share.astype(str).str.lower().eq('true')].copy()
        valid['return20']=valid.symbol.map(ret20.loc[day]);spy=float(ret20.loc[day,'SPY'])
        for sector,g in valid.groupby('sector',dropna=False):
            n=len(g);observed=g.return20.notna().sum();rs=float(g.return20.median()-spy) if observed and np.isfinite(spy) else None
            sectors.append({'date':day,'sector':sector,'n':n,'observed':int(observed),'coverage':observed/n,'rs20':rs,'ready':bool(observed>=10 and observed/n>=.8),'median_ret120':g.ret120.median(),'median_ret252':g.ret252.median(),'classification':'DATE_LOCAL_STORED_SOURCE','available_at':next(r['collected_at'] for r in receipts if r['date']==day)})
    selected=prices[prices.symbol.isin(SYMBOLS)]
    files={'prices_selected.csv':selected.to_csv(index=False).encode(),'sector_asof.csv':pd.DataFrame(sectors).to_csv(index=False).encode(),'source_receipts.json':json.dumps(receipts,indent=2).encode()}
    files['manifest.json']=json.dumps({'experiment':'p123-r3-20261108','cache_file_id':'1cWHJeNCPBSZVa0fWfXqO6en5SX-GKcOY','cache_sha256':sha(history_bytes),'cache_max_date':str(hist.date.max()),'source_end':'2026-11-06','selected_symbols':sorted(SYMBOLS),'files':{n:{'sha256':sha(b),'bytes':len(b)} for n,b in files.items()},'operations':'GET only on Supabase; new private Drive file only','full_raw_universe_uploaded':False,'script_sha256':sha(pathlib.Path(__file__).read_bytes())},indent=2).encode()
    z=io.BytesIO()
    with zipfile.ZipFile(z,'w',zipfile.ZIP_DEFLATED) as package:
        for n,b in files.items():package.writestr(n,b)
    payload=z.getvalue();upload=drive.upload(FOLDER,'bounded-us-inputs-r3.zip',payload,'application/zip')
    if sha(drive.download(upload['id']))!=sha(payload):raise ValueError('Drive readback mismatch')
    print('Read-only research export completed; private Drive readback verified')
if __name__=='__main__':main()
