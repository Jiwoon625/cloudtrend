"""Bounded daily-runtime regression checks. No external calls or publication."""
from contextlib import redirect_stdout
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed
import math
import time
import hashlib
import importlib
import importlib.util
import io
import json
import re
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import zipfile

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('r3_runtime_test', ROOT/'runtime/__init__.py', submodule_search_locations=[str(ROOT/'runtime')])
rt = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = rt
spec.loader.exec_module(rt)


class StubRequestError(Exception):
    pass


class StubTimeout(StubRequestError):
    pass


REQUEST_EXCEPTIONS = types.SimpleNamespace(Timeout=StubTimeout, RequestException=StubRequestError)


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.ns = {'RUN_PLAN':'US_ONLY','RUN_US_EVENING':False,'US_BASE_DIR':self.base/'us',
                   'KR_REFERENCE_DIR':self.base/'kr_ref','KR_CLAIM_DIRECTORY':self.base/'kr_claims',
                   'SUPABASE_URL':'https://example.invalid','EXPECTED_SUPABASE_URL':'https://example.invalid',
                   'SUPABASE_USER_ID':'test-owner','SUPABASE_SERVICE_ROLE_KEY':'test-only',
                   'GITHUB_TOKEN':'test-only','Path':Path,'pd':pd,'np':np,'hashlib':hashlib,'json':json,
                   'display':lambda x:None}
        self.run_stage('plan_init')
        self.run_stage('helpers')
        self.run_stage('us_setup')

    def tearDown(self):
        self.temp.cleanup()

    def run_stage(self, name):
        with redirect_stdout(io.StringIO()):
            rt.run_stage(name,self.ns)

    def test_stage_interface_daily_plan_and_400_15_cache(self):
        self.assertEqual(rt.STAGES[0],'plan_init')
        self.assertEqual(len(rt.STAGES),30)
        self.assertTrue(self.ns['RUN_US_MARKET'])
        self.assertFalse(self.ns['RUN_KR_MARKET'])
        self.assertEqual((self.ns['INITIAL_BARS'],self.ns['INCREMENTAL_BARS'],self.ns['CACHE_KEEP_BARS']),(400,15,400))
        self.assertNotIn('_US_DATA_MODE',self.ns)
        self.assertNotIn('_CT_US_RECOVERY',self.ns)
        self.assertIn('archive',self.ns['_US_STAGE_ORDER'])

    def test_plan_modes_and_reset_preserve_notebook_configuration(self):
        resolve=self.ns['resolve_integrated_run_plan']
        self.assertEqual(resolve('AUTO',datetime(2026,10,8,8)),('MORNING',True,True))
        self.assertEqual(resolve('AUTO',datetime(2026,10,8,20)),('EVENING',True,False))
        self.assertEqual(resolve('KR_ONLY',datetime(2026,10,8,8)),('MORNING',True,False))
        self.ns.update(RUN_PLAN='KR_ONLY',_US_UPLOAD_VERIFIED=True,_US_DAILY_ARCHIVE_SOURCE={'old':True})
        self.run_stage('plan_init')
        self.assertFalse(self.ns['RUN_US_MARKET'])
        self.assertFalse(self.ns['_US_UPLOAD_VERIFIED'])
        self.assertIsNone(self.ns['_US_DAILY_ARCHIVE_SOURCE'])
        self.assertEqual(self.ns['RUN_PLAN'],'KR_ONLY')

    def test_kr_settings_preserve_user_parameters(self):
        self.ns.update(RUN_KR_MARKET=True,KR_COLLECTION_DAYS=3,UNIVERSE_MODE='STOCK_ONLY',ETF_UNIVERSE_MODE='CURATED_150',SCHEMA_REVIEW_DATE='2026-09-28')
        self.run_stage('kr_setup')
        self.assertEqual(self.ns['COLLECTION_DAYS'],3)
        self.assertEqual(self.ns['UNIVERSE_MODE'],'STOCK_ONLY')
        self.assertEqual(self.ns['SCHEMA_REVIEW_DATE'],'2026-09-28')
        self.assertFalse(self.ns['SHOW_DETAILED_QA'])

    def test_run_dependency_guards_and_failure_invalidates_dispatch(self):
        with self.assertRaises(RuntimeError):self.ns['_us_require_stage']('collection')
        run=self.ns['_US_RUN_ID']
        self.ns['_US_STAGE_RUN'].update({s:run for s in self.ns['_US_STAGE_ORDER']})
        self.ns['_US_UPLOAD_VERIFIED']=True
        self.ns['_us_begin_stage']('features')
        self.assertIn('collection',self.ns['_US_STAGE_RUN'])
        self.assertNotIn('upload',self.ns['_US_STAGE_RUN'])
        self.assertNotIn('archive',self.ns['_US_STAGE_RUN'])
        self.assertNotIn('dispatch',self.ns['_US_STAGE_RUN'])
        self.assertFalse(self.ns['_US_UPLOAD_VERIFIED'])

    def test_original_feature_math_on_synthetic_histories(self):
        dates=pd.bdate_range(end='2026-10-06',periods=400).strftime('%Y-%m-%d').tolist()
        histories={}
        for symbol,factor in [('SPY',1.0),('TEST',1.4)]:
            close=100.0
            rows=[]
            for i,day in enumerate(dates):
                close *= 1 + 0.0004 + factor*0.005*np.sin(i/7)
                rows.append({'symbol':symbol,'date':day,'open':close*0.998,'high':close*1.002,'low':close*0.997,
                             'close':close,'volume':1000000+i*17,'currency':'USD'})
            histories[symbol]=rows
        self.ns.update(AS_OF_DATE='2026-10-06',seed=pd.DataFrame({'ticker':list(histories)}),
            combined=pd.DataFrame([r for rows in histories.values() for r in rows]),
            master=pd.DataFrame([{'symbol':s,'name':s,'englishName':s,'market':'NASDAQ','securityType':'STOCK','status':'ACTIVE','currency':'USD','sharesOutstanding':100,
                                 'isCommonShare':s!='SPY','sector':'TEST'} for s in histories]),
            truthy=lambda v:str(v).lower()=='true', VERIFIED_LIFECYCLE_EVENTS=[],provider_gap_symbols=set(),
            _validate_lifecycle_events=lambda events,day:set())
        self.ns['_US_STAGE_RUN']['collection']=self.ns['_US_RUN_ID']
        self.run_stage('us_features')
        snap=self.ns['snap'].set_index('symbol')
        spy=pd.Series([r['close'] for r in histories['SPY']]).pct_change(fill_method=None)
        for symbol,rows in histories.items():
            close=pd.Series([r['close'] for r in rows]);returns=close.pct_change(fill_method=None)
            self.assertAlmostEqual(snap.loc[symbol,'ret252'],close.iloc[-1]/close.iloc[-253]-1)
            expected=returns.rolling(60,min_periods=50).cov(spy).iloc[-1]/spy.rolling(60,min_periods=50).var().iloc[-1]
            self.assertAlmostEqual(snap.loc[symbol,'beta60_spy'],expected)
        self.assertEqual(self.ns['_US_STAGE_RUN']['features'],self.ns['_US_RUN_ID'])

    def _upload_fixture(self):
        row={'date':'2026-10-08','symbol':'SPY','name':'SPY','market':'AMEX','sector':'BENCHMARK',
             'security_type':'ETF','status':'ACTIVE','currency':'USD','shares_outstanding':100,
             'toss_tradable':True,'is_common_share':False,'open':10,'close':11}
        frame=pd.DataFrame([row]);raw=frame.to_csv(index=False,lineterminator='\n').encode()
        self.ns.update(AS_OF_DATE=row['date'],latest_date=row['date'],PREVIOUS_SESSION='2026-10-07',out=frame,raw=raw,
                       data_hash='sha256:'+hashlib.sha256(raw).hexdigest(),unhandled_failures=[],provider_gap_symbols=set(),
                       provider_gap_latest_dates={},lifecycle_events=[],lifecycle_exempt_symbols=set(),seed=pd.DataFrame({'ticker':['SPY']}),
                       COLLECTION_UNIVERSE=self.base/'seed.csv',collection_universe_hash='test-hash',
                       market_calendar={'ok':True},exchange_rate={'ok':False},ranking_amount={'ok':False})
        self.ns['_US_STAGE_RUN']['snapshot']=self.ns['_US_RUN_ID'];self.ns['_US_SNAPSHOT_READY']=True
        return raw

    def test_atomic_preserved_before_upload_failure_and_first_capture_reused(self):
        raw=self._upload_fixture()
        calls=[]
        def fail(*args,**kwargs):calls.append(args[0]);raise RuntimeError('simulated upload outage')
        self.ns['requests']=types.SimpleNamespace(post=fail,get=fail)
        for attempt in range(2):
            with self.assertRaisesRegex(RuntimeError,'simulated upload outage'):self.run_stage('us_upload')
            path=self.ns['DATED_ARCHIVE_DIR']/'2026-10-08/source.json'
            self.assertTrue(path.is_file())
            source=json.loads(path.read_text())
            self.assertEqual(source['pit']['kind'],'ATOMIC_DATED_SNAPSHOT')
            body=self.ns['DATED_ARCHIVE_DIR']/'2026-10-08'/source['dataHash'][7:]/'input.csv'
            self.assertEqual(body.read_bytes(),raw)
            if attempt==0:first=path.read_bytes();captured=source['sourceCapturedAt']
            else:self.assertEqual(path.read_bytes(),first);self.assertEqual(self.ns['payload']['collected_at'],captured)
        self.assertEqual(len(calls),2)
        self.assertFalse(self.ns['_US_UPLOAD_VERIFIED'])
        with self.assertRaises(RuntimeError):self.run_stage('us_dispatch')

    def test_archive_connection_does_not_repeat_source_file_reads(self):
        self._upload_fixture()
        self.ns['_US_STAGE_RUN']['upload']=self.ns['_US_RUN_ID'];self.ns['_US_UPLOAD_VERIFIED']=True
        self.ns['_US_DAILY_ARCHIVE_SOURCE']={'date':'2026-10-08','dataHash':self.ns['data_hash']}
        with patch.object(Path,'read_bytes',side_effect=AssertionError('unexpected source reread')):
            self.run_stage('us_archive')
        self.assertEqual(self.ns['_US_ARCHIVE_STATUS']['status'],'ATOMIC_CHAIN_READY')

    def test_private_destination_guard_is_injected(self):
        with self.assertRaisesRegex(RuntimeError,'Unexpected Supabase'):
            self.ns['_CT_US_ARCHIVE']['UsArchiveApi']('https://wrong.invalid','k','u','t',None)
        with self.assertRaisesRegex(ValueError,'Unexpected Supabase'):
            self.ns['_CT_KR_CALLBACK']['KrCallbackApi']({},'https://wrong.invalid','t',session=object())

    def test_atomic_only_chain_and_true_true_contract(self):
        source=(ROOT/'runtime/helpers/us_archive.py').read_text()
        self.assertIn("'replay_apply':'true'",source)
        self.assertIn("'replay_then_screen':'true'",source)
        archive=self.ns['_CT_US_ARCHIVE']
        folder=self.base/'bad_archive/2026-10-08';folder.mkdir(parents=True)
        (folder/'source.json').write_text(json.dumps({'date':'2026-10-08','pit':{'kind':'OTHER'}}))
        with self.assertRaisesRegex(RuntimeError,'Only saved atomic'):
            archive['read_us_atomic_archive'](folder.parent,'2026-10-08')

    def test_public_runtime_has_no_private_values_or_oneoff_recovery(self):
        text='\n'.join(p.read_text() for p in (ROOT/'runtime').rglob('*.py'))
        for word in ['DATED_ROSTER_RECONSTRUCTION','SOURCE_UNAVAILABLE','targeted13','SAVED_DATE_REPLAY',
                     '_CT_US_RECOVERY','_US_DATA_MODE','_US_SCREENING_SESSION_COUNT']:
            self.assertNotIn(word,text)
        self.assertNotRegex(text,r'https://[a-z0-9]+\.supabase\.co')
        self.assertNotRegex(text,r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}')
        self.assertNotIn('%pip',text)
        for p in (ROOT/'runtime').rglob('*.py'):compile(p.read_text(),str(p),'exec')

    def _pending_api(self, response):
        calls=[]
        def get(url,**kwargs):calls.append(url);return response
        api=types.SimpleNamespace(uid='test-owner',url='https://example.invalid',headers={},session=types.SimpleNamespace(get=get))
        return api,calls

    def _pending_pointer(self):
        root=self.base/'pending';root.mkdir()
        pending={'manifestHash':'sha256:'+'a'*64,'manifestPath':'test-owner/us-replay/manifests/'+'a'*64+'.json','throughDate':'2026-10-08'}
        (root/'active_replay.json').write_text(json.dumps(pending))
        return root,pending

    def test_no_pending_performs_zero_get(self):
        api,calls=self._pending_api(None)
        result=self.ns['_CT_US_ARCHIVE']['check_pending_us_publication'](root=self.base/'absent',api=api)
        self.assertEqual(result['status'],'NO_PENDING_REPLAY');self.assertEqual(calls,[])

    def test_completed_matching_publication_clears_pending(self):
        root,pending=self._pending_pointer()
        receipt={'version':'us-daily-publication-receipt-v1',**pending,'screeningPublished':True}
        api,calls=self._pending_api(types.SimpleNamespace(status_code=200,json=lambda:receipt))
        result=self.ns['_CT_US_ARCHIVE']['check_pending_us_publication'](root=root,api=api)
        self.assertEqual(result['status'],'PRIOR_PUBLICATION_CONFIRMED')
        self.assertFalse((root/'active_replay.json').exists());self.assertEqual(len(calls),1)

    def test_missing_or_mismatched_publication_holds_pending(self):
        root,pending=self._pending_pointer()
        for status,receipt in [(404,{}),(200,{'version':'us-daily-publication-receipt-v1',**pending,'screeningPublished':False}),
                               (200,{'version':'us-daily-publication-receipt-v1',**pending,'throughDate':'2026-10-07','screeningPublished':True})]:
            api,calls=self._pending_api(types.SimpleNamespace(status_code=status,json=lambda:receipt))
            with self.assertRaisesRegex(RuntimeError,'새 수집과 업로드'):
                self.ns['_CT_US_ARCHIVE']['check_pending_us_publication'](root=root,api=api)
            self.assertTrue((root/'active_replay.json').exists());self.assertEqual(len(calls),1)

    def test_uncertain_gap_dispatch_preserves_pending(self):
        archive=self.ns['_CT_US_ARCHIVE'];root=self.base/'gap'
        source={'date':'2026-10-08','previousSessionDate':'2026-10-07','storagePath':'test-owner/us-replay/inputs/x.csv',
                'dataHash':'sha256:'+'b'*64,'pit':{'kind':'ATOMIC_DATED_SNAPSHOT','rosterStoragePath':'test-owner/us-replay/rosters/x.json','rosterHash':'sha256:'+'c'*64}}
        def uncertain(inputs):raise RuntimeError('transport uncertain')
        api=types.SimpleNamespace(uid='test-owner',token='test',common_base=lambda:'2026-10-07',upload_verified=lambda *args:None,dispatch=uncertain)
        original=archive['prepare_us_atomic_chain']
        archive['prepare_us_atomic_chain']=lambda *args:({'version':'us-dated-replay-v1','baseDate':'2026-10-07','throughDate':'2026-10-08','sessions':[source]},[])
        try:result=archive['publish_us_atomic_chain'](api=api,root=root,dates=['2026-10-08'],base_date='2026-10-07')
        finally:archive['prepare_us_atomic_chain']=original
        self.assertEqual(result['status'],'DISPATCH_UNCERTAIN');self.assertTrue((root/'active_replay.json').exists())

    def test_missing_token_does_not_leave_pending_or_upload(self):
        archive=self.ns['_CT_US_ARCHIVE'];root=self.base/'no_token'
        def unexpected(*args):raise AssertionError('must not call API')
        api=types.SimpleNamespace(uid='test-owner',token='',common_base=unexpected,upload_verified=unexpected,dispatch=unexpected)
        result=archive['publish_us_atomic_chain'](api=api,root=root,dates=['2026-10-08'],base_date='2026-10-07')
        self.assertEqual(result['status'],'MISSING_TOKEN');self.assertFalse((root/'active_replay.json').exists())

    def test_clear_rejected_request_removes_pending_but_keeps_receipt(self):
        archive=self.ns['_CT_US_ARCHIVE'];root=self.base/'rejected'
        api=types.SimpleNamespace(uid='test-owner',token='test',common_base=lambda:'2026-10-07',upload_verified=lambda *args:None,dispatch=lambda inputs:403)
        original=archive['prepare_us_atomic_chain']
        archive['prepare_us_atomic_chain']=lambda *args:({'version':'us-dated-replay-v1','baseDate':'2026-10-07','throughDate':'2026-10-08','sessions':[]},[])
        try:result=archive['publish_us_atomic_chain'](api=api,root=root,dates=['2026-10-08'],base_date='2026-10-07')
        finally:archive['prepare_us_atomic_chain']=original
        self.assertEqual(result['status'],'REQUEST_REJECTED');self.assertFalse((root/'active_replay.json').exists())
        receipts=list((root/'requests').glob('*.response.json'));self.assertEqual(len(receipts),1)
        self.assertEqual(json.loads(receipts[0].read_text())['httpStatus'],403)

    def test_known_wbd_lifecycle_remains_in_daily_setup(self):
        event=next(e for e in self.ns['VERIFIED_LIFECYCLE_EVENTS'] if e['symbol']=='WBD')
        self.assertEqual(event['effective_date'],'2026-10-06');self.assertEqual(event['status'],'SUSPENDED')

    def _snapshot_fixture(self, *, date='2026-10-07', frozen=True, registered=True):
        stable=['open','high','low','close','volume','dollar_volume','ret120','ret252',
                'beta60_spy','ichimoku_tk_gap','relvol1_20','adv20_usd','amihud20']
        frame=pd.DataFrame([{'date':date,'symbol':symbol,'name':symbol,'status':'ACTIVE',
                            'toss_tradable':True,'active20':True,**{col:10.0 for col in stable}}
                           for symbol in ['KEEP','SPY','WBD']])
        original=frame.to_csv(index=False,lineterminator='\n').encode()
        path=self.ns['OUTPUT_DIR']/('us_screening_input_'+date.replace('-','')+'.csv')
        if frozen:path.write_bytes(original)
        elif path.exists():path.unlink()
        event=next(e.copy() for e in self.ns['VERIFIED_LIFECYCLE_EVENTS'] if e['symbol']=='WBD')
        frame.loc[frame.symbol.eq('WBD'),stable]=np.nan
        frame.loc[frame.symbol.eq('WBD'),['toss_tradable','active20']]=False
        frame.loc[frame.symbol.eq('WBD'),'status']='SUSPENDED'
        pointer={'as_of_date':date,'data_hash':'sha256:'+hashlib.sha256(original).hexdigest(),
                 'row_count':3,'symbol_count':3}
        if frozen and registered:
            ingest={**pointer,'user_id':'test-owner','collected_at':'2026-10-08T00:00:00+00:00',
                    'metadata':{'confirmedRegularClose':True,'failedSymbols':0,'previousSessionDate':('2026-10-02' if date<'2026-10-06' else '2026-10-06'),
                                'sourceCoverageComplete':True,'providerGapSymbols':[],'lifecycleExcludedSymbols':[]}}
            self.ns['_CT_US_ARCHIVE']['freeze_us_atomic_archive'](
                raw=original,ingest=ingest,root=self.ns['DATED_ARCHIVE_DIR'],user_id='test-owner')
        proof={'analysis':{'date':date},'source':{'metadata':{
            'sourceCoverageComplete':False,'quarantinedSymbols':['WBD'],
            'recoveryPublication':{'version':'us-recovery-publication-v1',
                'sourceKind':'REVIEWED_ATOMIC_QUARANTINE','originalDataHash':pointer['data_hash']}}}}
        self.ns.update(AS_OF_DATE=date,latest_date=date,snap=frame,lifecycle_events=[event],
                       provider_gap_symbols=set(),truthy=lambda v:str(v).lower() in ('true','1'))
        self.ns['_US_STAGE_RUN']['diagnostics']=self.ns['_US_RUN_ID']
        calls=[]
        def get(url,**kwargs):
            calls.append((url,kwargs))
            value=([pointer] if registered else []) if '/rest/v1/' in url else proof
            return types.SimpleNamespace(status_code=200,json=lambda:value,raise_for_status=lambda:None)
        self.ns['requests']=types.SimpleNamespace(get=get,exceptions=REQUEST_EXCEPTIONS)
        return path,original,pointer,proof,calls

    def test_reviewed_wbd_same_day_reuses_exact_bytes_and_one_small_proof(self):
        path,original,pointer,proof,calls=self._snapshot_fixture()
        log=io.StringIO()
        with redirect_stdout(log):rt.run_stage('us_snapshot',self.ns)
        self.assertEqual(path.read_bytes(),original)
        self.assertEqual(self.ns['raw'],original)
        self.assertEqual(self.ns['data_hash'],pointer['data_hash'])
        self.assertEqual(self.ns['out'].set_index('symbol').loc['WBD','status'],'ACTIVE')
        self.assertTrue(self.ns['_US_SNAPSHOT_READY'])
        self.assertIn('sourceCoverageComplete=False',log.getvalue())
        self.assertEqual(len(calls),2)
        url,kwargs=calls[1]
        self.assertEqual(url,'https://example.invalid/storage/v1/object/authenticated/cloudtrend-data/test-owner/cache/us-screening/summary-v1.json')
        self.assertEqual(kwargs['headers']['Authorization'],'Bearer test-only')
        self.assertEqual(kwargs['headers']['Cache-Control'],'no-cache')
        self.assertEqual(kwargs['timeout'],30)

    def test_wbd_reuse_requires_matching_complete_review_marker(self):
        mutations=[lambda p:p.clear(),lambda p:p['analysis'].update(date='2026-10-06'),
                   lambda p:p['source']['metadata']['recoveryPublication'].update(originalDataHash='sha256:'+'f'*64),
                   lambda p:p['source']['metadata']['recoveryPublication'].update(version='other'),
                   lambda p:p['source']['metadata']['recoveryPublication'].update(sourceKind='ATOMIC_DATED_SNAPSHOT'),
                   lambda p:p['source']['metadata'].update(quarantinedSymbols=[]),
                   lambda p:p['source']['metadata'].update(quarantinedSymbols='WBD'),
                   lambda p:p['source']['metadata'].update(sourceCoverageComplete=True),
                   lambda p:p['source']['metadata'].update(sourceCoverageComplete=0)]
        for change in mutations:
            with self.subTest(change=change):
                path,original,_,proof,calls=self._snapshot_fixture()
                change(proof)
                with self.assertRaisesRegex(RuntimeError,'근거의 날짜'):self.run_stage('us_snapshot')
                self.assertFalse(self.ns['_US_SNAPSHOT_READY'])
                self.assertEqual(path.read_bytes(),original)
                self.assertEqual(len(calls),2)

    def test_wbd_proof_read_failures_are_safe_and_diagnostic(self):
        cases=[(403,'HTTP 403'),(404,'HTTP 404'),(StubTimeout('secret-response'),'timeout'),
               (StubRequestError('secret-response'),'연결 오류'),('bad-json','근거의 날짜')]
        for failure,message in cases:
            with self.subTest(failure=message):
                path,original,_,_,calls=self._snapshot_fixture()
                pointer_get=self.ns['requests'].get
                def get(url,**kwargs):
                    if '/rest/v1/' in url:return pointer_get(url,**kwargs)
                    if isinstance(failure,Exception):raise failure
                    def body():raise ValueError('secret-response')
                    return types.SimpleNamespace(status_code=200 if failure=='bad-json' else failure,json=body)
                self.ns['requests']=types.SimpleNamespace(get=get,exceptions=REQUEST_EXCEPTIONS)
                with self.assertRaisesRegex(RuntimeError,message) as error:self.run_stage('us_snapshot')
                self.assertNotIn('secret-response',str(error.exception))
                self.assertFalse(self.ns['_US_SNAPSHOT_READY'])
                self.assertEqual(path.read_bytes(),original)

    def test_wbd_reuse_requires_original_local_archive_without_creating_a_descriptor(self):
        mutations=[None,lambda s:s.update(date='2026-10-06'),lambda s:s.update(dataHash='sha256:'+'f'*64),
                   lambda s:s['pit'].update(kind='REVIEWED_ATOMIC_QUARANTINE')]
        for mutate in mutations:
            path,original,_,_,calls=self._snapshot_fixture()
            archive_path=self.ns['DATED_ARCHIVE_DIR']/'2026-10-07/source.json'
            if mutate is None:archive_path.unlink()
            else:
                source=json.loads(archive_path.read_text());mutate(source)
                archive_path.write_text(json.dumps(source))
            before=archive_path.read_bytes() if archive_path.exists() else None
            with self.assertRaisesRegex(RuntimeError,'날짜별 보존 기록'):self.run_stage('us_snapshot')
            self.assertEqual(path.read_bytes(),original);self.assertEqual(len(calls),1)
            self.assertEqual(archive_path.read_bytes() if archive_path.exists() else None,before)
            # Restore only this synthetic fixture for the next subcase.
            if archive_path.exists():archive_path.unlink()

    def test_wbd_reuse_checks_registered_identity_before_proof_read(self):
        for change in [lambda p:p.update(data_hash='sha256:'+'f'*64),lambda p:p.update(row_count=4),
                       lambda p:p.update(symbol_count=4)]:
            path,original,pointer,_,calls=self._snapshot_fixture()
            change(pointer)
            with self.assertRaisesRegex(RuntimeError,'source hash|source counts'):self.run_stage('us_snapshot')
            self.assertEqual(path.read_bytes(),original);self.assertEqual(len(calls),1)
        path,original,_,_,calls=self._snapshot_fixture(registered=False)
        with self.assertRaisesRegex(RuntimeError,'lifecycle exclusion'):self.run_stage('us_snapshot')
        self.assertEqual(path.read_bytes(),original);self.assertEqual(len(calls),1)

    def test_other_or_multiple_lifecycle_conflicts_remain_blocked_without_proof_read(self):
        for conflicts in [['KEEP'],['WBD','KEEP']]:
            path,original,_,_,calls=self._snapshot_fixture()
            self.ns['lifecycle_events']=[{**self.ns['lifecycle_events'][0],'symbol':s} for s in conflicts]
            with self.assertRaisesRegex(RuntimeError,'lifecycle exclusion'):self.run_stage('us_snapshot')
            self.assertEqual(path.read_bytes(),original);self.assertEqual(len(calls),1)

    def test_wbd_reuse_requires_known_effective_suspension(self):
        for change in [dict(effective_date='2026-10-08'),dict(effective_date='bad'),dict(status='ACTIVE')]:
            path,original,_,_,calls=self._snapshot_fixture()
            self.ns['lifecycle_events'][0].update(change)
            with self.assertRaisesRegex(RuntimeError,'lifecycle exclusion'):self.run_stage('us_snapshot')
            self.assertEqual(path.read_bytes(),original);self.assertEqual(len(calls),1)
        path,original,_,_,calls=self._snapshot_fixture(date='2026-10-05')
        with self.assertRaisesRegex(RuntimeError,'lifecycle exclusion'):self.run_stage('us_snapshot')
        self.assertEqual(path.read_bytes(),original);self.assertEqual(len(calls),1)

    def test_reviewed_wbd_does_not_hide_other_stock_or_benchmark_corrections(self):
        for symbol in ['KEEP','SPY']:
            path,original,_,_,calls=self._snapshot_fixture()
            self.ns['snap'].loc[self.ns['snap'].symbol.eq(symbol),'close']=11
            with self.assertRaisesRegex(RuntimeError,'Current same-session values differ'):self.run_stage('us_snapshot')
            self.assertFalse(self.ns['_US_SNAPSHOT_READY'])
            self.assertEqual(path.read_bytes(),original);self.assertEqual(len(calls),2)

    def test_no_conflict_and_new_date_use_no_review_get(self):
        path,original,_,_,calls=self._snapshot_fixture()
        self.ns['lifecycle_events']=[]
        self.ns['snap']=pd.read_csv(path)
        self.run_stage('us_snapshot')
        self.assertEqual(path.read_bytes(),original);self.assertEqual(len(calls),1)
        path,_,pointer,_,calls=self._snapshot_fixture(date='2026-10-08',frozen=False)
        pointer['as_of_date']='2026-10-07'
        self.run_stage('us_snapshot')
        self.assertEqual(len(calls),1)
        wbd=pd.read_csv(path).set_index('symbol').loc['WBD']
        self.assertEqual(wbd.status,'SUSPENDED');self.assertFalse(wbd.toss_tradable)
        self.assertTrue(pd.isna(wbd.close));self.assertFalse(wbd.active20)

    def test_reviewed_reuse_upload_preserves_original_archive_and_ingest(self):
        self._upload_fixture()
        path,original,pointer,_,calls=self._snapshot_fixture()
        archive=self.ns['_CT_US_ARCHIVE']
        ingest={**pointer,'user_id':'test-owner','collected_at':'2026-10-08T00:00:00+00:00',
                'metadata':{'confirmedRegularClose':True,'failedSymbols':0,'previousSessionDate':'2026-10-06',
                            'sourceCoverageComplete':True,'providerGapSymbols':[],'lifecycleExcludedSymbols':[]}}
        source=archive['freeze_us_atomic_archive'](raw=original,ingest=ingest,root=self.ns['DATED_ARCHIVE_DIR'],user_id='test-owner')
        before={p:p.read_bytes() for p in self.ns['DATED_ARCHIVE_DIR'].rglob('*') if p.is_file()}
        self.run_stage('us_snapshot')
        writes=[]
        def get(url,**kwargs):
            return types.SimpleNamespace(status_code=200,content=original,json=lambda:[pointer],raise_for_status=lambda:None)
        def post(url,**kwargs):
            writes.append((url,kwargs))
            return types.SimpleNamespace(status_code=409)
        self.ns['requests']=types.SimpleNamespace(get=get,post=post)
        self.ns['PREVIOUS_SESSION']='2026-10-06'
        self.run_stage('us_upload');self.run_stage('us_archive')
        self.assertTrue(self.ns['_US_UPLOAD_VERIFIED'])
        self.assertEqual(path.read_bytes(),original)
        self.assertEqual({p:p.read_bytes() for p in self.ns['DATED_ARCHIVE_DIR'].rglob('*') if p.is_file()},before)
        self.assertEqual(self.ns['_US_DAILY_ARCHIVE_SOURCE'],source)
        self.assertEqual(len(writes),1)
        self.assertIn('/storage/v1/object/cloudtrend-data/',writes[0][0])
        self.assertEqual(writes[0][1]['data'],original)
        self.assertEqual(writes[0][1]['headers']['x-upsert'],'false')

    def _collection_fixture(self, stale=None, extra=None, failures=None, no_cache=()):
        """Run the real collection/feature code using successful provider-response fixtures."""
        stale=dict({'DBRG':'2026-09-29'} if stale is None else stale)
        symbols=list(dict.fromkeys(['SPY','GOOD',*stale,*(extra or []),*no_cache]))
        histories={}
        for symbol in symbols:
            end=stale.get(symbol,'2026-10-09')
            histories[symbol]=[{'symbol':symbol,'date':day,'open':100+i/10,'high':101+i/10,
                'low':99+i/10,'close':100+i/10,'volume':1000000+i,'currency':'USD'}
                for i,day in enumerate(pd.bdate_range(end=end,periods=400).strftime('%Y-%m-%d'))]
        prior=[]
        for symbol,rows in histories.items():
            if symbol not in no_cache:
                prior.extend(rows if symbol in stale else rows[:-1])
        pd.DataFrame(prior).to_parquet(self.ns['CACHE_PATH'],index=False)
        seed=pd.DataFrame({'ticker':symbols})
        seed_path=self.ns['BASE_DIR']/'test_seed.csv';seed.to_csv(seed_path,index=False)
        master=pd.DataFrame([{'symbol':symbol,'name':symbol,'englishName':symbol,'market':'NASDAQ',
            'securityType':'ETF' if symbol=='SPY' else 'STOCK','status':'ACTIVE','currency':'USD',
            'sharesOutstanding':1000,'isCommonShare':symbol!='SPY','sector':'TEST'} for symbol in symbols])
        calendar={'result':{
            'currentBusinessDay':{'date':'2026-10-09','regularMarket':{'endTime':'2026-10-09T20:00:00Z'}},
            'previousBusinessDay':{'date':'2026-10-08','regularMarket':{'endTime':'2026-10-08T20:00:00Z'}}}}
        calls=[]
        def get(path,params=None,chart=False):
            if path=='/api/v1/market-calendar/US':return calendar,{}
            self.assertEqual(path,'/api/v1/candles')
            symbol=params['symbol'];calls.append(symbol)
            self.ns['_chart_request_count']+=1
            failure=(failures or {}).get(symbol)
            if isinstance(failure,Exception):raise failure
            if failure is not None:return failure,{}
            rows=histories[symbol][-params['count']:]
            return {'result':{'candles':rows}},{}
        self.ns.update(seed=seed,seed_path=seed_path,master=master,candidate_quarantine={},
            VERIFIED_LIFECYCLE_EVENTS=[],toss_get=get,_chart_request_count=0,
            time=types.SimpleNamespace(monotonic=time.monotonic,sleep=lambda _:None),math=math,
            datetime=datetime,timezone=timezone,ThreadPoolExecutor=ThreadPoolExecutor,as_completed=as_completed,
            tqdm=lambda sequence,**kwargs:sequence,truthy=lambda value:str(value).lower()=='true')
        self.ns['_US_STAGE_RUN']['master']=self.ns['_US_RUN_ID']
        return histories,calls

    def test_long_gap_is_recorded_without_fabricating_price_and_healthy_upload_continues(self):
        histories,calls=self._collection_fixture(stale={'DBRG':'2026-09-29','SHORT':'2026-10-08'})
        original_stale=pd.read_parquet(self.ns['CACHE_PATH']).query("symbol == 'DBRG'").reset_index(drop=True)
        self.run_stage('us_collection')
        self.assertEqual(self.ns['provider_gap_symbols'],{'DBRG','SHORT'})
        self.assertEqual(self.ns['unhandled_failures'],[])
        reason=self.ns['provider_gap_reasons']['DBRG']
        self.assertEqual(reason['reason'],'latest_price_unconfirmed')
        self.assertEqual(reason['latestBarDate'],'2026-09-29')
        self.assertEqual(reason['gapCalendarDays'],10)
        self.assertEqual(reason['classification'],'UNCONFIRMED_PRICE')
        self.assertEqual(calls.count('DBRG'),2)
        cached=pd.read_parquet(self.ns['CACHE_PATH'])
        pd.testing.assert_frame_equal(cached.query("symbol == 'DBRG'").reset_index(drop=True),original_stale)
        self.assertEqual(cached.query("symbol == 'GOOD'").date.max(),'2026-10-09')
        evidence=list((self.ns['BASE_DIR']/'dated_collection_evidence_v1').glob('*/*/collection.json'))
        self.assertEqual(len(evidence),1)
        self.assertEqual(json.loads(evidence[0].read_text())['diagnostics']['providerGapCount'],2)
        self.run_stage('us_features')
        self.assertEqual(self.ns['lifecycle_events'],[])
        self.ns['_US_STAGE_RUN']['diagnostics']=self.ns['_US_RUN_ID']
        posted=[];storage={};pointer=[]
        def get(url,**kwargs):
            if '/rest/v1/us_screening_ingest' in url:
                return types.SimpleNamespace(json=lambda:pointer,raise_for_status=lambda:None)
            return types.SimpleNamespace(content=next(iter(storage.values())),raise_for_status=lambda:None)
        def post(url,**kwargs):
            posted.append((url,kwargs))
            if '/storage/v1/object/' in url:storage[url]=kwargs['data']
            else:pointer[:]=[kwargs['json']]
            return types.SimpleNamespace(status_code=200)
        self.ns.update(requests=types.SimpleNamespace(get=get,post=post),
            COLLECTION_UNIVERSE=self.ns['seed_path'],collection_universe_hash='test-hash',
            market_calendar={'ok':True},exchange_rate={'ok':False},ranking_amount={'ok':False})
        self.run_stage('us_snapshot');self.run_stage('us_upload')
        out=self.ns['out'].set_index('symbol')
        self.assertTrue(out.loc['GOOD','close']>0)
        self.assertTrue(pd.isna(out.loc['DBRG','close']))
        self.assertFalse(out.loc['DBRG','toss_tradable'])
        self.assertFalse(out.loc['DBRG','active20'])
        self.assertEqual(out.loc['DBRG','status'],'ACTIVE')  # no invented lifecycle
        self.assertTrue(self.ns['_US_UPLOAD_VERIFIED'])
        meta=self.ns['payload']['metadata']
        self.assertFalse(meta['sourceCoverageComplete'])
        self.assertEqual(meta['providerGapReasons']['DBRG']['gapCalendarDays'],10)
        self.assertEqual(meta['failedSymbols'],0)
        self.assertEqual(len(posted),2)
        self.run_stage('us_archive')
        dispatched=[]
        api=types.SimpleNamespace(token='test-only',common_base=lambda:'2026-10-07',
                                  dispatch=lambda inputs:dispatched.append(inputs) or 204)
        self.ns['_CT_US_ARCHIVE']['UsArchiveApi']=lambda *args:api
        self.run_stage('us_dispatch')
        self.assertEqual(self.ns['_US_DISPATCH_STATUS'],'BLOCKED_REPLAY_PREFLIGHT')
        self.assertEqual(dispatched,[])  # missing 10/08 evidence is never bypassed
        api.common_base=lambda:'2026-10-08'
        self.run_stage('us_dispatch')
        self.assertEqual(self.ns['_US_DISPATCH_STATUS'],'REQUEST_ACCEPTED')
        self.assertEqual(len(dispatched),1)
        self.run_stage('us_dispatch')
        self.assertEqual(self.ns['_US_DISPATCH_STATUS'],'REQUEST_ALREADY_RECORDED')
        self.assertEqual(len(dispatched),1)

    def test_history_length_hold_retains_current_prices_with_null_scores(self):
        histories,calls=self._collection_fixture(extra=['VJET','WQEY'])
        for symbol in ('VJET','WQEY'):
            histories[symbol]=histories[symbol][-5:]
        self.ns['seed']['history_start_date']=None
        self.ns['seed'].loc[self.ns['seed'].ticker.isin(['VJET','WQEY']),'history_start_date']='2026-10-05'
        self.run_stage('us_collection');self.run_stage('us_features')
        snap=self.ns['snap'].set_index('symbol')
        self.assertEqual(set(self.ns['candidate_scoring_holds']),{'VJET','WQEY'})
        for symbol in ('VJET','WQEY'):
            self.assertEqual(snap.loc[symbol,'date'],'2026-10-09')
            self.assertGreater(snap.loc[symbol,'open'],0)
            self.assertGreater(snap.loc[symbol,'close'],0)
            self.assertTrue(pd.isna(snap.loc[symbol,'ret120']))
            self.assertTrue(pd.isna(snap.loc[symbol,'ret252']))
            self.assertFalse(snap.loc[symbol,'active20'])
            self.assertEqual(snap.loc[symbol,'status'],'ACTIVE')

    def test_short_and_long_quarantine_share_existing_ten_symbol_cap(self):
        for count in (10,11):
            with self.subTest(count=count):
                self._collection_fixture(stale={f'GAP{i}':'2026-09-01' for i in range(count)})
                if count==10:
                    self.run_stage('us_collection')
                    self.assertEqual(len(self.ns['provider_gap_symbols']),10)
                else:
                    with self.assertRaisesRegex(RuntimeError,'11 symbols failed'):self.run_stage('us_collection')
                    self.assertTrue(self.ns['diagnostics']['providerGapLimitExceeded'])
                    self.assertEqual(self.ns['provider_gap_symbols'],set())
                    self.assertNotIn('collection',self.ns['_US_STAGE_RUN'])
                    with self.assertRaises(RuntimeError):self.run_stage('us_features')

    def test_stale_spy_always_stops(self):
        self._collection_fixture(stale={'SPY':'2026-09-29'})
        with self.assertRaisesRegex(RuntimeError,'SPY'):self.run_stage('us_collection')
        self.assertEqual(self.ns['provider_gap_symbols'],set())
        self.assertNotIn('collection',self.ns['_US_STAGE_RUN'])

    def test_auth_network_and_malformed_errors_cannot_be_quarantined_even_for_candidate(self):
        for failure in (RuntimeError('401 Unauthorized'),RuntimeError('403 Forbidden'),
                        StubTimeout('network timeout'),RuntimeError('latest candle injected error'),
                        {'result':{'error':'invalid-token'}},
                        {'result':{'candles':[],'error':'Unauthorized'}},
                        {'result':{'candles':[{'close':100}]}},
                        {'result':{'candles':[{'date':'2026-10-08','close':'changed-schema'}]}},
                        {'success':False,'result':{'candles':[]}},
                        {'result':{'candles':[{'date':'2026-99-99','close':100}]}}):
            with self.subTest(failure=str(failure)):
                self._collection_fixture(failures={'DBRG':failure})
                self.ns['seed']['history_start_date']='2026-01-01'
                with self.assertRaisesRegex(RuntimeError,'DBRG'):self.run_stage('us_collection')
                self.assertEqual(self.ns['provider_gap_symbols'],set())
                self.assertNotIn('collection',self.ns['_US_STAGE_RUN'])
                self.assertFalse(self.ns['_US_UPLOAD_VERIFIED'])

    def test_missing_cached_evidence_still_stops_before_upload(self):
        for response in ({'result':{'candles':[]}},
                         {'result':{'candles':[{'date':'2026-09-29','close':100}]}}):
            with self.subTest(response=response):
                self._collection_fixture(stale={},no_cache=['NEW'],failures={'NEW':response})
                with self.assertRaisesRegex(RuntimeError,'NEW'):self.run_stage('us_collection')
                self.assertEqual(self.ns['provider_gap_symbols'],set())
                self.assertEqual(self.ns['unhandled_failures'][0][0],'NEW')
                self.assertNotIn('collection',self.ns['_US_STAGE_RUN'])
                self.assertFalse(self.ns['_US_UPLOAD_VERIFIED'])

    def test_provider_and_cached_latest_dates_remain_distinct(self):
        histories,calls=self._collection_fixture()
        frame=pd.read_parquet(self.ns['CACHE_PATH'])
        extra={**histories['DBRG'][-1],'date':'2026-09-30','volume':0}
        pd.concat([frame,pd.DataFrame([extra])],ignore_index=True).to_parquet(self.ns['CACHE_PATH'],index=False)
        self.run_stage('us_collection')
        reason=self.ns['provider_gap_reasons']['DBRG']
        self.assertEqual(reason['providerLatestBarDate'],'2026-09-29')
        self.assertEqual(reason['cachedLatestBarDate'],'2026-09-30')
        self.assertEqual(reason['latestBarDate'],'2026-09-30')
        self.assertEqual(reason['gapCalendarDays'],9)

    def test_current_incremental_with_failed_adjusted_refresh_is_hard_qa_failure(self):
        for response in ({'result':{'candles':[]}},
                         {'result':{'candles':[{'date':'2026-09-29','close':100}]}}):
            with self.subTest(response=response):
                self._collection_fixture(stale={},extra=['DBRG'])
                original_get=self.ns['toss_get']
                def get(path,params=None,chart=False):
                    if path=='/api/v1/candles' and params['symbol']=='DBRG':
                        if params['count']>15:return response,{}
                        body,headers=original_get(path,params,chart)
                        rows=[dict(row) for row in body['result']['candles']]
                        rows[-2]['close']*=1.1
                        return {'result':{'candles':rows}},headers
                    return original_get(path,params,chart)
                self.ns['toss_get']=get
                with self.assertRaisesRegex(RuntimeError,'history QA failed'):self.run_stage('us_collection')
                self.assertEqual(self.ns['provider_gap_symbols'],set())
                self.assertNotIn('collection',self.ns['_US_STAGE_RUN'])

    def test_recovered_symbol_leaves_quarantine_on_next_confirmed_run(self):
        histories,calls=self._collection_fixture()
        self.run_stage('us_collection')
        self.assertIn('DBRG',self.ns['provider_gap_symbols'])
        last=histories['DBRG'][-1]
        histories['DBRG'].append({**last,'date':'2026-10-09','close':last['close']+1})
        self.run_stage('us_collection')
        self.assertEqual(self.ns['provider_gap_symbols'],set())
        self.assertEqual(self.ns['combined'].query("symbol == 'DBRG'").date.max(),'2026-10-09')
        self.assertEqual(len(list((self.ns['BASE_DIR']/'dated_collection_evidence_v1').glob('*/*/collection.json'))),2)

    def test_stale_checkpoint_preserved_and_current_cache_reused_on_rerun(self):
        histories,calls=self._collection_fixture()
        checkpoint=self.ns['BASE_DIR']/'checkpoints/2026-10-09/DBRG.json'
        checkpoint.parent.mkdir(parents=True)
        raw=json.dumps({'asOfDate':'2026-10-09','rows':histories['DBRG'][-15:]}).encode()
        checkpoint.write_bytes(raw)
        self.run_stage('us_collection')
        preserved=checkpoint.parent/'rejected/DBRG'/(hashlib.sha256(raw).hexdigest()+'.json')
        self.assertEqual(preserved.read_bytes(),raw)
        self.assertFalse(checkpoint.exists())
        self.assertEqual(self.ns['stale_checkpoint_rejected_count'],1)
        calls.clear();self.run_stage('us_collection')
        self.assertEqual(set(calls),{'DBRG'})
        self.assertEqual(self.ns['mode_counts']['cache_current'],2)
        self.assertEqual(preserved.read_bytes(),raw)

    def test_release_manifest_matches_runtime_sources(self):
        manifest=json.loads((ROOT/'runtime/manifest.json').read_text())
        self.assertEqual(manifest['version'],rt.RUNTIME_VERSION)
        for record in manifest['files']:
            raw=(ROOT/'runtime'/record['path']).read_bytes()
            self.assertEqual(record['sha256'],hashlib.sha256(raw).hexdigest(),record['path'])
            self.assertEqual(record['bytes'],len(raw))

    def test_release_zip_matches_runtime_source_exactly(self):
        expected={str(p.relative_to(ROOT/'runtime')):p.read_bytes()
                  for p in (ROOT/'runtime').rglob('*.py')}
        prefix='cloudtrend_lite_r3_runtime/'
        with zipfile.ZipFile(ROOT/'runtime.zip') as archive:
            self.assertEqual(set(archive.namelist()),{prefix+name for name in expected})
            for name,raw in expected.items():self.assertEqual(archive.read(prefix+name),raw,name)

    def test_real_zip_import_and_stage_resource_read(self):
        package='r3_daily_zip_test'
        archive=self.base/'runtime.zip'
        with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
            for p in (ROOT/'runtime').rglob('*'):
                if p.is_file():z.write(p,package+'/'+str(p.relative_to(ROOT/'runtime')))
        sys.path.insert(0,str(archive))
        try:
            module=importlib.import_module(package)
            ns={'RUN_PLAN':'US_ONLY','RUN_US_EVENING':False}
            with redirect_stdout(io.StringIO()):module.run_stage('plan_init',ns)
            self.assertTrue(ns['RUN_US_MARKET'])
            self.assertTrue(callable(module.run_stage))
            self.assertIn('us_collection',module.STAGES)
        finally:
            sys.path.remove(str(archive));sys.modules.pop(package,None)


if __name__=='__main__':unittest.main(verbosity=2)
