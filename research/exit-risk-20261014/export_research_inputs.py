"""Read-only pinned research transfer. Only authenticated ciphertext leaves the job."""
import os,json,hashlib,tarfile,tempfile,requests
from pathlib import Path
from urllib.parse import quote
from cryptography.hazmat.primitives import serialization,hashes
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.ciphers import Cipher,algorithms,modes

ROOT=Path(os.environ['RUNNER_TEMP'])/'exit-transfer'
ROOT.mkdir(mode=0o700)
owner=os.environ['SUPABASE_USER_ID'];base=os.environ['SUPABASE_URL']
assert base=='https://ahbvrtugugwnbrfnbxzp.supabase.co'
headers={'apikey':os.environ['SUPABASE_SERVICE_ROLE_KEY'],'Authorization':'Bearer '+os.environ['SUPABASE_SERVICE_ROLE_KEY']}
session=requests.Session()
prefix=owner+'/research/adopted-full-period/'
items=[]
def get(key,relative,sha=None):
    assert key.startswith(prefix) and '..' not in relative
    p=ROOT/relative;p.parent.mkdir(parents=True,exist_ok=True)
    with session.get(base+'/storage/v1/object/authenticated/cloudtrend-data/'+quote(key,safe='/'),headers=headers,stream=True,timeout=(20,300),allow_redirects=False) as r:
        if r.status_code!=200: raise RuntimeError('PINNED_READ_FAILED')
        h=hashlib.sha256()
        with p.open('xb') as f:
            for b in r.iter_content(1024*1024):h.update(b);f.write(b)
    if sha and h.hexdigest()!=sha.removeprefix('sha256:'):raise RuntimeError('HASH_MISMATCH')
    items.append({'path':relative,'sha256':h.hexdigest(),'bytes':p.stat().st_size})
    return p
manifest=get(prefix+'inputs/78e59c019a579b704a40c1d9a6a5de414dfaad8e71da1312f583327c2306ca89/source-manifest.json','source-manifest.json','0a87b02838ea0cd2c084c98c82cdc9f798beb6d10d3c6e563b55595577e2daf6')
for x in json.loads(manifest.read_text())['orderedFiles']:get(x['storagePath'],'raw/'+x['sourcePath'],x['sha256'])
run=prefix+'resumable/38016639367/'
for role in ['plan']+['score-%03d'%i for i in range(20)]+['replay-kr','replay-etf']:
    p=get(run+role+'/completion.json','stored/'+role+'/completion.json')
    completion=json.loads(p.read_text())
    # Completion files are used as an exact object allowlist; no arbitrary remote path.
    files=completion.get('files',[])
    for x in files:
        rel=x.get('path') or x.get('relative')
        if not isinstance(rel,str):raise RuntimeError('COMPLETION_SCHEMA')
        get(run+role+'/'+rel,'stored/'+role+'/'+rel,x.get('sha256'))
Path(ROOT/'transfer-manifest.json').write_text(json.dumps(items,sort_keys=True))
plain=ROOT.parent/'research.tar'
with tarfile.open(plain,'w') as t:t.add(ROOT,arcname='research')
key=os.urandom(32);nonce=os.urandom(12)
public=serialization.load_pem_public_key(Path('research/exit-risk-20261014/transfer_public.pem').read_bytes())
wrapped=public.encrypt(key,padding.OAEP(mgf=padding.MGF1(hashes.SHA256()),algorithm=hashes.SHA256(),label=None))
out=Path('encrypted-transfer');out.mkdir()
enc=Cipher(algorithms.AES(key),modes.GCM(nonce)).encryptor()
with plain.open('rb') as src,(out/'research.enc').open('wb') as dst:
    for b in iter(lambda:src.read(1024*1024),b''):dst.write(enc.update(b))
    dst.write(enc.finalize())
(out/'envelope.json').write_text(json.dumps({'key':wrapped.hex(),'nonce':nonce.hex(),'tag':enc.tag.hex(),'sha256':hashlib.sha256((out/'research.enc').read_bytes()).hexdigest()}))
print('Encrypted pinned read-only research transfer complete; files:',len(items))
