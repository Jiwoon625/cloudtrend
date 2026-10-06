"""Regression tests for deterministic parallel candidate receipt collection."""
from concurrent.futures import Future
from types import SimpleNamespace
import unittest

from cmresearchengine.cli import (
    _ordered_parallel_receipts,
    _parallel_future_receipt,
    _parallel_not_started_receipt,
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


if __name__ == "__main__":
    unittest.main()
