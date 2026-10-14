import importlib.util
import json
import multiprocessing
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('cloudtrend_lite_resume_v1', ROOT/'runtime/__init__.py', submodule_search_locations=[str(ROOT/'runtime')])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
from cloudtrend_lite_resume_v1.state import RunState, RunLock, canonical, digest
from cloudtrend_lite_resume_v1.planning import plan_market, common_allocation_dates, classify_us_input
from cloudtrend_lite_resume_v1.kr import enrich_dates


def locked(root, pipe):
    try:
        with RunLock(root):
            pipe.send('acquired')
    except RuntimeError:
        pipe.send('blocked')


class StateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = RunState(self.tmp.name, 'run1', {'runtime': 'r1', 'config': 'a'}, started_at='2026-10-14T01:00:00+00:00')

    def test_new_process_restores_same_clock_and_only_complete_stage(self):
        self.state.save_json('prices', {'source': 'v1'}, {'symbol': 'A', 'close': 5})
        resumed = RunState(self.tmp.name, 'run1', {'runtime': 'r1', 'config': 'a'})
        self.assertEqual(resumed.plan, self.state.plan)
        self.assertEqual(resumed.load_json('prices', {'source': 'v1'}), {'symbol': 'A', 'close': 5})
        self.assertIsNone(resumed.load_json('snapshot', {}))

    def test_configuration_and_runtime_mismatch_refused(self):
        for identity in [{'runtime': 'r2', 'config': 'a'}, {'runtime': 'r1', 'config': 'b'}]:
            with self.assertRaisesRegex(RuntimeError, 'changed'):
                RunState(self.tmp.name, 'run1', identity)

    def test_corrupt_plan_or_output_refused(self):
        self.state.save_json('prices', {}, {'close': 5})
        saved = self.state.load('prices', {})
        (self.state.root/'blobs'/saved['artifacts']['payload'][7:]).write_bytes(b'corrupt')
        with self.assertRaisesRegex(RuntimeError, 'corrupted'):
            self.state.load_json('prices', {})
        p = self.state.root/'plan.json'
        body = json.loads(p.read_text()); body['startedAt'] = '2030-01-01'
        p.write_text(json.dumps(body))
        with self.assertRaisesRegex(RuntimeError, 'Corrupt run plan'):
            RunState(self.tmp.name, 'run1', {'runtime': 'r1', 'config': 'a'})

    def test_revision_invalidates_only_dependent_stage_and_preserves_original(self):
        self.state.save_json('price', {'revision': 1}, {'close': 10})
        self.state.save_json('roster', {'roster': 1}, {'name': 'A'})
        before = set((self.state.root/'blobs').iterdir())
        self.assertIsNone(self.state.load_json('price', {'revision': 2}))
        self.assertEqual(self.state.load_json('roster', {'roster': 1}), {'name': 'A'})
        self.state.save_json('price', {'revision': 2}, {'close': 11})
        self.assertTrue(all(p.exists() for p in before))

    def test_artifact_saved_before_stage_commit_is_not_completed(self):
        self.state.put_blob(b'uncommitted batch')
        self.assertIsNone(self.state.load('batch', {}))
        self.state.save_json('batch', {}, [1,2])
        self.state.save_json('batch', {}, [1,2])
        self.assertEqual(self.state.load_json('batch', {}), [1,2])

    def test_uncertain_request_is_not_complete(self):
        self.state.save('dispatch', {}, {}, status='REQUEST_UNCERTAIN')
        self.assertIsNone(self.state.load_json('dispatch', {}))
        self.assertEqual(self.state.load('dispatch', {})['status'], 'REQUEST_UNCERTAIN')

    def test_concurrent_process_blocked_and_lock_released(self):
        parent, child = multiprocessing.Pipe()
        with RunLock(self.tmp.name):
            p = multiprocessing.Process(target=locked, args=(self.tmp.name, child)); p.start()
            self.assertEqual(parent.recv(), 'blocked'); p.join(5)
        with RunLock(self.tmp.name):
            pass

    def test_frozen_target_survives_midnight(self):
        a = self.state.freeze('dates', ['2026-10-13'])
        self.assertEqual(self.state.freeze('dates', ['2026-10-14']), a)


class PlannerTests(unittest.TestCase):
    def plan(self, **kwargs):
        days = ['2026-10-12', '2026-10-13', '2026-10-14']
        args = dict(market='US', now='2026-10-15T01:00:00Z',
            sessions=[{'date': d, 'confirmedAt': d+'T20:30:00Z'} for d in days],
            coverage_start='2026-10-12', coverage_end='2026-10-15', calendar_source='fixture-exchange',
            collected_through='2026-10-14', model_through={'A0': '2026-10-12', 'A2': '2026-10-12'},
            inputs={d: dict(asOfDate=d,kind='ATOMIC_DATED_SNAPSHOT',dataHash=digest(d.encode()),rosterHash=digest(b'roster'),validated=True) for d in days})
        args.update(kwargs)
        return plan_market(**args)

    def test_contiguous_fixed_input_batch_equals_daily_sequence(self):
        batch = self.plan()['batches']
        daily = [self.plan(now=d+'T21:00:00Z', model_through={'A0': prev})['batches']
                 for prev,d in [('2026-10-12','2026-10-13'),('2026-10-13','2026-10-14')]]
        self.assertEqual([d for b in batch for d in b], [d for p in daily for b in p for d in b])
        # This is order/coverage parity only; financial parity uses official TS engines.

    def test_missing_middle_blocks_later_ready_date(self):
        data = {'2026-10-14':dict(asOfDate='2026-10-14',kind='ATOMIC_DATED_SNAPSHOT',dataHash='x',rosterHash='y',validated=True)}
        p = self.plan(inputs=data)
        self.assertEqual([r['status'] for r in p['rows']], ['WAITING_INPUT','WAITING_PREDECESSOR'])
        self.assertEqual(p['batches'], [])

    def test_intraday_not_yet_closed_excluded(self):
        self.assertEqual(self.plan(now='2026-10-14T19:59:00Z')['targetDate'], '2026-10-13')

    def test_market_holiday_comes_from_calendar_not_weekdays(self):
        sessions = [{'date':'2026-10-12','confirmedAt':'2026-10-12T20:30:00Z'},
                    {'date':'2026-10-14','confirmedAt':'2026-10-14T20:30:00Z'}]
        self.assertEqual(self.plan(sessions=sessions)['batches'], [['2026-10-14']])

    def test_dst_uses_explicit_offset_and_close_time(self):
        sessions = [{'date':'2026-10-12','confirmedAt':'2026-10-12T16:30:00-04:00'},
                    {'date':'2026-11-02','confirmedAt':'2026-11-02T16:30:00-05:00'}]
        self.assertEqual(self.plan(now='2026-11-02T21:00:00Z',coverage_end='2026-11-02', sessions=sessions)['targetDate'],'2026-10-12')

    def test_separate_model_watermarks(self):
        p=self.plan(model_through={'A0':'2026-10-13','A2':'2026-10-12'})
        self.assertEqual(p['rows'][0]['models'], ['A2'])

    def test_current_roster_cannot_restore_past(self):
        with self.assertRaises(ValueError):
            classify_us_input(None, dict(kind='CURRENT_ROSTER',validated=True))
        self.assertFalse(classify_us_input(None,None)['validated'])

    def test_corrupt_atomic_not_silently_replaced(self):
        with self.assertRaises(ValueError):
            classify_us_input({'validated':False},dict(kind='DATED_ROSTER_RECONSTRUCTION',validated=True,reconstructionProofHash='h'))

    def test_reconstruction_requires_separate_evidence(self):
        reconstruction=dict(kind='DATED_ROSTER_RECONSTRUCTION',validated=True,reconstructionProofHash='h')
        self.assertEqual(classify_us_input(None,reconstruction), reconstruction)
        del reconstruction['reconstructionProofHash']
        with self.assertRaises(ValueError): classify_us_input(None,reconstruction)

    def test_allocation_waits_for_required_market_not_calendar_day(self):
        needs={'2026-10-13': {'KR':'2026-10-13','US':'2026-10-12'},
               '2026-10-14': {'KR':'2026-10-14','US':'2026-10-13'}}
        self.assertEqual(common_allocation_dates(needs,{'KR':{'2026-10-13','2026-10-14'},'US':{'2026-10-12'}}),['2026-10-13'])

    def test_calendar_coverage_missing_refused(self):
        with self.assertRaises(ValueError): self.plan(coverage_start='2026-10-13')


class KrTests(unittest.TestCase):
    def test_each_date_uses_own_cap_no_current_share_copy_and_one_request_per_market(self):
        import pandas as pd
        frame=pd.DataFrame([dict(symbol='000001',date=d,securityType='STOCK',market='KOSPI',close=10)
                            for d in ('2026-10-12','2026-10-13')])
        calls=[]
        def fetch(day,market):
            calls.append((day,market))
            return pd.DataFrame([dict(symbol='000001',date=day,krxLatestMarketCap=100 if day.endswith('12') else 200,krxLatestListedShares=10 if day.endswith('12') else 20)])
        out=enrich_dates(frame,['2026-10-12','2026-10-13'],{'get_krx_market_cap_market_day':fetch})
        self.assertEqual(out.marketCap.tolist(),[100,200]); self.assertEqual(out.listedShares.tolist(),[10,20])
        self.assertEqual(len(calls),2)
        self.assertEqual(out.close.tolist(),[10,10])

    def test_unpublished_is_missing_not_zero_and_refresh_can_fill(self):
        import pandas as pd
        f=pd.DataFrame([dict(symbol='000001',date='2026-10-13',securityType='STOCK',market='KOSPI')])
        out=enrich_dates(f,['2026-10-13'],{'get_krx_market_cap_market_day':lambda *_:pd.DataFrame()})
        self.assertTrue(out.marketCap.isna().all())

    def test_wrong_provider_date_or_network_error_not_normal_missing(self):
        import pandas as pd
        f=pd.DataFrame([dict(symbol='000001',date='2026-10-13',securityType='STOCK',market='KOSPI')])
        def error(*_): raise ConnectionError('provider failed')
        with self.assertRaises(ConnectionError): enrich_dates(f,['2026-10-13'],{'get_krx_market_cap_market_day':error})
        with self.assertRaises(ValueError): enrich_dates(f,['2026-10-13'],{'get_krx_market_cap_market_day':lambda *_:pd.DataFrame([dict(symbol='000001',date='2026-10-14')])})

class RunnerHookTests(unittest.TestCase):
    def test_auto_and_explicit_market_modes_keep_frozen_slot(self):
        source=(ROOT/'runtime/overrides/plan_init.py').read_text()
        cases=[('AUTO','01:00:00',True,True,'MORNING'),
               ('AUTO','12:00:00',True,False,'EVENING'),
               ('KR_ONLY','01:00:00',True,False,'MORNING'),
               ('US_ONLY','12:00:00',False,True,'MORNING'),
               ('BOTH','12:00:00',True,True,'EVENING')]
        for plan,clock,kr,us,slot in cases:
            ns={'RUN_PLAN':plan,'RUN_US_EVENING':False,'_CT_RUN_CLOCK':'2026-10-14T'+clock+'+00:00'}
            exec(compile(source,'plan_init','exec'),ns,ns)
            self.assertEqual((ns['RUN_KR_MARKET'],ns['RUN_US_MARKET'],ns['INTEGRATED_SLOT']),(kr,us,slot))

    def test_metadata_reuses_saved_payload_but_does_not_backfill_from_current_endpoint(self):
        from cloudtrend_lite_resume_v1.runner import _freeze_api
        from datetime import datetime, timezone
        with tempfile.TemporaryDirectory() as root:
            state=RunState(root,'run',{},started_at=datetime.now(timezone.utc).isoformat())
            calls=[]
            def get(endpoint,params):
                calls.append(1);return {'result':[{'symbol':'OLD'}]},{'private-header':'never serialize'}
            ns={'toss_get':get,'_CT_RUN_CLOCK':state.plan['startedAt']}
            _freeze_api(ns,state)
            first=ns['toss_get']('/api/v1/stocks',{'symbols':'OLD'})
            ns['_CT_RUN_CLOCK']='2026-01-01T00:00:00+00:00'
            self.assertEqual(ns['toss_get']('/api/v1/stocks',{'symbols':'OLD'})[0],first[0])
            with self.assertRaisesRegex(RuntimeError,'historical metadata'):
                ns['toss_get']('/api/v1/stocks',{'symbols':'NEW'})
            self.assertEqual(calls,[1])
            self.assertFalse(any(b'private-header' in p.read_bytes() for p in (state.root/'blobs').iterdir()))

    def test_etf_final_refresh_preserves_adjusted_prices_and_fills_only_dated_fields(self):
        import pandas as pd
        frame=pd.DataFrame([dict(symbol='123456',date='2026-10-13',securityType='ETF',market='ETF',
            close=99,priceSource='TOSS_ADJUSTED_CANDLE',marketCap=None,tradingValue=None)])
        daily=pd.DataFrame([dict(symbol='123456',date='2026-10-13',close=200,
            marketCap=1000,listedShares=10,tradingValue=0,etfNav=101,etfMarketCap=1000,
            etfUnderlyingIndexClose=200)])
        out=enrich_dates(frame,['2026-10-13'],{'official_day':lambda *_:daily})
        self.assertEqual(out.close.iloc[0],99)
        self.assertEqual(out.priceSource.iloc[0],'TOSS_ADJUSTED_CANDLE')
        self.assertEqual(out.tradingValue.iloc[0],0)
        self.assertEqual(out.etfNav.iloc[0],101)
        self.assertEqual(out.etfTradingValue.iloc[0],0)
        self.assertEqual(out.marketCapSource.iloc[0],'KRX_ETF')

class HttpTests(unittest.TestCase):
    def test_response_lost_after_commit_reconciles_without_second_post(self):
        from cloudtrend_lite_resume_v1.http import create_verified
        remote=[]; posts=[]
        def create():
            posts.append(1); remote.append(b'data'); raise TimeoutError()
        read=lambda:remote[-1] if remote else None
        self.assertEqual(create_verified(read=read,create=create,expected=b'data'),'RECONCILED')
        self.assertEqual(create_verified(read=read,create=create,expected=b'data'),'REUSED')
        self.assertEqual(posts,[1])

    def test_network_read_error_is_not_absence(self):
        from cloudtrend_lite_resume_v1.http import create_verified
        def read(): raise PermissionError('auth failure')
        def create(): self.fail('must not post')
        with self.assertRaises(PermissionError):create_verified(read=read,create=create,expected=b'data')

    def test_conflict_and_unresolved_outcomes_stop(self):
        from cloudtrend_lite_resume_v1.http import create_verified
        def create(): raise TimeoutError()
        with self.assertRaisesRegex(RuntimeError,'differs'):
            create_verified(read=lambda:b'other',create=create,expected=b'data')
        with self.assertRaisesRegex(RuntimeError,'unresolved'):
            create_verified(read=lambda:None,create=create,expected=b'data')

if __name__=='__main__': unittest.main()
