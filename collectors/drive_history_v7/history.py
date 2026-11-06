"""Immutable KR/ETF Drive history transport. No Supabase source fallback; no executable archives."""
from __future__ import annotations
import argparse, csv, hashlib, io, json, os, re, stat, tempfile, time, urllib.request, urllib.parse, urllib.error, zipfile
from pathlib import Path, PurePosixPath

BASELINE_ID = '1lriFdL0lU9gu0-wlRx6Yc0NMPLAqh52D'
BASELINE_SHA = 'd0cb8477ca6f94a5ebbcbd8e79928635222e46f20e116fafb902c7763e0bfe92'
OWNER = 'bdfc8818-33a7-4030-9dbd-ecad39f223ac'
MAX_PACKAGE = 80 * 1024**2
MAX_EXPANDED = 400 * 1024**2

def require(ok, message):
    if not ok: raise ValueError(message)

def sha(data): return hashlib.sha256(data).hexdigest()
def atomic(path, data):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as f:
        f.write(data); f.flush(); os.fsync(f.fileno()); tmp = f.name
    os.replace(tmp, path)

def checked(data, entry):
    require(len(data) == entry['bytes'] and sha(data) == entry['sha256'].removeprefix('sha256:'), 'SHA256/size mismatch')
    return data

def safe_member(name):
    p = PurePosixPath(name)
    require(not p.is_absolute() and '..' not in p.parts and '\\' not in name and str(p) == name, 'Unsafe archive path')
    return name

class Drive:
    """Refresh on expiry/401; never persist bearer tokens or raw provider errors."""
    def __init__(self, credentials=None):
        self.credentials = credentials or json.loads(os.environ.get('GOOGLE_DRIVE_CREDENTIALS_JSON', '{}'))
        require(self.credentials.get('type') == 'authorized_user', 'GOOGLE_DRIVE_CREDENTIALS_JSON must contain refreshable authorized_user credentials')
        self.token, self.until, self.reads = '', 0, []
    def refresh(self):
        c = self.credentials
        body = urllib.parse.urlencode({k:c[k] for k in ('client_id','client_secret','refresh_token')} | {'grant_type':'refresh_token'}).encode()
        try:
            with urllib.request.urlopen(urllib.request.Request('https://oauth2.googleapis.com/token', data=body), timeout=60) as r: result = json.load(r)
        except urllib.error.HTTPError as e: raise RuntimeError(f'Drive OAuth refresh failed ({e.code}); renew authorized_user consent') from None
        self.token, self.until = result['access_token'], time.monotonic() + int(result.get('expires_in',3600)) - 120
    def call(self, route, *, query=None, data=None, method=None, content_type=None, upload=False, limit=MAX_PACKAGE):
        require(route == 'files' or re.fullmatch(r'files/[A-Za-z0-9_-]{10,200}',route), 'Invalid Drive route')
        url = 'https://www.googleapis.com/' + ('upload/drive/v3/' if upload else 'drive/v3/') + route
        if query: url += '?' + urllib.parse.urlencode(query)
        for attempt in range(2):
            if time.monotonic() >= self.until: self.refresh()
            headers = {'Authorization':'Bearer '+self.token}
            if content_type: headers['Content-Type'] = content_type
            try:
                with urllib.request.urlopen(urllib.request.Request(url, data=data, method=method, headers=headers), timeout=180) as r:
                    raw = r.read(limit+1); require(len(raw)<=limit,'Drive response limit exceeded'); return raw
            except urllib.error.HTTPError as e:
                if e.code == 401 and attempt == 0: self.until=0; continue
                raise RuntimeError(f'Drive request failed ({e.code})') from None
    def download(self, file_id):
        raw = self.call('files/'+file_id, query={'alt':'media','supportsAllDrives':'true'})
        self.reads.append({'backend':'drive','fileId':file_id,'bytes':len(raw)})
        return raw
    def upload(self, folder, name, raw):
        require(re.fullmatch(r'[A-Za-z0-9_-]{10,200}',folder),'Invalid folder ID')
        boundary = 'cloudtrend_'+sha(raw)
        body = (f'--{boundary}\r\nContent-Type: application/json\r\n\r\n'.encode()+json.dumps({'name':name,'parents':[folder]}).encode()+
                f'\r\n--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n'.encode()+raw+f'\r\n--{boundary}--\r\n'.encode())
        result=json.loads(self.call('files',query={'uploadType':'multipart','fields':'id,name,webViewLink'},data=body,upload=True,content_type=f'multipart/related; boundary={boundary}'))
        require(sha(self.download(result['id']))==sha(raw),'Drive readback mismatch')
        return result

def validate_manifest(raw, digest=BASELINE_SHA):
    require(sha(raw)==digest,'Baseline manifest hash mismatch')
    m=json.loads(raw)
    require(m['schemaVersion']=='cloudtrend-drive-history-baseline-v1' and m['market']=='KR_ETF' and m['immutable'] is True,'Unsupported baseline')
    sources=m['sources']; require(len(sources)==52,'Expected pinned 52 sources')
    require([s['ordinal'] for s in sources]==list(range(len(sources))),'Source ordinal mismatch')
    records=[s['sourceRecord'] for s in sources]
    key=lambda r:(r['activated_at'] is not None, r['activated_at'] or '',r['created_at'],r['id'])
    require(records==sorted(records,key=key),'Registry precedence changed')
    require(len({r['id'] for r in records})==len(records),'Duplicate source IDs')
    packages={p['name']:p for p in m['packages']}; require(len(packages)==len(m['packages']),'Duplicate packages')
    for s in sources:
        r=s['sourceRecord']; safe_member(s['member'])
        require(s['member']=='objects/'+s['sourcePath'] and r['storage_path']==s['sourcePath'],'Source path mismatch')
        require(r['user_id']==OWNER and r['status']=='active' and r['source_type']=='screening','Unexpected source owner/type/status')
        require(r['file_hash']=='sha256:'+s['sha256'] and r['file_size_bytes']==s['bytes'],'Registered byte evidence mismatch')
        require(s['packageName'] in packages,'Missing package descriptor')
    return m

def prepare_baseline(output, *, mounted=None, local_manifest=None, package_dir=None, drive=None):
    """Recheck every cache hit. Extract one independent ZIP at a time, only expected members."""
    out=Path(output); out.mkdir(parents=True,exist_ok=True)
    if mounted: local_manifest=Path(mounted)/'baseline-manifest.json'; package_dir=Path(mounted)
    raw=Path(local_manifest).read_bytes() if local_manifest else drive.download(BASELINE_ID)
    m=validate_manifest(raw); total=0
    for p in m['packages']:
        cache=out/'packages'/p['name']
        if package_dir: data=checked((Path(package_dir)/p['name']).read_bytes(),p)
        elif cache.exists(): data=checked(cache.read_bytes(),p)
        else: data=checked(drive.download(p['fileId']),p); atomic(cache,data)
        require(len(data)<=MAX_PACKAGE,'Package limit exceeded')
        expected={s['member']:s for s in m['sources'] if s['packageName']==p['name']}
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            infos=z.infolist(); names=[i.filename for i in infos]
            require(len(names)==len(set(names)) and set(names)==set(expected),'Duplicate/unexpected/missing ZIP member')
            require(sum(i.file_size for i in infos)==p['uncompressedBytes'] and len(infos)==p['memberCount'],'ZIP inventory mismatch')
            total+=sum(i.file_size for i in infos); require(total<=MAX_EXPANDED,'ZIP expansion limit exceeded')
            for i in infos:
                safe_member(i.filename); require(not stat.S_ISLNK(i.external_attr>>16),'ZIP symlink forbidden')
                require(i.file_size==expected[i.filename]['bytes'] and i.file_size<=50*1024**2,'Member size limit exceeded')
                data=checked(z.read(i),expected[i.filename]) # CRC checked by zipfile
                atomic(out/i.filename,data)
    atomic(out/'baseline-manifest.json',raw)
    receipt={'version':'drive-baseline-verification-v1','manifestSha256':sha(raw),'sourceCount':len(m['sources']),
             'sourceBytes':total,'orderedSourceHashes':[s['sha256'] for s in m['sources']], 'complete':True,'supabaseSourceGETs':0}
    atomic(out/'baseline-receipt.json',json.dumps(receipt,indent=2).encode())
    return m

def main():
    p=argparse.ArgumentParser(); p.add_argument('--output',required=True); p.add_argument('--mounted'); p.add_argument('--manifest'); p.add_argument('--packages')
    a=p.parse_args(); prepare_baseline(a.output,mounted=a.mounted,local_manifest=a.manifest,package_dir=a.packages,drive=None if a.mounted or a.manifest else Drive())
if __name__=='__main__': main()
