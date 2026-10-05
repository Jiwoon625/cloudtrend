"""Exact parity tests for the vectorized CM US ranking fast-path."""
from pathlib import Path
import random
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from cmresearchengine import runtime
runtime.activate()
import cm06_comparison_signals as signals


class RankingFastPathTests(unittest.TestCase):
    def test_percentile_rank_matches_reference_with_ties(self):
        rng=random.Random(20261006)
        for n in (2,3,10,101,1000):
            for _ in range(8):
                pairs=[(f"S{i:04d}",rng.choice([-3.5,-1.0,0.0,0.0,1.25,4.0])+rng.choice([0,0,0,0.5]))
                       for i in range(n)]
                self.assertEqual(signals.percentile_rank(pairs),signals._percentile_rank_reference(pairs))

    def test_precision_sensitive_values_fall_back_exactly(self):
        pairs=[("A",2**53+1),("B",2**53+2),("C",0)]
        self.assertEqual(signals.percentile_rank(pairs),signals._percentile_rank_reference(pairs))

    def test_full_us_analysis_is_identical_to_reference_ranker(self):
        rows=[]
        for i in range(250):
            rows.append({
                "date":"2024-01-03","symbol":f"S{i:04d}",
                "researchCommonSnapshot":True,"researchExchangeEligible":True,
                "status":"ACTIVE","close":100+i/10,
                "ret120":(i%31-15)/100,"ret252":(i%47-23)/100,
                "beta60Spy":(i%19)/10,"ichimokuTkGap":(i%23-11)/20,
                "relvol1_20":(i%17)/7,"adv20Usd":500000+(i%29)*10000,
                "amihud20":(i%13)/100000,"active20":True,
            })
        rows.append({
            "date":"2024-01-03","symbol":"SPY",
            "researchCommonSnapshot":True,"researchExchangeEligible":True,
            "status":"ACTIVE","close":400.0,"ret120":0.1,"ret252":0.2,
            "beta60Spy":1.0,"ichimokuTkGap":0.1,"relvol1_20":1.0,
            "adv20Usd":1e9,"amihud20":0.0,"active20":True,
        })
        previous={"lastDate":"2024-01-02",
                  "coreRanks":{f"S{i:04d}":(i%100)/100 for i in range(250)},
                  "betaWeakStreak":{f"S{i:04d}":i%4 for i in range(250)}}
        fast=signals.us_analysis(rows,previous)
        with patch.object(signals,"percentile_rank",signals._percentile_rank_reference):
            reference=signals.us_analysis(rows,previous)
        self.assertEqual(fast,reference)


if __name__=="__main__":
    unittest.main()
