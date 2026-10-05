"""Separate source-pinned exact-ledger cancellation V2, synthetic only.

Frozen cancellation V1 is unchanged. V2 explicitly accepts the new exact
ledger and live rational positions, never reconstructing a live fraction from
its Decimal projection or its original mandatory-entitlement audit.
"""
from __future__ import annotations

import copy
import hashlib
import json
from dataclasses import asdict
from datetime import date
from decimal import Decimal
from fractions import Fraction
from pathlib import Path

from cm06.accounting import Position, ZERO, dec, utc
import cm06_exact_units_resume_state_v1 as exact_codec
from cm06_exact_units_accounting_v1 import (
    ExactComparisonLedger, ExactComparisonEntitlementPosition, exact_quantity,
)
import cm06_zero_recovery_cancellation_v1 as legacy
from cm06_zero_recovery_cancellation_v1 import (
    ValidatedRegistryProof, IdentityPreflight, RecognitionBoundary, PendingIntentPreflight,
    load_registry_proof, validate_registry_proof, cancellation_event_id,
    canonical, digest, _sha, PINNED_PROOF_SHA256, PROOF_FILENAME, SYNTHETIC_SCOPE, EVENT_KIND,
)

VERSION = 'CM06_DOCUMENTED_ZERO_RECOVERY_CANCELLATION_V2_EXACT'
DEPENDENCY_PIN_FILENAME = 'exact_dependency_pins_v2.json'


def current_source_binding():
    """Require reviewed exact-codec dependency bytes, then bind this V2 path."""
    pins_path = Path(__file__).with_name(DEPENDENCY_PIN_FILENAME)
    pins = json.loads(pins_path.read_text())
    actual = exact_codec.source_binding()
    if (pins.get('schema') != 'CM06_CANCELLATION_V2_EXACT_DEPENDENCY_PINS_V1' or
            pins.get('exact_codec_version') != exact_codec.CODEC_VERSION or
            pins.get('sources') != actual):
        raise ValueError('Exact dependency source mismatch; cancellation v2 revalidation required')
    files = {
        'helper_v2': Path(__file__),
        'helper_v1_shared_validation_types': Path(legacy.__file__),
        'proof': Path(__file__).with_name(PROOF_FILENAME),
        'dependency_pins': pins_path,
    }
    sources = {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in files.items()}
    payload = {'version': VERSION, 'sources': sources, 'exact_dependencies': actual,
               'exact_codec_version': exact_codec.CODEC_VERSION,
               'proof_sha256': PINNED_PROOF_SHA256}
    return {**payload, 'sha256': digest(payload)}


def _preflight(ledger, sleeve, symbol, proof, identity, recognition, pending):
    if type(ledger) is not ExactComparisonLedger:
        raise TypeError('Explicit ExactComparisonLedger required for cancellation v2')
    if type(proof) is not ValidatedRegistryProof:
        raise ValueError('Explicit validated registry proof required')
    document = proof.document()
    event_id = cancellation_event_id(proof, sleeve)
    if type(identity) is not IdentityPreflight:
        raise ValueError('Explicit old-equity identity preflight required')
    _sha(identity.receipt_sha256, 'Identity preflight')
    expected = document['identity']
    if any(getattr(identity, field) != value for field, value in expected.items()):
        raise ValueError('Identity mismatch with proven old equity')
    if (identity.sleeve, identity.symbol) != (sleeve, symbol):
        raise ValueError('Identity does not match requested holding')
    if identity.tickers_sha256 != document['identity_source']['tickers_sha256']:
        raise ValueError('Identity source hash mismatch')
    if type(recognition) is not RecognitionBoundary:
        raise ValueError('Explicit recognition boundary required')
    if recognition.scope != SYNTHETIC_SCOPE:
        raise ValueError('Historical recognition remains unadmitted; synthetic scope only')
    if (not isinstance(recognition.boundary_evidence, str) or
            not recognition.boundary_evidence.strip()):
        raise ValueError('Explicit synthetic boundary evidence required')
    if (not isinstance(recognition.new_source_bound_trial_id, str) or
            not recognition.new_source_bound_trial_id.startswith('synthetic-zero-recovery:') or
            not recognition.new_source_bound_trial_id.split(':', 1)[1]):
        raise ValueError('A fresh synthetic source-bound trial is required')
    if recognition.source_binding_sha256 != current_source_binding()['sha256']:
        raise ValueError('Fresh trial source binding mismatch')
    recognized_at = utc(recognition.recognized_at)
    if recognized_at > ledger.at:
        raise ValueError('Future recognition timestamp')
    if recognized_at != ledger.at:
        raise ValueError('Recognition must equal the explicit current event boundary')
    if recognized_at.date() < date.fromisoformat(document['effective_date']):
        raise ValueError('Recognition predates the documented legal date')
    if type(pending) is not PendingIntentPreflight:
        raise ValueError('Dispatcher pending-intent preflight required')
    _sha(pending.receipt_sha256, 'Pending-intent preflight')
    if ((pending.sleeve, pending.symbol) != (sleeve, symbol) or
            utc(pending.recognized_at) != recognized_at or
            pending.new_source_bound_trial_id != recognition.new_source_bound_trial_id or
            pending.identity_receipt_sha256 != identity.receipt_sha256):
        raise ValueError('Dispatcher preflight scope mismatch')
    if type(pending.pending_intent_ids) is not tuple or pending.pending_intent_ids:
        raise ValueError('Related pending intents must be resolved by the dispatcher')
    if event_id in ledger.seen or any(event.get('id') == event_id for event in ledger.events):
        raise ValueError(f'Duplicate cancellation: {event_id}')
    key = (sleeve, symbol)
    position = ledger.positions.get(key)
    if position is None:
        raise ValueError('Documented cancellation requires an actually held position')
    if ((position.sleeve, position.symbol, position.currency) != (sleeve, symbol, identity.currency) or
            type(position) not in (Position, ExactComparisonEntitlementPosition)):
        raise ValueError('Held position identity/type mismatch')
    if type(position.quantity) not in (int, Decimal) or dec(position.quantity) <= ZERO:
        raise ValueError('Invalid held entitlement quantity')
    if min(dec(position.cost_native), dec(position.cost_krw)) < ZERO:
        raise ValueError('Invalid remaining position basis')
    if key not in ledger.prices:
        raise ValueError('Missing pre-cancellation valuation mark')
    price, mark_at = ledger.prices[key]
    if dec(price) <= ZERO or utc(mark_at) > ledger.at:
        raise ValueError('Invalid or future pre-cancellation mark')
    if (position.currency not in ledger.fx_at or
            utc(ledger.fx_at[position.currency]) > ledger.at or dec(ledger.rate(position.currency)) <= ZERO):
        raise ValueError('Invalid or future valuation FX')
    live = exact_quantity(position)
    if type(live) is not Fraction or live <= 0:
        raise ValueError('Invalid live exact quantity')
    # Frozen invariants can insert defaultdict zero keys. Always validate copies.
    copy.deepcopy(ledger).assert_invariants()
    return document, event_id, key


def cancel_documented_zero_equity(ledger, *, sleeve, symbol, proof=None, identity=None,
                                 recognition=None, pending=None):
    """All-or-nothing removal of one proven old-equity holding and its mark.

    Duplicate invocation fails without mutation. `seen` plus a deterministic
    event ID persists in the existing codec, so a dispatcher can skip already
    committed events on exact resume. An unheld case fails, not a zero event.
    The caller owns single-threaded ledger mutation and must not retain aliases
    to affected collections across a successful transaction.
    """
    document, event_id, key = _preflight(ledger, sleeve, symbol, proof, identity, recognition, pending)
    staged = copy.deepcopy(ledger)
    position = staged.positions[key]
    mark, mark_at = staged.prices[key]
    removed_market_value = dec(position.quantity) * mark * staged.rate(position.currency)
    staged.pnl['realized_gross'] = staged.pnl.get('realized_gross', ZERO) - position.cost_krw
    del staged.positions[key]
    del staged.prices[key]
    staged.unique(event_id)
    staged.record(
        EVENT_KIND, id=event_id, helper_version=VERSION, sleeve=sleeve, symbol=symbol,
        currency=position.currency, permaticker=identity.permaticker,
        equity_class=identity.equity_class, non_market=True,
        old_quantity=dec(position.quantity),
        old_quantity_exact={'numerator': exact_quantity(position).numerator,
                            'denominator': exact_quantity(position).denominator},
        old_quantity_exact_source=('LIVE_POSITION_FRACTION' if type(position) is ExactComparisonEntitlementPosition
                                   else 'INTEGER_POSITION_QUANTITY'),
        old_live_unit_audit=copy.deepcopy(getattr(position, 'live_unit_audit', None)),
        basis_native=position.cost_native,
        basis_krw=position.cost_krw, realized_gross_krw=-position.cost_krw,
        proceeds_native=ZERO, proceeds_krw=ZERO, cash_delta=ZERO,
        fee=ZERO, fee_krw=ZERO, receivable_created=False,
        previous_mark=mark, previous_mark_at=utc(mark_at).isoformat(),
        removed_market_value_krw=removed_market_value,
        legal_effective_date=document['effective_date'], legal_effective_at=None,
        recognition_at=utc(recognition.recognized_at).isoformat(),
        recognition_scope=recognition.scope, boundary_evidence=recognition.boundary_evidence,
        new_source_bound_trial_id=recognition.new_source_bound_trial_id,
        source_binding_sha256=recognition.source_binding_sha256,
        proof_id=document['proof_id'], proof_sha256=PINNED_PROOF_SHA256,
        source_provenance=copy.deepcopy(document['sources']),
        identity_preflight=asdict(identity), dispatcher_preflight=asdict(pending),
        prior_mandatory_entitlement_id=getattr(position, 'mandatory_event_id', None),
        prior_entitlement_audit=copy.deepcopy(getattr(position, 'entitlement_audit', None)),
    )
    copy.deepcopy(staged).assert_invariants()
    # A single state-reference publication follows every possible validation.
    # Keep all other original collections, including cash/reservations/claims,
    # receivables/tax balances/FX, byte-for-byte and object-for-object intact.
    changed = ('positions', 'prices', 'pnl', 'events', 'seen')
    published = dict(ledger.__dict__)
    published.update({field: getattr(staged, field) for field in changed})
    result = copy.deepcopy(staged.events[-1])
    ledger.__dict__ = published
    return result
