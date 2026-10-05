"""Explicit approved pro-rata comparison convention, separate from legal CIL.

This module has no registry, history runner, data fetch or activation hook. A
released, fully evidenced event must be supplied by the dated dispatcher.
"""
from copy import deepcopy
from dataclasses import dataclass
from datetime import date
from decimal import localcontext
from fractions import Fraction
from zoneinfo import ZoneInfo
import json

from cm06.accounting import Receivable, ZERO, dec, utc
from cm06_stock_merger_registry_v1 import reference
from cm06_exact_units_accounting_v1 import (
    ExactComparisonLedger, ExactComparisonEntitlementPosition,
    LIVE_UNIT_POLICY, exact_quantity, project_units, project_amount,
)

MODEL_CONTRACT_ID = 'CM06_APPROVED_COMPARISON_20261005_V1'
LINEAR_POLICY = 'EXACT_PRO_RATA_COMPARISON_EXPOSURE_V1'
from cm06_us_cash_t5_policy_v1 import PAYMENT_POLICY as CASH_POLICY, us_t_plus_five, USSessionCalendar
BASIS_POLICY = 'PRIOR_CAUSAL_CONSIDERATION_VALUE_BASIS_ALLOCATION_COMPARISON_NOT_TAX'


@dataclass(frozen=True)
class LinearExchangeTerms:
    event_id: str
    predecessor: str
    successor: str
    old_permaticker: str
    new_permaticker: str
    legal_effective_date: str
    activation_at: str
    last_trade_date: str
    successor_reference_date: str
    share_ratio: object
    cash_per_raw_equivalent: object
    source_url: str
    # Explicit opt-in: neither this policy nor completeness is inferred.
    fractional_policy: str | None = None
    model_contract_id: str | None = None
    complete_linear_consideration: bool = False
    legal_effective_at: str | None = None
    legal_effective_timezone: str | None = None
    causal_activation_verified: bool = False
    calendar_id: str | None = None
    old_name_tokens: tuple = ()
    new_name_tokens: tuple = ()


@dataclass(frozen=True)
class LinearExchangePlan:
    event_id: str
    before_sha256: str
    source_sha256: str
    after_state: bytes
    after_sha256: str
    audit_json: bytes


def rational(value, label, *, positive=False):
    if isinstance(value, bool) or type(value) not in (int, str, Fraction, type(ZERO)):
        raise ValueError(label + ': exact int/Decimal/string/Fraction required')
    try:
        out = Fraction(value)
    except (ValueError, TypeError, ZeroDivisionError, OverflowError) as exc:
        raise ValueError(label + ': invalid exact rational') from exc
    if out < 0 or (positive and out == 0):
        raise ValueError(label + ': invalid nonnegative consideration')
    return out


def _fraction_record(value):
    return {'numerator': value.numerator, 'denominator': value.denominator}


def _validate_terms(ledger, terms):
    if type(terms) is not LinearExchangeTerms:
        raise TypeError('Explicit LinearExchangeTerms required')
    if terms.fractional_policy != LINEAR_POLICY or terms.model_contract_id != MODEL_CONTRACT_ID:
        raise ValueError('EXPLICIT_LINEAR_COMPARISON_CONTRACT_REQUIRED: legal whole-share/CIL mode is separate')
    if terms.complete_linear_consideration is not True:
        raise ValueError('UNRESOLVED_CONSIDERATION: rights, election, proration or recovery cannot be zeroed')
    if not all(isinstance(x, str) and x.strip() for x in (
            terms.event_id, terms.predecessor, terms.successor, terms.old_permaticker,
            terms.new_permaticker, terms.source_url)):
        raise ValueError('Missing explicit transaction/identity/evidence binding')
    if terms.predecessor == terms.successor:
        raise ValueError('Self-exchange requires a separate split/unit action')
    activation = utc(terms.activation_at)
    effective = date.fromisoformat(terms.legal_effective_date)
    last = date.fromisoformat(terms.last_trade_date)
    reference_day = date.fromisoformat(terms.successor_reference_date)
    if ledger.at != activation or effective > activation.date() or last > activation.date() or reference_day > activation.date():
        raise ValueError('MISSED_OR_PREMATURE_LINEAR_EXCHANGE: explicit causal dates required')
    if terms.legal_effective_at is not None:
        legal = utc(terms.legal_effective_at)
        if not terms.legal_effective_timezone:
            raise ValueError('Exact legal timestamp requires its explicit civil timezone')
        if legal.astimezone(ZoneInfo(terms.legal_effective_timezone)).date() != effective or legal > activation:
            raise ValueError('Legal effective timestamp conflicts with date/activation')
    elif effective == activation.date() and terms.causal_activation_verified is not True:
        raise ValueError('Same-day activation requires explicit causal proof when legal time is unknown')
    return rational(terms.share_ratio, 'share ratio', positive=True), rational(terms.cash_per_raw_equivalent, 'cash boot')


def plan_linear_exchange(ledger, terms, old_row, new_row, *, us_sessions=None):
    """Pure, fully validated stock/mixed plan; never mutates the input ledger.

    Price rows use the existing stock-v1 reference schema. The successor's
    explicitly named reference date is not forced to the predecessor last day.
    Even a newly listed successor needs an observed, already available row.
    """
    import cm06_exact_units_resume_state_v1 as codec
    if type(ledger) is not ExactComparisonLedger:
        raise TypeError('Explicitly promote to ExactComparisonLedger before planning')
    before = codec.canonical(codec.encode(ledger))
    staged = deepcopy(ledger)
    if type(terms) is not LinearExchangeTerms:
        raise TypeError('Explicit LinearExchangeTerms required')
    old_key, new_key = ('U', terms.predecessor), ('U', terms.successor)
    old = staged.positions.get(old_key)
    if old is None:
        return None
    ratio, cash_rate = _validate_terms(staged, terms)
    if terms.event_id in staged.seen:
        raise ValueError('Duplicate linear exchange event')
    if old.currency != 'USD':
        raise ValueError('US comparison exchange requires USD holdings')
    old_factor, old_facts = reference(old_row, terms.predecessor, terms.last_trade_date, staged.at,
                                      permaticker=terms.old_permaticker, tokens=terms.old_name_tokens)
    new_factor, new_facts = reference(new_row, terms.successor, terms.successor_reference_date, staged.at,
                                      permaticker=terms.new_permaticker, tokens=terms.new_name_tokens)
    old_facts['exact_raw_per_comparison_unit'] = _fraction_record(old_factor)
    new_facts['exact_raw_per_comparison_unit'] = _fraction_record(new_factor)
    current = exact_quantity(old)
    raw_equivalents = current * old_factor
    incoming = raw_equivalents * ratio / new_factor
    exact_cash = raw_equivalents * cash_rate
    successor = staged.positions.get(new_key)
    if successor is not None and successor.currency != 'USD':
        raise ValueError('Successor currency mismatch')
    combined = incoming + (exact_quantity(successor) if successor is not None else Fraction(0))
    price, price_at = dec(new_row['comparison_close']), utc(new_row['available_at'])
    if new_key in staged.prices and staged.prices[new_key][1] > price_at:
        raise ValueError('Newer successor mark cannot be overwritten with an older reference')
    fx = staged.rate('USD')
    incoming_quantity, incoming_audit = project_units(incoming, price, fx)
    merged_quantity, merged_audit = project_units(combined, price, fx)
    cash, cash_audit = project_amount(exact_cash, fx=fx)
    due = None
    calendar = None
    if exact_cash:
        if not terms.calendar_id or us_sessions is None:
            raise ValueError('BOUND_US_CALENDAR_REQUIRED: cash due cannot be guessed')
        # The shared calendar validator owns US-market identity, coverage and
        # exact fifth-session counting; no fallback or imported old T+2 policy.
        calendar = us_sessions if type(us_sessions) is USSessionCalendar else USSessionCalendar(us_sessions, calendar_id=terms.calendar_id)
        if calendar.calendar_id != terms.calendar_id:
            raise ValueError('US calendar identity does not match the event binding')
        due = us_t_plus_five(calendar, terms.legal_effective_date, calendar_id=terms.calendar_id)
        due = utc(due)
        if due < staged.at:
            raise ValueError('Cash entitlement recognition after its due date needs a separate catch-up contract')
    stock_value = incoming * Fraction(price)
    cash_basis_fraction = exact_cash / (stock_value + exact_cash)
    with localcontext() as context:
        context.prec = 36
        cash_basis_native, _ = project_amount(Fraction(old.cost_native) * cash_basis_fraction, fx=fx)
        cash_basis_krw, _ = project_amount(Fraction(old.cost_krw) * cash_basis_fraction)
        carry_native = old.cost_native - cash_basis_native
        carry_krw = old.cost_krw - cash_basis_krw
        total_native = carry_native + (successor.cost_native if successor else ZERO)
        total_krw = carry_krw + (successor.cost_krw if successor else ZERO)
    staged.assert_invariants()
    staged.unique(terms.event_id)
    del staged.positions[old_key]
    staged.prices.pop(old_key, None)
    provenance = dict(unit_policy=LIVE_UNIT_POLICY, fractional_policy=LINEAR_POLICY,
                      model_contract_id=terms.model_contract_id, source_url=terms.source_url,
                      raw_equivalents_not_physical_broker_shares=True,
                      actual_fractional_settlement_reproduced=False,
                      predecessor_exact_units=_fraction_record(current),
                      predecessor_raw_equivalents=_fraction_record(raw_equivalents),
                      incoming_exact_units=_fraction_record(incoming),
                      incoming_unit_audit=incoming_audit,
                      prior_successor_entitlement=(deepcopy(successor.entitlement_audit)
                          if type(successor) is ExactComparisonEntitlementPosition else None))
    staged.positions[new_key] = ExactComparisonEntitlementPosition(
        'U', terms.successor, 'USD', merged_quantity, total_native, total_krw,
        successor.sector if successor else new_row.get('sector', old.sector),
        mandatory_event_id=terms.event_id, entitlement_audit=provenance,
        exact_quantity=combined, live_unit_audit=merged_audit)
    staged.prices[new_key] = (price, price_at)
    if exact_cash:
        staged.receivables[terms.event_id] = Receivable(terms.event_id, 'U', 'USD', cash, due,
                                                      'MANDATORY_STOCK_EXCHANGE_CASH:' + CASH_POLICY)
    staged.pnl['realized_gross'] += cash * fx - cash_basis_krw
    staged.record('STOCK_MERGER', id=terms.event_id, sleeve='U', symbol=terms.predecessor,
                  successor=terms.successor, quantity_before=old.quantity,
                  predecessor_exact_units=_fraction_record(current),
                  predecessor_raw_equivalents=_fraction_record(raw_equivalents),
                  successor_exact_units=_fraction_record(incoming),
                  successor_comparison_units=incoming_quantity,
                  successor_unit_projection_audit=incoming_audit,
                  cash_boot_exact=_fraction_record(exact_cash), cash_boot_usd=cash,
                  cash_projection_audit=cash_audit, cash_in_lieu_usd=ZERO,
                  cash_receivable_usd=cash, cash_payment_policy=CASH_POLICY if exact_cash else None,
                  payment_at=due.isoformat() if due else None, payment_timestamp_is_actual=False,
                  cash_available_from=due.isoformat() if due else None,
                  cash_calendar_id=calendar.calendar_id if calendar else None,
                  cash_calendar_sha256=calendar.fingerprint if calendar else None,
                  cash_in_lieu_valuation_status='NOT_APPLICABLE_PRO_RATA_COMPARISON_NO_CIL_PROXY',
                  fee=ZERO, fee_policy='NO_MANDATORY_STOCK_EXCHANGE_MARKET_FEE',
                  market_trade=False, mandatory_exchange=True, fractional_policy=LINEAR_POLICY,
                  model_contract_id=terms.model_contract_id,
                  actual_fractional_settlement_reproduced=False,
                  predecessor_unit_reference=old_facts, successor_unit_reference=new_facts,
                  basis_policy=BASIS_POLICY, predecessor_basis_native=old.cost_native,
                  predecessor_basis_krw=old.cost_krw, carried_basis_native=carry_native,
                  carried_basis_krw=carry_krw, cash_disposed_basis_native=cash_basis_native,
                  cash_disposed_basis_krw=cash_basis_krw, realized_gross_krw=cash*fx-cash_basis_krw,
                  legal_effective_date=terms.legal_effective_date,
                  legal_effective_at=terms.legal_effective_at, activation_at=terms.activation_at,
                  legal_effective_timezone=terms.legal_effective_timezone,
                  source_url=terms.source_url)
    audit = deepcopy(staged.events[-1])
    staged.assert_invariants()
    if due is not None and due == staged.at:
        staged.settle()
    after = codec.canonical(codec.encode(staged))
    return LinearExchangePlan(terms.event_id, codec.hashlib.sha256(before).hexdigest(),
                              codec.digest(codec.source_binding()), after,
                              codec.hashlib.sha256(after).hexdigest(), codec.canonical(audit))


def apply_linear_exchange(ledger, plan):
    """Publish a plan only against exactly its original live state/source."""
    import cm06_exact_units_resume_state_v1 as codec
    if plan is None:
        return False
    if type(ledger) is not ExactComparisonLedger or type(plan) is not LinearExchangePlan:
        raise TypeError('Exact ledger and LinearExchangePlan required')
    if codec.digest(codec.source_binding()) != plan.source_sha256:
        raise ValueError('Linear exchange plan source identity changed')
    before = codec.canonical(codec.encode(ledger))
    if codec.hashlib.sha256(before).hexdigest() != plan.before_sha256:
        raise ValueError('Stale linear exchange plan: ledger changed')
    if codec.hashlib.sha256(plan.after_state).hexdigest() != plan.after_sha256:
        raise ValueError('Linear exchange plan payload changed')
    staged = codec.decode(json.loads(plan.after_state))
    if type(staged) is not ExactComparisonLedger or plan.event_id not in staged.seen or plan.event_id in ledger.seen:
        raise ValueError('Invalid linear exchange commit boundary')
    staged.assert_invariants()
    audit = json.loads(plan.audit_json)
    committed_audits = [e for e in staged.events if e.get('id') == plan.event_id and e.get('kind') == 'STOCK_MERGER']
    if audit.get('id') != plan.event_id or committed_audits != [audit]:
        raise ValueError('Linear exchange audit identity mismatch')
    ledger._publish(staged)
    return audit
