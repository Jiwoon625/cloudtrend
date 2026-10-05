"""Versioned mandatory-entitlement comparison-unit accounting, research only.

Ordinary BUY orders remain whole comparison units. A legal corporate action can
create a Decimal comparison position, with the exact rational entitlement kept
separately. Decimal values are finite projections, never claimed to be exact
rational values. No source module or process-wide Decimal context is modified.
"""
from dataclasses import dataclass, field
from decimal import Decimal, localcontext, ROUND_HALF_EVEN
from fractions import Fraction

from cm06.accounting import Ledger, Position, Receivable, dec, utc, ZERO, EPS, trading_fee

UNIT_PRECISION = 36
UNIT_POLICY = 'MANDATORY_ENTITLEMENT_RATIONAL_AUDIT_DECIMAL36_COMPARISON_UNITS_V1'


def comparison_units(numerator, denominator):
    """Return a 36-significant-digit projection and its exact rational error.

    This does not quantize to a whole share or a fixed number of decimals. The
    caller must separately preserve legal whole shares and legal cash-in-lieu.
    """
    if type(numerator) is not int or type(denominator) is not int or numerator < 0 or denominator <= 0:
        raise ValueError('Invalid comparison-unit rational')
    exact = Fraction(numerator, denominator)
    with localcontext() as context:
        context.prec = UNIT_PRECISION
        context.rounding = ROUND_HALF_EVEN
        projected = Decimal(exact.numerator) / Decimal(exact.denominator)
    error = Fraction(projected) - exact
    return projected, {
        'unit_policy': UNIT_POLICY,
        'comparison_unit_numerator': exact.numerator,
        'comparison_unit_denominator': exact.denominator,
        'comparison_units_decimal': str(projected),
        'decimal_precision': UNIT_PRECISION,
        'decimal_rounding': ROUND_HALF_EVEN,
        'projection_error_numerator': error.numerator,
        'projection_error_denominator': error.denominator,
    }


def assert_projection_value_error(audit, price, fx=1):
    """Require the Decimal projection's KRW value error to be < EPS / 1000."""
    exact = Fraction(audit['comparison_unit_numerator'], audit['comparison_unit_denominator'])
    projected = dec(audit['comparison_units_decimal'])
    error = Fraction(projected) - exact
    if error != Fraction(audit['projection_error_numerator'], audit['projection_error_denominator']):
        raise ValueError('Comparison entitlement projection audit mismatch')
    if abs(error * Fraction(dec(price)) * Fraction(dec(fx))) >= Fraction(EPS) / 1000:
        raise ValueError('Comparison entitlement projection value error exceeds bound')
    return error


@dataclass
class ComparisonEntitlementPosition(Position):
    """The quantity is a comparison unit, not an executable raw-share count.

    entitlement_audit describes the original legal exchange, not a claim that
    later integer comparison BUYs or partial comparison SELLs are raw shares.
    A subsequent exchange can put prior audit records in entitlement_history.
    """
    quantity: Decimal
    mandatory_event_id: str = ''
    entitlement_audit: dict = field(default_factory=dict)


def promote_ledger(ledger):
    """Explicit runtime upgrade at a dated event; no __class__ monkeypatch."""
    if type(ledger) is FractionalComparisonLedger:
        return ledger
    if type(ledger) is not Ledger:
        raise TypeError('Unsupported ledger class for explicit entitlement upgrade')
    ledger.assert_invariants()
    upgraded = FractionalComparisonLedger.__new__(FractionalComparisonLedger)
    upgraded.__dict__.update(ledger.__dict__)
    upgraded.assert_invariants()
    return upgraded


class FractionalComparisonLedger(Ledger):
    """Allow fractional disposal only for traced mandatory comparison positions."""

    def buy(self, event_id, sleeve, symbol, currency, quantity, price, known_at,
            reservation_id=None, sector=None):
        # Never floor inside accounting. Sizing must explicitly choose an integer
        # before a new purchase, including when adding to an entitlement holding.
        if type(quantity) is not int:
            raise ValueError('Ordinary BUY quantity must remain an integer')
        return super().buy(event_id, sleeve, symbol, currency, quantity, price,
                           known_at, reservation_id, sector)

    def sell(self, event_id, sleeve, symbol, quantity, price, known_at, settlement_at):
        key = (sleeve, symbol)
        p = self.positions.get(key)
        if type(p) is not ComparisonEntitlementPosition:
            return super().sell(event_id, sleeve, symbol, quantity, price, known_at, settlement_at)
        if type(quantity) not in (int, Decimal):
            raise ValueError('Entitlement SELL requires integer or Decimal comparison units')
        quantity = dec(quantity)
        price, known, due = dec(price), utc(known_at), utc(settlement_at)
        if not ZERO < quantity <= p.quantity:
            raise ValueError('Oversell or invalid quantity')
        if known > self.at or due < self.at or price <= 0:
            raise ValueError('Invalid/future sale or settlement')
        if key in self.prices and known < self.prices[key][1]:
            raise ValueError('Stale fill quote cannot overwrite a later mark')
        fx, gross = self.rate(p.currency), quantity * price
        fee = trading_fee(gross)
        full = quantity == p.quantity
        # Final disposal consumes every remaining Decimal unit and all basis;
        # there is no int cast, tolerance-based deletion, or stranded residual.
        fraction = Decimal(1) if full else quantity / p.quantity
        basis_native = p.cost_native if full else p.cost_native * fraction
        basis_krw = p.cost_krw if full else p.cost_krw * fraction
        self.unique(event_id)
        p.quantity = ZERO if full else p.quantity - quantity
        p.cost_native = ZERO if full else p.cost_native - basis_native
        p.cost_krw = ZERO if full else p.cost_krw - basis_krw
        self.pnl['realized_gross'] += gross * fx - basis_krw
        self.pnl['trading_cost'] += fee * fx
        self.receivables[event_id] = Receivable(event_id, sleeve, p.currency, gross - fee, due, 'SALE')
        self.record('SELL', id=event_id, sleeve=sleeve, symbol=symbol, currency=p.currency,
                    quantity=quantity, price=price, fee=fee, fx=fx,
                    basis_native=basis_native, basis_krw=basis_krw,
                    gross_pnl_native=gross-basis_native, gross_pnl_krw=gross*fx-basis_krw,
                    settlement_at=due.isoformat(), quantity_unit='ADJUSTED_COMPARISON_UNITS',
                    mandatory_entitlement_id=p.mandatory_event_id,
                    full_comparison_liquidation=full)
        if full:
            del self.positions[key]
        else:
            self.prices[key] = (price, known)
        self.assert_invariants()
        return gross - fee

    def split(self, event_id, sleeve, symbol, numerator, denominator):
        if type(self.positions[(sleeve, symbol)]) is ComparisonEntitlementPosition:
            raise ValueError('Entitlement position split requires an explicit legal/comparison-unit action adapter')
        return super().split(event_id, sleeve, symbol, numerator, denominator)

    def assert_invariants(self):
        # Same cash, claims, reservation, receivable and PnL checks as frozen
        # Ledger; only the position-type/quantity contract is extended.
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
            elif type(p) is ComparisonEntitlementPosition:
                if type(p.quantity) is not Decimal or not p.quantity.is_finite():
                    raise AssertionError('Entitlement quantity requires finite Decimal units')
                if not p.mandatory_event_id or p.mandatory_event_id not in self.seen:
                    raise AssertionError('Entitlement position lacks committed mandatory event')
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
