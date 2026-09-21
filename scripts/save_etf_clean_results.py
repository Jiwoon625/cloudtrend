#!/usr/bin/env python3
"""Append-only private Storage archive with local hashes and remote MD5 checks."""
import hashlib,json,os,urllib.request
from pathlib import Path

def main():
    root=Path('analysis-runs/m0-clean');bucket='cloudtrend-data';owner=os.environ['SUPABASE_USER_ID'];run=os.environ['GITHUB_RUN_ID']
    assert owner=='bdfc8818-33a7-4030-9dbd-ecad39f223ac'
    prefix=f'{owner}/results/etf-m0-clean-inputs/20260911/{run}'
    url=os.environ['SUPABASE_URL'].rstrip('/');key=os.environ['SUPABASE_SERVICE_ROLE_KEY']
    headers={'Authorization':'Bearer '+key,'apikey':key}
    def request(method,path,data=None,ctype='application/json'):
        req=urllib.request.Request(url+'/storage/v1/'+path,data=data,method=method,headers={**headers,'Content-Type':ctype,'x-upsert':'false'})
        with urllib.request.urlopen(req,timeout=180) as r:return r.read()
    files=[]
    for p in sorted(root.iterdir()):
        if not p.is_file() or p.name in {'manifest.json','storage-receipt.json'}:continue
        assert p.suffix not in {'.md','.html','.pdf'},'No separate report artifacts'
        b=p.read_bytes();files.append(dict(path=p.name,size=len(b),sha256=hashlib.sha256(b).hexdigest(),md5=hashlib.md5(b).hexdigest()))
    existing=json.loads(request('POST','object/list/'+bucket,json.dumps({'prefix':prefix,'limit':1000,'offset':0}).encode()));existing={x['name']:x for x in existing if x.get('id')}
    for f in files:
        if f['path'] in existing:
            m=existing[f['path']]['metadata'];assert int(m['size'])==f['size'] and str(m['eTag']).strip('"')==f['md5'];continue
        ext=Path(f['path']).suffix;ctype={'.csv':'text/csv','.json':'application/json'}.get(ext,'application/octet-stream')
        request('POST','object/'+bucket+'/'+prefix+'/'+f['path'],(root/f['path']).read_bytes(),ctype)
    remote=json.loads(request('POST','object/list/'+bucket,json.dumps({'prefix':prefix,'limit':1000,'offset':0}).encode()));remote={x['name']:x for x in remote if x.get('id')}
    for f in files:
        m=remote[f['path']]['metadata'];assert int(m['size'])==f['size'] and str(m['eTag']).strip('"')==f['md5']
    manifest=dict(bucket=bucket,prefix=prefix,files=files,commit=os.environ['GITHUB_SHA'],cutoff='2026-09-11',verified=True)
    content=json.dumps(manifest,ensure_ascii=False,indent=2).encode();(root/'manifest.json').write_bytes(content)
    if 'manifest.json' not in existing:request('POST','object/'+bucket+'/'+prefix+'/manifest.json',content)
    receipt=dict(bucket=bucket,prefix=prefix,files=len(files),bytes=sum(f['size'] for f in files),verified=True)
    (root/'storage-receipt.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt))
if __name__=='__main__':main()
