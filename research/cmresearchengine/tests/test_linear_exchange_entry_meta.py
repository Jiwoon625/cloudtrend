"""Regression tests for corporate-action successor holding metadata."""
from types import SimpleNamespace
import unittest

from cmresearchengine import runtime
runtime.activate()
from cm06_dated_action_dispatcher_v1 import _bind_successor_entry_meta


class LinearExchangeEntryMetaTests(unittest.TestCase):
    def event(self):
        return SimpleNamespace(
            kind="LINEAR_EXCHANGE",
            successor="NEW",
            legal_effective_date="2020-01-06",
        )

    def staged(self, entry_meta=None):
        return SimpleNamespace(
            ledger=SimpleNamespace(positions={("U","NEW"): object()}),
            entry_meta={} if entry_meta is None else entry_meta,
        )

    def test_new_successor_gets_fresh_us_entry_meta(self):
        staged=self.staged()
        _bind_successor_entry_meta(staged,self.event())
        self.assertEqual(staged.entry_meta[("U","NEW")],{
            "entry_date":"2020-01-06",
            "valid_bar_count":0,
            "market":"US",
        })

    def test_preexisting_successor_meta_is_not_overwritten(self):
        existing={"entry_date":"2019-12-01","valid_bar_count":12,"market":"US"}
        staged=self.staged({("U","NEW"):dict(existing)})
        _bind_successor_entry_meta(staged,self.event())
        self.assertEqual(staged.entry_meta[("U","NEW")],existing)

    def test_missing_successor_position_fails_closed(self):
        staged=SimpleNamespace(ledger=SimpleNamespace(positions={}),entry_meta={})
        with self.assertRaisesRegex(ValueError,"successor position missing"):
            _bind_successor_entry_meta(staged,self.event())


if __name__=="__main__":
    unittest.main()
