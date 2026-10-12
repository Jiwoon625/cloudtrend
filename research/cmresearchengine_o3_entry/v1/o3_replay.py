"""Extension observer and monthly target, original portfolio executor unchanged."""
import pandas as pd
from cmresearchengine import runtime
from cmresearchengine.replay import ResearchReplay
from cm06_comparison_panels import panel_records
from cm06.allocation import move_idle_cash
from cm06_shared_us_analysis_v1 import (activate_shared_us_analysis, deactivate_shared_us_analysis,
    shared_us_analysis_stats)
from o3_policy import target, options
from o3_signals import observe, initial_state, SIGNAL_COLUMNS, OBSERVATION_COLUMNS


class O3ResearchReplay(ResearchReplay):
    def __init__(self, *args, policy_options=None, share_us_analysis=True, **kwargs):
        super().__init__(*args, **kwargs)
        if set(self.currency) != set("KEU"):
            raise ValueError("O3 original three-market contract required")
        self.o3_options = options(policy_options)
        self.o3_signal_state = {e: initial_state() for e in "KEU"}
        self.o3_entry_signals = []
        self.o3_signal_observations = []
        self.o3_share_us_analysis = share_us_analysis

    def step(self):
        # These fields are outside the original US atomic write-set. Preserve
        # them across any failed event without changing the frozen codec.
        before = (self.o3_signal_state, self.o3_entry_signals, self.o3_signal_observations)
        try:
            return super().step()
        except BaseException:
            self.o3_signal_state, self.o3_entry_signals, self.o3_signal_observations = before
            raise

    def _close(self, engine, session):
        day = session["session_date"]
        rows = panel_records(self.panels[engine], day) if day in self.panels[engine] else []
        share = engine == 'U' and bool(rows) and self.o3_share_us_analysis
        if share:
            # Existing frozen memo checks EVERY raw row and the complete prior
            # market-rank state before a cache hit. It holds no portfolio data.
            # Scope is exactly one observer/executor pair at one close event.
            if self.o3_signal_state['U']['us_state'] != self.adapters['U'].us_state:
                raise ValueError('O3 observer/executor US market state diverged')
            if shared_us_analysis_stats()['active']:
                raise ValueError('O3 cannot join an external analysis cache scope')
            activate_shared_us_analysis({'mode': 'LOCKSTEP_SHARED_US_ANALYSIS_V1',
                                         'scope': 'O3_OBSERVER_EXECUTOR_ONE_SESSION_V1'})
        try:
            result = self._observed_close(engine, session, rows)
            if share:
                stats = shared_us_analysis_stats()
                if stats['misses'] != 1 or stats['hits'] != 1:
                    raise ValueError('O3 expected exactly one US computation and one verified reuse')
            return result
        finally:
            if share:
                deactivate_shared_us_analysis()

    def _observed_close(self, engine, session, rows):
        day = session['session_date']
        state, entries, receipt = observe(engine, rows, session, self.o3_signal_state[engine], self.contract.start_date)
        # Publish only after original close/exits/marks/adapter succeeded. The
        # observer gets no ledger, cash, holdings, pending orders or slot counts.
        result = super()._close(engine, session)
        self.o3_signal_state = {**self.o3_signal_state, engine: state}
        self.o3_entry_signals = self.o3_entry_signals + entries
        if day >= self.contract.start_date:
            self.o3_signal_observations = self.o3_signal_observations + [receipt]
        return result

    def _review(self, month):
        if not self.started:
            return
        if self.candidate.candidate_id != "O3" or self.candidate.policy_id != "O3":
            raise ValueError("O3 extension candidate only")
        if self.contract.cash_movement != "MONTHLY":
            raise ValueError("O3 requires original monthly cash movement")
        result = target(month, self.ledger.at, self.o3_entry_signals, self.calendars,
                        self.o3_signal_observations, self.contract.start_date, self.target, self.o3_options)
        self.target = result["weights"]
        for engine in self.currency:
            if self.target.get(engine, 0) <= 0:
                for intent in self.adapters[engine].pending_intents():
                    if intent["side"] == "BUY":
                        self.adapters[engine].cancel(intent["signal_id"])
                self._reserve_pending_cash(engine)
        movement = move_idle_cash(self.ledger, self.target, self.currency, self.contract.fx_spread,
                                  f"review:{month}", engine_order=tuple(self.currency))
        self.target_reviews.append({"at": self.ledger.at.isoformat(), "month": month,
                                    "policy": result["diagnostics"], "movement": movement})

    def result(self):
        result = super().result()
        result["o3_entry_signals"] = pd.DataFrame(self.o3_entry_signals, columns=SIGNAL_COLUMNS)
        result["o3_signal_observations"] = pd.DataFrame(self.o3_signal_observations, columns=OBSERVATION_COLUMNS)
        result["o3_source_calendar"] = pd.DataFrame(
            [dict(engine=e, **session) for e, sessions in self.calendars.items() for session in sessions])
        return result
