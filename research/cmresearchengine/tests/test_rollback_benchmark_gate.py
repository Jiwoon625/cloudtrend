"""Fail closed on incomplete or inconsistent benchmark receipts."""
import json
import unittest
from verify_rollback_benchmark import verify_receipts

def sample():
    rows = [dict(status='PAUSED_VERIFIED', candidate_id=cid, processed_events=400,
                 checkpoint_sequence=2) for cid in ('S01', 'S02', 'S03', 'S04')]
    rows += [dict(status='HYBRID_US_ANALYSIS_GROUP_VERIFIED', group_index=i,
                  hits=10, misses=10, row_checks=10, max_cached_rows=40) for i in (0, 1)]
    rows += [dict(status='HYBRID_US_ANALYSIS_VERIFIED', groups=2,
                  hits=20, misses=20, row_checks=20, max_cached_rows=40),
             dict(status='BATCH_VERIFIED', selected_count=4, terminal_receipts_collected=4,
                  worker_exceptions=0, not_started=0, parallel_workers=2, hybrid_2x2=True,
                  completed_in_selected_batch=0, remaining_in_selected_batch=4)]
    return rows

def text(rows):
    return '\n'.join(json.dumps(row) for row in rows)

class BenchmarkReceiptTests(unittest.TestCase):
    def test_clean_cap_pause(self):
        self.assertEqual(verify_receipts(text(sample())), 0)

    def test_missing_duplicate_or_exception_receipt_rejected(self):
        rows = sample()
        with self.assertRaises(ValueError): verify_receipts(text(rows[1:]))
        with self.assertRaises(ValueError): verify_receipts(text(rows+[rows[0]]))
        rows[0]['status'] = 'WORKER_EXCEPTION'
        with self.assertRaises(ValueError): verify_receipts(text(rows))

    def test_batch_and_combined_stat_inconsistency_rejected(self):
        rows = sample()
        rows[-1]['worker_exceptions'] = 1
        with self.assertRaises(ValueError): verify_receipts(text(rows))
        rows = sample()
        rows[-2]['hits'] = 21
        with self.assertRaises(ValueError): verify_receipts(text(rows))
