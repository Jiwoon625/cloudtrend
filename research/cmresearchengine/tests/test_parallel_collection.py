"""Regression tests for deterministic parallel candidate receipt collection."""
from concurrent.futures import Future
from types import SimpleNamespace
import unittest

from cmresearchengine.cli import (
    _hybrid_pairs,
    _ordered_parallel_receipts,
    _parallel_future_receipt,
    _parallel_not_started_receipt,
    _parallel_pair_exception_receipts,
)


def candidate(candidate_id):
    return SimpleNamespace(candidate_id=candidate_id)


class ParallelReceiptCollectionTests(unittest.TestCase):
    def test_child_exception_is_attributed_without_hiding_sibling_terminal_state(self):
        failed = Future()
        failed.set_exception(TypeError("synthetic"))
        paused = Future()
        paused.set_result({
            "status": "PAUSED_VERIFIED",
            "processed_events": 123,
            "checkpoint_sequence": 7,
        })
        s03, s04 = candidate("S03"), candidate("S04")
        failed_receipt, failed_parent_only = _parallel_future_receipt(failed, s03)
        paused_receipt, paused_parent_only = _parallel_future_receipt(paused, s04)
        self.assertTrue(failed_parent_only)
        self.assertFalse(paused_parent_only)
        self.assertEqual(failed_receipt["status"], "WORKER_EXCEPTION")
        self.assertEqual(failed_receipt["candidate_id"], "S03")
        self.assertEqual(failed_receipt["error_type"], "TypeError")
        ordered = _ordered_parallel_receipts(
            [s03, s04],
            {"S04": paused_receipt, "S03": failed_receipt},
        )
        self.assertEqual(
            [receipt["status"] for receipt in ordered],
            ["WORKER_EXCEPTION", "PAUSED_VERIFIED"],
        )

    def test_deadline_candidates_receive_explicit_receipts_and_order_is_preserved(self):
        selected = [candidate("S01"), candidate("S02"), candidate("S03")]
        receipts = {
            "S01": {
                "status": "COMPLETED_VERIFIED",
                "processed_events": 456,
                "checkpoint_sequence": 9,
            }
        }
        for item in selected[1:]:
            receipts[item.candidate_id] = _parallel_not_started_receipt(
                item, "NOT_STARTED_DEADLINE"
            )
        ordered = _ordered_parallel_receipts(selected, receipts)
        self.assertEqual(
            [receipt["status"] for receipt in ordered],
            ["COMPLETED_VERIFIED", "NOT_STARTED_DEADLINE", "NOT_STARTED_DEADLINE"],
        )

    def test_missing_candidate_receipt_fails_closed_instead_of_silent_omission(self):
        selected = [candidate("S01"), candidate("S02")]
        with self.assertRaisesRegex(RuntimeError, "S02"):
            _ordered_parallel_receipts(
                selected,
                {"S01": {"status": "COMPLETED_VERIFIED"}},
            )

    def test_hybrid_pairing_is_deterministic_and_complete(self):
        selected=[candidate("S01"),candidate("S02"),candidate("S03"),candidate("S04")]
        pairs=_hybrid_pairs(selected)
        self.assertEqual([[x.candidate_id for x in pair] for pair in pairs],
            [["S01","S02"],["S03","S04"]])
        with self.assertRaises(ValueError):_hybrid_pairs(selected[:3])

    def test_pair_exception_attributes_both_candidates(self):
        pair=(candidate("S01"),candidate("S02"))
        receipts=_parallel_pair_exception_receipts(pair,TypeError("synthetic"))
        self.assertEqual([r["candidate_id"] for r in receipts],["S01","S02"])
        self.assertEqual({r["status"] for r in receipts},{"WORKER_EXCEPTION"})
        self.assertEqual({r["error_type"] for r in receipts},{"TypeError"})


if __name__ == "__main__":
    unittest.main()
