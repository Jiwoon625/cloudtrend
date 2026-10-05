"""Pure prepare/atomic publish seam for the existing comparison OPEN handler.

No history run, automatic provider admission, queue kind, signal transplant, or
frozen-module monkeypatch. A plan is disposable until all operations validate.
"""
from __future__ import annotations

from collections.abc import Mapping
from copy import copy, deepcopy
from dataclasses import dataclass, replace
import hashlib

from cm06.accounting import ZERO, dec, utc
from cm06_cash_merger_registry_v1 import CashMerger
from cm06_cash_merger_registry_v2 import convert_cash_merger, unit_conversion
from cm06_dated_action_contract_v1 import ActionRegistry, StableInstrumentIdentityMap, PAYMENT_POLICY


class DatedActionPanels(Mapping):
    """Date-gated terminal predecessor removal, no future or unresolved blacklist."""
    def __init__(self, panels, registry, identity_for_row=None):
        self.panels, self.registry = panels, registry
        self.identity_for_row = identity_for_row
    def __len__(self): return len(self.panels)
    def __iter__(self): return iter(self.panels)
    def __contains__(self, day): return day in self.panels
    def __getitem__(self, day):
        frame = self.panels[day]
        inactive = self.registry.inactive_symbols(day)
        if not inactive:
            return frame
        active_events = [e for e in self.registry.events if e.predecessor in inactive
                         and e.recognition_session_date <= day and e.kind != 'UNRESOLVED_RIGHT']
        keep = []
        for row in frame.to_dict('records'):
            if row['symbol'] not in inactive:
                keep.append(True)
                continue
            identity = self.identity_for_row(row) if self.identity_for_row else row.get('permaticker')
            if identity is None or str(identity) in ('', 'nan', 'None'):
                raise ValueError('RETIRED_TICKER_DATED_IDENTITY_REQUIRED: ' + row['symbol'])
            keep.append(not any(e.predecessor == row['symbol'] and e.predecessor_identity == str(identity)
                                for e in active_events))
        return frame.loc[keep].copy()
    def __getattr__(self, name): return getattr(self.panels, name)


def _state(replay):
    # Strictly the collections this transaction may publish. Panel/calendar data
    # and strategy calculations are deliberately excluded from the copy.
    return {'ledger': replay.ledger.__dict__,
            'adapter_u': replay.adapters['U'].__dict__,
            'entry_meta': replay.entry_meta, 'holding_spans': replay.holding_spans,
            'input_identity_sha256': (replay.corporate_action_instrument_identities.fingerprint
                if hasattr(replay, 'corporate_action_instrument_identities') else None)}


def _state_bytes(value):
    """Data-only state binding, including adapter NaN feature observations."""
    from cm06_resume_state import encode, canonical
    try:
        return canonical(encode(value))
    except TypeError:
        # The exact codec extends only the safe class/type allowlist.
        from cm06_exact_units_resume_state_v1 import encode as exact_encode
        return canonical(exact_encode(value))


def _state_equal(left, right):
    return _state_bytes(left) == _state_bytes(right)


@dataclass(frozen=True)
class OpenPlan:
    at: object
    binding_sha256: str
    new_trial_id: str
    before: dict
    staged: object
    after_sha256: str
    actions: tuple[dict, ...]
    changed: bool


def _receipt(replay, event):
    matches = [r for r in replay.ledger.events if r.get('id') == event.receipt_id]
    seen = event.receipt_id in replay.ledger.seen
    if seen != bool(matches) or len(matches) > 1:
        raise ValueError('Inconsistent persisted corporate-action receipt')
    return matches[0] if matches else None


def _validate_context(event, context):
    if context.get('identity_receipt_sha256') != event.identity_receipt_sha256:
        raise ValueError(event.predecessor + ': dynamic identity receipt mismatch')
    if context.get('predecessor_identity') != event.predecessor_identity:
        raise ValueError(event.predecessor + ': dynamic predecessor identity mismatch')
    if event.successor and context.get('successor_identity') != event.successor_identity:
        raise ValueError(event.predecessor + ': dynamic successor identity mismatch')


def _cash(staged, event, context, registry):
    """Reuse verified raw-share converter and unchanged frozen 15bp sale cost."""
    original = context.get('cash_event')
    if type(original) is not CashMerger:
        raise ValueError('Explicit documented CashMerger object required')
    expected = (event.predecessor, event.legal_effective_date, event.last_trade_date,
                event.source_url, event.payload.get('cash_per_share'))
    actual = (original.symbol, original.effective_date, original.last_trade_date,
              original.source_url, original.cash_per_share)
    if expected != actual:
        raise ValueError('Cash merger terms differ from immutable admitted event')
    cloned = replace(original, payment_assumption=PAYMENT_POLICY)
    due = registry.calendar.t_plus_five(event.legal_effective_date)
    if due <= staged.ledger.at:
        raise ValueError('Recognition must precede comparison cash release')
    prior = deepcopy(context.get('prior_row'))
    if not isinstance(prior, dict):
        raise ValueError('Exact verified predecessor quote required')
    if str(prior.get('permaticker')) != event.predecessor_identity:
        raise ValueError('Cash reference row identity differs from admitted predecessor')
    unit_conversion(cloned, prior, staged.ledger.at)
    key = ('U', event.predecessor)
    convert_cash_merger(staged.ledger, cloned, staged.ledger.positions[key].quantity, due, prior)
    return dict(staged.ledger.events[-1])


def _linear(staged, event, context, registry):
    from cm06_exact_units_accounting_v1 import promote_ledger
    from cm06_exact_units_exchange_v1 import plan_linear_exchange, apply_linear_exchange
    terms = context.get('terms')
    if terms is None:
        raise ValueError('Explicit validated linear exchange terms required')
    expected = {'event_id': event.event_id, 'predecessor': event.predecessor, 'successor': event.successor,
                'old_permaticker': event.predecessor_identity,
                'new_permaticker': event.successor_identity,
                'legal_effective_date': event.legal_effective_date,
                'last_trade_date': event.last_trade_date, 'source_url': event.source_url}
    if any(str(getattr(terms, name, None)) != str(value) for name, value in expected.items()):
        raise ValueError('Linear terms differ from immutable admitted event')
    from fractions import Fraction
    payload = event.payload
    if (terms.legal_effective_at != event.legal_effective_at or
            terms.legal_effective_timezone != event.legal_effective_timezone or
            terms.successor_reference_date != payload.get('successor_reference_date') or
            Fraction(terms.share_ratio) != Fraction(payload['share_ratio']) or
            Fraction(terms.cash_per_raw_equivalent) != Fraction(payload['cash_per_raw_equivalent'])):
        raise ValueError('Linear economic terms/reference differ from immutable event')
    if utc(terms.activation_at) != utc(event.recognition_at):
        raise ValueError('Linear recognition boundary mismatch')
    staged.ledger = promote_ledger(staged.ledger)
    plan = plan_linear_exchange(staged.ledger, terms, context.get('old_row'),
                                context.get('new_row'), us_sessions=registry.calendar)
    return apply_linear_exchange(staged.ledger, plan)


def _zero(staged, event, context, registry):
    # v1 is intentionally synthetic-only; no real IRBTQ activation is inferred.
    from cm06_exact_units_accounting_v1 import ExactComparisonLedger
    if type(staged.ledger) is ExactComparisonLedger:
        from cm06_zero_recovery_cancellation_v2 import cancel_documented_zero_equity
    else:
        from cm06_zero_recovery_cancellation_v1 import cancel_documented_zero_equity
    if event.admission != 'SYNTHETIC_VALIDATED':
        raise ValueError('Zero-recovery historical recognition remains unadmitted')
    kwargs = deepcopy(context.get('cancellation_kwargs', {}))
    if kwargs.get('sleeve') != 'U' or kwargs.get('symbol') != event.predecessor:
        raise ValueError('Cancellation target mismatch')
    return cancel_documented_zero_equity(staged.ledger, **kwargs)


HANDLERS = {'CASH_MERGER': _cash, 'LINEAR_EXCHANGE': _linear, 'ZERO_RECOVERY': _zero}


def plan_open(replay, registry, session, *, contexts=None, pending_entitlements=frozenset()):
    """Return a validated, uncommitted OPEN plan; failure never changes replay.

    contexts are event-id keyed dynamic identity/unit preflight inputs, not
    admission grants. pending_entitlements lists actual (sleeve, symbol, event_id) rights;
    unfilled BUY intent alone does not constitute an owned entitlement.
    """
    if type(registry) is not ActionRegistry:
        raise ValueError('Explicit source-bound admitted registry required')
    day = session['session_date']
    at = utc(session['open_at'])
    bound_session = registry.calendar.session(day)
    if utc(bound_session.open_at) != at or replay.ledger.at != at:
        raise ValueError('Dispatcher requires current matching US OPEN boundary')
    contexts = {} if contexts is None else contexts
    identities = getattr(replay, 'corporate_action_instrument_identities', None)
    if type(identities) is not StableInstrumentIdentityMap:
        raise ValueError('Pinned stable-per-symbol input identity preflight required by symbol-keyed ledger')
    if not isinstance(pending_entitlements, (set, frozenset)) or any(
            type(k) is not tuple or len(k) != 3 for k in pending_entitlements):
        raise ValueError('Explicit actual pending-entitlement keys required')
    before = deepcopy(_state(replay))
    staged = copy(replay)
    staged.__dict__ = dict(replay.__dict__)
    staged.ledger = deepcopy(replay.ledger)
    staged.adapters = dict(replay.adapters)
    staged.adapters['U'] = deepcopy(replay.adapters['U'])
    staged.entry_meta = deepcopy(replay.entry_meta)
    staged.holding_spans = deepcopy(replay.holding_spans)
    actions = []
    # This first pass prevents another event's staged cancellation from hiding
    # actual unsupported rights and prevents provider-only global blocking.
    for event in registry.events:
        if day < event.recognition_session_date:
            continue
        key = ('U', event.predecessor)
        pending_key = (*key, event.event_id)
        same_identity = identities.identity(event.predecessor) == event.predecessor_identity if key in replay.ledger.positions else False
        owns_current_boundary = same_identity and key in replay.ledger.positions and (event.terminal or day == event.recognition_session_date)
        if event.kind == 'UNRESOLVED_RIGHT' and (owns_current_boundary or pending_key in pending_entitlements):
            raise ValueError('UNRESOLVED_CORPORATE_ACTION_RIGHT: U ' + event.predecessor + ' ' + event.event_id)
    for event in sorted(registry.events, key=lambda e: (e.recognition_at, e.event_id)):
        if day < event.recognition_session_date or event.kind == 'UNRESOLVED_RIGHT':
            continue
        key = ('U', event.predecessor)
        pending_key = (*key, event.event_id)
        # Stable source identity is mandatory because the frozen ledger uses
        # symbol-only keys. A different proven issuer must never be retired.
        affected = key in staged.ledger.positions or any(
            intent['symbol'] == event.predecessor for intent in staged.adapters['U'].pending_intents())
        if affected and identities.identity(event.predecessor) != event.predecessor_identity and pending_key not in pending_entitlements:
            continue
        previous = _receipt(staged, event)
        if previous:
            if (previous.get('event_fingerprint') != event.fingerprint or
                    previous.get('binding_sha256') != registry.binding_sha256 or
                    previous.get('new_trial_id') != registry.new_trial_id):
                raise ValueError('Committed event source/policy identity changed')
            if key in staged.ledger.positions or pending_key in pending_entitlements:
                raise ValueError('Retired predecessor reappeared after committed event')
            continue
        held = key in staged.ledger.positions
        pending = [i for i in staged.adapters['U'].pending_intents() if i['symbol'] == event.predecessor]
        if not held and not pending and pending_key not in pending_entitlements:
            continue
        if day != event.recognition_session_date:
            raise ValueError('MISSED_CORPORATE_ACTION_BOUNDARY: ' + event.event_id)
        if pending_key in pending_entitlements:
            raise ValueError('Existing pending entitlement requires explicit reconciliation')
        context = contexts.get(event.event_id, {})
        _validate_context(event, context)
        # Cancellation occurs only on the copied adapter. Any handler failure
        # discards it together with every other staged ledger change.
        for intent in pending:
            staged.adapters['U'].cancel(intent['signal_id'])
        result = HANDLERS[event.kind](staged, event, context, registry) if held else None
        if held:
            if key in staged.ledger.positions:
                raise ValueError('Terminal handler failed to remove predecessor')
            meta = staged.entry_meta.pop(key, {})
            entry = meta.get('entry_date', event.legal_effective_date)
            # Date-only legal close and execution recognition stay distinct.
            span = dict(engine='U', symbol=event.predecessor, entry_date=entry,
                        exit_date=event.legal_effective_date)
            staged.holding_spans.append(span)
            staged.adapters['U'].record_holding_span(event.predecessor, entry, event.legal_effective_date)
        staged.ledger.unique(event.receipt_id)
        staged.ledger.record('DATED_ACTION_COMMIT', id=event.receipt_id,
            event_id=event.event_id, event_fingerprint=event.fingerprint,
            binding_sha256=registry.binding_sha256, new_trial_id=registry.new_trial_id,
            input_identity_sha256=identities.fingerprint,
            legal_effective_date=event.legal_effective_date, legal_effective_at=event.legal_effective_at,
            legal_effective_timezone=event.legal_effective_timezone,
            recognition_session_date=event.recognition_session_date, recognition_at=event.recognition_at,
            boundary_evidence=event.boundary_evidence, source_url=event.source_url,
            source_sha256=event.source_sha256, identity_receipt_sha256=event.identity_receipt_sha256,
            cancelled_predecessor_intents=tuple(i['signal_id'] for i in pending), held=held)
        actions.append({'event_id': event.event_id, 'held': held,
                        'cancelled_ids': tuple(i['signal_id'] for i in pending), 'result': result})
    if actions:
        # Reuse existing reservation calculation, not a new fee/order policy.
        staged._reserve_pending_cash('U')
        staged.ledger.assert_invariants()
    return OpenPlan(at, registry.binding_sha256, registry.new_trial_id, before,
                    staged, hashlib.sha256(_state_bytes(_state(staged))).hexdigest(), tuple(actions), bool(actions))


def apply_open(replay, registry, plan):
    """Publish only a current fully validated plan, with a single state swap."""
    if type(plan) is not OpenPlan or type(registry) is not ActionRegistry:
        raise ValueError('Explicit validated OPEN plan and registry required')
    if (registry.binding_sha256 != plan.binding_sha256 or registry.new_trial_id != plan.new_trial_id
            or replay.ledger.at != plan.at):
        raise ValueError('Plan source/policy/time binding mismatch')
    if not _state_equal(_state(replay), plan.before):
        raise ValueError('Stale OPEN plan: replay changed after preflight')
    if hashlib.sha256(_state_bytes(_state(plan.staged))).hexdigest() != plan.after_sha256:
        raise ValueError('Validated OPEN plan was modified after preflight')
    if not plan.changed:
        return plan.actions
    published = dict(replay.__dict__)
    published.update(ledger=plan.staged.ledger, adapters=plan.staged.adapters,
                     entry_meta=plan.staged.entry_meta, holding_spans=plan.staged.holding_spans)
    replay.__dict__ = published
    return plan.actions


def dispatch_open(replay, registry, session, **kwargs):
    return apply_open(replay, registry, plan_open(replay, registry, session, **kwargs))


class DatedActionOpenMixin:
    """Call before existing OPEN orders/marks; configure on a fresh trial only.

    The host supplies corporate_action_registry and corporate_action_contexts
    (a callable receiving session), plus optional pending_entitlement_keys.
    Use with the ordinary comparison Replay, never legacy merger overrides.
    Static registry/callbacks must be reconstructed and source-bound on resume.
    """
    def _open(self, e, session):
        if e == 'U':
            if hasattr(super(), '_handle_cash_mergers'):
                raise ValueError('Legacy merger dispatcher must not run behind the T+5 hook')
            dispatch_open(self, self.corporate_action_registry, session,
                          contexts=self.corporate_action_contexts(session),
                          pending_entitlements=getattr(self, 'pending_entitlement_keys', frozenset()))
        return super()._open(e, session)
