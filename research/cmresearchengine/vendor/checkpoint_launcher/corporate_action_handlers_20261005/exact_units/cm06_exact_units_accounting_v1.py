"""Isolated live rational comparison-unit accounting. No event is activated here.

The Fraction is the current balance. Decimal36 is only the ledger-facing
projection. The old legal whole-share/CIL implementation remains a separate
position policy and is never reconstructed from a stale entitlement audit.
"""
from copy import deepcopy
from dataclasses import dataclass, field
from decimal import Decimal
from fractions import Fraction

from cm06.accounting import Ledger, Position, Receivable, ZERO, EPS, dec, utc, trading_fee
from cm06_fractional_accounting_v1 import (
    FractionalComparisonLedger, ComparisonEntitlementPosition,
    comparison_units, assert_projection_value_error, UNIT_POLICY,
)

LIVE_UNIT_POLICY = 'LIVE_RATIONAL_COMPARISON_UNITS_DECIMAL36_V1'


def project_units(exact, price=None, fx=1):
    if type(exact) is not Fraction or exact < 0:
        raise ValueError('Exact comparison units require a nonnegative Fraction')
    projected, audit = comparison_units(exact.numerator, exact.denominator)
    audit['unit_policy'] = LIVE_UNIT_POLICY
    if price is not None:
        assert_projection_value_error(audit, price, fx)
    return projected, audit


def project_amount(exact, *, fx=1):
    """Bound the native monetary projection error in the KRW bridge."""
    if type(exact) is not Fraction or exact < 0:
        raise ValueError('Exact nonnegative rational amount required')
    return project_units(exact, 1, fx)


@dataclass
class ExactComparisonEntitlementPosition(ComparisonEntitlementPosition):
    exact_quantity: Fraction = Fraction(0)
    live_unit_audit: dict = field(default_factory=dict)


def exact_quantity(position):
    if type(position) is Position and type(position.quantity) is int:
        return Fraction(position.quantity)
    if type(position) is ExactComparisonEntitlementPosition:
        return position.exact_quantity
    raise ValueError('EXPLICIT_EXACT_BALANCE_MIGRATION_REQUIRED: legacy audit is not a live balance')


def _set_units(position, exact, price, fx):
    projected, audit = project_units(exact, price, fx)
    position.exact_quantity = exact
    position.quantity = projected
    position.live_unit_audit = audit


def promote_ledger(ledger):
    """Return a distinct upgraded ledger, with no class mutation or old writes.

    Existing legal/CIL positions stay on their old policy. Their current exact
    balance cannot be inferred from their original historical audit.
    """
    if type(ledger) is ExactComparisonLedger:
        return ledger
    if type(ledger) not in (Ledger, FractionalComparisonLedger):
        raise TypeError('Unsupported explicit exact-ledger upgrade')
    upgraded = ExactComparisonLedger.__new__(ExactComparisonLedger)
    upgraded.__dict__.update(deepcopy(ledger.__dict__))
    upgraded.assert_invariants()
    return upgraded


def execution_sale_quantity(position, capacity):
    """Match the existing integer-capacity execution seam without rounding.

    Current execution cannot produce rational partial sales: it returns integer
    capacity, or the complete projected entitlement when below that capacity.
    A future rational-partial execution contract needs its own explicit seam.
    """
    if type(capacity) is not int or capacity < 0:
        raise ValueError('Frozen execution capacity must be a nonnegative integer')
    if type(position) is ExactComparisonEntitlementPosition:
        return position.quantity if Fraction(capacity) >= position.exact_quantity else capacity
    return min(position.quantity, capacity)


class ExactComparisonLedger(FractionalComparisonLedger):
    def _publish(self, staged, *, closed_key=None):
        # Preserve position references used by the existing execution adapter.
        for key, old in self.positions.items():
            replacement = staged.positions.get(key)
            if replacement is not None and type(replacement) is type(old):
                old.__dict__.update(replacement.__dict__)
                staged.positions[key] = old
            elif key == closed_key:
                old.quantity = ZERO
                old.cost_native = old.cost_krw = ZERO
                _set_units(old, Fraction(0), self.prices[key][0], self.rate(old.currency))
        self.__dict__.clear()
        self.__dict__.update(staged.__dict__)

    def buy(self, event_id, sleeve, symbol, currency, quantity, price, known_at,
            reservation_id=None, sector=None):
        if type(quantity) is not int:
            raise ValueError('Ordinary BUY quantity must remain an integer')
        key = (sleeve, symbol)
        if type(self.positions.get(key)) is not ExactComparisonEntitlementPosition:
            return super().buy(event_id, sleeve, symbol, currency, quantity, price,
                               known_at, reservation_id, sector)
        staged = deepcopy(self)
        staged.assert_invariants()
        p = staged.positions[key]
        price, known = dec(price), utc(known_at)
        if quantity <= 0 or price <= 0 or known > staged.at:
            raise ValueError('Invalid/future buy')
        gross, fee = price * quantity, trading_fee(price * quantity)
        fx = staged.rate(currency)
        if known < staged.prices[key][1]:
            raise ValueError('Stale fill quote cannot overwrite a later mark')
        if gross + fee > staged.available(sleeve, currency, reservation_id) + EPS:
            raise ValueError('Buy exceeds settled available cash')
        if p.currency != currency:
            raise ValueError('Currency changed without corporate action')
        if reservation_id is not None:
            r = staged.reservations.get(reservation_id)
            if r is None or (r.sleeve, r.currency) != (sleeve, currency):
                raise ValueError('Unknown or mismatched reservation')
        _set_units(p, p.exact_quantity + quantity, price, fx)
        staged.unique(event_id)
        if reservation_id is not None:
            staged.reservations.pop(reservation_id)
        staged.cash[currency] -= gross + fee
        staged.claims[(sleeve, currency)] -= gross + fee
        p.cost_native += gross
        p.cost_krw += gross * fx
        staged.prices[key] = (price, known)
        staged.pnl['trading_cost'] += fee * fx
        staged.record('BUY', id=event_id, sleeve=sleeve, symbol=symbol, currency=currency,
                      quantity=quantity, price=price, fee=fee, fee_krw=fee * fx, fx=fx)
        staged.assert_invariants()
        self._publish(staged)
        return gross + fee

    def sell(self, event_id, sleeve, symbol, quantity, price, known_at, settlement_at):
        key = (sleeve, symbol)
        old = self.positions.get(key)
        if type(old) is not ExactComparisonEntitlementPosition:
            return super().sell(event_id, sleeve, symbol, quantity, price, known_at, settlement_at)
        # Only a complete matching projection can stand for noninteger units.
        # Never construct Fraction from an arbitrary projected partial sale.
        if type(quantity) is Decimal and quantity == old.quantity:
            sold = old.exact_quantity
        elif type(quantity) is int:
            sold = Fraction(quantity)
        else:
            raise ValueError('Exact SELL requires integer partial quantity or exact full-close projection')
        if not 0 < sold <= old.exact_quantity:
            raise ValueError('Oversell or invalid quantity')
        staged = deepcopy(self)
        staged.assert_invariants()
        p = staged.positions[key]
        price, known, due = dec(price), utc(known_at), utc(settlement_at)
        if known > staged.at or due < staged.at or price <= 0:
            raise ValueError('Invalid/future sale or settlement')
        if known < staged.prices[key][1]:
            raise ValueError('Stale fill quote cannot overwrite a later mark')
        fx = staged.rate(p.currency)
        units, sold_audit = project_units(sold, price, fx)
        # Frozen finite-Decimal gross/15bp fee arithmetic is intentionally kept.
        gross = units * price
        fee = trading_fee(gross)
        full = sold == p.exact_quantity
        ratio, _ = project_units(sold / p.exact_quantity)
        basis_native = p.cost_native if full else p.cost_native * ratio
        basis_krw = p.cost_krw if full else p.cost_krw * ratio
        _set_units(p, p.exact_quantity - sold, price, fx)
        p.cost_native = ZERO if full else p.cost_native - basis_native
        p.cost_krw = ZERO if full else p.cost_krw - basis_krw
        staged.unique(event_id)
        staged.pnl['realized_gross'] += gross * fx - basis_krw
        staged.pnl['trading_cost'] += fee * fx
        staged.receivables[event_id] = Receivable(event_id, sleeve, p.currency, gross - fee, due, 'SALE')
        staged.record('SELL', id=event_id, sleeve=sleeve, symbol=symbol, currency=p.currency,
                      quantity=units, price=price, fee=fee, fx=fx,
                      basis_native=basis_native, basis_krw=basis_krw,
                      gross_pnl_native=gross-basis_native, gross_pnl_krw=gross*fx-basis_krw,
                      settlement_at=due.isoformat(), quantity_unit='ADJUSTED_COMPARISON_UNITS',
                      mandatory_entitlement_id=p.mandatory_event_id,
                      full_comparison_liquidation=full, exact_sold_unit_audit=sold_audit)
        if full:
            del staged.positions[key]
        else:
            staged.prices[key] = (price, known)
        staged.assert_invariants()
        self._publish(staged, closed_key=key if full else None)
        return gross - fee

    def split(self, event_id, sleeve, symbol, numerator, denominator):
        """Apply a compiled COMPARISON-unit ratio, never a raw legal split R.

        A dispatcher must compile F_old * R / F_new first. Prepared comparison
        prices may already include the split, so passing R alone can double it.
        """
        key = (sleeve, symbol)
        if type(self.positions[key]) is not ExactComparisonEntitlementPosition:
            return super().split(event_id, sleeve, symbol, numerator, denominator)
        if type(numerator) is not int or type(denominator) is not int or min(numerator, denominator) <= 0:
            raise ValueError('Exact split requires positive integer numerator/denominator')
        staged = deepcopy(self)
        staged.assert_invariants()
        p = staged.positions[key]
        price, stamp = staged.prices[key]
        ratio = Fraction(numerator, denominator)
        new_price, _ = project_amount(Fraction(price) / ratio, fx=staged.rate(p.currency))
        price_error = Fraction(new_price) - Fraction(price) / ratio
        if abs(price_error * p.exact_quantity * ratio * Fraction(staged.rate(p.currency))) >= Fraction(EPS)/1000:
            raise ValueError('Split price projection value error exceeds bound')
        _set_units(p, p.exact_quantity * ratio, new_price, staged.rate(p.currency))
        staged.unique(event_id)
        staged.prices[key] = (new_price, stamp)
        staged.record('SPLIT', id=event_id, sleeve=sleeve, symbol=symbol,
                      numerator=numerator, denominator=denominator, new_quantity=p.quantity,
                      live_unit_audit=p.live_unit_audit, fee=ZERO)
        staged.assert_invariants()
        self._publish(staged)

    def mark(self, sleeve, symbol, price, available_at):
        key = (sleeve, symbol)
        if type(self.positions.get(key)) is ExactComparisonEntitlementPosition:
            assert_projection_value_error(self.positions[key].live_unit_audit, dec(price), self.rate(self.positions[key].currency))
        return super().mark(sleeve, symbol, price, available_at)

    def observe_fx(self, currency, krw_per_unit, available_at):
        for key, p in self.positions.items():
            if type(p) is ExactComparisonEntitlementPosition and p.currency == currency:
                assert_projection_value_error(p.live_unit_audit, self.prices[key][0], dec(krw_per_unit))
        return super().observe_fx(currency, krw_per_unit, available_at)

    def assert_invariants(self):
        # Frozen ledger checks, with only the position class contract extended.
        currencies = set(self.cash) | {c for s, c in self.claims}
        for currency in currencies:
            if self.cash[currency] < -EPS:
                raise AssertionError('Negative physical cash')
            if abs(sum(v for (s, c), v in self.claims.items() if c == currency)-self.cash[currency]) > EPS:
                raise AssertionError('Cash claims duplicate or lose physical cash')
        for sleeve, currency in list(self.claims):
            if self.available(sleeve, currency) < -EPS:
                raise AssertionError('Negative available cash')
        for key, p in self.positions.items():
            if type(p) is Position:
                if type(p.quantity) is not int:
                    raise AssertionError('Ordinary position quantity must remain integer')
            elif type(p) in (ComparisonEntitlementPosition, ExactComparisonEntitlementPosition):
                if type(p.quantity) is not Decimal or not p.quantity.is_finite():
                    raise AssertionError('Entitlement quantity requires finite Decimal units')
                if not p.mandatory_event_id or p.mandatory_event_id not in self.seen:
                    raise AssertionError('Entitlement position lacks committed mandatory event')
                if type(p) is ExactComparisonEntitlementPosition:
                    if type(p.exact_quantity) is not Fraction or p.exact_quantity <= 0:
                        raise AssertionError('Live exact quantity must be a positive Fraction')
                    quantity, audit = project_units(p.exact_quantity, self.prices[key][0], self.rate(p.currency))
                    if p.quantity != quantity or p.live_unit_audit != audit:
                        raise AssertionError('Live exact quantity/projection audit mismatch')
                    if p.entitlement_audit.get('unit_policy') != LIVE_UNIT_POLICY:
                        raise AssertionError('Missing exact mandatory comparison provenance')
                else:
                    audit = p.entitlement_audit
                    if not isinstance(audit, dict) or audit.get('unit_policy') != UNIT_POLICY:
                        raise AssertionError('Entitlement position lacks versioned rational unit audit')
                    if type(audit.get('raw_legal_shares')) is not int or audit['raw_legal_shares'] < 0:
                        raise AssertionError('Legal raw shares must be explicit whole shares')
                    assert_projection_value_error(audit, self.prices[key][0], self.rate(p.currency))
            else:
                raise AssertionError('Unsupported position class')
            if p.quantity <= 0 or p.cost_native < -EPS or p.cost_krw < -EPS:
                raise AssertionError('Invalid position quantity or cost')
        if any(r.amount < -EPS for r in self.receivables.values()):
            raise AssertionError('Negative receivable')
        if all(c in self.fx for c in currencies):
            residual = self.snapshot()['bridge_residual_krw']
            if abs(residual) > EPS:
                raise AssertionError(f'PnL bridge residual {residual}')
