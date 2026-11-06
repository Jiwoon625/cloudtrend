"""One authorized publication of verified private Drive inputs; no credential output."""
import copy, hashlib, importlib.util, io, json, os, pathlib, sys, urllib.parse, urllib.request, zipfile

OWNER=os.environ['SUPABASE_USER_ID']
assert OWNER=='bdfc8818-33a7-4030-9dbd-ecad39f223ac'
BASE=os.environ['SUPABASE_URL'].rstrip('/')
KEY=os.environ['SUPABASE_SERVICE_ROLE_KEY']
ROOT=pathlib.Path('drive-publication-20261106')
RUN='288f696eb14c4ef48f267f3fcfb61151'
PREFIX=OWNER+'/operations/drive-publication/20261106/'
ARCHIVES={'kr-outputs.zip':'211c48a814846377743f103560e17b9b67b7564c622821ce3b56fd1a3d7ee9bd',
          'drive-screening-saved.zip':'8da3985d194adde3f6375161d9fbc51982831401503d997ea9e5bfcf4de35ccc'}
def require(ok, message):
    if not ok:raise ValueError(message)
def call(path, data=None, method=None, content_type=None):
    headers={'Authorization':'Bearer '+KEY,'apikey':KEY,'cache-control':'no-cache'}
    if content_type:headers['Content-Type']=content_type
    req=urllib.request.Request(BASE+path,data=data,headers=headers,method=method)
    with urllib.request.urlopen(req,timeout=180) as response:
        raw=response.read(50*1024*1024+1)
    require(len(raw)<=50*1024*1024,'Response exceeds bound')
    return raw
def storage(path):return '/storage/v1/object/cloudtrend-data/'+urllib.parse.quote(path,safe='/')
def query(table, args):return json.loads(call('/rest/v1/'+table+'?'+urllib.parse.urlencode(args)))
def write(name, value):
    target=ROOT/name;target.parent.mkdir(parents=True,exist_ok=True)
    target.write_text(json.dumps(value,ensure_ascii=False,indent=2))
def bundle(directory):
    found=list((ROOT/directory/'results').glob('screening-*/screening-bundle.json'))
    require(len(found)==1,'Expected one screening bundle')
    return json.loads(found[0].read_text())
def expected():return json.loads((ROOT/'expected-bundle.json').read_text())
def normalized(value):
    result=copy.deepcopy(value);result.pop('calculatedAt',None);return result
def compare(actual):
    want=normalized(expected()['result']);got=normalized(actual)
    require(got==want,'Saved Drive and current engine analysis differ; publication blocked')
    require(got['asOfDate']=='2026-11-06' and len(got['rows'])==1798,'Wrong screening identity')
    p=got.get('krPublication',{})
    require(p.get('phase')=='PRELIMINARY' and p.get('financialSideEffects') is False,'Publication phase changed')
    return len(got['rows'])
def history_date():
    rows=query('screening_history',{'select':'date','user_id':'eq.'+OWNER,'order':'date.desc','limit':'1'})
    return rows[0]['date'] if rows else None
def active():
    return query('analysis_source_files',{'select':'id,file_hash,data_hash,max_date','user_id':'eq.'+OWNER,
        'source_type':'eq.screening','status':'eq.active','order':'activated_at.asc.nullsfirst,created_at.asc,id.asc'})

action=sys.argv[1]
ROOT.mkdir(exist_ok=True)
if action=='prepare':
    for name,digest in ARCHIVES.items():
        raw=call(storage(PREFIX+name));require(hashlib.sha256(raw).hexdigest()==digest,'Staged archive SHA mismatch')
        (ROOT/name).write_bytes(raw)
    with zipfile.ZipFile(ROOT/'drive-screening-saved.zip') as z:
        names=[n for n in z.namelist() if n.endswith('screening-bundle.json')]
        require(len(names)==1,'Missing saved result');saved=json.loads(z.read(names[0]))
    write('expected-bundle.json',saved)
    historical=saved['data']['inputProvenance']['historicalSources'];registered=active()
    require([{'id':r['id'],'fileHash':r['file_hash'],'dataHash':r['data_hash']} for r in registered]==historical,
            'Operational baseline changed since saved Drive run')
    require(max(r['max_date'] for r in registered)=='2026-11-05','Newer registered input already exists')
    write('before.json',{'historyDate':history_date(),'active':registered})
    module=importlib.util.spec_from_file_location('drive_transfer','scripts/drive-screening-transfer.py')
    transfer=importlib.util.module_from_spec(module);module.loader.exec_module(transfer)
    archive=(ROOT/'kr-outputs.zip').read_bytes();manifest,raw_manifest,parts=transfer.inspect_archive(archive,RUN)
    require(hashlib.sha256(raw_manifest).hexdigest()=='dcdae091866b953c17bcf27b77af38eff88245f90d242c8e8420685a2cb9a9a8','Manifest pin mismatch')
    require(manifest['actualLatestPriceDate']=='2026-11-06' and manifest['krxPublicationEvidence']['phase']=='PRELIMINARY','Wrong source phase/date')
    for mode,directory in [('drive','preflight'),('supabase','publication')]:
        target=ROOT/directory;target.mkdir(exist_ok=True);(target/'collector-manifest.json').write_bytes(raw_manifest)
        for part in parts:(target/part['name']).write_bytes(part['bytes'])
        write(directory+'/input.json',{'version':'drive-screening-input-v1','runId':RUN,'mode':mode,
            'archiveFileId':'1kopqVYVx7RH79DbsEgqJZ-Wsyww5qNts','archiveSha256':ARCHIVES['kr-outputs.zip'],
            'manifestSha256':hashlib.sha256(raw_manifest).hexdigest(),'parts':[{'path':p['name'],'sha256':p['sha256']} for p in parts]})
    print(json.dumps({'prepared':True,'date':'2026-11-06','phase':'PRELIMINARY','rows':len(saved['result']['rows'])}))
elif action=='compare':
    count=compare(bundle('preflight')['result'])
    write('preflight-verification.json',{'savedDriveResultMatched':True,'rowCount':count,'phase':'PRELIMINARY'})
    print(json.dumps({'savedDriveResultMatched':True,'rows':count}))
elif action=='backup':
    require((ROOT/'preflight-verification.json').exists(),'Preflight comparison missing')
    require(active()==json.loads((ROOT/'before.json').read_text())['active'],'Source changed after preflight')
    backups=[]
    for relative in ['cache/screening/latest.json','cache/dashboard/latest.json','kr.json','results/screening/latest.json']:
        raw=call(storage(OWNER+'/'+relative));target=ROOT/'before-cache'/relative;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(raw)
        backups.append({'path':relative,'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw)})
    write('before-cache-manifest.json',backups)
    print(json.dumps({'backedUp':len(backups)}))
elif action=='verify':
    compare(bundle('publication')['result'])
    cached=json.loads(call(storage(OWNER+'/cache/screening/latest.json')))
    compare(cached['payload']['analysis'])
    dashboard=json.loads(call(storage(OWNER+'/cache/dashboard/latest.json')))
    require(dashboard['asOfDate']=='2026-11-06','Dashboard date not published')
    require(dashboard.get('krPublication',{}).get('phase')=='PRELIMINARY','Dashboard phase changed')
    require(dashboard['inputFingerprint']==cached['inputFingerprint'] and dashboard['resultDigest']==cached['resultDigest'],'Dashboard/screening pair mismatch')
    old=json.loads((ROOT/'before.json').read_text());registered=active()
    require(history_date()==old['historyDate'],'Confirmed history changed during preliminary publication')
    require(all(r in registered for r in old['active']),'Prior active sources changed')
    require(len(registered)==len(old['active'])+1,'Expected one additive source registration')
    receipt=json.loads((ROOT/'publication/execution-receipt.json').read_text())
    require(receipt['status']=='COMPLETED' and receipt['dashboardPublished'] is True,'Publication receipt incomplete')
    write('publication-verification.json',{'dashboardPublished':True,'date':'2026-11-06','phase':'PRELIMINARY',
       'rowCount':1798,'savedDriveResultMatched':True,'cacheReadbackMatched':True,'cachePairMatched':True,
       'confirmedHistoryUnchanged':True,'confirmedHistoryDate':history_date(),'priorSourcesUnchanged':True,
       'activeSourceCount':len(registered),'inputFingerprint':cached['inputFingerprint'],'resultDigest':cached['resultDigest']})
    print((ROOT/'publication-verification.json').read_text())
else:raise ValueError('Unknown action')
