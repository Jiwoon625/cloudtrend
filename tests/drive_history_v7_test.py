import hashlib, importlib.util, io, json, os, sys, tempfile, unittest, urllib.error, zipfile
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'collectors'/'drive_history_v7'))
import history as h
from collector import incremental_plan,review_adjusted_corrections,run_lock,collect,MIN_ADJUSTED_REFRESH
spec=importlib.util.spec_from_file_location('v7transfer',ROOT/'scripts'/'drive-history-transfer.py');transport=importlib.util.module_from_spec(spec);spec.loader.exec_module(transport)

class FakeDrive:
    def __init__(self,objects):self.objects=objects
    def download(self,key):return self.objects[key]

class Contracts(unittest.TestCase):
    def test_adjusted_refresh_windows_the_full_indicator_span(self):
        sessions=[f'2026-{m:02d}-{d:02d}' for m in range(1,7) for d in range(1,29)][:130]
        plans={p['symbol']:p for p in incremental_plan(
            {'000001':set(sessions),'000002':set(sessions)},['000001','000002'],sessions,
            overlap=1,refresh_symbols=['000002'],refresh_overlap=MIN_ADJUSTED_REFRESH)}
        self.assertEqual(plans['000001']['providerSessions'],1);self.assertFalse(plans['000001']['adjustedRefresh'])
        self.assertEqual(plans['000002']['providerSessions'],MIN_ADJUSTED_REFRESH);self.assertTrue(plans['000002']['adjustedRefresh'])
        self.assertEqual(plans['000002']['start'],sessions[-MIN_ADJUSTED_REFRESH])
        with self.assertRaisesRegex(ValueError,'window must exceed'):
            incremental_plan({'000001':set(sessions)},['000001'],sessions,overlap=5,
                             refresh_symbols=['000001'],refresh_overlap=5)
        with self.assertRaisesRegex(ValueError,'configured universe'):
            incremental_plan({'000001':set(sessions)},['000001'],sessions,overlap=5,
                             refresh_symbols=['999999'])
        with self.assertRaisesRegex(ValueError,'Duplicate'):
            incremental_plan({'000001':set(sessions)},['000001'],sessions,overlap=5,
                             refresh_symbols=['000001','000001'])

    def test_restatement_leaves_quarantine_only_when_covered(self):
        sessions=[f'2026-{m:02d}-{d:02d}' for m in range(1,7) for d in range(1,29)][:130]
        plans=incremental_plan({'000001':set(sessions),'000002':set(sessions)},['000001','000002'],sessions,
                               overlap=1,refresh_symbols=['000002'],refresh_overlap=MIN_ADJUSTED_REFRESH)
        pair={'symbol':'000002','date':sessions[-3],'field':'close','before':'100','after':'50','provider':'TOSS_ADJUSTED_CANDLE'}
        accepted=review_adjusted_corrections([pair],plans)
        self.assertTrue(accepted['accepted']);self.assertEqual(accepted['detectedCount'],1)
        self.assertEqual(accepted['windowSessions'],MIN_ADJUSTED_REFRESH)
        unscoped=review_adjusted_corrections([{**pair,'symbol':'000001'}],plans)
        self.assertFalse(unscoped['accepted']);self.assertEqual(unscoped['rejected'][0]['reason'],'NO_ADJUSTED_REFRESH_WINDOW')
        unproven=review_adjusted_corrections([{**pair,'provider':'TOSS_RAW_CANDLE'}],plans)
        self.assertFalse(unproven['accepted']);self.assertEqual(unproven['reason'],'UNCOVERED_PRICE_RESTATEMENT')
        outside=review_adjusted_corrections([{**pair,'date':sessions[-MIN_ADJUSTED_REFRESH-1]}],plans)
        self.assertFalse(outside['accepted']);self.assertEqual(outside['rejected'][0]['reason'],'RESTATEMENT_OUTSIDE_REFRESH_WINDOW')
        short=review_adjusted_corrections([pair],incremental_plan(
            {'000002':set(sessions)},['000002'],sessions,overlap=1,refresh_symbols=['000002'],refresh_overlap=60))
        self.assertFalse(short['accepted']);self.assertEqual(short['rejected'][0]['reason'],'REFRESH_WINDOW_TOO_SHORT')
        self.assertFalse(review_adjusted_corrections([],plans)['accepted'])

    def test_gaps_are_not_recent_three_calendar_days(self):
        sessions=['2026-11-02','2026-11-03','2026-11-04','2026-11-05','2026-11-06']
        p=incremental_plan({'000001':{'2026-11-02','2026-11-05'}},['000001'],sessions,overlap=1)[0]
        self.assertEqual(p['missingSessions'],['2026-11-03','2026-11-04','2026-11-06']);self.assertEqual(p['start'],'2026-11-03')
    def test_new_unreviewed_symbol_is_not_automatically_included(self):
        with self.assertRaisesRegex(ValueError,'bootstrap'):incremental_plan({},['000001'],['2026-11-06'])
    def test_run_lock_and_release_on_interruption(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(InterruptedError):
                with run_lock(d):
                    with self.assertRaises(RuntimeError):
                        with run_lock(d):pass
                    raise InterruptedError()
            with run_lock(d):pass
    def test_path_traversal(self):
        for p in ['../x','/x','objects/../../x','objects\\x','objects//x']:
            with self.assertRaises(ValueError):h.safe_member(p)
    def test_hash_mismatch(self):
        with self.assertRaises(ValueError):h.checked(b'data',{'bytes':4,'sha256':'0'*64})
    def test_private_drive_requires_refresh_credentials(self):
        with patch.dict(os.environ,{'GOOGLE_DRIVE_CREDENTIALS_JSON':'{}'},clear=True):
            with self.assertRaises(ValueError):h.Drive()
    def test_expired_access_token_is_refreshed_once(self):
        d=h.Drive({'type':'authorized_user'});d.token='expired';d.until=float('inf')
        class Response(io.BytesIO):
            def __enter__(self):return self
            def __exit__(self,*args):self.close()
        def refresh():d.token='new';d.until=float('inf')
        with patch.object(d,'refresh',side_effect=refresh) as refreshed,patch('urllib.request.urlopen',side_effect=[urllib.error.HTTPError('url',401,'expired',{},None),Response(b'ok')]):
            self.assertEqual(d.download('abcdefghijk'),b'ok');self.assertEqual(refreshed.call_count,1)
    def test_incomplete_run_does_not_prepare_inputs(self):
        raw=json.dumps({'version':'drive-history-collector-v7.0-preview','complete':False}).encode()
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError,'incomplete'):transport.prepare_run(FakeDrive({'m':raw}),'m',h.sha(raw),tmp)
    def delta_manifest(self,names):
        b=io.BytesIO();raw=b'symbol,date,close\n000001,2026-11-06,10\n'
        with zipfile.ZipFile(b,'w') as z:
            for name in names:z.writestr(name,raw)
        m={'version':'drive-history-collector-v7.0-preview','complete':True,'history_backend':'drive','baselineSha256':h.BASELINE_SHA,'parentManifestSha256':h.BASELINE_SHA,'missingSymbols':[],'missingIndexSymbols':[],'missingSymbolCount':0,'correctionCount':0,
           'files':[{'name':'delta.zip','bytes':len(b.getvalue()),'sha256':h.sha(b.getvalue()),'fileId':'z'}],
           'deltaMembers':[{'name':n,'bytes':len(raw),'sha256':h.sha(raw)} for n in names]}
        return json.dumps(m).encode(),b.getvalue()
    def test_duplicate_package_member(self):
        raw,z=self.delta_manifest(['a.csv','a.csv'])
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):transport.prepare_run(FakeDrive({'m':raw,'z':z}),'m',h.sha(raw),tmp)
    def test_missing_package(self):
        raw,z=self.delta_manifest(['a.csv'])
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(KeyError):transport.prepare_run(FakeDrive({'m':raw}),'m',h.sha(raw),tmp)
    def test_delta_prepare_rechecks_hash_on_every_resume(self):
        raw,z=self.delta_manifest(['a.csv'])
        with tempfile.TemporaryDirectory() as tmp:
            drive=FakeDrive({'m':raw,'z':z});transport.prepare_run(drive,'m',h.sha(raw),tmp)
            transport.prepare_run(drive,'m',h.sha(raw),tmp)
            drive.objects['z']=z+b'changed'
            with self.assertRaises(ValueError):transport.prepare_run(drive,'m',h.sha(raw),tmp)

if __name__=='__main__':unittest.main()

class CollectorFlow(unittest.TestCase):
    def test_normal_restart_interruption_missing_date_price_and_publication_lag(self):
        import pandas as pd
        import provider as p
        from contextlib import ExitStack
        sessions=['2026-11-04','2026-11-05','2026-11-06'];calls=[];mode={'value':'interrupt'}
        def price(symbol,dates):
            return pd.DataFrame([{'symbol':symbol,'name':symbol,'market':'KOSPI','securityType':'STOCK','date':d,'open':10,'high':10,'low':10,'close':10,'volume':100,'marketCap':1000} for d in dates])
        def candles(symbol,count,is_index=False):return price(symbol,sessions)
        def build(symbol):
            calls.append(symbol)
            if symbol=='000002' and mode['value']=='interrupt':raise KeyboardInterrupt()
            dates=sessions if mode['value']!='date-gap' else [sessions[0],sessions[-1]]
            f=price(symbol,dates)
            if mode['value']=='price-missing' and symbol=='000002':f=f[f.date!=sessions[-1]]
            return f
        def official(market,day):
            empty=mode['value']=='pending' and day==sessions[-1]
            p._OFFICIAL_QA.append({'date':day,'market':market,'rawRows':0 if empty else 2,'usableRows':0 if empty else 2,'status':'empty_unconfirmed' if empty else 'received'})
            return pd.DataFrame() if empty else pd.DataFrame([{'close':10}])
        with tempfile.TemporaryDirectory() as temp,ExitStack() as stack:
            root=Path(temp); baseline=root/'baseline';baseline.mkdir()
            old=price('000001',sessions[:1]);old=pd.concat([old,price('000002',sessions[:1])]);old.to_csv(baseline/'old.csv',index=False)
            previous={'requestedSymbols':['000001','000002']}
            manifest={'sources':[{'member':'old.csv','sha256':'0'*64,'sourceRecord':{'validation_result':{'krPublication':{'manifestText':json.dumps(previous)}}}}]}
            for key,value in {'TossClient':lambda:object(),'validate_toss_openapi':lambda strict:None,'get_candles_frame':candles,'build_symbol_frame':build,
                'official_day':official,'official_symbol_frame':lambda *a:pd.DataFrame(), '_completion_quality':lambda *a:{'ok':True},
                'get_market_investor_flow_frame':lambda *a:pd.DataFrame()}.items():stack.enter_context(patch.object(p,key,value))
            stack.enter_context(patch.dict(os.environ,{'TOSS_CLIENT_ID':'test','TOSS_CLIENT_SECRET':'test'}))
            with self.assertRaises(KeyboardInterrupt):collect(baseline,manifest,root,cutoff=sessions[-1],run_id='resume001')
            self.assertTrue((root/'runs'/'resume001'/'checkpoints'/'000001.csv').exists())
            mode['value']='ok';p._OFFICIAL_QA=[]
            done=collect(baseline,manifest,root,cutoff=sessions[-1],run_id='resume001');self.assertTrue(done['complete'])
            self.assertEqual(calls.count('000001'),1)
            before=len(calls);self.assertEqual(collect(baseline,manifest,root,cutoff=sessions[-1],run_id='resume001'),done);self.assertEqual(len(calls),before)
            mode['value']='date-gap';p._OFFICIAL_QA=[]
            broken=collect(baseline,manifest,root,cutoff=sessions[-1],run_id='dategap01');self.assertFalse(broken['complete']);self.assertEqual(broken['missingSymbolCount'],2)
            mode['value']='price-missing';p._OFFICIAL_QA=[]
            excluded=collect(baseline,manifest,root,cutoff=sessions[-1],run_id='missing01');self.assertTrue(excluded['complete']);self.assertEqual(excluded['requestedSymbols'],['000001']);self.assertEqual(excluded['missingPriceExcludedSymbols'][0]['symbol'],'000002')
            mode['value']='pending';p._OFFICIAL_QA=[]
            pending=collect(baseline,manifest,root,cutoff=sessions[-1],run_id='pending01');self.assertEqual(pending['krxPublicationEvidence']['phase'],'PRELIMINARY')
