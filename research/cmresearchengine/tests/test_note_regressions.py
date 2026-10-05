"""Current-rule regression fixtures distilled from the user's development notes.

Historical strategies/fees/PIT claims are not imported as new assumptions.
Sources are listed with each focused guard; these are synthetic checks only.
"""
import io,json,os,subprocess,sys,tempfile,unittest
from copy import deepcopy
from pathlib import Path
import pandas as pd
from pandas.testing import assert_frame_equal
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from fixtures import inputs,make,H
from test_research_regressions import stop_before,monthly_runner,files_for
from cmresearchengine import runtime
from cmresearchengine.plan import candidates
from cmresearchengine.replay import ResearchReplay
from cmresearchengine.runner import build_references,serialize_result
from cm06.accounting import dec,utc
from cm06.registry import candidate_by_id
from cm06_comparison_signals import FrozenIntentAdapter
from cm06_dated_action_contract_v1 import ActionRegistry,StableInstrumentIdentityMap
from cm06_us_cash_t5_policy_v1 import USSessionCalendar
from cm06_comparison_execution import ExecutionContract


def etf_row(day,score=81.,underlying=100.,ma=100.):
    panels,_,_=inputs();row=panels['E'].iloc[0].to_dict()
    row.update(symbol='ETF_SYN',session_date=day,available_at=day+'T06:31:00+00:00',
        score=score,underlying_close=underlying,underlying_ma60=ma)
    return row

def feed(adapter,day,next_day,score,holdings,underlying=100.,ma=100.):
    return adapter.on_close([etf_row(day,score,underlying,ma)],holdings,
        100_000.,100_000.,100_000.,next_day+'T00:00:00+00:00',day+'T06:31:00+00:00')

class ETFLifecycleNoteTests(unittest.TestCase):
    # https://app.notion.com/p/3ecd908cac2f81dc954fd037e45adbd4
    def test_onset_while_held_cannot_be_reused_after_next_open_sale(self):
        a=FrozenIntentAdapter('ETF_V02');held={'ETF_SYN':{'quantity':10,'sector':'S'}}
        feed(a,'2020-01-02','2020-01-03',79.,held)
        emitted=feed(a,'2020-01-03','2020-01-06',81.,held,underlying=99.)
        sale=next(i for i in emitted if i['side']=='SELL')
        a.on_fill(sale['signal_id'],10,100.,0)
        a.record_holding_span('ETF_SYN','2019-12-01','2020-01-06')
        emitted=feed(a,'2020-01-06','2020-01-07',82.,{})
        self.assertFalse([i for i in emitted if i['side']=='BUY'])
        feed(a,'2020-01-07','2020-01-08',79.,{})
        feed(a,'2020-01-08','2020-01-09',81.,{})
        emitted=feed(a,'2020-01-09','2020-01-10',82.,{})
        self.assertEqual([i['origin_date'] for i in emitted if i['side']=='BUY'],['2020-01-08'])

    def test_holding_span_exit_boundary_matches_inclusive_same_day_policy(self):
        for exit_day,should_enter in [('2020-01-02',True),('2020-01-03',False),('2020-01-06',False)]:
            with self.subTest(exit_day=exit_day):
                a=FrozenIntentAdapter('ETF_V02')
                feed(a,'2020-01-02','2020-01-03',79.,{})
                feed(a,'2020-01-03','2020-01-06',81.,{})
                a.record_holding_span('ETF_SYN','2019-12-01',exit_day)
                emitted=feed(a,'2020-01-06','2020-01-07',82.,{})
                self.assertEqual(any(i['side']=='BUY' for i in emitted),should_enter)

    def test_blocked_onset_survives_checkpoint_before_interim_sale(self):
        from fixtures import identity
        from cm06_fresh_codec_v1 import pack,restore
        def factory():
            panels,calendars,fx=inputs();panels['E']['score']=[79.,81.,82.,82.,82.,82.]
            panels['E'].loc[panels['E'].session_date.eq('2020-01-03'),'underlying_close']=99.
            return make(candidate_by_id('S02'),panels=panels,calendars=calendars,fx=fx)
        def blocked():
            r=factory();stop_before(r,'CLOSE','E','2020-01-03')
            r.fill_counter+=1
            r.ledger.buy('fill:'+str(r.fill_counter),'E','E_A','KRW',10,100,r.ledger.at,sector='S')
            r.entry_meta[('E','E_A')]={'entry_date':'2020-01-03','valid_bar_count':0,'market':'ETF'}
            r.step();return r
        full=blocked();full.run();partial=blocked();bound=identity(partial)
        resumed=restore(factory(),pack(partial,bound),bound)
        self.assertIn(('E_A','2020-01-03'),resumed.adapters['E'].blocked_origins)
        resumed.run()
        self.assertFalse(any(i['side']=='BUY' for i in resumed.adapters['E'].pending_intents()))
        for key in ('nav','events','orders','demands'):
            assert_frame_equal(full.result()[key],resumed.result()[key],check_exact=True)

    # https://app.notion.com/p/3e2d908cac2f807e92cfe547f568ca64
    def test_missing_index_is_not_a_normal_ma60_exit(self):
        for underlying,ma in [(None,100.),(0.,100.),(float('nan'),100.),(100.,None),(100.,0.)]:
            with self.subTest(underlying=underlying,ma=ma):
                a=FrozenIntentAdapter('ETF_V02')
                out=feed(a,'2020-01-03','2020-01-06',70.,{'ETF_SYN':{'quantity':10}},underlying,ma)
                self.assertFalse([i for i in out if i['side']=='SELL'])
        out=feed(FrozenIntentAdapter('ETF_V02'),'2020-01-03','2020-01-06',70.,
            {'ETF_SYN':{'quantity':10}},99.,100.)
        self.assertEqual([i['reason'] for i in out if i['side']=='SELL'],['MA60'])

    def test_failed_confirmation_does_not_wait_for_later_valid_index(self):
        for missing in (None,0.,float('nan')):
            a=FrozenIntentAdapter('ETF_V02')
            feed(a,'2020-01-02','2020-01-03',79.,{})
            feed(a,'2020-01-03','2020-01-06',81.,{})
            self.assertFalse(feed(a,'2020-01-06','2020-01-07',82.,{},missing))
            self.assertFalse(feed(a,'2020-01-07','2020-01-08',82.,{}))

class ImportIsolationNoteTests(unittest.TestCase):
    # https://app.notion.com/p/3efd908cac2f81678a4ecd533739ec55
    def env(self):
        env=os.environ.copy();env['PYTHONPATH']=str(runtime.ROOT)
        return env
    def fake(self,directory,content):
        package=Path(directory)/'cm06';package.mkdir();(package/'__init__.py').write_text(content)
    def test_fresh_cli_ignores_wrong_cwd_cm06_package(self):
        with tempfile.TemporaryDirectory() as directory:
            self.fake(directory,"raise RuntimeError('Wrong cwd package executed')\n")
            out=subprocess.run([sys.executable,'-m','cmresearchengine.cli','plan'],cwd=directory,
                env=self.env(),capture_output=True,text=True,timeout=30)
            self.assertEqual(out.returncode,0,out.stderr)
            self.assertEqual(json.loads(out.stdout)['stage_counts']['base'],52)
    def test_preloaded_foreign_cm06_is_rejected_not_silently_reused(self):
        with tempfile.TemporaryDirectory() as directory:
            self.fake(directory,"origin='unreviewed cwd package'\n")
            out=subprocess.run([sys.executable,'-c',"import cm06; from cmresearchengine import runtime; print('UNEXPECTED_IMPORT_SUCCESS')"],
                cwd=directory,env=self.env(),capture_output=True,text=True,timeout=30)
            self.assertNotEqual(out.returncode,0)
            self.assertIn('outside reviewed source tree',out.stderr)

class ImportPathPriorityNoteTests(unittest.TestCase):
    def test_existing_reviewed_root_is_moved_ahead_of_foreign_cwd(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory)/'cm06_comparison_signals.py').write_text("FOREIGN=True\n")
            env=os.environ.copy();env['PYTHONPATH']=os.pathsep.join([str(runtime.ROOT),str(runtime.VENDOR/'resumable_allocation/runtime')])
            script="from cmresearchengine import runtime; import cm06_comparison_signals as m; assert not hasattr(m,'FOREIGN'); print('REVIEWED')"
            out=subprocess.run([sys.executable,'-c',script],cwd=directory,env=env,capture_output=True,text=True,timeout=30)
            self.assertEqual(out.returncode,0,out.stderr);self.assertIn('REVIEWED',out.stdout)
    def test_preloaded_reviewed_path_also_requires_controlled_initialization(self):
        with tempfile.TemporaryDirectory() as directory:
            env=os.environ.copy();env['PYTHONPATH']=os.pathsep.join([str(runtime.ROOT),str(runtime.VENDOR/'resumable_allocation/runtime')])
            script="import cm06_comparison_signals; from cmresearchengine import runtime"
            out=subprocess.run([sys.executable,'-c',script],cwd=directory,env=env,capture_output=True,text=True,timeout=30)
            self.assertNotEqual(out.returncode,0);self.assertIn('Preloaded CM module cannot be source-verified',out.stderr)
    def test_later_source_change_requires_a_fresh_process(self):
        from unittest.mock import patch
        with patch('cmresearchengine.runtime.code_hashes',return_value={'changed':'f'*64}):
            with self.assertRaisesRegex(RuntimeError,'source changed after controlled'):
                runtime.activate()

class ExecutionClockNoteTests(unittest.TestCase):
    # Timing/cash invariants: https://app.notion.com/p/3d8d908cac2f81509b88f21d0b0817cd
    def test_same_session_future_close_and_scores_do_not_change_open_fills(self):
        a=make();b=make();stop_before(a,'OPEN','U','2020-01-06');stop_before(b,'OPEN','U','2020-01-06')
        frame=b.panels['U'].panels.panels['2020-01-06'].copy()
        for col in ('comparison_close','signal_close','ret120','ret252','beta60_spy','ichimoku_tk_gap'):
            frame[col]=999999.
        b.panels['U'].panels.panels['2020-01-06']=frame
        a.step();b.step()
        self.assertEqual(a.ledger.events,b.ledger.events)
        self.assertEqual(a.ledger.cash,b.ledger.cash)
        self.assertEqual(a.ledger.positions,b.ledger.positions)
    def test_signal_availability_after_close_is_rejected(self):
        r=make();stop_before(r,'CLOSE','K','2020-01-03')
        r.panels['K']['2020-01-03']['available_at']='2020-01-06T06:31:00+00:00'
        with self.assertRaisesRegex(ValueError,'unavailable'):r.step()
    def test_zero_volume_open_does_not_fill_expiring_entry(self):
        r=make(candidate_by_id('S01'));stop_before(r,'OPEN','K','2020-01-06')
        r.panels['K']['2020-01-06']['source_volume']=0
        r.step();self.assertNotIn(('K','K_A'),r.ledger.positions)
        self.assertTrue(any(o['reason']=='NO_EXECUTABLE_VOLUME' for o in r.order_diagnostics))

class USIdentifierNoteTests(unittest.TestCase):
    # Literal NA bug: https://app.notion.com/p/3ead908cac2f8181b2cbe2b0eb661888
    def test_literal_na_survives_rank_fill_and_csv_identifier_join(self):
        panels,calendars,fx=inputs();panels['U']['symbol']=panels['U'].symbol.replace({'U00':'NA'})
        identities=StableInstrumentIdentityMap(tuple(sorted(('NA' if i==0 else f'U{i:02}',str(i+100)) for i in range(40))),H,H,True)
        registry=ActionRegistry.bind((),USSessionCalendar(calendars['U']),H)
        r=ResearchReplay(candidate_by_id('S03'),ExecutionContract('2020-01-03','2020-01-07',fx_spread='0'),
            panels,calendars,fx,registry=registry,contexts=lambda s:{},instrument_identities=identities,context_sha256=H)
        r.run();self.assertEqual(identities.identity('NA'),'100')
        buys=[e for e in r.ledger.events if e['kind']=='BUY' and e['symbol']=='NA']
        self.assertTrue(buys)
        files=files_for(r)
        events=pd.read_csv(io.BytesIO(files['events.csv']),keep_default_na=False,dtype={'symbol':str})
        self.assertTrue(events.symbol.eq('NA').any())
        names=pd.read_csv(io.StringIO('symbol,sector\nNA,S\n'),keep_default_na=False,dtype={'symbol':str})
        joined=events.loc[events.symbol.eq('NA')].merge(names,on='symbol',suffixes=('','_reference'))
        self.assertEqual(len(joined),int(events.symbol.eq('NA').sum()))

class KoreanBudgetSlotNoteTests(unittest.TestCase):
    # Combined K caps: https://app.notion.com/p/253d908cac2f80468145e44512e4d47b
    def test_combined_market_sector_count_uses_incoming_market_limit(self):
        for market,existing_count,should_fill in [('KOSPI',3,False),('KOSDAQ',5,True),('KOSDAQ',6,False)]:
            with self.subTest(market=market,existing_count=existing_count):
                r=make(candidate_by_id('S01'));stop_before(r,'OPEN','K','2020-01-06')
                for i in range(existing_count):
                    symbol=f'OTHER{i}'
                    r.ledger.buy('seed:'+str(i),'K',symbol,'KRW',1,100,r.ledger.at,sector='S')
                    r.entry_meta[('K',symbol)]={'entry_date':'2020-01-03','valid_bar_count':1,
                        'market':'KOSDAQ' if market=='KOSPI' else 'KOSPI'}
                a=r.adapters['K'];a.pending.clear()
                row=r.panels['K']['2020-01-06'].iloc[0].to_dict();row.update(market=market,sector='S')
                intent=a._intent(row,'BUY','2020-01-03T06:31:00+00:00','2020-01-06T00:00:00+00:00',
                    'SYNTHETIC_EXISTING_FROZEN_RULE','2020-01-03',budget=1000.,inclusive=True,priority=(0,'K_A'),expiry='NEXT_MARKET_OPEN_ONLY')
                intent.update(target_positions=30,sector_max_positions=3 if market=='KOSPI' else 6)
                a.pending[intent['signal_id']]=intent
                a.latest_gate={'date':'2020-01-03','evaluatedCount':4,'issues':[],'status':'RISK_ON','incomplete':False}
                r.step();self.assertEqual(('K','K_A') in r.ledger.positions,should_fill)
                self.assertTrue(all(('K',f'OTHER{i}') in r.ledger.positions for i in range(existing_count)))

    def test_thirty_slots_and_priority_ties_are_deterministic(self):
        panels,calendars,fx=inputs();parts=[]
        for i in range(31):
            f=panels['K'].copy();f['symbol']=f'K{i:02}';f['sector']=f'S{i:02}';f['priority']=i%2
            f['score']=[6.,8.,8.,8.,8.,8.];parts.append(f)
        panels['K']=pd.concat(parts,ignore_index=True)
        r=make(candidate_by_id('S01'),panels=panels,calendars=calendars,fx=fx)
        stop_before(r,'OPEN','K','2020-01-06');r.step()
        filled=[e['symbol'] for e in r.ledger.events if e['kind']=='BUY' and e['sleeve']=='K']
        expected=sorted([f'K{i:02}' for i in range(31)],key=lambda s:(-(int(s[1:])%2),s))[:30]
        self.assertEqual(filled,expected);self.assertEqual(len(r._holdings('K')),30)
        self.assertTrue(any(d['reason']=='SLOT_LIMIT' for d in r.order_diagnostics))

    # Original-budget floor: https://app.notion.com/p/3edd908cac2f8159b006d1709ad3005e
    def test_floor_does_not_force_minimum_one_or_exceed_fee_inclusive_budget(self):
        from cm06.accounting import Ledger,FEE
        self.assertEqual(Ledger.quantity_for_budget(99,100000,100,True),0)
        for budget,price in [(1000,100),(1000,333),(1000,999)]:
            quantity=Ledger.quantity_for_budget(budget,budget,price,True)
            self.assertLessEqual(dec(quantity)*dec(price)*(1+FEE),dec(budget))
            self.assertGreater(dec(quantity+1)*dec(price)*(1+FEE),dec(budget))

    # H60 counts remaining observed positive OHLC bars, not 60 calendar days.
    # https://app.notion.com/p/3ead908cac2f8155911efbb2f88efffe
    def test_h60_close_uses_frozen_valid_bar_horizon_and_fees_once(self):
        panels,_,fx=inputs();days=pd.bdate_range('2020-01-02',periods=70).strftime('%Y-%m-%d').tolist()
        days.remove('2020-01-20') # Explicit synthetic exchange-calendar gap.
        calendars={e:[dict(session_date=d,open_at=d+('T14:30:00Z' if e=='U' else 'T00:00:00Z'),
            close_available_at=d+('T21:01:00Z' if e=='U' else 'T06:31:00Z')) for d in days] for e in 'KEU'}
        expanded={}
        for e in 'KEU':
            parts=[]
            for index,s in enumerate(calendars[e]):
                f=panels[e].loc[panels[e].session_date.eq('2020-01-02')].copy()
                f['session_date']=s['session_date'];f['available_at']=s['close_available_at']
                if e=='K':f['score']=6. if index==0 else 8.
                parts.append(f)
            expanded[e]=pd.concat(parts,ignore_index=True)
        identity_map=StableInstrumentIdentityMap(tuple((f'U{i:02}',str(i+100)) for i in range(40)),H,H,True)
        registry=ActionRegistry.bind((),USSessionCalendar(calendars['U']),H)
        r=ResearchReplay(candidate_by_id('S01'),ExecutionContract(days[1],days[64],fx_spread='0'),
            expanded,calendars,fx,registry=registry,contexts=lambda s:{},instrument_identities=identity_map,context_sha256=H)
        r.run();fills=[e for e in r.ledger.events if e['kind'] in ('BUY','SELL')]
        self.assertEqual([e['kind'] for e in fills],['BUY','SELL'])
        expected_exit=days[2+59]
        self.assertEqual(fills[-1]['at'][:10],expected_exit)
        self.assertEqual(fills[-1]['at'][11:16],'06:31')
        self.assertGreater(utc(fills[-1]['settlement_at']),utc(fills[-1]['at']))
        fees=sum(dec(e['fee']) for e in fills)
        self.assertEqual(r.ledger.snapshot()['gross_nav_krw'],dec(100_000_000)-fees)
        self.assertEqual(r.ledger.pnl['income'],0)
        self.assertEqual(r.ledger.pnl['trading_cost'],fees)

class USDemandPersistenceNoteTests(unittest.TestCase):
    # Partial-order independence: https://app.notion.com/p/3e9d908cac2f81909ea6cdf2ba127de9
    def factory(self,participation):
        panels,calendars,fx=inputs()
        good=panels['U'].loc[panels['U'].session_date.eq('2020-01-03')].set_index('symbol')
        day='2020-01-06';mask=panels['U'].session_date.eq(day)
        for col in ('ret120','ret252','beta60_spy','ichimoku_tk_gap'):
            panels['U'].loc[mask,col]=panels['U'].loc[mask,'symbol'].map(good[col]).to_numpy()
        for e in 'KEU':
            for future in ('2020-01-10','2020-01-13'):
                calendars[e].append(dict(session_date=future,open_at=future+('T14:30:00Z' if e=='U' else 'T00:00:00Z'),
                    close_available_at=future+('T21:01:00Z' if e=='U' else 'T06:31:00Z')))
        identity_map=StableInstrumentIdentityMap(tuple((f'U{i:02}',str(i+100)) for i in range(40)),H,H,True)
        registry=ActionRegistry.bind((),USSessionCalendar(calendars['U']),H)
        contract=ExecutionContract('2020-01-03','2020-01-09',fx_spread='0',
            capacity_mode='UNIFORM_ADV' if participation is not None else 'FROZEN_BASELINE',participation_limit=participation)
        return ResearchReplay(candidate_by_id('S03'),contract,panels,calendars,fx,registry=registry,
            contexts=lambda s:{},instrument_identities=identity_map,context_sha256=H)
    def test_partial_buy_and_sell_intents_survive_exact_checkpoint_resume(self):
        from fixtures import identity
        from cm06_fresh_codec_v1 import pack,restore
        full=self.factory(.001);full.run();r=self.factory(.001);bound=identity(r)
        saw_partial_buy=saw_partial_sell=False
        while r.step():
            if ('U','U00') in r.ledger.positions:
                pending=r.adapters['U'].pending_intents()
                saw_partial_buy|=any(i['symbol']=='U00' and i['side']=='BUY' for i in pending)
                saw_partial_sell|=any(i['symbol']=='U00' and i['side']=='SELL' for i in pending)
            r=restore(self.factory(.001),pack(r,bound),bound)
        self.assertTrue(saw_partial_buy);self.assertTrue(saw_partial_sell)
        for key in ('nav','events','orders','demands'):
            assert_frame_equal(full.result()[key],r.result()[key],check_exact=True)
    def test_never_binding_cap_preserves_path_and_costs(self):
        a=self.factory(None);b=self.factory(1.0);a.run();b.run()
        for key in ('nav','orders','demands'):
            assert_frame_equal(a.result()[key],b.result()[key],check_exact=True)
        for side in ('BUY','SELL'):
            self.assertEqual([e for e in a.ledger.events if e['kind']==side],
                [e for e in b.ledger.events if e['kind']==side])

class AllocationAndCashNoteTests(unittest.TestCase):
    # https://app.notion.com/p/3eed908cac2f8144b068e016ecc13fba
    def test_repeated_pending_demand_and_future_updates_are_not_new_o2_demand(self):
        from cm06.policies import policy_target
        days=pd.bdate_range('2020-01-02',periods=30)
        sessions={e:[pd.Timestamp(d,tz='UTC')+pd.Timedelta(hours=14,minutes=30) for d in days] for e in 'KEU'}
        cutoff=days[-1].tz_localize('UTC')+pd.Timedelta(hours=22)
        nav=pd.DataFrame({e:100. for e in 'KEU'},index=pd.DatetimeIndex(sessions['U']))
        rows=[]
        for engine,ident,amount in [('K','k1',100.),('K','k2',100.),('E','e1',100.),('U','u1',200.)]:
            at=sessions[engine][-5]
            rows.append(dict(engine=engine,demand_id=ident,session_at=at,available_at=at,desired_amount=amount,eligible=True))
        baseline=pd.DataFrame(rows)
        retries=[dict(rows[0],session_at=sessions['K'][-2],available_at=sessions['K'][-2],desired_amount=99999.)]
        future=cutoff+pd.Timedelta(days=1)
        retries.append(dict(rows[-1],demand_id='future-u',session_at=future,available_at=future,desired_amount=10**12))
        a=policy_target('O2',nav,cutoff,demand_events=baseline,reference_capital={e:1000. for e in 'KEU'},engine_sessions=sessions)
        b=policy_target('O2',nav,cutoff,demand_events=pd.concat([baseline,pd.DataFrame(retries)],ignore_index=True),
            reference_capital={e:1000. for e in 'KEU'},engine_sessions=sessions)
        self.assertEqual(a.weights,b.weights)
        self.assertEqual(a.weights,{'K':.4,'E':.2,'U':.4,'C':0.})

    def test_future_reference_nav_does_not_change_current_monthly_target(self):
        from cm06.policies import policy_target
        idx=pd.date_range('2019-01-01',periods=220,tz='UTC')
        nav=pd.DataFrame({'K':[100+i for i in range(220)],'E':[100+i/2 for i in range(220)],'U':[100+i/4 for i in range(220)]},index=idx)
        cutoff=idx[199]
        changed=nav.copy();changed.loc[changed.index>cutoff,:]=10**12
        for policy in ('G1','G2','V1','V2','R1','R2','M1','M2','D1','D2'):
            self.assertEqual(policy_target(policy,nav,cutoff).weights,policy_target(policy,changed,cutoff).weights)

    def test_idle_cash_move_cannot_reset_budget_force_sell_or_sweep_reserved_receivable(self):
        r=make();stop_before(r,'CLOSE','U','2020-01-06');r.step()
        initial=dict(r.initial_native);quantities={k:p.quantity for k,p in r.ledger.positions.items()}
        r.ledger.income('synthetic-future-cash','U','USD',100,'2020-01-09T14:30:00Z')
        reserve=min(dec(10),r.ledger.available('U','USD'))
        self.assertGreater(reserve,0);r.ledger.reserve('synthetic-manual-reserve','U','USD',reserve)
        before=r.ledger.snapshot()['gross_nav_krw'];old_sales=len([e for e in r.ledger.events if e['kind']=='SELL'])
        r.target={'K':0.,'E':1.,'U':0.,'C':0.};r._review('2020-01')
        self.assertEqual(r.initial_native,initial)
        self.assertEqual({k:p.quantity for k,p in r.ledger.positions.items()},quantities)
        self.assertEqual(len([e for e in r.ledger.events if e['kind']=='SELL']),old_sales)
        self.assertEqual(r.ledger.snapshot()['gross_nav_krw'],before)
        self.assertIn('synthetic-manual-reserve',r.ledger.reservations)
        self.assertIn('synthetic-future-cash',r.ledger.receivables)
        self.assertGreaterEqual(r.ledger.claims[('U','USD')],reserve)

    # https://app.notion.com/p/3d8d908cac2f81509b88f21d0b0817cd
    def test_open_sale_does_not_fund_another_open_buy_before_settlement(self):
        r=make(candidate_by_id('S01'));stop_before(r,'OPEN','K','2020-01-06')
        r.ledger.buy('seed-held','K','K_A','KRW',10,100,r.ledger.at,sector='S')
        r.entry_meta[('K','K_A')]={'entry_date':'2020-01-03','valid_bar_count':1,'market':'KOSDAQ'}
        if 'pending-batch:K' in r.ledger.reservations:
            r.ledger.release('pending-batch:K','SYNTHETIC_REPLACE_PENDING_BATCH')
        available=r.ledger.available('K','KRW')
        r.ledger.reserve('retain-old-cash','K','KRW',available)
        frame=r.panels['K']['2020-01-06'];other=frame.copy();other['symbol']='K_B';other['sector']='OTHER'
        r.panels['K']['2020-01-06']=pd.concat([frame,other],ignore_index=True)
        a=r.adapters['K'];a.pending.clear();known='2020-01-03T06:31:00+00:00';opens='2020-01-06T00:00:00+00:00'
        sell=a._intent(frame.iloc[0].to_dict(),'SELL',known,opens,'SYNTHETIC_SELL','2020-01-03',priority=(0,'K_A'),expiry='UNTIL_EXECUTABLE_OPEN')
        buy=a._intent(other.iloc[0].to_dict(),'BUY',known,opens,'SYNTHETIC_BUY','2020-01-03',budget=1000.,inclusive=True,priority=(0,'K_B'),expiry='NEXT_MARKET_OPEN_ONLY')
        buy.update(target_positions=30,sector_max_positions=6)
        a.pending={sell['signal_id']:sell,buy['signal_id']:buy};cash=r.ledger.cash['KRW']
        r.step()
        self.assertNotIn(('K','K_A'),r.ledger.positions);self.assertNotIn(('K','K_B'),r.ledger.positions)
        self.assertEqual(r.ledger.cash['KRW'],cash)
        self.assertTrue(any(d['symbol']=='K_B' and d['reason']=='CASH_BUDGET_OR_CAPACITY_ZERO' for d in r.order_diagnostics))
        self.assertTrue(any(x.source=='SALE' and x.due_at>r.ledger.at for x in r.ledger.receivables.values()))

class KoreanSignalBoundaryNoteTests(unittest.TestCase):
    # https://app.notion.com/p/3dad908cac2f80399a2bf9a61f8b5faf
    def test_kosdaq_overshoot_entry_and_later_crossing_exits_remain_distinct(self):
        from cm06_comparison_signals import kr_operational_signals
        first=kr_operational_signals('KOSDAQ',6.,9.,True,held=False)
        self.assertTrue(first['kosdaq80Onset']);self.assertIsNone(first['exitSignal'])
        self.assertIsNone(kr_operational_signals('KOSDAQ',9.,9.,True,held=True)['exitSignal'])
        self.assertEqual(kr_operational_signals('KOSDAQ',8.5,9.,True,held=True)['exitSignal'],'UP90')
        self.assertEqual(kr_operational_signals('KOSDAQ',4.,3.,True,held=True)['exitSignal'],'DOWN30')
        self.assertIsNone(kr_operational_signals('KOSDAQ',3.,2.,True,held=True)['exitSignal'])

    def test_kospi_failed_exact_confirmation_never_revives_old_onset(self):
        from cm06_comparison_signals import kospi_confirmation
        def observation(day,score,**changes):
            row={'date':day,'score':score,'eligible':True,'observed':True,'rsAccel':1.,
                'marketGate':{'date':day,'status':'RISK_ON','incomplete':False,'evaluatedCount':4,'issues':[]}}
            row.update(changes);return row
        before=observation('2020-01-02',6.);origin=observation('2020-01-03',8.)
        variants=[{'observed':False},{'rsAccel':0.},{'marketGate':{'date':'2020-01-06','status':'UNKNOWN','incomplete':True,'evaluatedCount':4,'issues':[]}}]
        for changes in variants:
            current=observation('2020-01-06',8.5,**changes)
            failed=kospi_confirmation(current,origin,before,historical_policy=True)
            self.assertFalse(failed['eligible']);self.assertNotEqual(failed['state'],'confirmed')
            later=kospi_confirmation(observation('2020-01-07',8.5),current,origin,historical_policy=True)
            self.assertFalse(later['eligible']);self.assertNotEqual(later['state'],'confirmed')
