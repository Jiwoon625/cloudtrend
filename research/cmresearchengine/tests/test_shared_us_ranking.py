"""Exact parity and fail-closed tests for shared US cross-sectional ranks."""
from pathlib import Path
from unittest.mock import patch
import os,tempfile,unittest
from fixtures import inputs
from cmresearchengine import runtime
runtime.activate()
from cmresearchengine.shared_us import write_shared_us_rank_cache
from cm06_comparison_signals import normalized_us_row,us_analysis
from cm06_shared_us_ranking_v1 import ENV,reset_shared_us_rank_cache,shared_rank_binding_from_env

class SharedUSRankingTests(unittest.TestCase):
    def _days(self):
        panels,_,_=inputs();out=[]
        for date in sorted(panels["U"].session_date.unique())[:3]:
            rows=panels["U"].loc[panels["U"].session_date.eq(date)].to_dict("records")
            out.append((date,[normalized_us_row(row) for row in rows]))
        return out
    def test_cached_analysis_is_exactly_equal_to_uncached_analysis(self):
        days=self._days()
        with patch.dict(os.environ,{ENV:""},clear=False):
            reset_shared_us_rank_cache();previous={};expected=[]
            for _,rows in days:
                result=us_analysis(rows,previous);expected.append(result);previous=result["state"]
        with tempfile.TemporaryDirectory() as directory:
            binding={"scope":"SYNTHETIC_ONLY","source":"fixture-v1"}
            cache=write_shared_us_rank_cache(days,Path(directory)/"cache",binding)
            with patch.dict(os.environ,{ENV:cache["manifest_path"]},clear=False):
                reset_shared_us_rank_cache();self.assertEqual(shared_rank_binding_from_env(),binding)
                previous={};actual=[]
                for _,rows in days:
                    result=us_analysis(rows,previous);actual.append(result);previous=result["state"]
                self.assertEqual(actual,expected)
            reset_shared_us_rank_cache()
    def test_cache_fails_closed_when_session_symbols_change(self):
        days=self._days()
        with tempfile.TemporaryDirectory() as directory:
            cache=write_shared_us_rank_cache(days,Path(directory)/"cache",{"scope":"SYNTHETIC_ONLY","source":"fixture-v1"})
            bad=[dict(row) for row in days[0][1]];bad[0]["symbol"]="UNEXPECTED"
            with patch.dict(os.environ,{ENV:cache["manifest_path"]},clear=False):
                reset_shared_us_rank_cache()
                with self.assertRaisesRegex(ValueError,"symbols differ"):us_analysis(bad,{})
            reset_shared_us_rank_cache()

if __name__=="__main__":unittest.main()
