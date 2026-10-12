from copy import deepcopy
import unittest
from synthetic_support import fixtures
from cm06_comparison_signals import FrozenIntentAdapter
from o3_signals import observe, initial_state


def data(engine, scores, market=None, symbols=1):
    panels, calendars, _=fixtures.inputs()
    source=panels[engine].iloc[0].to_dict()
    result=[]
    for i,score in enumerate(scores):
        s=calendars[engine][i]
        gate={'date':s['session_date'],'status':'RISK_ON','incomplete':False,'evaluatedCount':4,'issues':[]}
        rows=[dict(source,symbol=f'{engine}{j}',session_date=s['session_date'],available_at=s['close_available_at'],
                   score=score,market=market or source['market'],market_gate=gate,rs_accel=1.) for j in range(symbols)]
        result.append((s,rows))
    return result


def collect(engine, days, start='2020-01-02'):
    state=initial_state();result=[];observations=[]
    for s,rows in days:
        state,signals,receipt=observe(engine,rows,s,state,start)
        result.extend(signals);observations.append(receipt)
    return state,result,observations


class IntrinsicSignals(unittest.TestCase):
    def test_kosdaq_onset_counted_while_held_in_adapter(self):
        days=data('K',[6.,8.],market='KOSDAQ')
        _,signals,_=collect('K',days)
        adapter=FrozenIntentAdapter('KR_MIXED')
        out=[]
        for s,rows in days:
            out += adapter.on_close(rows,{'K0':{'quantity':1}},0,0,0,'2020-02-01T00:00:00Z')
        self.assertEqual(len(signals),1)
        self.assertFalse(any(r['side']=='BUY' for r in out))

    def test_kospi_confirmation_keeps_rs_and_gate_not_holdings(self):
        days=data('K',[6.,8.,8.5],market='KOSPI')
        _,signals,_=collect('K',days)
        self.assertEqual(len(signals),1)
        self.assertEqual(signals[0]['origin_date'],'2020-01-03')
        self.assertEqual(signals[0]['confirmation_date'],'2020-01-06')
        for field,value in [('rs_accel',0.),('score',9.5)]:
            altered=deepcopy(days);altered[-1][1][0][field]=value
            self.assertEqual(collect('K',altered)[1],[])
        altered=deepcopy(days);altered[-1][1][0]['market_gate']['status']='RISK_OFF'
        self.assertEqual(collect('K',altered)[1],[])

    def test_etf_raw_onset_is_not_entry_until_next_confirmation(self):
        self.assertEqual(collect('E',data('E',[70.,80.]))[1],[])
        signals=collect('E',data('E',[70.,80.,85.]))[1]
        self.assertEqual(len(signals),1)
        self.assertEqual(signals[0]['origin_date'],'2020-01-03')
        self.assertEqual(signals[0]['confirmation_date'],'2020-01-06')

    def test_etf_original_nonportfolio_data_gates_retained(self):
        for field,value in [('annual_volatility',None),('average_trading_value20',None),
                            ('average_trading_value20',-1),('krx_batch_pending',True),
                            ('underlying_close',99.),('eligible',False),('score',79.)]:
            altered=data('E',[70.,80.,85.]);altered[-1][1][0][field]=value
            self.assertEqual(collect('E',altered)[1],[],field)

    def test_execution_price_and_budget_are_not_new_signal_gates(self):
        days=data('E',[70.,80.,85.])
        for _,rows in days:
            rows[0]['comparison_close']=None
            rows[0]['comparison_open']=None
        self.assertEqual(len(collect('E',days)[1]),1)
        adapter=FrozenIntentAdapter('ETF_V02')
        adapter.set_research_start('2020-01-02')
        orders=[]
        for s,rows in days:
            orders += adapter.on_close(rows,{},0,0,0,'2020-02-01T00:00:00Z',nav_complete=False)
        self.assertEqual(orders,[])

    def test_held_origin_suppressed_order_still_entry(self):
        days=data('E',[70.,80.,85.]);adapter=FrozenIntentAdapter('ETF_V02')
        out=[]
        for i,(s,rows) in enumerate(days):
            held={'E0':{'quantity':1}} if i==1 else {}
            out += adapter.on_close(rows,held,0,100,100,'2020-02-01T00:00:00Z')
        self.assertFalse(any(r['side']=='BUY' for r in out))
        self.assertEqual(len(collect('E',days)[1]),1)

    def test_us_all_entries_observed_before_twenty_slots(self):
        panels,calendars,_=fixtures.inputs();source=panels['U'].iloc[0].to_dict()
        days=[]
        for i in range(2):
            s=calendars['U'][i];rows=[]
            for j in range(300):
                rank=j+1 if i==0 else 300-j
                rows.append(dict(source,symbol=f'U{j:03}',session_date=s['session_date'],available_at=s['close_available_at'],
                                 ret120=float(rank),ret252=float(rank),beta60_spy=float(rank),ichimoku_tk_gap=float(rank)))
            days.append((s,rows))
        _,signals,_=collect('U',days)
        adapter=FrozenIntentAdapter('US_A0');out=[]
        for s,rows in days:
            out += adapter.on_close(rows,{},0,100000,100000,'2020-02-01T00:00:00Z')
        self.assertEqual(len(signals),30)
        self.assertEqual(sum(r['side']=='BUY' for r in out),20)

    def test_missing_whole_session_breaks_confirmation_adjacency(self):
        for engine,days in [('K',data('K',[6,8,8.5],market='KOSPI')),('E',data('E',[70,80,85]))]:
            days[1]=(days[1][0],[])
            _,signals,receipts=collect(engine,days)
            self.assertEqual(signals,[])
            self.assertEqual(receipts[1]['status'],'MISSING')

    def test_prestart_origin_does_not_leak_through_warmup(self):
        self.assertEqual(collect('E',data('E',[70,80,85]),start='2020-01-06')[1],[])

    def test_unavailable_or_duplicate_source_rejected(self):
        s,rows=data('K',[8.])[0]
        bad=deepcopy(rows);bad[0]['available_at']='2021-01-01T00:00:00Z'
        for data_rows in (bad,rows+rows):
            with self.assertRaises(ValueError):observe('K',data_rows,s,initial_state(),'2020-01-02')

    def test_input_state_and_rows_never_mutated(self):
        s,rows=data('K',[6.])[0];state=initial_state();before=deepcopy((rows,state))
        observe('K',rows,s,state,'2020-01-02')
        self.assertEqual((rows,state),before)

if __name__=='__main__':unittest.main()
