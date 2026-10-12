from copy import deepcopy
from datetime import date
import unittest
import pandas as pd
from o3_policy import target, options, PROPOSED_OPTIONS


def inputs(start='2020-01-01', end='2020-03-03'):
    calendars, observations = {}, []
    for e in 'KEU':
        calendars[e] = []
        for d in pd.bdate_range('2019-12-27', end, tz='UTC'):
            session = {'session_date':d.date().isoformat(),
                'open_at':(d + pd.Timedelta(hours=14 if e=='U' else 0)).isoformat(),
                'close_available_at':(d + pd.Timedelta(hours=21 if e=='U' else 7)).isoformat()}
            calendars[e].append(session)
            if session['session_date'] >= start:
                observations.append({'engine':e,'session_date':session['session_date'],
                    'available_at':session['close_available_at'],'status':'COMPLETE'})
    return calendars, observations


def signal(e, symbol, origin='2020-01-02', confirmed='2020-01-03', available=None):
    return {'engine':e,'symbol':symbol,'origin_date':origin,'confirmation_date':confirmed,
            'available_at':available or confirmed + ('T21:00:00Z' if e=='U' else 'T07:00:00Z'),
            'reason':'ENTRY'}


class EntryPolicy(unittest.TestCase):
    def setUp(self):
        self.cal, self.obs = inputs()
        self.signals = [signal(e,e+str(i)) for e,n in {'K':8,'E':1,'U':1}.items() for i in range(n)]

    def run_target(self, **overrides):
        args=dict(month='2020-01',cutoff='2020-01-31T21:00:00Z',signals=self.signals,
                  calendars=self.cal,observations=self.obs,start_date='2020-01-01')
        args.update(overrides)
        return target(**args)

    def test_count_proportion_cap_and_cash(self):
        result=self.run_target()
        self.assertEqual(result['diagnostics']['unique_entry_counts'],{'K':8,'E':1,'U':1})
        self.assertEqual(result['weights']['K'],.6)
        self.assertAlmostEqual(result['weights']['C'],.2)

    def test_holdings_cash_budget_and_fill_fields_do_not_affect_counts(self):
        other=[dict(s,held=True,cash=0,slots=0,desired_amount=0,filled=False) for s in self.signals]
        self.assertEqual(self.run_target(signals=other),self.run_target())

    def test_global_origin_dedup_before_month_selection(self):
        first=signal('K','retry','2019-12-30','2019-12-31')
        second=signal('K','retry','2019-12-30','2020-01-02')
        result=self.run_target(signals=[second,first],start_date='2019-12-01')
        self.assertEqual(result['diagnostics']['unique_entry_counts']['K'],0)

    def test_same_symbol_distinct_origin_is_new_signal(self):
        rows=[signal('K','same'),signal('K','same','2020-01-06','2020-01-07')]
        self.assertEqual(self.run_target(signals=rows)['diagnostics']['unique_entry_counts']['K'],2)

    def test_duplicate_delivery_same_origin_different_reason_once(self):
        row=signal('K','A')
        self.assertEqual(self.run_target(signals=[row,dict(row,reason='retry')])['diagnostics']['total_entries'],1)

    def test_market_identity_is_part_of_key(self):
        rows=[signal(e,'same') for e in 'KEU']
        self.assertEqual(self.run_target(signals=rows)['diagnostics']['total_entries'],3)

    def test_origin_last_month_confirmation_this_month_counts_this_month(self):
        row=signal('K','A','2019-12-31','2020-01-01')
        result=self.run_target(signals=[row],start_date='2019-12-01')
        self.assertEqual(result['diagnostics']['total_entries'],1)

    def test_confirmation_decides_month_despite_utc_delivery_next_day(self):
        row=signal('U','A','2020-01-30','2020-01-31','2020-02-01T01:00:00Z')
        before=self.run_target(signals=[row])
        after=self.run_target(signals=[row],cutoff='2020-02-01T01:00:00Z')
        self.assertEqual(before['diagnostics']['total_entries'],0)
        self.assertEqual(after['diagnostics']['total_entries'],1)

    def test_complete_zero_month_proposal_all_cash(self):
        self.assertEqual(self.run_target(signals=[])['weights'],{'K':0,'E':0,'U':0,'C':1})

    def test_partial_research_prefix_is_valid_without_prestart_data(self):
        cal,obs=inputs(start='2020-01-20')
        row=signal('K','A','2020-01-20','2020-01-21')
        result=self.run_target(signals=[row],calendars=cal,observations=obs,start_date='2020-01-20')
        self.assertFalse(result['diagnostics']['fallback'])
        self.assertTrue(result['diagnostics']['partial_start_month'])
        self.assertEqual(result['diagnostics']['total_entries'],1)

    def test_missing_session_inside_partial_prefix_holds_previous(self):
        cal,obs=inputs(start='2020-01-20')
        obs=[x for x in obs if not (x['engine']=='U' and x['session_date']=='2020-01-22')]
        result=self.run_target(signals=[],calendars=cal,observations=obs,start_date='2020-01-20')
        self.assertTrue(result['diagnostics']['fallback'])
        self.assertEqual(result['weights'],PROPOSED_OPTIONS['initial_weights'])

    def test_prestart_origin_not_new_entry_after_start(self):
        row=signal('K','A','2019-12-31','2020-01-01')
        self.assertEqual(self.run_target(signals=[row])['diagnostics']['total_entries'],0)

    def test_explicit_missing_session_is_not_zero_signals(self):
        self.obs[10]['status']='MISSING'
        result=self.run_target(signals=[])
        self.assertTrue(result['diagnostics']['fallback'])
        self.assertEqual(result['weights']['C'],0)

    def test_prior_target_preserved_when_data_missing(self):
        prior={'K':.4,'E':.3,'U':.2,'C':.1}
        self.assertEqual(self.run_target(observations=[],previous=prior)['weights'],prior)

    def test_review_before_all_market_closes_holds(self):
        self.assertTrue(self.run_target(cutoff='2020-01-31T20:59:59Z')['diagnostics']['fallback'])

    def test_review_cannot_apply_at_or_after_next_open(self):
        self.assertTrue(self.run_target(cutoff='2020-02-03T00:00:00Z')['diagnostics']['fallback'])

    def test_weekend_month_end_accepts_last_regular_session(self):
        result=target('2020-02','2020-02-29T12:00:00Z',[],self.cal,self.obs,'2020-01-01')
        self.assertFalse(result['diagnostics']['fallback'])
        self.assertEqual(result['diagnostics']['source_month_sessions']['K']['last'],'2020-02-28')

    def test_policy_choices_remain_testable_not_assumed_approved(self):
        no_cap={**PROPOSED_OPTIONS,'cap':None}
        self.assertEqual(self.run_target(policy_options=no_cap)['weights']['K'],.8)
        keep={**PROPOSED_OPTIONS,'zero_signal_month':'KEEP_PREVIOUS'}
        self.assertEqual(self.run_target(signals=[],policy_options=keep)['weights'],keep['initial_weights'])
        hold={**PROPOSED_OPTIONS,'first_partial_month':'HOLD_PRIOR_FULL_MONTH'}
        self.assertTrue(self.run_target(start_date='2020-01-20',policy_options=hold)['diagnostics']['fallback'])

    def test_demand_schema_cannot_be_substituted(self):
        self.assertTrue(self.run_target(signals=[{'engine':'K','demand_id':'A','available_at':'2020-01-03T00:00:00Z'}])['diagnostics']['fallback'])

    def test_invalid_and_conflicting_observations_hold(self):
        conflict=dict(self.obs[0],status='MISSING')
        self.assertTrue(self.run_target(observations=self.obs+[conflict])['diagnostics']['fallback'])
        self.assertTrue(self.run_target(cutoff='2020-01-31')['diagnostics']['fallback'])

    def test_boundary_options_validation(self):
        for change in ({'cap':True},{'cap':float('nan')},{'cap':0},{'first_partial_month':'guess'}):
            with self.assertRaises(ValueError):options({**PROPOSED_OPTIONS,**change})

if __name__=='__main__':unittest.main()
