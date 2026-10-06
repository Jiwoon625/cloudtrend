"""Regression tests for shared US rank cache."""
from pathlib import Path
import tempfile
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cmresearchengine import runtime
runtime.activate()

import cm06_comparison_signals as signals
from cmresearchengine.us_shared_rank_cache import SharedUSRankCache


class SharedRankCacheTests(unittest.TestCase):
    def test_shared_rank_cache_preserves_exact_us_analysis(self):
        data = []
        for i, symbol in enumerate(("A", "B", "C", "SPY")):
            data.append({
                "date": "2026-01-05",
                "symbol": symbol,
                "researchCommonSnapshot": True,
                "researchExchangeEligible": True,
                "status": "ACTIVE",
                "close": 100.0 + i,
                "ret120": 0.10 + i * 0.01,
                "ret252": 0.20 + i * 0.02,
                "beta60Spy": 1.0 + i * 0.03,
                "ichimokuTkGap": 0.3 + i * 0.04,
                "relvol1_20": 1.1 + i * 0.05,
                "adv20Usd": 2000000.0 + i * 1000,
                "amihud20": 0.0001 + i * 0.00001,
                "active20": True,
            })
        previous = {
            "lastDate": "2026-01-02",
            "coreRanks": {"A": 0.1, "B": 0.2, "C": 0.3},
            "betaWeakStreak": {"A": 2, "B": 0, "C": 1},
        }
        expected_empty = signals.us_analysis(data, {})
        expected_previous = signals.us_analysis(data, previous)
        with tempfile.TemporaryDirectory() as directory:
            first = SharedUSRankCache(directory, "S01", ("S01", "S02"))
            second = SharedUSRankCache(directory, "S02", ("S01", "S02"))
            self.assertEqual(
                first.analyze(signals, signals.us_analysis, data, {}),
                expected_empty,
            )
            self.assertEqual(
                second.analyze(signals, signals.us_analysis, data, previous),
                expected_previous,
            )
            self.assertEqual(first.stats()["misses"], 1)
            self.assertEqual(first.stats()["rank_calls_computed"], 8)
            self.assertEqual(second.stats()["hits"], 1)
            self.assertEqual(second.stats()["rank_calls_replayed"], 8)


if __name__ == "__main__":
    unittest.main()
