"""Rollback optimization gates; fixtures are synthetic, never live holdings."""
import io
import json
import random
import unittest
import zipfile
from copy import deepcopy
from decimal import Decimal, getcontext, setcontext
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
from fixtures import make, identity
from cmresearchengine.immutable_session_rows import freeze_us_session_rows, _ReadOnlyDict
from cmresearchengine.runner import serialize_result
from cmresearchengine.replay import ResearchReplay
from cm06_comparison_execution import Replay as BaseReplay
from cm06_exact_units_resume_state_v1 import encode, decode, canonical
from cm06_fresh_codec_v1 import pack, restore
from cm06.registry import candidate_by_id
from test_research_regressions import stop_before


class ImmutableRowsTests(unittest.TestCase):
    def test_order_values_and_codec_are_exact(self):
        rows = {'B': {'symbol': 'B', 'close': Decimal('2.3000'), 'v': np.int64(8)},
                'A': {'symbol': 'A', 'close': float('nan'), 'v': None}}
        frozen = freeze_us_session_rows(rows)
        self.assertIs(type(frozen), _ReadOnlyDict)
        self.assertEqual(canonical(encode(frozen)), canonical(encode(rows)))
        self.assertEqual(list(frozen), ['B', 'A'])
        self.assertEqual(canonical(encode(decode(encode(frozen)))), canonical(encode(rows)))

    def test_deepcopy_reuses_only_readonly_maps(self):
        rows = {'A': {'symbol': 'A', 'close': 1.0}}
        frozen = freeze_us_session_rows(rows)
        self.assertIs(deepcopy(frozen), frozen)
        self.assertIs(deepcopy(frozen['A']), frozen['A'])
        self.assertIs(freeze_us_session_rows(frozen), frozen)
        self.assertIsNot(frozen, rows)
        self.assertIsNot(frozen['A'], rows['A'])

    def test_source_changes_cannot_mutate_snapshot(self):
        rows = {'A': {'symbol': 'A', 'close': 1.0}}
        frozen = freeze_us_session_rows(rows)
        rows['A']['close'] = 7.0
        rows['B'] = {'symbol': 'B'}
        self.assertEqual(frozen, {'A': {'symbol': 'A', 'close': 1.0}})

    def test_mutation_methods_are_blocked_on_both_levels(self):
        frozen = freeze_us_session_rows({'A': {'symbol': 'A', 'close': 1.0}})
        operations = (
            lambda obj: obj.__setitem__('x', 1),
            lambda obj: obj.__delitem__('x'),
            lambda obj: obj.clear(),
            lambda obj: obj.pop('x', None),
            lambda obj: obj.popitem(),
            lambda obj: obj.setdefault('x', 1),
            lambda obj: obj.update({'x': 1}),
            lambda obj: obj.__ior__({'x': 1}),
        )
        for obj in (frozen, frozen['A']):
            for operation in operations:
                with self.assertRaises(TypeError):
                    operation(obj)
            before = canonical(encode(obj))
            obj.__init__({'x': 1})
            self.assertEqual(canonical(encode(obj)), before)

    def test_mutable_or_unknown_payload_retains_legacy_deepcopy(self):
        for value in ([], {}, np.array([1, 2]), object()):
            rows = {'A': {'symbol': 'A', 'nested': value}}
            self.assertIs(freeze_us_session_rows(rows), rows)
            self.assertIsNot(deepcopy(rows), rows)
        with self.assertRaises(TypeError):
            _ReadOnlyDict({'mutable': []})

    def test_candidate_maps_are_independent_and_empty_safe(self):
        source = {'A': {'symbol': 'A', 'close': 1.0}}
        a = freeze_us_session_rows(source)
        b = freeze_us_session_rows(source)
        self.assertIsNot(a, b)
        self.assertIsNot(a['A'], b['A'])
        self.assertEqual(a, b)
        self.assertEqual(freeze_us_session_rows({}), {})


class RollbackIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.python_state = random.getstate()
        self.numpy_state = np.random.get_state()
        self.decimal_state = getcontext().copy()

    def tearDown(self):
        random.setstate(self.python_state)
        np.random.set_state(self.numpy_state)
        setcontext(self.decimal_state)

    def reset_context(self):
        random.setstate(self.python_state)
        np.random.set_state(self.numpy_state)
        setcontext(self.decimal_state.copy())

    def test_s01_s04_complete_archives_match_legacy_deepcopy(self):
        for candidate_id in ('S01', 'S02', 'S03', 'S04'):
            with self.subTest(candidate=candidate_id):
                self.reset_context()
                with patch('cmresearchengine.replay.freeze_us_session_rows', side_effect=lambda rows: rows):
                    old = make(candidate_by_id(candidate_id))
                    old.run()
                    expected = serialize_result(old)
                self.reset_context()
                new = make(candidate_by_id(candidate_id))
                new.run()
                self.assertEqual(serialize_result(new), expected)

    def test_every_event_checkpoint_matches_legacy_bytes(self):
        self.reset_context()
        with patch('cmresearchengine.replay.freeze_us_session_rows', side_effect=lambda rows: rows):
            old = make()
            old_identity = identity(old)
            expected = []
            while old.step():
                expected.append(pack(old, old_identity))
        self.reset_context()
        new = make()
        bound = identity(new)
        index = 0
        while new.step():
            self.assertEqual(pack(new, bound), expected[index])
            index += 1
        self.assertEqual(index, len(expected))

    def test_every_event_restore_preserves_complete_archive(self):
        self.reset_context()
        full = make()
        full.run()
        expected = serialize_result(full)
        self.reset_context()
        runner = make()
        bound = identity(runner)
        while runner.step():
            runner = restore(make(), pack(runner, bound), bound)
        self.assertEqual(serialize_result(runner), expected)

    def fail_after_event(self, kind):
        runner = make()
        stop_before(runner, kind, 'U', '2020-01-06')
        if kind == 'CLOSE':
            # No economic action: enable the host's existing CLOSE transaction
            # boundary using a synthetic no-op bridge.
            runner.entitlement_bridge = SimpleNamespace(
                resolve_close=lambda *args: None,
                nontradable_symbols=lambda *args: frozenset())
        bound = identity(runner)
        before = pack(runner, bound)
        original = getattr(BaseReplay, '_' + kind.lower())

        def failing(instance, engine, session):
            result = original(instance, engine, session)
            if engine == 'U':
                currency = next(iter(instance.ledger.cash))
                instance.ledger.cash[currency] += Decimal('1')
                instance.adapters['U'].pending['fault'] = {'side': 'BUY'}
                instance.bridge_pending['fault'] = {'quantity': '1'}
                instance.latest_rows['U'] = {'FAULT': {'symbol': 'FAULT'}}
                random.random()
                np.random.random()
                getcontext().prec = 9
                raise RuntimeError('SYNTHETIC_ROLLBACK_FAULT')
            return result

        with patch.object(BaseReplay, '_' + kind.lower(), failing):
            with self.assertRaisesRegex(RuntimeError, 'SYNTHETIC_ROLLBACK_FAULT') as caught:
                runner.step()
        self.assertTrue(caught.exception.atomic_event_rollback_verified)
        self.assertEqual(pack(runner, bound), before)

    def test_failed_us_open_restores_state_rng_decimal_and_checkpoint(self):
        self.fail_after_event('OPEN')

    def test_failed_us_close_restores_state_rng_decimal_and_checkpoint(self):
        self.fail_after_event('CLOSE')


if __name__ == '__main__':
    unittest.main()
