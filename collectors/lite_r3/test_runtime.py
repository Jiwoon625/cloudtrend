"""Bounded daily-runtime regression checks. No external calls or publication."""
from contextlib import redirect_stdout
from datetime import datetime
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
