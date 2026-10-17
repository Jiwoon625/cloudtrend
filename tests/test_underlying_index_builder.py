"""The offline extractor accepts Arrow logical dates without changing their day."""
import importlib.util
import unittest
from datetime import date, datetime, timezone
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    'index_builder', Path(__file__).parents[1] / 'scripts/build-underlying-index-supplement.py'
)
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class SourceDateTests(unittest.TestCase):
    def test_equivalent_types_have_identical_cutoff(self):
        for value in [date(2026, 10, 16), datetime(2026, 10, 16),
                      datetime(2026, 10, 16, tzinfo=timezone.utc),
                      '2026-10-16', '2026-10-16 00:00:00', '2026-10-16T00:00:00Z']:
            with self.subTest(value=value):
                self.assertEqual(builder.normalize_source_date(value), '2026-10-16')

    def test_mixed_calendar_dates_can_be_sorted_and_compared(self):
        dates = [datetime(2026, 10, 15), '2026-10-14', date(2026, 10, 16)]
        normalized = sorted(map(builder.normalize_source_date, dates))
        self.assertEqual(normalized, ['2026-10-14', '2026-10-15', '2026-10-16'])
        self.assertGreater(builder.normalize_source_date(datetime(2026, 10, 17)), '2026-10-16')

    def test_invalid_dates_are_rejected(self):
        for value in [None, 20261016, '', '2026-02-30', 'NaT']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                builder.normalize_source_date(value)


if __name__ == '__main__':
    unittest.main()
