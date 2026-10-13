"""Read-only predecessor routing; no network, credentials or runtime artifacts."""
import unittest
from pathlib import Path

NS = {}
exec(compile((Path(__file__).parent / 'runtime/helpers/us_archive.py').read_text(), 'us_archive.py', 'exec'), NS)

class CurrentUsLedgerBoundaryTests(unittest.TestCase):
    def fixture(self, date='2026-10-12', mismatch=False):
        api = object.__new__(NS['UsArchiveApi'])
        calls = []
        def rows(table, params):
            calls.append((table, params))
            if table == 'us_screening_history': return [{'date': date}]
            if table == 'us_portfolio_snapshots': return [{'date': date}]
            return [{'session_date': '2026-10-09' if mismatch else date}]
        api.rows = rows
        return api, calls
    def test_current_base_uses_exact_restart_books_and_completion_marker(self):
        api, calls = self.fixture()
        self.assertEqual(api.common_base(), '2026-10-12')
        self.assertFalse(any(table == 'us_portfolio_snapshots' for table, _ in calls))
        books = [params['series_id'] for table, params in calls if table == 'ledger_model_sessions']
        self.assertEqual(books, ['eq.adopted-shadow-2026-10-12-v1:' + x for x in ('US_A0','US_A2','US_B3')])
    def test_current_mismatch_does_not_fall_back_to_legacy(self):
        api, calls = self.fixture(mismatch=True)
        with self.assertRaisesRegex(RuntimeError, 'dates differ'): api.common_base()
        self.assertFalse(any(table == 'us_portfolio_snapshots' for table, _ in calls))
    def test_historical_base_remains_available(self):
        api, calls = self.fixture(date='2026-10-09')
        self.assertEqual(api.common_base(), '2026-10-09')
        self.assertEqual(sum(table == 'us_portfolio_snapshots' for table, _ in calls), 4)
    def test_missing_history_is_not_zero_or_legacy(self):
        api, _ = self.fixture()
        api.rows = lambda *args: []
        with self.assertRaisesRegex(RuntimeError, 'no verified predecessor'): api.common_base()

if __name__ == '__main__': unittest.main()
