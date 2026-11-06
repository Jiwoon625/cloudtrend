"""Separate mounted-Drive collector. Immutable baseline + ordered delta layers; merging is TS engine only."""
from __future__ import annotations
import csv, io, json, os, re, time, uuid, zipfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from history import BASELINE_SHA, atomic, checked, require, sha
VERSION='drive-history-collector-v7.0-preview'

def load_observations(baseline, manifest, delta_paths=()):
    # This is coverage planning, NOT a pandas replacement for the field-level official parser.
    dates={}; metadata={}; last_price={}; latest_values={}
    files=[Path(baseline)/s['member'] for s in manifest['sources']]+list(delta_paths)
    for file in files:
        with file.open(encoding='utf-8-sig',newline='') as f:
            for r in csv.DictReader(f):
                symbol=r['symbol']; day=r['date']; kind=r.get('type',r.get('securityType',''))
                dates.setdefault(symbol,set()).add(day)
                if symbol not in metadata or day>=metadata[symbol]['date']:
                    metadata[symbol]={'name':r.get('name',symbol),'market':r.get('market',''),'type':kind,'date':day}
                try: positive=float(r.get('close') or 0)>0
                except ValueError: positive=False
                if positive: last_price[symbol]=max(day,last_price.get(symbol,''))
                # Retain only observed price fields for correction detection. Never fill analytical data here.
                key=(symbol,day)
                values=latest_values.setdefault(key,{})
                for field in ('open','high','low','close','volume'):
                    if r.get(field,'').strip(): values[field]=r[field]
    return dates,metadata,last_price,latest_values

def incremental_plan(dates, universe, sessions, overlap=5, pending_dates=()):
    require(sessions and sessions==sorted(set(sessions)),'Invalid provider calendar')
    require(isinstance(overlap,int) and overlap>=1,'Overlap must be positive')
    plans=[]
    for symbol in universe:
        known=dates.get(symbol,set()); require(known,'New symbol requires an explicitly reviewed history bootstrap')
        first=min(known); expected=[d for d in sessions if d>=first]
        gaps=[d for d in expected if d not in known]
        recheck=expected[-overlap:]+[d for d in pending_dates if d>=first and d<=sessions[-1]]
        wanted=sorted(set(gaps+recheck)); start=wanted[0] if wanted else sessions[-1]
        plans.append({'symbol':symbol,'firstObserved':first,'lastObserved':max(known),'missingSessions':gaps,
                      'recheckSessions':sorted(set(recheck)),'start':start,'end':sessions[-1],
                      'providerSessions':sum(d>=start for d in sessions)})
    return plans

@contextmanager
def run_lock(directory):
    """Same mounted filesystem writer exclusion; never promotes a shared latest/baseline pointer."""
    directory=Path(directory); directory.mkdir(parents=True,exist_ok=True); lock=directory/'writer.lock'
    try: fd=os.open(lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    except FileExistsError: raise RuntimeError('This run is locked; resume after the other writer stops. Stale locks require inspection.') from None
    try:
        os.write(fd,str(os.getpid()).encode());os.close(fd);yield
    finally: lock.unlink(missing_ok=True)

def frame_csv(frame): return frame.to_csv(index=False,na_rep='',lineterminator='\n').encode('utf-8-sig')
def read_frame(file):
    import pandas as pd
    return pd.read_csv(file,dtype={'symbol':str,'date':str},keep_default_na=False)

def publication_evidence(p, sessions, checked_at):
    latest=sessions[-1]; previous=sessions[-2]; markets={};pending=False
    for market in ('KOSPI','KOSDAQ','ETF'):
        frame=p.official_day(market,latest)
        qa=next(q for q in p._OFFICIAL_QA if q['date']==latest and q['market']==market)
        if len(frame): last=latest;status='EXACT_READY'
        else:
            require(len(p.official_day(market,previous))>0,'KRX publication gap is not a verified one-session delay')
            last=previous;status='PENDING_PUBLICATION';pending=True
        markets[market]={'provider':'KRX_OPENAPI','targetDate':latest,'lastPublishedDate':last,'status':status,
                        'rawRows':qa['rawRows'],'usableRows':qa['usableRows'],'responseStatus':qa['status'],
                        'referenceOnlyPrices':qa['status']=='reference_only_no_prices'}
    return {'version':'krx-publication-readiness-v1','phase':'PRELIMINARY' if pending else 'FINAL',
            'calendar':{'latestSession':latest,'previousSession':previous,'sessions':sessions,'checkedAt':checked_at,
                        'source':'TOSS_BOTH_MARKET_INDEX_CANDLES'},'markets':markets}

def collect(baseline, manifest, root, *, cutoff, run_id=None, excluded_symbols=(), overlap=5, parent=None):
    """Uses the existing approved Toss/KRX endpoints in Colab; no Supabase credential is needed."""
    import pandas as pd
    import provider as p
    run_id=run_id or uuid.uuid4().hex;require(re.fullmatch(r'[A-Za-z0-9_-]{8,128}',run_id),'Invalid run ID')
    require(re.fullmatch(r'\d{4}-\d{2}-\d{2}',cutoff),'Invalid price cutoff')
    require(not parent,'Parent delta promotion is disabled until distributed CAS is validated; baseline preview only')
    run=Path(root)/'runs'/run_id; run.mkdir(parents=True,exist_ok=True)
    with run_lock(run):
        code_hashes={n:sha((Path(__file__).parent/n).read_bytes()) for n in ['history.py','provider.py','collector.py','colab_support.py']}
        request_key=sha(json.dumps({'codeHashes':code_hashes,'cutoff':cutoff,'excluded':sorted(excluded_symbols),'overlap':overlap,'baseline':BASELINE_SHA,'version':VERSION},sort_keys=True).encode())
        request_path=run/'request-identity.txt'
        if request_path.exists():require(request_path.read_text()==request_key,'Run ID already has different collection parameters')
        else:atomic(request_path,request_key.encode())
        # A completed run is immutable. Reusing its ID returns exact verified artifacts, not a new collection.
        final=run/'complete-manifest.json'
        if final.exists():
            done=json.loads(final.read_text());require(done['baselineSha256']==BASELINE_SHA and done['cutoffDateInclusive']==cutoff,'Completed run has different parameters')
            for f in done['files']:checked((run/f['name']).read_bytes(),f)
            return done
        created_path=run/'created-at.txt'
        if not created_path.exists():atomic(created_path,datetime.now(timezone.utc).isoformat().encode())
        created=created_path.read_text(); p.CLIENT_ID=os.environ['TOSS_CLIENT_ID'];p.CLIENT_SECRET=os.environ['TOSS_CLIENT_SECRET']
        p.COLLECTION_CUTOFF_DATE=cutoff;p.COLLECTION_CUTOFF_BEFORE=cutoff+'T23:59:59+09:00'
        p.OUTPUT_ROOT=run;p.REFRESH_CACHE=True
        os.environ['CLOUDTREND_STATE_ROOT']=str(run)
        p.client=p.TossClient();p.validate_toss_openapi(strict=True)
        dates,metadata,last_price,old_prices=load_observations(baseline,manifest)
        require(cutoff>max(max(v) for v in dates.values()),'New preview runs must be later than the immutable baseline; same-session revisions require the publication adapter')
        # Recover the actual configured universe, never expand to old inactive/research instruments.
        previous=json.loads(manifest['sources'][-1]['sourceRecord']['validation_result']['krPublication']['manifestText'])
        exclusions=set(excluded_symbols)
        configured=previous['requestedSymbols'];universe=[s for s in configured if s not in exclusions]
        require(universe and all(s in metadata for s in universe),'Configured universe metadata is incomplete')
        p.ETF_SET={s for s in universe if metadata[s]['type']=='ETF'};p.symbol_info=metadata
        calendar_count=max(520,(pd.Timestamp(cutoff)-pd.Timestamp(min(min(v) for v in dates.values()))).days+20)
        require(calendar_count<=6000,'Calendar exceeds reviewed collector bound')
        probes={i:p.get_candles_frame(i,calendar_count,True) for i in ('KOSPI','KOSDAQ')}
        calendars=[set(f.loc[pd.to_numeric(f.close,errors='coerce').gt(0),'date']) for f in probes.values()]
        require(calendars[0]==calendars[1] and len(calendars[0])>=2,'Both market calendars must agree')
        sessions=sorted(calendars[0]);require(sessions[-1]==cutoff,'Cutoff is not the latest actual completed session; use the date shown by the provider')
        pending_dates=[]
        for source in manifest['sources']:
            contract=source['sourceRecord']['validation_result'].get('krPublication',{})
            if contract.get('phase')=='PRELIMINARY':pending_dates.append(contract['asOfDate'])
        plans=incremental_plan(dates,universe,sessions,overlap,pending_dates)
        atomic(run/'collection-plan.json',json.dumps({'plans':plans,'lastActualPriceDates':last_price,'excludedSymbols':sorted(exclusions)},ensure_ascii=False,indent=2).encode())
        publication=publication_evidence(p,sessions,datetime.now(timezone.utc).isoformat())
        expected=[];missing=[];price_excluded=[];corrections=[]
        for n,plan in enumerate(plans):
            symbol=plan['symbol'];file=run/'checkpoints'/f'{symbol}.csv';receipt=file.with_suffix('.json')
            key=sha(json.dumps({'plan':plan,'baseline':BASELINE_SHA,'phase':publication['phase'],'version':VERSION},sort_keys=True).encode())
            if file.exists() and receipt.exists():
                saved=json.loads(receipt.read_text());require(saved['key']==key,'Checkpoint parameters changed; use a new run ID')
                checked(file.read_bytes(),saved);frame=read_frame(file)
            else:
                try:
                    p.TARGET_COUNT=p.FLOW_COUNT=plan['providerSessions'];p._stage_frames.clear()
                    frame=p.build_symbol_frame(symbol)
                    # Stock exact facts are fetched from the shared official market/day service, without price substitution.
                    exact=p.official_symbol_frame(symbol,plan['start'].replace('-',''),cutoff.replace('-',''),symbol in p.ETF_SET)
                    if symbol not in p.ETF_SET and not exact.empty:
                        frame=frame.drop(columns=[c for c in exact.columns if c!='date' and c in frame],errors='ignore').merge(exact,on='date',how='left',validate='one_to_one')
                        for src,dst in [('krxMarketCap','marketCap'),('krxListedShares','listedShares'),('krxTradingValue','tradingValue')]:
                            values=pd.to_numeric(frame[src],errors='coerce');mask=values.notna();frame.loc[mask,dst]=values[mask]
                        frame.loc[pd.to_numeric(frame['marketCap'],errors='coerce').gt(0),'marketCapSource']='KRX_STOCK'
                        frame.loc[pd.to_numeric(frame['krxTradingValue'],errors='coerce').notna(),'tradingValueSource']='KRX_STOCK'
                    frame=frame.loc[frame.date.between(plan['start'],cutoff)].copy()
                    require(not frame.duplicated(['symbol','date']).any(),'Duplicate symbol/date')
                    latest=frame.loc[frame.date.eq(cutoff)]
                    if latest.empty or not pd.to_numeric(latest.close,errors='coerce').gt(0).all():
                        price_excluded.append({'symbol':symbol,'reason':'NO_POSITIVE_PRICE_ON_TARGET_SESSION','lastActualPriceDate':last_price.get(symbol)});continue
                    require(set(plan['missingSessions'])<=set(frame.date),'Requested missing sessions remain unfilled; distinguish suspension/listing using provider evidence')
                    quality=p._completion_quality(frame,symbol);require(quality['ok'],'Existing collector quality contract failed')
                    market='ETF' if symbol in p.ETF_SET else metadata[symbol]['market']
                    ready=publication['markets'].get(market)
                    require(ready,'Unrecognized configured market')
                    if ready['status']=='EXACT_READY':
                        require(pd.to_numeric(frame.loc[frame.date.eq(cutoff),'marketCap'],errors='coerce').gt(0).all(),'Published KRX current market cap missing')
                    else:
                        frame.loc[frame.date.eq(cutoff),'marketCapSource']='PENDING_PUBLICATION'
                    raw=frame_csv(frame);atomic(file,raw);atomic(receipt,json.dumps({'key':key,'bytes':len(raw),'sha256':sha(raw),'quality':quality},ensure_ascii=False).encode())
                except Exception:
                    missing.append({'symbol':symbol,'reason':'COLLECTION_OR_COVERAGE_FAILED'});continue
            for row in frame.to_dict('records'):
                old=old_prices.get((symbol,row['date']),{})
                for field in ('open','high','low','close'):
                    if field in old and pd.notna(row.get(field)) and abs(float(old[field])-float(row[field]))>1e-8:
                        corrections.append({'symbol':symbol,'date':row['date'],'field':field,'before':old[field],'after':str(row[field]),'provider':'TOSS_ADJUSTED_CANDLE','checkpointSha256':sha(file.read_bytes())})
            expected.append(file)
            if (n+1)%10==0:print(f'검증 완료 {n+1}/{len(plans)}; 누락 {len(missing)}; 당일 가격 제외 {len(price_excluded)}')
        # Index collection is independently bounded to earliest required delta; full baseline is kept for all indicators.
        first=min(p['start'] for p in plans)
        for symbol,frame in probes.items():
            frame=frame.loc[frame.date.ge(first)].copy();frame['symbol']=symbol;frame['name']=symbol;frame['market']='INDEX';frame['securityType']='INDEX';frame['priceSource']='TOSS_MARKET_INDICATOR'
            flow=p.get_market_investor_flow_frame(symbol,sum(d>=first for d in sessions));frame=p.merge_on_date(frame,[flow]);frame['tradingValue']=0;frame['tradingValueSource']='NOT_APPLICABLE_INDEX';frame['investorValueSource']='TOSS_MARKET_INDICATOR_KRW'
            file=run/'checkpoints'/f'{symbol}.csv';atomic(file,frame_csv(frame));expected.append(file)
        atomic(run/'corrections.json',json.dumps(corrections,ensure_ascii=False,indent=2).encode())
        # Price restatement is quarantined: full adjusted history/event evidence must be reviewed before completion.
        complete=not missing and not corrections
        archive=run/'delta.zip';buf=io.BytesIO();entries=[]
        with zipfile.ZipFile(buf,'w',zipfile.ZIP_DEFLATED) as z:
            for f in expected:
                raw=f.read_bytes();z.writestr(f.name,raw);entries.append({'name':f.name,'bytes':len(raw),'sha256':sha(raw)})
        atomic(archive,buf.getvalue())
        targets=[s for s in universe if s not in {x['symbol'] for x in price_excluded}]
        result={'version':VERSION,'history_backend':'drive','result_backend':'drive','publish_dashboard':False,
                'baselineVersion':'screening_history_baseline_20261107_v1','baselineSha256':BASELINE_SHA,
                'orderedSourceHashes':[s['sha256'] for s in manifest['sources']],'parentManifestSha256':BASELINE_SHA,
                'runId':run_id,'createdAt':created,'codeCommit':os.environ.get('CLOUDTREND_CODE_COMMIT','UNKNOWN'),
                'codeHashes':code_hashes,'rulesVersion':'repository-official-engine','mode':'SCREENING','complete':complete,
                'actualLatestPriceDate':cutoff,'cutoffDateInclusive':cutoff,'requestedSymbols':targets,
                'excludedSymbols':sorted(exclusions),'missingPriceExcludedSymbols':price_excluded,'missingSymbols':[m['symbol'] for m in missing],
                'missingSymbolCount':len(missing),'missingIndexSymbols':[], 'correctionCount':len(corrections),
                'latestKrxPublicationPending':publication['phase']=='PRELIMINARY','latestKrxPendingDate':cutoff if publication['phase']=='PRELIMINARY' else None,
                'krxPublicationEvidence':publication,'deltaMembers':entries,
                'files':[{'name':'delta.zip','bytes':archive.stat().st_size,'sha256':sha(archive.read_bytes())}],
                'promotionStatus':'DISABLED_PREVIEW_NO_LATEST_POINTER'}
        atomic(run/('complete-manifest.json' if complete else 'incomplete-manifest.json'),json.dumps(result,ensure_ascii=False,indent=2).encode())
        print(f'완료={complete}, 가격 제외={len(price_excluded)}, 누락={len(missing)}, 수정주가 변경 격리={len(corrections)}')
        return result
