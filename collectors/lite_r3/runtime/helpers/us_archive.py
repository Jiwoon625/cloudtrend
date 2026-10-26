"""Immutable US dated-source archiving and bounded replay publication.
No collector, scheduler, credential creation, or current-ingest replacement.
"""
import csv, hashlib, io, json, math, os, re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

US_OPERATING_IDS = ('A0_QUARTER_PRIMARY','A2_QUARTER_SHADOW','B3_BETA_SHADOW','SPY_BENCHMARK')
US_RESTART_START = '2026-10-12'
US_RESTART_SHADOW_IDS = tuple('adopted-shadow-2026-10-12-v1:'+x for x in ('US_A0','US_A2','US_B3'))
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

US_SOURCE_QUALITY_VERSION = 'us-source-quality-v1'
US_SCORING_HOLD_REASON = 'unverified_pre_event_history_and_insufficient_post_event_lookback'
US_HELD_SCORE_FIELDS = ('ret120','ret252','beta60_spy','ichimoku_tk_gap','relvol1_20','adv20_usd','amihud20')

def _ua_source_quality(rows, metadata, quarantine, date):
    """Price coverage and explicit score eligibility are independent evidence.

    This does not admit unknown identity holds or lower any lookback/price rule.
    The legacy overall coverage flag remains false for either kind of hold.
    """
    holds = metadata.get('guardedCandidateScoringHolds', {})
    _ua_require(isinstance(holds, dict), 'Invalid US scoring hold evidence')
    candidate=metadata.get('guardedCandidateQuarantine',{})
    _ua_require(isinstance(candidate,dict) and not candidate,
                'Candidate identity quarantine needs separately reviewed roster evidence')
    by_symbol = {r['symbol']:r for r in rows}
    for row in rows:
        symbol=row['symbol']
        if symbol in quarantine:
            _ua_require(all(row.get(k) in ('',None) for k in ('open','close','ret120','ret252')),
                        'Unsafe US price quarantine: '+symbol)
        elif _ua_bool(row.get('toss_tradable')):
            _ua_require((_ua_num(row.get('open')) or 0)>0 and (_ua_num(row.get('close')) or 0)>0,
                        'Tradable US security lacks current prices: '+symbol)
    for symbol, hold in holds.items():
        _ua_require(isinstance(symbol,str) and re.fullmatch(r'[A-Z0-9.^-]+',symbol)
                    and symbol != 'SPY' and symbol not in quarantine and symbol in by_symbol,
                    'Unknown or conflicting US scoring hold')
        _ua_require(isinstance(hold,dict) and set(hold)=={'reason','postEventBars','minimumBars','historyStartDate'}
                    and hold.get('reason')==US_SCORING_HOLD_REASON
                    and type(hold.get('postEventBars')) is int and 0 < hold['postEventBars'] < 253
                    and type(hold.get('minimumBars')) is int and hold['minimumBars']==253,
                    'Invalid US history-length hold evidence: '+symbol)
        start=hold.get('historyStartDate')
        try: valid_date=isinstance(start,str) and datetime.strptime(start,'%Y-%m-%d').strftime('%Y-%m-%d')==start and start<=date
        except (ValueError,TypeError): valid_date=False
        _ua_require(valid_date, 'Invalid US scoring hold history date: '+symbol)
        row=by_symbol[symbol]
        prices=[_ua_num(row.get(k)) for k in ('open','high','low','close')]
        volume=_ua_num(row.get('volume'))
        _ua_require(all(v is not None and v>0 for v in prices)
                    and prices[2]<=min(prices[0],prices[3])<=max(prices[0],prices[3])<=prices[1]
                    and volume is not None and volume>=0,'Unsafe US scoring hold prices: '+symbol)
        _ua_require(all(row.get(k) in ('',None) for k in US_HELD_SCORE_FIELDS)
                    and str(row.get('active20')).lower() in ('false','0')
                    and (_ua_num(row.get('open')) or 0)>0 and (_ua_num(row.get('close')) or 0)>0,
                    'Unsafe US history-length hold: '+symbol)
    _ua_require(type(metadata.get('sourceCoverageComplete')) is bool,
                'Source coverage evidence missing')
    _ua_require(metadata['sourceCoverageComplete']==(not quarantine and not holds),
                'US source coverage contradicts explicit price/score holds')
    quality={'version':US_SOURCE_QUALITY_VERSION,'priceCoverageComplete':not bool(quarantine),
             'scoringHolds':holds}
    if 'sourceQuality' in metadata:
        _ua_require(_ua_json(metadata['sourceQuality'])==_ua_json(quality),'US source quality evidence differs')
    return quality

def _ua_price_quarantine(rows,metadata):
    symbols={r['symbol'] for r in rows}
    for key in ('providerGapSymbols','lifecycleExcludedSymbols'):
        value=metadata.get(key,[])
        _ua_require(isinstance(value,list) and all(isinstance(s,str) and re.fullmatch(r'[A-Z0-9.^-]+',s)
                    and s!='SPY' and (key!='providerGapSymbols' or s in symbols) for s in value)
                    and len(set(value))==len(value),'Invalid US price quarantine evidence: '+key)
    absent=set(metadata.get('lifecycleExcludedSymbols',[]))-symbols
    events=metadata.get('verifiedLifecycleEvents',[])
    _ua_require(not absent or isinstance(events,list),'Missing verified lifecycle omission evidence')
    for symbol in absent:
        matches=[e for e in events if isinstance(e,dict) and e.get('symbol')==symbol]
        _ua_require(len(matches)==1,'Missing or ambiguous verified lifecycle omission: '+symbol)
        event=matches[0];effective=event.get('effective_date');evidence=urlparse(str(event.get('source_url','')))
        try: valid_date=isinstance(effective,str) and datetime.strptime(effective,'%Y-%m-%d').strftime('%Y-%m-%d')==effective and effective<=rows[0]['date']
        except (ValueError,TypeError): valid_date=False
        _ua_require(event.get('status')=='SUSPENDED' and valid_date and evidence.scheme=='https' and evidence.netloc,
                    'Invalid verified lifecycle omission: '+symbol)
    # Verified lifecycle events can exempt a seed security with no as-of row.
    # Retain that producer metadata, but never invent a missing CSV quarantine.
    return sorted(set(metadata.get('providerGapSymbols',[])) |
                  (set(metadata.get('lifecycleExcludedSymbols',[])) & symbols))

def _ua_validate_atomic_input(raw, ingest, user_id):
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
    return rows,date,metadata,captured,previous

def freeze_us_atomic_archive(*, raw, ingest, root, user_id):
    """Only collector-QA or registered immutable atomic CSV; preserve original capture time."""
    rows,date,metadata,captured,previous=_ua_validate_atomic_input(raw,ingest,user_id)
    identity=[]
    for row in rows:
        identity.append({'symbol':row['symbol'].strip().upper(),'name':(row.get('name') or '').strip() or row['symbol'].strip().upper(),
                         **{dest:((row.get(src) or '').strip() or None) for src,dest in [('market','market'),('sector','sector'),('security_type','securityType'),('status','status'),('currency','currency')]},
                         'sharesOutstanding':_ua_num(row.get('shares_outstanding')),
                         'tossTradable':_ua_bool(row.get('toss_tradable')),'isCommonShare':_ua_bool(row.get('is_common_share'))})
    roster={'version':'us-dated-roster-v1','asOfDate':date,'capturedAt':captured,'rows':identity}
    roster_raw=_ua_json(roster); dh=_ua_hash(raw); rh=_ua_hash(roster_raw)
    quarantine=_ua_price_quarantine(rows,metadata)
    quality=_ua_source_quality(rows,metadata,quarantine,date)
    # The same object travels in ingest metadata and the immutable replay source.
    metadata['sourceQuality']=quality
    source={'date':date,'previousSessionDate':previous,'storagePath':f'{user_id}/us-replay/inputs/{date}/{dh[7:]}.csv',
            'dataHash':dh,'rowCount':len(rows),'symbolCount':len(rows),'sourceCapturedAt':captured,
            'confirmedRegularClose':True,'failedSymbols':0,'sourceCoverageComplete':metadata['sourceCoverageComplete'],
            'quarantinedSymbols':quarantine,'sourceQuality':quality,'pit':{'kind':'ATOMIC_DATED_SNAPSHOT','asOfDate':date,'rosterCapturedAt':captured,
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
        # Current operations depend on completed screening and the exact restart
        # books, never the September operating or October 5 beta books.
        history=self.rows('us_screening_history',{'select':'date','order':'date.desc','limit':1})
        _ua_require(len(history)==1 and re.fullmatch(r'\d{4}-\d{2}-\d{2}',str(history[0].get('date'))),
                    'US screening has no verified predecessor')
        current=history[0]['date'] >= US_RESTART_START
        dates=[history[0]['date']] if current else []
        if not current:
            for strategy in US_OPERATING_IDS:
                rows=self.rows('us_portfolio_snapshots',{'strategy_id':'eq.'+strategy,'select':'date','order':'date.desc','limit':1})
                _ua_require(len(rows)==1,'Operating book has no verified predecessor: '+strategy); dates.append(rows[0]['date'])
        for book in (US_RESTART_SHADOW_IDS if current else US_SHADOW_IDS):
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
        rows,date,metadata,_,previous=_ua_validate_atomic_input(raw,payload,user_id)
        saved, saved_raw, _ = read_us_atomic_archive(root,payload['as_of_date'])
        _ua_require(saved_raw==raw,'Existing dated atomic bytes differ; original preserved')
        _ua_require(saved['storagePath']==f"{user_id}/us-replay/inputs/{date}/{payload['data_hash'][7:]}.csv"
                    and saved['pit']['rosterStoragePath']==f"{user_id}/us-replay/rosters/{date}/{saved['pit']['rosterHash'][7:]}.json"
                    and saved['previousSessionDate']==previous and saved['rowCount']==len(rows)==saved['symbolCount']
                    and saved['confirmedRegularClose'] is True and saved['failedSymbols']==0,
                    'Existing dated atomic owner/session evidence differs')
        quarantine=_ua_price_quarantine(rows,metadata)
        _ua_require(quarantine==saved['quarantinedSymbols'] and metadata.get('sourceCoverageComplete') is saved['sourceCoverageComplete'],
                    'Existing dated atomic coverage evidence differs')
        if 'sourceQuality' in saved:
            quality=_ua_source_quality(rows,metadata,quarantine,date)
            _ua_require(_ua_json(quality)==_ua_json(saved['sourceQuality']),'Existing dated source quality differs; original preserved')
            payload['metadata']['sourceQuality']=saved['sourceQuality']
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


def prepare_us_lifecycle_derivative(*, root, date, original_raw, events, registry, user_id):
    """Separate reviewed input; never relabel or replace the dated atomic receipt.

    SUSPENDED is the existing engine's non-scoreable lifecycle state, not a new
    claim about an exchange's terminology. Only exact maintained lifecycle registry
    events enter this path; temporary provider failures never establish lifecycle.
    """
    source, archived_raw, roster = read_us_atomic_archive(root, date)
    _ua_require(archived_raw == original_raw, 'Original archive differs from frozen source')
    _ua_require(source['rowCount'] == source['symbolCount'], 'Original archive counts differ')
    reader = csv.DictReader(io.StringIO(original_raw.decode('utf-8-sig')))
    fields = reader.fieldnames
    rows = list(reader)
    _ua_require(len(rows) == source['rowCount'], 'Original archive counts differ')
    allowed = {event['symbol']: event for event in registry}
    _ua_require(len(allowed) == len(registry), 'Duplicate lifecycle registry symbol')
    changed = {event['symbol'] for event in events}
    _ua_require(changed and len(changed) == len(events), 'Invalid lifecycle corrections')
    evidence = []
    nullable = ('open','high','low','close','volume','dollar_volume','market_cap',
                'ret120','ret252','beta60_spy','ichimoku_tk_gap','relvol1_20','adv20_usd','amihud20')
    for event in sorted(events, key=lambda e: e['symbol']):
        symbol = event['symbol']
        try:
            effective = datetime.fromisoformat(str(event.get('effective_date', ''))).date().isoformat()
        except ValueError:
            effective = None
        _ua_require(symbol != 'SPY' and event == allowed.get(symbol)
                    and effective is not None and effective == event.get('effective_date')
                    and effective <= date and event.get('status') == 'SUSPENDED'
                    and re.fullmatch(r'https://[^\s]+', str(event.get('source_url', ''))),
                    'Unreviewed lifecycle correction')
        held = [row for row in rows if row['symbol'] == symbol]
        _ua_require(len(held) == 1, 'Lifecycle correction symbol missing or duplicated')
        row = held[0]
        guard = event.get('identity_name_contains')
        normalized_guard = re.sub(r'[^A-Z0-9]', '', str(guard or '').upper())
        _ua_require(normalized_guard and normalized_guard in
                    re.sub(r'[^A-Z0-9]', '', row.get('name', '').upper()), 'Original lifecycle issuer identity differs')
        row['status'] = 'SUSPENDED'
        row['toss_tradable'] = 'False'
        row['active20'] = 'False'
        for column in nullable:
            if column in row: row[column] = ''
        evidence.append({'symbol':symbol,'effectiveDate':event['effective_date'],'evidenceUrls':[event['source_url']]})
    stream = io.StringIO(newline='')
    writer = csv.DictWriter(stream, fieldnames=fields, lineterminator='\n')
    writer.writeheader(); writer.writerows(rows)
    raw = stream.getvalue().encode('utf-8'); dh = _ua_hash(raw)
    reviewed = {**source, 'storagePath':f'{user_id}/us-replay/inputs/{date}/{dh[7:]}.csv',
                'dataHash':dh, 'sourceCoverageComplete':False,
                'quarantinedSymbols':sorted(set(source['quarantinedSymbols']) | changed),
                'originalSource':{'storagePath':source['storagePath'],'dataHash':source['dataHash'],
                                  'sourceCapturedAt':source['sourceCapturedAt']},
                'lifecycleQuarantines':evidence,
                'pit':{**source['pit'],'kind':'REVIEWED_ATOMIC_QUARANTINE'}}
    if 'sourceQuality' in source:
        reviewed['sourceQuality']={**source['sourceQuality'],'priceCoverageComplete':False,
            'scoringHolds':{k:v for k,v in source['sourceQuality']['scoringHolds'].items() if k not in changed}}
    manifest = {'version':'us-dated-replay-v1','baseDate':source['previousSessionDate'],
                'throughDate':date,'sessions':[reviewed]}
    manifest_raw = _ua_json(manifest); mh = _ua_hash(manifest_raw)
    manifest_path = f'{user_id}/us-replay/manifests/{mh[7:]}.json'
    folder = Path(root)/date/'reviewed'/dh[7:]
    _ua_write_once(folder/'input.csv',raw)
    _ua_write_once(folder/'source.json',_ua_json(reviewed))
    _ua_write_once(folder/'manifest.json',manifest_raw)
    return {'source':reviewed,'raw':raw,'manifestHash':mh,'manifestPath':manifest_path,
            'localPath':str(folder/'input.csv'),
            'blobs':[(source['storagePath'],original_raw,'text/csv'),
                     (source['pit']['rosterStoragePath'],roster,'application/json'),
                     (reviewed['storagePath'],raw,'text/csv'),
                     (manifest_path,manifest_raw,'application/json')]}


def upload_us_lifecycle_derivative(*, api, correction):
    """Upload immutable, hash-addressed review artifacts only; never change ingest."""
    for target, body, mime in correction['blobs']:
        api.upload_verified(target,body,mime)
    return correction['source']


def dispatch_us_lifecycle_derivative(*, api, root, correction):
    """Same immutable manifest on every retry; the server verifies both identities."""
    if not api.token: return {'status':'MISSING_TOKEN'}
    mh = correction['manifestHash']; path = correction['manifestPath']
    pending_path = Path(root)/'active_replay.json'
    pending_raw = _ua_json({'manifestHash':mh,'manifestPath':path,'throughDate':correction['source']['date']})
    _ua_write_once(pending_path,pending_raw)
    inputs = {'supabase_user_id':api.uid,'replay_manifest_path':path,'replay_manifest_hash':mh,
              'replay_apply':'true','replay_then_screen':'true'}
    result = dispatch_us_once(api=api,root=root,fingerprint=mh[7:],inputs=inputs)
    if result['status'] in ('REQUEST_REJECTED','MISSING_TOKEN') and pending_path.exists():
        if pending_path.read_bytes() == pending_raw: pending_path.unlink()
    return {**result,'manifestHash':mh,'manifestPath':path}
