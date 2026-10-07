"""Shared full-US-analysis parity and fail-closed regressions."""
from copy import deepcopy
import unittest
from fixtures import inputs
from cm06_comparison_signals import FrozenIntentAdapter,us_session_analysis
from cm06_shared_us_analysis_v1 import (
    activate_shared_us_analysis,deactivate_shared_us_analysis,shared_us_analysis_stats,
)

BINDING={'schema':'CM_EXECUTION_OPTIMIZATION_V1','mode':'LOCKSTEP_SHARED_US_ANALYSIS_V1',
    'shared_panels':'READ_ONLY_SAME_INPUT_OBJECTS','candidate_state':'FULLY_INDEPENDENT'}

class SharedUSAnalysisTests(unittest.TestCase):
    def tearDown(self):deactivate_shared_us_analysis()
    def _rows(self,day_index=0):
        panels,_,_=inputs();day=sorted(panels['U'].session_date.unique())[day_index]
        return panels['U'].loc[panels['U'].session_date.eq(day)].to_dict('records')
    def test_same_session_and_prior_state_hits_exact_same_analysis(self):
        rows=self._rows();baseline=us_session_analysis(rows,{})
        activate_shared_us_analysis(BINDING)
        first=us_session_analysis(rows,{})
        second=us_session_analysis([dict(row) for row in rows],{})
        self.assertEqual(first,baseline);self.assertEqual(second,baseline)
        stats=shared_us_analysis_stats()
        self.assertEqual((stats['misses'],stats['hits'],stats['row_checks']),(1,1,1))
        self.assertEqual(stats['max_cached_rows'],len(rows))
    def test_same_date_input_divergence_fails_closed(self):
        rows=self._rows();activate_shared_us_analysis(BINDING);us_session_analysis(rows,{})
        changed=deepcopy(rows);changed[0]['ret120']+=1
        with self.assertRaisesRegex(ValueError,'rows diverged'):us_session_analysis(changed,{})
    def test_candidate_us_state_is_copied_not_shared(self):
        rows=self._rows();activate_shared_us_analysis(BINDING)
        first=FrozenIntentAdapter('US_A0');second=FrozenIntentAdapter('US_A0')
        next_open='2020-01-03T14:30:00+00:00';decision='2020-01-03T00:00:00+00:00'
        first.on_close(rows,{},100000.,100000.,100000.,next_open,decision_at=decision)
        second.on_close(rows,{},100000.,100000.,100000.,next_open,decision_at=decision)
        self.assertEqual(first.us_state,second.us_state);self.assertIsNot(first.us_state,second.us_state)
        self.assertIsNot(first.us_state['coreRanks'],second.us_state['coreRanks'])
        self.assertIsNot(first.us_state['betaWeakStreak'],second.us_state['betaWeakStreak'])

if __name__=='__main__':unittest.main()
