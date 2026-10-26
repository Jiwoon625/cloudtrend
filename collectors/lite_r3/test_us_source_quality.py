"""Offline real-redacted metadata -> Python archive -> TypeScript golden fixture."""
import copy,csv,hashlib,importlib.util,io,json,sys,tempfile,unittest
from datetime import datetime,timezone
from types import SimpleNamespace
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('quality_archive',Path(__file__).parent/'runtime/helpers/us_archive.py')
archive=importlib.util.module_from_spec(spec);spec.loader.exec_module(archive)
fixture=json.loads((ROOT/'tests/fixtures/us-scoring-holds-golden.json').read_text())
FIELDS='date symbol name market sector security_type status currency shares_outstanding open high low close volume ret120 ret252 beta60_spy ichimoku_tk_gap relvol1_20 adv20_usd amihud20 active20 toss_tradable is_common_share'.split()

def inputs(mixed=False):
    rows=[]
    for symbol in ['SPY','VJET','WQEY']+(['GAP'] if mixed else []):
        row=dict.fromkeys(FIELDS,'')
        row.update(date=fixture['asOfDate'],symbol=symbol,name=symbol,market='NYSE',sector='TEST',security_type='STOCK',status='ACTIVE',currency='USD',shares_outstanding='1000000',open='100',high='102',low='99',close='101',volume='1000',active20='false',toss_tradable='true',is_common_share=str(symbol!='SPY').lower())
        if symbol=='SPY':row.update(ret120='.1',ret252='.2',beta60_spy='1',ichimoku_tk_gap='.1',relvol1_20='1',adv20_usd='1000000',amihud20='.001',active20='true')
        if symbol=='GAP':
            for k in ['open','high','low','close','volume']:row[k]=''
        rows.append(row)
    metadata={k:copy.deepcopy(fixture[k]) for k in ['previousSessionDate','confirmedRegularClose','failedSymbols','sourceCoverageComplete','providerGapSymbols','lifecycleExcludedSymbols','guardedCandidateQuarantine','guardedCandidateScoringHolds']}
    if mixed:metadata['providerGapSymbols']=['GAP']
    return rows,metadata

def payload(rows,metadata):
    stream=io.StringIO();w=csv.DictWriter(stream,fieldnames=FIELDS,lineterminator='\n');w.writeheader();w.writerows(rows);raw=stream.getvalue().encode()
    return raw,dict(user_id='11111111-1111-4111-8111-111111111111',as_of_date=fixture['asOfDate'],data_hash='sha256:'+hashlib.sha256(raw).hexdigest(),row_count=len(rows),symbol_count=len(rows),collected_at='2026-10-24T01:00:00Z',metadata=metadata)

def producer_golden(root,mode='present',stage=None):
    """Execute the real upload producer through archive admission, stopping before HTTP."""
    rows,meta=inputs(mode!='absent')
    if mode!='mixed':
        rows=[r for r in rows if r['symbol'] not in ('VJET','WQEY')]
        meta['guardedCandidateScoringHolds']={}
    if mode!='absent':
        row=next(r for r in rows if r['symbol']=='GAP');row.update(status='SUSPENDED',toss_tradable='false')
    lifecycle=['OMITTED'] if mode=='absent' else ['GAP']
    if mode=='mixed':lifecycle.append('OMITTED')
    events=[dict(symbol=s,status='SUSPENDED',effective_date=fixture['asOfDate'],source_url='https://example.invalid/verified',identity_name_contains=s) for s in lifecycle]
    raw,p=payload(rows,meta)
    class Symbols(list):
        def nunique(self):return len(set(self))
    class Output:
        symbol=Symbols(r['symbol'] for r in rows)
        def __len__(self):return len(self.symbol)
    class FrozenDatetime:
        @staticmethod
        def now(tz):return datetime(2026,10,24,1,tzinfo=tz)
    class StopBeforeHttp(Exception):pass
    captured={}
    def preserve(**kwargs):
        captured['ingest']=kwargs['payload']
        captured['source']=archive.preserve_us_daily_before_upload(**kwargs)
        raise StopBeforeHttp()
    class NoHttp:
        def __getattr__(self,name):raise AssertionError('Unexpected network access: '+name)
    ns=dict(RUN_US_MARKET=True,_US_SNAPSHOT_READY=True,_us_begin_stage=lambda s:None,_us_require_stage=lambda s:None,
        SUPABASE_URL='https://example.invalid',SUPABASE_SERVICE_ROLE_KEY='synthetic',SUPABASE_USER_ID=p['user_id'],
        latest_date=fixture['asOfDate'],data_hash=p['data_hash'],out=Output(),datetime=FrozenDatetime,timezone=timezone,
        CACHE_PATH='synthetic',MASTER_PATH='synthetic',COLLECTION_UNIVERSE='synthetic',collection_universe_hash='synthetic',
        unhandled_failures=[],provider_gap_symbols=set(),candidate_scoring_holds=meta['guardedCandidateScoringHolds'],candidate_quarantine={},
        PREVIOUS_SESSION=fixture['previousSessionDate'],COLLECTOR_VERSION='synthetic',PROVIDER_GAP_POLICY_VERSION='synthetic',
        lifecycle_events=events,lifecycle_exempt_symbols=set(lifecycle),seed=SimpleNamespace(ticker=list(Output.symbol)+lifecycle),
        provider_gap_latest_dates={},market_calendar={'ok':True},exchange_rate={'ok':True},ranking_amount={'ok':True},raw=raw,
        DATED_ARCHIVE_DIR=root,_CT_US_ARCHIVE={'preserve_us_daily_before_upload':preserve},requests=NoHttp())
    code=Path(stage or Path(__file__).parent/'runtime/stages/us_upload.py').read_text()
    try:exec(compile(code,'actual-us-upload-stage','exec'),ns)
    except StopBeforeHttp:pass
    else:raise AssertionError('Producer did not reach archive boundary')
    manifest,blobs=archive.prepare_us_atomic_chain(root,[fixture['asOfDate']],fixture['previousSessionDate'])
    return dict(ingest=captured['ingest'],manifest=manifest,files={p:b.decode() for p,b,m in blobs})

def golden(root,mixed=False):
    raw,ingest=payload(*inputs(mixed))
    source=archive.preserve_us_daily_before_upload(raw=raw,payload=ingest,root=root,user_id=ingest['user_id'])
    manifest,blobs=archive.prepare_us_atomic_chain(root,[source['date']],source['previousSessionDate'])
    return dict(ingest=ingest,manifest=manifest,files={p:b.decode() for p,b,m in blobs})

class QualityTests(unittest.TestCase):
    def test_actual_upload_producer_lifecycle_boundaries(self):
        for mode in ['present','absent','mixed']:
            with self.subTest(mode=mode),tempfile.TemporaryDirectory() as root:
                g=producer_golden(root,mode);source=g['manifest']['sessions'][0];metadata=g['ingest']['metadata']
                self.assertEqual(source['sourceCoverageComplete'],mode=='absent')
                self.assertEqual(source['sourceQuality']['priceCoverageComplete'],mode=='absent')
                self.assertEqual(source['quarantinedSymbols'],[] if mode=='absent' else ['GAP'])
                self.assertEqual(metadata['lifecycleExcludedSymbols'],['OMITTED'] if mode=='absent' else (['GAP','OMITTED'] if mode=='mixed' else ['GAP']))
                self.assertEqual(len(metadata['verifiedLifecycleEvents']),len(metadata['lifecycleExcludedSymbols']))
    def test_missing_provider_or_unverified_lifecycle_stays_blocked(self):
        for mode in ['provider','no-event','future','bad-status','bad-url','duplicate']:
            with self.subTest(mode=mode),tempfile.TemporaryDirectory() as root:
                rows,meta=inputs();meta['lifecycleExcludedSymbols']=['OMITTED']
                event=dict(symbol='OMITTED',status='SUSPENDED',effective_date=fixture['asOfDate'],source_url='https://example.invalid/verified')
                meta['verifiedLifecycleEvents']=[event]
                if mode=='provider':meta['providerGapSymbols']=['OMITTED']
                if mode=='no-event':meta['verifiedLifecycleEvents']=[]
                if mode=='future':event['effective_date']='2026-10-24'
                if mode=='bad-status':event['status']='ACTIVE'
                if mode=='bad-url':event['source_url']='http://example.invalid/'
                if mode=='duplicate':meta['lifecycleExcludedSymbols'].append('OMITTED')
                raw,p=payload(rows,meta)
                with self.assertRaises(RuntimeError):archive.freeze_us_atomic_archive(raw=raw,ingest=p,root=root,user_id=p['user_id'])
                self.assertEqual(list(Path(root).iterdir()),[])

    def test_golden_and_mixed(self):
        for mixed in [False,True]:
            with tempfile.TemporaryDirectory() as root:
                out=golden(root,mixed);s=out['manifest']['sessions'][0]
                self.assertFalse(s['sourceCoverageComplete']);self.assertEqual(s['sourceQuality']['priceCoverageComplete'],not mixed)
                self.assertEqual(s['sourceQuality']['scoringHolds'],fixture['guardedCandidateScoringHolds'])
                self.assertEqual(s['quarantinedSymbols'],['GAP'] if mixed else [])
                self.assertEqual(out['ingest']['metadata']['sourceQuality'],s['sourceQuality'])
    def test_exact_retry_preserves_metadata_and_capture(self):
        with tempfile.TemporaryDirectory() as root:
            first=golden(root);saved={str(p):p.read_bytes() for p in Path(root).rglob('*') if p.is_file()}
            raw,p=payload(*inputs());p['collected_at']='2026-10-24T02:00:00Z'
            archive.preserve_us_daily_before_upload(raw=raw,payload=p,root=root,user_id=p['user_id'])
            self.assertEqual(p['collected_at'],first['ingest']['collected_at']);self.assertEqual(p['metadata']['sourceQuality'],first['ingest']['metadata']['sourceQuality'])
            self.assertEqual(saved,{str(p):p.read_bytes() for p in Path(root).rglob('*') if p.is_file()})
            p['metadata']['guardedCandidateScoringHolds']['VJET']['postEventBars']=16
            with self.assertRaisesRegex(RuntimeError,'quality differs|evidence differs'):
                archive.preserve_us_daily_before_upload(raw=raw,payload=p,root=root,user_id=p['user_id'])
            self.assertEqual(saved,{str(p):p.read_bytes() for p in Path(root).rglob('*') if p.is_file()})
    def test_reviewed_lifecycle_derivative_preserves_unrelated_holds(self):
        for symbol in ['GAP','VJET']:
            with tempfile.TemporaryDirectory() as root:
                out=golden(root,True);source=out['manifest']['sessions'][0];raw=out['files'][source['storagePath']].encode()
                saved={str(p):p.read_bytes() for p in Path(root).rglob('*') if p.is_file()}
                event=dict(symbol=symbol,effective_date=source['date'],status='SUSPENDED',source_url='https://example.invalid/review',identity_name_contains=symbol)
                derived=archive.prepare_us_lifecycle_derivative(root=root,date=source['date'],original_raw=raw,events=[event],registry=[event],user_id=out['ingest']['user_id'])
                quality=derived['source']['sourceQuality']
                self.assertFalse(quality['priceCoverageComplete'])
                self.assertEqual(set(quality['scoringHolds']),set(['VJET','WQEY'])-{symbol})
                self.assertEqual(source['sourceQuality']['scoringHolds'],fixture['guardedCandidateScoringHolds'])
                for p,b in saved.items():self.assertEqual(Path(p).read_bytes(),b)

    def test_malformed_holds_fail_before_archive_writes(self):
        changes=[lambda r,m:m.update(sourceCoverageComplete=True),lambda r,m:m['guardedCandidateScoringHolds'].update(UNKNOWN=m['guardedCandidateScoringHolds']['VJET']),lambda r,m:m.update(guardedCandidateQuarantine={'OMITTED':{'reason':'identity'}})]
        for key,value in [('reason','unknown'),('postEventBars',253),('postEventBars',-1),('postEventBars',15.0),('postEventBars',True),('minimumBars',252),('historyStartDate','2026-10-24'),('historyStartDate','2026-02-31')]:
            changes.append(lambda r,m,k=key,v=value:m['guardedCandidateScoringHolds']['VJET'].update({k:v}))
        for key,value in [('ret252','0'),('beta60_spy','0'),('active20','true'),('close',''),('high','98'),('volume','-1')]:
            changes.append(lambda r,m,k=key,v=value:r[1].update({k:v}))
        for change in changes:
            with self.subTest(change=change),tempfile.TemporaryDirectory() as root:
                r,m=inputs();change(r,m);raw,p=payload(r,m)
                with self.assertRaises(RuntimeError):archive.freeze_us_atomic_archive(raw=raw,ingest=p,root=root,user_id=p['user_id'])
                self.assertEqual(list(Path(root).iterdir()),[])

if __name__=='__main__':
    if '--emit' in sys.argv:
        with tempfile.TemporaryDirectory() as root:
            out=producer_golden(root,sys.argv[sys.argv.index('--producer')+1]) if '--producer' in sys.argv else golden(root,'--mixed' in sys.argv)
            print(json.dumps(out))
    else:unittest.main()
