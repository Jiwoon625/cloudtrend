"""Immutable US dated-source archiving and bounded replay publication.
No collector, scheduler, credential creation, or current-ingest replacement.
"""
import csv, hashlib, io, json, math, os, re
from datetime import datetime, timezone
from pathlib import Path

US_OPERATING_IDS = ('A0_QUARTER_PRIMARY','A2_QUARTER_SHADOW','B3_BETA_SHADOW','SPY_BENCHMARK')
US_SHADOW_IDS = tuple('adopted-shadow-2026-10-05-v1:'+x for x in ('US_A0','US_A2','US_B3'))

def _ua_require(ok, message):
    if not ok: raise RuntimeError(message)

def _ua_hash(raw): return 'sha256:'+hashlib.sha256(raw).hexdigest()
def _ua_json(obj): return json.dumps(obj,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
def _ua_bool(value): return str(value).strip().lower() in ('true','1','y','yes','t')
def _ua_num(value):
    try:
        n=float(value)
        return n if math.isfinite(n) else None
    except (TypeError,ValueError): return None

def _ua_write_once(path, raw):
    path=Path(path); path.parent.mkdir(parents=True,exist_ok=True)
    if path.exists():
        _ua_require(path.read_bytes()==raw, 'Immutable dated artifact conflict: '+path.name)
        return path
    try:
        with path.open('xb') as stream: stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    except FileExistsError:
        _ua_require(path.read_bytes()==raw,'Concurrent dated artifact conflict: '+path.name)
    _ua_require(path.read_bytes()==raw,'Dated artifact readback failed')
    return path

def freeze_us_atomic_archive(*, raw, ingest, root, user_id):
    """Only collector-QA or registered immutable atomic CSV; preserve original capture time."""
    _ua_require(ingest.get('user_id')==user_id,'Wrong atomic owner')
    date=ingest.get('as_of_date'); metadata=ingest.get('metadata') or {}
    _ua_require(re.fullmatch(r'\d{4}-\d{2}-\d{2}',str(date)),'Invalid atomic date')
    _ua_require(_ua_hash(raw)==ingest.get('data_hash'),'Atomic source hash mismatch')
    rows=list(csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))))
    _ua_require(rows and len(rows)==ingest.get('row_count')==ingest.get('symbol_count'),'Atomic source count mismatch')
    _ua_require(len({r['symbol'] for r in rows})==len(rows) and all(r['date']==date for r in rows),'Atomic source row/date mismatch')
    captured=ingest.get('collected_at')
    _ua_require(isinstance(captured,str) and datetime.fromisoformat(captured.replace('Z','+00:00')).tzinfo is not None,'Missing original capture time')
    _ua_require(metadata.get('confirmedRegularClose') is True and metadata.get('failedSymbols')==0,'Unverified original close/collection')
    previous=metadata.get('previousSessionDate')
    _ua_require(isinstance(previous,str) and previous<date,'Missing original previous session')
    identity=[]
    for row in rows:
        identity.append({'symbol':row['symbol'].strip().upper(),'name':(row.get('name') or '').strip() or row['symbol'].strip().upper(),
                         **{dest:((row.get(src) or '').strip() or None) for src,dest in [('market','market'),('sector','sector'),('security_type','securityType'),('status','status'),('currency','currency')]},
                         'sharesOutstanding':_ua_num(row.get('shares_outstanding')),
                         'tossTradable':_ua_bool(row.get('toss_tradable')),'isCommonShare':_ua_bool(row.get('is_common_share'))})
    roster={'version':'us-dated-roster-v1','asOfDate':date,'capturedAt':captured,'rows':identity}
    roster_raw=_ua_json(roster); dh=_ua_hash(raw); rh=_ua_hash(roster_raw)
    symbols={r['symbol'] for r in rows}
    quarantine=sorted((set(metadata.get('providerGapSymbols',[])) | set(metadata.get('lifecycleExcludedSymbols',[]))) & symbols)
    _ua_require(metadata.get('sourceCoverageComplete') in (True,False),'Source coverage evidence missing')
    _ua_require(metadata['sourceCoverageComplete'] or quarantine,'Incomplete source has no recorded quarantine')
    source={'date':date,'previousSessionDate':previous,'storagePath':f'{user_id}/us-replay/inputs/{date}/{dh[7:]}.csv',
            'dataHash':dh,'rowCount':len(rows),'symbolCount':len(rows),'sourceCapturedAt':captured,
            'confirmedRegularClose':True,'failedSymbols':0,'sourceCoverageComplete':metadata['sourceCoverageComplete'],
            'quarantinedSymbols':quarantine,'pit':{'kind':'ATOMIC_DATED_SNAPSHOT','asOfDate':date,'rosterCapturedAt':captured,
            'rosterStoragePath':f'{user_id}/us-replay/rosters/{date}/{rh[7:]}.json','rosterHash':rh}}
    folder=Path(root)/date/dh[7:]
    _ua_write_once(folder/'input.csv',raw); _ua_write_once(folder/'roster.json',roster_raw)
    _ua_write_once(folder/'source.json',_ua_json(source))
    _ua_write_once(Path(root)/date/'source.json',_ua_json(source))
    return source

def read_us_atomic_archive(root, date):
    source=json.loads((Path(root)/date/'source.json').read_text())
    _ua_require(source['date']==date and source['pit']['kind']=='ATOMIC_DATED_SNAPSHOT','Only saved atomic daily sources may enter automatic processing')
    folder=Path(root)/date/source['dataHash'][7:]
    raw=(folder/'input.csv').read_bytes(); roster=(folder/'roster.json').read_bytes()
    _ua_require(_ua_hash(raw)==source['dataHash'] and _ua_hash(roster)==source['pit']['rosterHash'],'Dated archive changed')
    return source,raw,roster

def prepare_us_atomic_chain(root, dates, base_date):
    _ua_require(dates and len(dates)<=31 and dates==sorted(set(dates)),'Replay requires 1–31 ascending session dates')
    previous=base_date; sources=[]; blobs=[]
    for date in dates:
        source,raw,roster=read_us_atomic_archive(root,date)
        _ua_require(source['previousSessionDate']==previous,'Missing intervening session before '+date)
        sources.append(source); blobs.extend([(source['storagePath'],raw,'text/csv'),(source['pit']['rosterStoragePath'],roster,'application/json')]); previous=date
    manifest={'version':'us-dated-replay-v1','baseDate':base_date,'throughDate':dates[-1],'sessions':sources}
    return manifest,blobs

class UsArchiveApi:
    def __init__(self,url,key,user_id,token,session):
        _ua_require(url.rstrip("/")==EXPECTED_SUPABASE_URL.rstrip("/"),'Unexpected Supabase destination')
        self.url=url.rstrip('/'); self.uid=user_id; self.token=token; self.session=session
        self.headers={'apikey':key,'Authorization':'Bearer '+key}
    def rows(self,table,params):
        response=self.session.get(self.url+'/rest/v1/'+table,headers=self.headers,params={'user_id':'eq.'+self.uid,**params},timeout=30)
        response.raise_for_status(); value=response.json(); _ua_require(isinstance(value,list),'Unexpected registry response'); return value
    def upload_verified(self,path,raw,mime):
        _ua_require(path.startswith(self.uid+'/us-replay/') and not any(x in path for x in ('..','\\','?','#','%')),'Unsafe private replay path')
        response=self.session.post(self.url+'/storage/v1/object/cloudtrend-data/'+path,headers={**self.headers,'Content-Type':mime,'x-upsert':'false'},data=raw,timeout=120)
        _ua_require(response.status_code<300 or response.status_code in (400,409),'Replay upload failed; no dispatch')
        check=self.session.get(self.url+'/storage/v1/object/authenticated/cloudtrend-data/'+path,headers=self.headers,timeout=120)
        check.raise_for_status(); _ua_require(check.content==raw,'Replay storage readback mismatch')
    def common_base(self):
        dates=[]
        for strategy in US_OPERATING_IDS:
            rows=self.rows('us_portfolio_snapshots',{'strategy_id':'eq.'+strategy,'select':'date','order':'date.desc','limit':1})
            _ua_require(len(rows)==1,'Operating book has no verified predecessor: '+strategy); dates.append(rows[0]['date'])
        for book in US_SHADOW_IDS:
            rows=self.rows('ledger_model_sessions',{'series_id':'eq.'+book,'select':'session_date','order':'session_date.desc','limit':1})
            _ua_require(len(rows)==1,'Shadow book has no verified predecessor'); dates.append(rows[0]['session_date'])
        _ua_require(len(set(dates))==1,'US book dates differ; reviewed retry is required, automatic replay blocked')
        return dates[0]
    def dispatch(self,inputs):
        response=self.session.post('https://api.github.com/repos/Jiwoon625/cloudtrend/actions/workflows/us-prospective-screening.yml/dispatches',headers={'Authorization':'Bearer '+self.token,'Accept':'application/vnd.github+json'},json={'ref':'main','inputs':inputs},timeout=30)
        return response.status_code

def dispatch_us_once(*, api, root, fingerprint, inputs):
    """Persistent intent before POST. Ambiguous POSTs are never automatically repeated."""
    directory=Path(root)/'requests'; directory.mkdir(parents=True,exist_ok=True)
    attempt=0
    while True:
        path=directory/(fingerprint+'.'+str(attempt)+'.json')
        if not path.exists(): break
        response_path=path.with_suffix('.response.json')
        response=json.loads(response_path.read_text()) if response_path.exists() else {'status':'DISPATCH_UNCERTAIN'}
        if response.get('status')!='REQUEST_REJECTED':
            return {'status':'REQUEST_ALREADY_RECORDED','priorStatus':response['status']}
        attempt+=1
    if not api.token: return {'status':'MISSING_TOKEN'}
    claim={'version':1,'status':'DISPATCHING','fingerprint':fingerprint,'inputs':inputs,'attempt':attempt}
    try:
        with path.open('xb') as stream: stream.write(_ua_json(claim)); stream.flush(); os.fsync(stream.fileno())
    except FileExistsError:
        return {'status':'REQUEST_ALREADY_RECORDED','priorStatus':'DISPATCHING'}
    _ua_require(path.read_bytes()==_ua_json(claim),'Request intent readback failed')
    try: status=api.dispatch(inputs)
    except Exception: return {'status':'DISPATCH_UNCERTAIN','claimPath':str(path)}
    result={**claim,'status':'REQUEST_ACCEPTED' if status==204 else ('DISPATCH_UNCERTAIN' if status>=500 else 'REQUEST_REJECTED'),'httpStatus':status}
    _ua_write_once(path.with_suffix('.response.json'),_ua_json(result))
    return {'status':result['status'],'httpStatus':status,'claimPath':str(path)}

def publish_us_atomic_chain(*, api, root, dates, base_date):
    if not api.token: return {'status':'MISSING_TOKEN','mode':'ATOMIC_CHAIN_REQUEST','dates':dates}
    manifest,blobs=prepare_us_atomic_chain(root,dates,base_date)
    _ua_require(api.common_base()==base_date,'US predecessor changed; replay blocked')
    raw=_ua_json(manifest); mh=_ua_hash(raw); path=f'{api.uid}/us-replay/manifests/{mh[7:]}.json'
    for target,body,mime in blobs: api.upload_verified(target,body,mime)
    api.upload_verified(path,raw,'application/json')
    _ua_write_once(Path(root)/'manifests'/(mh[7:]+'.json'),raw)
    inputs={'supabase_user_id':api.uid,'replay_manifest_path':path,'replay_manifest_hash':mh,'replay_apply':'true','replay_then_screen':'true'}
    pending_path=Path(root)/'active_replay.json'
    pending_raw=_ua_json({'manifestHash':mh,'manifestPath':path,'throughDate':dates[-1]})
    _ua_write_once(pending_path,pending_raw)
    result=dispatch_us_once(api=api,root=root,fingerprint=mh[7:],inputs=inputs)
    if result['status'] in ('REQUEST_REJECTED','MISSING_TOKEN') and pending_path.exists():
        if pending_path.read_bytes()==pending_raw: pending_path.unlink()
    return {**result,'mode':'ATOMIC_CHAIN_REQUEST','manifestHash':mh,'manifestPath':path,'dates':dates}


def preserve_us_daily_before_upload(*, raw, payload, root, user_id):
    """Freeze the collector-QA atomic source before HTTP; retain first capture."""
    path = Path(root) / payload['as_of_date'] / 'source.json'
    if path.exists():
        source = json.loads(path.read_text())
        _ua_require(source['date'] == payload['as_of_date'] and source['dataHash'] == payload['data_hash'],
                    'Existing dated atomic source differs; original preserved')
        _ua_require(source['pit']['kind'] == 'ATOMIC_DATED_SNAPSHOT', 'Saved source must be atomic')
        payload['collected_at'] = source['sourceCapturedAt']
        return source
    return freeze_us_atomic_archive(raw=raw, ingest=payload, root=root, user_id=user_id)

def check_pending_us_publication(*, root, api):
    """One receipt GET only when a previous automatic atomic request is pending."""
    path = Path(root) / 'active_replay.json'
    if not path.exists():
        return {'status':'NO_PENDING_REPLAY'}
    raw = path.read_bytes()
    try:
        pending = json.loads(raw)
        mh = pending['manifestHash']
        _ua_require(re.fullmatch(r'sha256:[0-9a-f]{64}',mh), 'Invalid pending hash')
        receipt_path = api.uid + '/results/us-gap-replay/' + mh[7:] + '/daily-publication-receipt.json'
        response = api.session.get(api.url+'/storage/v1/object/authenticated/cloudtrend-data/'+receipt_path,
                                   headers=api.headers,timeout=30)
        _ua_require(response.status_code == 200, 'Publication receipt missing')
        receipt = response.json()
        _ua_require(receipt.get('version') == 'us-daily-publication-receipt-v1'
                    and receipt.get('manifestHash') == mh
                    and receipt.get('throughDate') == pending['throughDate']
                    and receipt.get('screeningPublished') is True,
                    'Publication receipt mismatch')
        _ua_require(path.read_bytes() == raw, 'Pending request changed')
        path.unlink()
        return {'status':'PRIOR_PUBLICATION_CONFIRMED','throughDate':pending['throughDate']}
    except Exception:
        raise RuntimeError('이전 미국 날짜별 요청의 게시 완료가 확인되지 않아 새 수집과 업로드를 중단했습니다.') from None
