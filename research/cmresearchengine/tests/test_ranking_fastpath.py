"""Regression tests for the exact Python CM percentile ranking contract."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from cmresearchengine import runtime
runtime.activate()
from cm06_comparison_signals import percentile_rank


class ExactRankingTests(unittest.TestCase):
    def test_tie_average_and_symbol_order_contract(self):
        pairs=[("D",2.0),("B",1.0),("C",2.0),("A",1.0)]
        self.assertEqual(percentile_rank(pairs),{
            "A":1/6,"B":1/6,"C":5/6,"D":5/6,
        })

    def test_single_value_is_one(self):
        self.assertEqual(percentile_rank([("A",7.0)]),{"A":1.0})


if __name__=="__main__":
    unittest.main()
