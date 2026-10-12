from copy import deepcopy
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import pandas as pd
from synthetic_support import fixtures
from cmresearchengine.replay import ResearchReplay
from cmresearchengine.runner import run_strategy, serialize_result
from cmresearchengine.plan import manifest as base_manifest
from cm06_comparison_execution import ExecutionContract
from cm06_fresh_codec_v1 import bind_identity, pack, restore
from cm06_checkpoint_store import DirectoryStore
from cm06.registry import Candidate
from o3_prepared import candidate
from o3_manifest import manifest
from o3_replay import O3ResearchReplay
from o3_cli import request, main


def make(start='2020-01-01',end='2020-01-31',cls=O3ResearchReplay):
    panels,_,_=fixtures.inputs();calendars={};expanded={}
    days=pd.bdate_range('2019-12-27','2020-02-05',tz='UTC')
    for e in 'KEU':
        rows=[];sessions=[]
        sources=panels[e].loc[panels[e].session_date.eq('2020-01-02')].to_dict('records')
        for stamp in days:
            day=stamp.date().isoformat()
            session={'session_date':day,
                     'open_at':(stamp+pd.Timedelta(hours=14,minutes=30) if e=='U' else stamp).isoformat(),
                     'close_available_at':(stamp+pd.Timedelta(hours=21,minutes=1) if e=='U' else stamp+pd.Timedelta(hours=7)).isoformat()}
            sessions.append(session)
            for i,source in enumerate(sources):
                score=(6 if day<'2020-01-02' else 8) if e=='K' else (70 if day<'2020-01-02' else 80)
                rank=40-i if day=='2020-01-02' else i+1
                rows.append(dict(source,session_date=day,available_at=session['close_available_at'],score=score,
                                 ret120=float(rank),ret252=float(rank),beta60_spy=float(rank),ichimoku_tk_gap=float(rank)))
        calendars[e]=sessions;expanded[e]=pd.DataFrame(rows)
    fx=pd.DataFrame([{'available_at':'2019-12-01T00:00:00Z','krw_per_usd':1000.}])
    cand=candidate() if cls is O3ResearchReplay else Candidate('O3','O',candidate().initial_weights,policy_id=None,stage='synthetic')
    with patch.object(fixtures,'ResearchReplay',cls),patch.object(fixtures,'ExecutionContract',return_value=ExecutionContract(start,end,fx_spread='0')):
        return fixtures.make(cand,panels=expanded,calendars=calendars,fx=fx)


def identity(runner):
    return bind_identity({'scope':'SYNTHETIC_O3_ENTRY_ONLY','deterministic_seed':12,'o3_plan':manifest()},runner)


class ReplayIntegration(unittest.TestCase):
    def test_complete_month_counts_original_entries_not_demand(self):
        r=make();r.run();review=r.target_reviews[0]['policy']
        self.assertFalse(review['fallback'])
        self.assertEqual(review['unique_entry_counts'],{'K':1,'E':1,'U':8})
        self.assertEqual(r.target,{'K':.1,'E':.1,'U':.6,'C':.19999999999999996})
        self.assertEqual(r.result()['final_snapshot']['bridge_residual_krw'],0)
        self.assertIsNone(r.reference_demands)
        self.assertIn('o3_entry_signals',r.result())

    def test_original_portfolio_execution_is_identical_before_first_review(self):
        original=make(end='2020-01-30',cls=ResearchReplay);observed=make(end='2020-01-30')
        original.run();observed.run()
        self.assertEqual(original.ledger.events,observed.ledger.events)
        self.assertEqual(original.demand_events,observed.demand_events)
        self.assertEqual(original.order_diagnostics,observed.order_diagnostics)
        self.assertEqual(original.initial_native,observed.initial_native)

    def test_one_us_computation_per_session_and_exact_uncached_equivalence(self):
        import cm06_comparison_signals as frozen
        full=make();uncached=make();uncached.o3_share_us_analysis=False
        real=frozen.us_analysis
        with patch.object(frozen,'us_analysis',wraps=real) as compute:
            full.run();shared_calls=compute.call_count
        with patch.object(frozen,'us_analysis',wraps=real) as compute:
            uncached.run();unshared_calls=compute.call_count
        expected=sum(1 for day in full.panels['U'] if day<=full.contract.end_date)
        self.assertEqual(shared_calls,expected)
        self.assertEqual(unshared_calls,expected*2)
        self.assertEqual(serialize_result(full),serialize_result(uncached))

    def test_divergent_observer_prior_state_cannot_reuse_analysis(self):
        r=make()
        while r.queue[0][3:5]!=('CLOSE','U'):r.step()
        r.o3_signal_state['U']['us_state']={'lastDate':'1900-01-01'}
        with self.assertRaisesRegex(ValueError,'state diverged'):r.step()

    def test_exact_resume_before_and_after_review_matches_full_result(self):
        full=make();full.run();expected=serialize_result(full)
        for after_review in (False,True):
            r=make();bound=identity(r)
            while r.step():
                if (bool(r.target_reviews) if after_review else len(r.o3_entry_signals)>5):break
            resumed=restore(make(),pack(r,bound),bound);resumed.run()
            self.assertEqual(serialize_result(resumed),expected)

    def test_bounded_resume_and_completion_are_idempotent(self):
        prepared=SimpleNamespace(factory=make,identity=identity(make()),trial_key='synthetic-o3-entry')
        with tempfile.TemporaryDirectory() as directory:
            store=DirectoryStore(directory)
            first=run_strategy(prepared,store,event_limit=30)
            self.assertEqual(first['status'],'PAUSED_VERIFIED')
            second=run_strategy(prepared,store);third=run_strategy(prepared,store)
            self.assertEqual(second['status'],'COMPLETED_VERIFIED')
            self.assertTrue(third['already_complete'])
            self.assertEqual(second['completion'],third['completion'])

    def test_initial_partial_month_uses_only_complete_start_prefix(self):
        r=make(start='2020-01-02');r.run();review=r.target_reviews[0]['policy']
        self.assertTrue(review['partial_start_month'])
        self.assertFalse(review['fallback'])
        self.assertEqual(review['coverage_start'],'2020-01-02')

    def test_zero_target_cancels_buy_preserves_sell_and_holdings(self):
        r=make()
        while r.queue[0][3]!='REVIEW':r.step()
        before_positions=deepcopy(r.ledger.positions)
        adapter=r.adapters['K']
        source=next(iter(r.latest_rows['K'].values()))
        buy=adapter._intent(dict(source,symbol='BUY_PENDING'),'BUY',r.ledger.at.isoformat(),'2020-02-03T00:00:00Z',
                            'TEST','2020-01-31',100,True,(),'NEXT_MARKET_OPEN_ONLY')
        sell=adapter._intent(source,'SELL',r.ledger.at.isoformat(),'2020-02-03T00:00:00Z','TEST','2020-01-31',
                             priority=(),expiry='UNTIL_EXECUTABLE_OPEN')
        adapter.pending[buy['signal_id']]=buy;adapter.pending[sell['signal_id']]=sell
        r.o3_entry_signals=[]
        r.step()
        self.assertEqual(r.target,{'K':0.,'E':0.,'U':0.,'C':1.})
        self.assertNotIn(buy['signal_id'],adapter.pending)
        self.assertIn(sell['signal_id'],adapter.pending)
        self.assertEqual(r.ledger.positions,before_positions)

    def test_observer_does_not_publish_failed_close(self):
        r=make()
        while r.queue[0][3]!='CLOSE':r.step()
        before=deepcopy((r.o3_signal_state,r.o3_entry_signals,r.o3_signal_observations))
        with patch.object(ResearchReplay,'_close',side_effect=ValueError('synthetic failure')):
            with self.assertRaises(ValueError):r.step()
        self.assertEqual((r.o3_signal_state,r.o3_entry_signals,r.o3_signal_observations),before)

    def test_original_registry_and_proposal_lock(self):
        before=deepcopy(base_manifest());own=manifest()
        self.assertEqual(base_manifest(),before)
        self.assertNotEqual(own['definition_sha256'],before['definition_sha256'])
        self.assertNotIn('O3',[r['candidate_id'] for rows in before['stages'].values() for r in rows])
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'request.json'
            p.write_text(json.dumps({'schema':'CM_O3_ENTRY_MANUAL_REQUEST_V1','request_id':'o3-entry-manual-test',
                                     'mode':'preflight','candidate_id':'O3','max_seconds':3000}))
            proposal=deepcopy(own);proposal['contract']['execution_status']='LOCAL_PREPARATION_ONLY_NOT_SUBMITTED'
            with patch('o3_cli.manifest',return_value=proposal):
                with self.assertRaisesRegex(ValueError,'local proposal'):main(['--request-file',str(p),'--work',d])

    def test_request_rejects_wrong_scope_and_unbounded_runs(self):
        base={'schema':'CM_O3_ENTRY_MANUAL_REQUEST_V1','request_id':'o3-entry-manual-test',
              'mode':'run','candidate_id':'O3','max_seconds':3000}
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'request.json'
            for change in ({'candidate_id':'D2'},{'max_seconds':3001},{'mode':'resume-all'},{'max_seconds':True}):
                p.write_text(json.dumps({**base,**change}))
                with self.assertRaises(ValueError):request(p)
            p.write_text(json.dumps(base));self.assertEqual(request(p),base)

if __name__=='__main__':unittest.main()
