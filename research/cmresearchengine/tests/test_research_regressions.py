"""Focused synthetic regressions, independent of licensed historical data.

These exercise research exception behavior and strategy plumbing, not historical
PIT fidelity, actual fills, or performance parity with the production engine.
"""
import io
import json
import tempfile
import unittest
import zipfile
from copy import deepcopy
import pandas as pd
from pandas.testing import assert_frame_equal

from fixtures import H, identity, inputs, make
from cmresearchengine.plan import candidates
from cmresearchengine.replay import ResearchReplay
from cmresearchengine.runner import build_references, serialize_result
from cm06.accounting import dec, trading_fee
from cm06_comparison_execution import ExecutionContract
from cm06_dated_action_contract_v1 import ActionRegistry, StableInstrumentIdentityMap
from cm06_fresh_codec_v1 import pack, restore
from cm06_fresh_host_v1 import CandidateHazard
from cm06_us_cash_t5_policy_v1 import USSessionCalendar


def stop_before(runner, kind, engine, day=None):
    while runner.queue:
        event = runner.queue[0]
        if event[3:5] == (kind, engine) and (day is None or event[5]['session_date'] == day):
            return
        if not runner.step():
            break
    raise AssertionError('Requested synthetic event was not found')


def held_us_close():
    runner = make()
    while runner.queue:
        if runner.queue[0][3:5] == ('CLOSE', 'U') and runner._holdings('U'):
            return runner
        runner.step()
    raise AssertionError('Synthetic US entry was not filled')


def files_for(runner):
    with zipfile.ZipFile(io.BytesIO(serialize_result(runner))) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


def monthly_runner(candidate, references=None):
    """One complete business-month including a real scheduled monthly REVIEW."""
    source, _, fx = inputs()
    dates = pd.bdate_range('2020-01-02', '2020-02-05').strftime('%Y-%m-%d').tolist()
    calendars = {engine: [dict(session_date=day,
        open_at=day + ('T14:30:00Z' if engine == 'U' else 'T00:00:00Z'),
        close_available_at=day + ('T21:01:00Z' if engine == 'U' else 'T06:31:00Z'))
        for day in dates] for engine in 'KEU'}
    panels = {}
    for engine in 'KEU':
        chunks = []
        original_days = source[engine].session_date.unique()
        for index, session in enumerate(calendars[engine]):
            frame = source[engine].loc[source[engine].session_date.eq(original_days[index % len(original_days)])].copy()
            frame['session_date'] = session['session_date']
            frame['available_at'] = session['close_available_at']
            chunks.append(frame)
        panels[engine] = pd.concat(chunks, ignore_index=True)
    identities = StableInstrumentIdentityMap(tuple((f'U{i:02}', str(i + 100)) for i in range(40)), H, H, True)
    registry = ActionRegistry.bind((), USSessionCalendar(calendars['U']), H)
    split = 'P' in candidate.initial_weights
    if split:
        combined = panels.pop('K')
        kospi = combined.copy()
        kospi['symbol'] = 'P_A'
        kospi['market'] = 'KOSPI'
        # Unknown gates must suppress KOSPI signals instead of guessing a gate.
        panels.update(P=kospi, Q=combined)
        korean_calendar = calendars.pop('K')
        calendars.update(P=deepcopy(korean_calendar), Q=deepcopy(korean_calendar))
    references = references or {}
    return ResearchReplay(candidate, ExecutionContract('2020-01-03', '2020-01-31',
        cash_movement='NONE' if candidate.stage == 'references' else 'MONTHLY', fx_spread='0'),
        panels, calendars, fx, registry=registry, contexts=lambda session: {},
        instrument_identities=identities, context_sha256=H, structural_split=split,
        reference_nav=references.get('nav'), reference_demands=references.get('demands'),
        reference_capital=references.get('capital'))


class MissingSessionRegressions(unittest.TestCase):
    def test_whole_missing_open_expires_one_session_buy(self):
        runner = make()
        stop_before(runner, 'OPEN', 'K', '2020-01-06')
        self.assertTrue(runner.adapters['K'].pending_intents())
        runner.panels['K'].pop('2020-01-06')
        runner.step()
        self.assertFalse(runner.adapters['K'].pending_intents())
        stop_before(runner, 'OPEN', 'K', '2020-01-07')
        runner.step()
        self.assertNotIn(('K', 'K_A'), runner.ledger.positions)

    def test_missing_whole_close_breaks_kosdaq_score_adjacency(self):
        panels, calendars, fx = inputs()
        panels['K']['score'] = [6., 6., 6., 8., 8., 8.]
        runner = make(panels=panels, calendars=calendars, fx=fx)
        runner.panels['K'].pop('2020-01-06')
        runner.run()
        self.assertFalse([intent for intent in runner.adapters['K'].pending_intents()
            if intent['side'] == 'BUY'])

    def test_missing_whole_close_does_not_delay_etf_confirmation(self):
        panels, calendars, fx = inputs()
        panels['E']['score'] = [79., 81., 82., 82., 82., 82.]
        runner = make(panels=panels, calendars=calendars, fx=fx)
        runner.panels['E'].pop('2020-01-06')
        runner.run()
        self.assertFalse([intent for intent in runner.adapters['E'].pending_intents()
            if intent['side'] == 'BUY'])

    def test_missing_close_is_calendar_session_not_weekend(self):
        runner = held_us_close()
        day = runner.queue[0][5]['session_date']
        self.assertEqual(day, '2020-01-06')
        symbol = next(iter(runner._holdings('U')))
        frame = runner.panels['U'].panels.panels[day]
        frame.loc[frame.symbol.eq(symbol), 'comparison_close'] = None
        runner.step()
        audit = next(row for row in runner.proxy_exits if row['symbol'] == symbol)
        self.assertEqual(audit['reference_price_date'], '2020-01-03')
        self.assertEqual(audit['trigger_session_date'], '2020-01-06')
        self.assertEqual(audit['cash_available_at'], '2020-01-08T14:30:00+00:00')

    def test_all_nonfinite_or_nonpositive_closes_use_same_fee_policy(self):
        for missing in (None, float('nan'), float('inf'), float('-inf'), 0., -1.):
            with self.subTest(missing=missing):
                runner = held_us_close()
                day = runner.queue[0][5]['session_date']
                symbol = next(iter(runner._holdings('U')))
                frame = runner.panels['U'].panels.panels[day]
                frame.loc[frame.symbol.eq(symbol), 'comparison_close'] = missing
                runner.step()
                audit = next(row for row in runner.proxy_exits if row['symbol'] == symbol)
                sale = next(row for row in runner.ledger.events if row.get('id') == audit['fill_id'])
                self.assertEqual(dec(sale['fee']), trading_fee(dec(sale['price']) * dec(sale['quantity'])))
                self.assertFalse(audit['actual_historical_fill'])
                self.assertFalse(audit['retroactive_nav_rewrite'])

    def test_missing_cross_section_is_scheduled_even_when_absent_initially(self):
        panels, calendars, fx = inputs()
        panels['U'] = panels['U'].loc[panels['U'].session_date.ne('2020-01-07')].copy()
        runner = make(panels=panels, calendars=calendars, fx=fx)
        events = [event for event in runner.queue if event[3:5] == ('CLOSE', 'U')
            and event[5]['session_date'] == '2020-01-07']
        self.assertEqual(len(events), 1)
        runner.run()
        self.assertTrue(runner.proxy_exits)
        self.assertEqual({row['trigger_session_date'] for row in runner.proxy_exits}, {'2020-01-07'})

    def test_proxy_state_restores_exactly_after_every_event(self):
        def factory():
            panels, calendars, fx = inputs()
            panels['U'] = panels['U'].loc[panels['U'].session_date.ne('2020-01-07')].copy()
            return make(panels=panels, calendars=calendars, fx=fx)
        full = factory()
        full.run()
        runner = factory()
        bound = identity(runner)
        while runner.step():
            runner = restore(factory(), pack(runner, bound), bound)
        self.assertEqual(full.proxy_exits, runner.proxy_exits)
        self.assertEqual(full.proxy_last_close, runner.proxy_last_close)
        for name in ('nav', 'events', 'orders', 'demands', 'retrospective_exit_proxy_audit'):
            assert_frame_equal(full.result()[name], runner.result()[name], check_exact=True)

    def test_failed_proxy_close_cannot_be_checkpointed(self):
        runner = held_us_close()
        day = runner.queue[0][5]['session_date']
        runner.panels['U'].panels.panels.pop(day)
        bound = identity(runner)
        before = pack(runner, bound)
        original_events = deepcopy(runner.ledger.events)

        def fail_after_sell(engine):
            raise RuntimeError('Synthetic failure after a proxy sale')

        runner._reserve_pending_cash = fail_after_sell
        with self.assertRaisesRegex(RuntimeError, 'Synthetic failure'):
            runner.step()
        self.assertTrue(runner._resume_poisoned)
        with self.assertRaisesRegex(ValueError, 'Unsafe'):
            pack(runner, bound)
        recovered = restore(make(), before, bound)
        self.assertEqual(recovered.ledger.events, original_events)
        self.assertFalse(recovered.proxy_exits)
        self.assertFalse(recovered._resume_poisoned)

    def test_failed_known_open_restores_proxy_observations_and_exact_bytes(self):
        runner = make(hazards=(CandidateHazard('failed-open', 'U00', '100',
            '2020-01-07', True, 'TEST', H, ()),))
        stop_before(runner, 'OPEN', 'U', '2020-01-07')

        def fail_context(session):
            raise RuntimeError('Synthetic known-action context failure')

        runner.corporate_action_contexts = fail_context
        bound = identity(runner)
        before = pack(runner, bound)
        with self.assertRaisesRegex(RuntimeError, 'Synthetic known-action') as caught:
            runner.step()
        self.assertTrue(caught.exception.atomic_event_rollback_verified)
        self.assertFalse(runner._resume_poisoned)
        self.assertEqual(pack(runner, bound), before)


class DynamicAndSplitRegressions(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.reference_results = {}
        cls.reference_runners = {}
        for candidate in candidates('references'):
            runner = monthly_runner(candidate)
            runner.run()
            cls.reference_results[candidate.candidate_id[-1]] = files_for(runner)
            cls.reference_runners[candidate.candidate_id[-1]] = runner
        cls.references = build_references(cls.reference_results)

    def test_references_have_no_allocation_feedback_or_shared_ledgers(self):
        self.assertEqual(set(self.references['nav'].columns), set('KEU'))
        self.assertEqual(self.references['capital'], {'K': 100_000_000., 'E': 100_000_000., 'U': 100_000.})
        self.assertEqual(len({id(r.ledger) for r in self.reference_runners.values()}), 3)
        for engine, runner in self.reference_runners.items():
            self.assertEqual(runner.contract.cash_movement, 'NONE')
            self.assertTrue(runner.target_reviews)
            self.assertTrue(all(row['movement']['reason'] == 'NO_INTER_SLEEVE_CASH_MOVEMENT'
                for row in runner.target_reviews))
            self.assertTrue(all(owner == engine for owner, symbol in runner.ledger.positions))

    def test_all_twelve_dynamic_policies_complete_monthly_review_without_mutating_references(self):
        before_nav = self.references['nav'].copy(deep=True)
        before_demands = self.references['demands'].copy(deep=True)
        before_capital = dict(self.references['capital'])
        dynamic = [candidate for candidate in candidates('base') if candidate.policy_id]
        self.assertEqual(len(dynamic), 12)
        for candidate in dynamic:
            with self.subTest(candidate=candidate.candidate_id):
                runner = monthly_runner(candidate, self.references)
                runner.run()
                self.assertTrue(runner._resume_finished)
                self.assertEqual(len(runner.target_reviews), 1)
                self.assertAlmostEqual(sum(runner.target.values()), 1.)
                self.assertTrue(all(weight >= 0 for weight in runner.target.values()))
                self.assertFalse(runner.proxy_exits)
        assert_frame_equal(before_nav, self.references['nav'], check_exact=True)
        assert_frame_equal(before_demands, self.references['demands'], check_exact=True)
        self.assertEqual(before_capital, self.references['capital'])

    def test_split_paths_complete_with_distinct_market_state(self):
        for stage in ('split25', 'split10'):
            candidate = next(candidate for candidate in candidates(stage)
                if all(candidate.initial_weights[engine] > 0 for engine in ('P', 'Q', 'E', 'U')))
            with self.subTest(stage=stage):
                runner = monthly_runner(candidate)
                runner.run()
                self.assertTrue(runner._resume_finished)
                self.assertEqual(set(runner.adapters), set('PQEU'))
                self.assertIsNot(runner.adapters['P'], runner.adapters['Q'])
                self.assertTrue(all(row['market'] == 'KOSPI' for row in runner.latest_rows['P'].values()))
                self.assertTrue(all(row['market'] == 'KOSDAQ' for row in runner.latest_rows['Q'].values()))
                self.assertFalse(runner.proxy_exits)

    def test_reference_mismatches_fail_closed(self):
        wrong_candidate = deepcopy(self.reference_results)
        summary = json.loads(wrong_candidate['K']['summary.json'])
        summary['candidate_id'] = 'S01'
        wrong_candidate['K']['summary.json'] = json.dumps(summary).encode()
        with self.assertRaisesRegex(ValueError, 'Reference strategy mismatch'):
            build_references(wrong_candidate)
        wrong_grid = deepcopy(self.reference_results)
        frame = pd.read_csv(io.BytesIO(wrong_grid['K']['nav.csv']))
        wrong_grid['K']['nav.csv'] = frame.iloc[1:].to_csv(index=False).encode()
        with self.assertRaisesRegex(ValueError, 'Reference cutoff grids differ'):
            build_references(wrong_grid)


if __name__ == '__main__':
    unittest.main()
