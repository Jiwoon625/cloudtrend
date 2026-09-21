#!/usr/bin/env python3
"""Persist completed research only. Never rerun backtests or overwrite objects."""
import hashlib,json,os,urllib.request,urllib.error,zipfile
from pathlib import Path

root=Path('analysis-runs/m0-archive');root.mkdir(parents=True,exist_ok=True)
payload=b''.join(p.read_bytes() for p in sorted(Path('research/etf-m0-archive-payload').glob('part-*.bin')))
archive=root/'supplement.zip';archive.write_bytes(payload)
with zipfile.ZipFile(archive) as z:z.extractall(root/'supplement')
manifest=json.loads(Path('research/etf-m0-archive-manifest.json').read_text())
url=os.environ['SUPABASE_URL'].rstrip('/');key=os.environ['SUPABASE_SERVICE_ROLE_KEY'];bucket=manifest['bucket'];prefix=manifest['prefix']
assert os.environ['SUPABASE_USER_ID']==prefix.split('/')[0], 'Owner prefix mismatch'
headers={'Authorization':'Bearer '+key,'apikey':key}

def request(method,path,data=None,extra=None):
    req=urllib.request.Request(url+'/storage/v1/'+path,data=data,headers={**headers,**(extra or {})},method=method)
    return urllib.request.urlopen(req,timeout=180)

def list_folder(folder):
    data=json.dumps({'prefix':folder,'limit':1000,'offset':0,'sortBy':{'column':'name','order':'asc'}}).encode()
    with request('POST','object/list/'+bucket,data,{'Content-Type':'application/json'}) as r:return json.load(r)

entries={}
for folder in sorted({str(Path(f['path']).parent) for f in manifest['files']}|{'.'}):
    remote=prefix if folder=='.' else prefix+'/'+folder
    for x in list_folder(remote):
        if x.get('id'):entries[(folder+'/' if folder!='.' else '')+x['name']]=x

# Verify all local files before any upload.
for f in manifest['files']:
    rel=f['path'];p=Path('analysis-runs/m0-main')/rel.removeprefix('enhancement/capped/') if rel.startswith('enhancement/capped/') else root/'supplement'/rel
    b=p.read_bytes();assert len(b)==f['size'] and hashlib.sha256(b).hexdigest()==f['sha256'], 'Local file checksum mismatch: '+rel

results=[]
for f in manifest['files']:
    rel=f['path'];remote=prefix+'/'+rel
    if rel in entries:
        # User requested no duplicate saves: verify an existing object instead of replacing it.
        with request('GET','object/authenticated/'+bucket+'/'+remote) as r:existing=r.read()
        if hashlib.sha256(existing).hexdigest()!=f['sha256']:raise RuntimeError('Existing object differs; not overwritten: '+remote)
        results.append(dict(path=remote,status='already_saved'));continue
    p=Path('analysis-runs/m0-main')/rel.removeprefix('enhancement/capped/') if rel.startswith('enhancement/capped/') else root/'supplement'/rel
    ext=p.suffix;ctype={'.json':'application/json','.csv':'text/csv','.md':'text/markdown','.gz':'application/gzip'}.get(ext,'application/octet-stream')
    with request('POST','object/'+bucket+'/'+remote,p.read_bytes(),{'Content-Type':ctype,'x-upsert':'false'}) as r:assert r.status in [200,201]
    results.append(dict(path=remote,status='uploaded'))

# List back to verify the object size for every result; no bulk result redownload.
verified={}
for folder in sorted({str(Path(f['path']).parent) for f in manifest['files']}):
    remote=prefix if folder=='.' else prefix+'/'+folder
    for x in list_folder(remote):
        if x.get('id'):verified[(folder+'/' if folder!='.' else '')+x['name']]=x
for f in manifest['files']:
    x=verified[f['path']];assert int(x['metadata']['size'])==f['size'], 'Remote size mismatch: '+f['path']
index={**manifest,'verification':'all local SHA256 checked; uploaded with no upsert; remote object sizes verified','savedFiles':len(results)}
if 'manifest.json' not in entries:
    with request('POST','object/'+bucket+'/'+prefix+'/manifest.json',json.dumps(index,ensure_ascii=False,indent=2).encode(),{'Content-Type':'application/json','x-upsert':'false'}) as r:assert r.status in [200,201]
(root/'archive-receipt.json').write_text(json.dumps(dict(prefix=prefix,files=len(results),uploaded=sum(x['status']=='uploaded' for x in results),skipped=sum(x['status']=='already_saved' for x in results),verified=True,objects=results),indent=2))
print(json.dumps(dict(prefix=prefix,files=len(results),uploaded=sum(x['status']=='uploaded' for x in results),verified=True)))
