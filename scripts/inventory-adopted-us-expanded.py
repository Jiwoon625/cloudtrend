#!/usr/bin/env python3
"""Read existing expanded market inputs; write a private hash/schema inventory only."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import re
import tempfile
import pandas as pd
import pyarrow.parquet as pq
import requests

spec = importlib.util.spec_from_file_location('private_job', Path(__file__).with_name('run-adopted-backtest-job.py'))
job = importlib.util.module_from_spec(spec); spec.loader.exec_module(job)
YEAR_BYTES = [31944875,31246364,30529940,31324639,31888174,33129482,39446204,42289923,38553683,36175681,34759165,26187831]
SOURCES = [(f'research/us/expanded/prices/year={y}/data_0.parquet', b) for y,b in zip(range(2015,2027),YEAR_BYTES)] + [
 ('research/us/expanded/benchmark/spy.parquet',141636),
 ('research/us/expanded/manifest.json',380),
 ('research/us/Expended/Reference/tickers.csv',24975596),
 ('research/us/Expended/Reference/actions.csv',49568954),
 ('research/us/expanded/reference/sector_map_extended.csv',4465654),
 ('research/us/expanded/reference/verified_event_overrides.csv',601),
 ('research/cm/manifest.json',153026),
 ('research/cm/inputs/cm06.batched.stage.CloseadjInputsV2.json',131485)]

def inventory(root, storage):
    report = {'schema':'expanded-us-input-inventory-v1','codeCommit':job.validated_code_commit(os.environ),'files':[]}
    all_symbols=set()
    for i,(relative,size) in enumerate(SOURCES):
        path=root/str(i); key=storage.owner+'/'+relative
        storage.input_keys.add(key)
        evidence=storage.download_observed(key,path,size)
        item={'source':relative,**evidence}
        if relative.endswith('.parquet'):
            pf=pq.ParquetFile(path); item.update(rows=pf.metadata.num_rows,columns=pf.schema_arrow.names)
            job.require({'ticker','date'}.issubset(item['columns']),'EXPANDED_SCHEMA_MISMATCH')
            frame=pd.read_parquet(path,columns=['ticker','date'])
            job.require(frame.ticker.notna().all() and frame.date.notna().all(),'EXPANDED_IDENTITY_NULL')
            job.require(not frame.duplicated(['ticker','date']).any(),'EXPANDED_IDENTITY_DUPLICATE')
            symbols=set(frame.ticker.astype(str)); dates=pd.to_datetime(frame.date).dt.strftime('%Y-%m-%d')
            item.update(symbols=len(symbols),firstDate=dates.min(),lastDate=dates.max(),literalNaRows=int(frame.ticker.eq('NA').sum()))
            if '/prices/' in relative: all_symbols.update(symbols)
        elif relative.endswith('.csv'):
            frame=pd.read_csv(path,keep_default_na=False,low_memory=False)
            item.update(rows=len(frame),columns=list(frame.columns))
            if relative.endswith('/tickers.csv'):
                sep=frame[frame['table'].eq('SEP')]
                common=sep.category.str.contains('Common Stock',regex=False)
                item.update(sepRows=len(sep),sepCommonRows=int(common.sum()),sepDuplicateTickers=int(sep.ticker.duplicated().sum()),sepDuplicatePermatickers=int(sep.permaticker.duplicated().sum()))
        else:
            raw=json.loads(path.read_bytes()); item['manifest']=raw
        report['files'].append(item)
    report['priceSymbols']=len(all_symbols)
    report['priceRows']=sum(x['rows'] for x in report['files'] if '/prices/' in x['source'])
    return report

def safe_metadata(report, sha):
    # Explicit scalar projection only; no raw rows, tickers, owner, source JSON, or credentials.
    files=[]
    for item in report['files']:
        x={k:item[k] for k in ['source','bytes','sha256','rows','symbols','firstDate','lastDate','literalNaRows','sepRows','sepCommonRows','sepDuplicateTickers','sepDuplicatePermatickers'] if k in item}
        job.require(re.fullmatch(r'research/[A-Za-z0-9/_.=-]+',x['source']),'INVALID_INVENTORY_SOURCE')
        job.check_hash(x['sha256'])
        for k,v in x.items():
            if k not in ['source','sha256','firstDate','lastDate']:
                job.require(type(v) is int and v>=0,'INVALID_INVENTORY_COUNT')
        for k in ['firstDate','lastDate']:
            if k in x: job.require(job.summary_date(x[k]),'INVALID_INVENTORY_DATE')
        files.append(x)
    payload={'schema':report['schema'],'codeCommit':report['codeCommit'],'inventorySha256':sha,'priceSymbols':report['priceSymbols'],'priceRows':report['priceRows'],'files':files}
    encoded=base64.b64encode(job.json_bytes(payload)).decode()
    job.require(len(encoded)<8000,'INVENTORY_METADATA_TOO_LARGE')
    return encoded

def main():
    job.require(os.environ.get('GITHUB_ACTIONS')=='true' and os.environ.get('GITHUB_REF')==job.REQUEST_BRANCH,'EXPLICIT_GITHUB_JOB_REQUIRED')
    event=job.read_local_json(os.environ.get('GITHUB_EVENT_PATH'),10*job.CHUNK,'INVALID_PUSH_EVENT')
    job.require(event.get('head_commit',{}).get('message','').splitlines()[0]=='inventory(adopted-backtest): expanded US','EXPLICIT_INVENTORY_COMMIT_REQUIRED')
    run=os.environ['GITHUB_RUN_ID']+'-'+os.environ['GITHUB_RUN_ATTEMPT']
    s=job.PrivateStorage(requests.Session(),os.environ['SUPABASE_URL'].rstrip('/'),os.environ['SUPABASE_USER_ID'],os.environ['SUPABASE_SERVICE_ROLE_KEY'],'0'*64,run)
    s.verify_private_bucket()
    with tempfile.TemporaryDirectory(prefix='expanded-inventory-') as tmp:
        root=Path(tmp); report=inventory(root,s)
        out=root/'inventory.json'; out.write_bytes(job.json_bytes(report))
        evidence=job.digest_file(out); header=safe_metadata(report,evidence['sha256'])
        key=s.run_prefix+'result/expanded-input-inventory.json'; s.output_keys.add(key)
        with out.open('rb') as stream:
            with job.safe_response(s.session,'POST',s._url(key,write=True),headers={**s.headers,'x-upsert':'false','Content-Type':'application/octet-stream','x-metadata':header},data=stream,timeout=(20,900)) as response:
                job.require(response.status_code in (200,201),'INVENTORY_CREATE_FAILED')
        s.download(key,root/'readback',evidence)
    print('EXPANDED_INVENTORY_COMPLETE_PRIVATE_RESULT_VERIFIED')

if __name__=='__main__':
    try: main()
    except job.JobError as e: print('STOPPED:'+str(e)); raise SystemExit(1)
    except Exception: print('STOPPED:UNEXPECTED_INVENTORY_FAILURE'); raise SystemExit(1)
