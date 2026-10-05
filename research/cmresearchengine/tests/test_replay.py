import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import unittest
from copy import deepcopy
from types import SimpleNamespace
from decimal import Decimal
from fixtures import make,inputs,identity,H
from cmresearchengine.replay import ResearchReplay
from cmresearchengine.plan import candidates,manifest,choose
from cmresearchengine.runner import run_strategy,build_references,read_result
from cm06_fresh_codec_v1 import pack,restore
from cm06_fresh_host_v1 import CandidateHazard
from cm06_checkpoint_store import DirectoryStore
from cm06.accounting import utc
from cm06.registry import candidate_by_id
from pandas.testing import assert_frame_equal
import tempfile

class PlanTests(unittest.TestCase):
    def test_original_counts_unique(self):
        self.assertEqual(manifest()['stage_counts'],{'base':52,'fine':286,'split25':70,'split10':1001})
        for stage in ('base','fine','split25','split10'):
            rows=candidates(stage)
            self.assertEqual(len({c.candidate_id for c in rows}),len(rows))
            for c in rows:self.assertAlmostEqual(sum(c.initial_weights.values()),1)
    def test_all_base_paths_have_independent_ledgers(self):
        a=make(candidate_by_id('S01'));b=make(candidate_by_id('S02'))
        self.assertIsNot(a.ledger,b.ledger);self.assertIsNot(a.adapters['U'],b.adapters['U'])
        self.assertIsNot(a.adapters['U'].pending,b.adapters['U'].pending)
    def test_invalid_candidate_rejected(self):
        with self.assertRaises(ValueError):choose('base',ids=['made-up'])

class ProxyTests(unittest.TestCase):
    def held_at_close(self,mutate=None):
        r=make()
        while r.queue:
            if r.queue[0][3:5]==('CLOSE','U') and any(e=='U' for e,_ in r.ledger.positions):return r
            self.assertTrue(r.step())
        self.fail('No holdings')
    def remove_close(self,r,whole=False):
        day=r.queue[0][5]['session_date'];symbol=next(s for e,s in r.ledger.positions if e=='U')
        panels=r.panels['U'].panels.panels
        # Wrapper layout: DatedActionPanels -> DocumentedQuotePanels -> dict.
        if whole:panels.pop(day)
        else:
            frame=panels[day].copy();frame.loc[frame.symbol.eq(symbol),'comparison_close']=None;panels[day]=frame
        return day,symbol
    def test_missing_close_uses_last_close_at_current_time(self):
        r=self.held_at_close();day,symbol=self.remove_close(r)
        old_snapshots=deepcopy(r.snapshots);last=r.proxy_last_close[('U',symbol)].copy()
        cash=r.ledger.cash['USD'];self.assertTrue(r.step())
        a=next(x for x in r.proxy_exits if x['symbol']==symbol)
        self.assertEqual(a['trigger_session_date'],day);self.assertEqual(a['reference_price_date'],last['date'])
        self.assertLess(a['reference_price_date'],a['trigger_session_date'])
        self.assertGreater(utc(a['cash_available_at']),utc(a['recognition_at']))
        self.assertEqual(r.snapshots,old_snapshots)
        self.assertEqual(r.ledger.cash['USD'],cash)
        sell=next(x for x in r.ledger.events if x.get('id')==a['fill_id'])
        self.assertEqual(sell['execution_class'],'RETROSPECTIVE_EXIT_PROXY')
        self.assertEqual(Decimal(str(sell['fee'])),Decimal(str(sell['price']))*Decimal(str(sell['quantity']))*Decimal('.0015'))
    def test_whole_missing_cross_section_exits_all_ordinary_holdings(self):
        r=self.held_at_close();count=len([1 for e,_ in r.ledger.positions if e=='U'])
        day,_=self.remove_close(r,True);self.assertTrue(r.step())
        self.assertEqual(len(r.proxy_exits),count);self.assertFalse(any(e=='U' for e,_ in r.ledger.positions))
    def test_unresolved_hazard_with_valid_quote_does_not_stop(self):
        r=make(hazards=(CandidateHazard('unresolved','U00','100','2020-01-03',True,'TEST',H,()),))
        r.run();self.assertFalse(r.proxy_exits)
    def test_valid_close_zero_volume_is_not_missing(self):
        r=self.held_at_close();day=r.queue[0][5]['session_date']
        panels=r.panels['U'].panels.panels;frame=panels[day].copy();frame['source_volume']=0;panels[day]=frame
        r.step();self.assertFalse(r.proxy_exits)
    def test_checkpoint_every_event_matches_full(self):
        full=make();expected=full.run();r=make();ident=identity(r)
        while r.step():r=restore(make(),pack(r,ident),ident)
        for key in ('nav','events','orders','demands'):assert_frame_equal(expected[key],r.result()[key],check_exact=True)
        self.assertEqual(full.proxy_last_close,r.proxy_last_close)
    def test_known_handler_order_is_before_fallback(self):
        # The existing host invokes known action dispatch at OPEN, before CLOSE.
        r=make();kinds=[(e[0],e[1],e[3]) for e in sorted(r.queue) if e[4]=='U']
        self.assertLess(next(x for x in kinds if x[2]=='OPEN'),next(x for x in kinds if x[2]=='CLOSE'))

class RunnerTests(unittest.TestCase):
    def prepared(self):
        r=make();return SimpleNamespace(identity=identity(r),trial_key='synthetic',factory=make)
    def test_pause_resume_complete_and_idempotent(self):
        with tempfile.TemporaryDirectory() as d:
            store=DirectoryStore(d);p=self.prepared()
            self.assertEqual(run_strategy(p,store,event_limit=3)['status'],'PAUSED_VERIFIED')
            result=run_strategy(p,store);self.assertEqual(result['status'],'COMPLETED_VERIFIED')
            again=run_strategy(p,store);self.assertTrue(again['already_complete'])
            self.assertEqual(again['completion'],result['completion'])
            files=read_result(result['completion'],store)
            self.assertIn('retrospective_exit_proxy_audit.csv',files)
    def test_changed_identity_starts_separate_chain(self):
        with tempfile.TemporaryDirectory() as d:
            store=DirectoryStore(d);p=self.prepared();a=run_strategy(p,store,event_limit=3)
            p.identity=dict(p.identity,change='different');b=run_strategy(p,store,event_limit=3)
            self.assertEqual(a['checkpoint_sequence'],b['checkpoint_sequence'])

if __name__=='__main__':unittest.main()
