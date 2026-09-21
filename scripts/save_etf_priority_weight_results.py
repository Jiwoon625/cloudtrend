#!/usr/bin/env python3
"""Append-only reference and research result persistence, checked by content hashes."""
import argparse,hashlib,json,os,urllib.request
from pathlib import Path

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--reference-only',action='store_true');a=ap.parse_args()
    owner=os.environ['SUPABASE_USER_ID'];assert owner=='bdfc8818-33a7-4030-9dbd-ecad39f223ac'
    bucket='cloudtrend-data';url=os.environ['SUPABASE_URL'].rstrip('/');key=os.environ['SUPABASE_SERVICE_ROLE_KEY']
    def req(method,path,data=None,ctype='application/json'):
        q=urllib.request.Request(url+'/storage/v1/'+path,data=data,method=method,headers={'Authorization':'Bearer '+key,'apikey':key,'Content-Type':ctype,'x-upsert':'false'})
        with urllib.request.urlopen(q,timeout=180) as r:return r.read()
    def ls(prefix):
        return {x['name']:x for x in json.loads(req('POST','object/list/'+bucket,json.dumps({'prefix':prefix,'limit':1000,'offset':0}).encode())) if x.get('id')}
    def archive(prefix,files):
        old=ls(prefix);manifest=[]
        for name,b in files.items():
            sha=hashlib.sha256(b).hexdigest();md5=hashlib.md5(b).hexdigest()
            if name in old:
                meta=old[name]['metadata'];assert int(meta['size'])==len(b) and str(meta['eTag']).strip('"')==md5,'Different existing object; not overwritten'
            else:req('POST','object/'+bucket+'/'+prefix+'/'+name,b,{'.csv':'text/csv','.json':'application/json'}.get(Path(name).suffix,'application/octet-stream'))
            manifest.append(dict(path=name,size=len(b),sha256=sha,md5=md5))
        current=ls(prefix)
        for f in manifest:
            meta=current[f['path']]['metadata'];assert int(meta['size'])==f['size'] and str(meta['eTag']).strip('"')==f['md5']
        return manifest
    mapping=Path('research/etf-universe-sector-map-20260911.csv');b=mapping.read_bytes();prefix=owner+'/source/Reference'
    refmeta=dict(file=mapping.name,symbols=393,cutoff='2026-09-11',sha256=hashlib.sha256(b).hexdigest(),mappingBasis='current name and underlying-index snapshot; not point-in-time holdings')
    archive(prefix,{mapping.name:b,'etf-universe-sector-map-20260911.metadata.json':json.dumps(refmeta,ensure_ascii=False,indent=2).encode()})
    print(json.dumps({'referencePrefix':prefix,'mappingSymbols':393,'verified':True}),flush=True)
    if a.reference_only:return
    root=Path('analysis-runs/m0-priority-weights');prefix=owner+'/results/etf-m0-priority-weights/20260911/'+os.environ['GITHUB_RUN_ID']
    archive(owner+'/source/Reference',{'etf-environment-routing-20260911-peer-mix.csv':(root/'etf-environment-routing-20260911.csv').read_bytes()})
    files={p.name:p.read_bytes() for p in sorted(root.iterdir()) if p.is_file() and p.name not in {'manifest.json','storage-receipt.json'}}
    assert all(Path(n).suffix not in {'.md','.pdf','.html'} for n in files)
    manifest=archive(prefix,files);doc=dict(prefix=prefix,bucket=bucket,files=manifest,commit=os.environ['GITHUB_SHA'],verified=True)
    archive(prefix,{'manifest.json':json.dumps(doc,ensure_ascii=False,indent=2).encode()})
    (root/'storage-receipt.json').write_text(json.dumps(dict(prefix=prefix,files=len(files),referenceVerified=True,verified=True),indent=2))
    print(json.dumps({'resultsPrefix':prefix,'files':len(files),'verified':True}))
if __name__=='__main__':main()
