"""Exact event accounting with one physical cash pool and sleeve ownership claims.

No settlement, FX, price, tax, or distribution inputs are invented here. Callers
must supply observed quotes and explicit settlement timestamps from a frozen
calendar. Synthetic unit tests are not historical engine parity evidence.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal, ROUND_DOWN, ROUND_CEILING, getcontext
from collections import defaultdict
from typing import Any

getcontext().prec = 36
D = Decimal
ZERO = D(0)
FEE = D("0.0015")
EPS = D("0.00000001")


def trading_fee(gross):
    return (dec(gross) * FEE).quantize(EPS, rounding=ROUND_CEILING)


def dec(value: Any) -> Decimal:
    value = value if isinstance(value, Decimal) else D(str(value))
    if not value.is_finite():
        raise ValueError("Non-finite amount")
    return value


def utc(value: str | datetime) -> datetime:
    ts = datetime.fromisoformat(value.replace("Z", "+00:00")) if isinstance(value, str) else value
    if ts.tzinfo is None:
        raise ValueError("Every event requires a timezone-aware timestamp")
    return ts.astimezone(timezone.utc)


@dataclass
class Position:
    sleeve: str
    symbol: str
    currency: str
    quantity: int
    cost_native: Decimal
    cost_krw: Decimal
    sector: str | None = None


@dataclass
class Receivable:
    id: str
    sleeve: str
    currency: str
    amount: Decimal
    due_at: datetime
    source: str


@dataclass
class Reservation:
    id: str
    sleeve: str
    currency: str
    amount: Decimal


class Ledger:
    """Physical cash equals the sum of claims; reservations are encumbrances.

    Buy fills consume settled cash immediately (conservative no borrowing).
    Sell proceeds enter receivables until the explicit settlement event.
    Fee 0.15% per side is the only default execution deduction.
    Tax liabilities are separate from fee and from refundable cash reservations.
    """

    def __init__(self, initial_krw: Any, at: str | datetime, sleeve_weights: dict[str, Any]):
        self.initial_krw = dec(initial_krw)
        if self.initial_krw <= 0:
            raise ValueError("Initial capital must be positive")
        weights = {k: dec(v) for k, v in sleeve_weights.items()}
        if any(v < 0 for v in weights.values()) or abs(sum(weights.values()) - 1) > EPS:
            raise ValueError("Initial weights must be non-negative and sum to one")
        self.at = utc(at)
        self.cash = defaultdict(lambda: ZERO, KRW=self.initial_krw)
        self.claims = defaultdict(lambda: ZERO)
        for sleeve, weight in weights.items():
            self.claims[(sleeve, "KRW")] = self.initial_krw * weight
        # Put any harmless decimal division remainder in the central cash claim.
        self.claims[("C", "KRW")] += self.initial_krw - sum(self.claims.values())
        self.reservations: dict[str, Reservation] = {}
        self.tax_reserve = defaultdict(lambda: ZERO)
        self.receivables: dict[str, Receivable] = {}
        self.positions: dict[tuple[str, str], Position] = {}
        self.fx = {"KRW": D(1)}
        self.fx_at = {"KRW": self.at}
        self.prices: dict[tuple[str, str], tuple[Decimal, datetime]] = {}
        self.tax_liability = defaultdict(lambda: ZERO)
        self.tax_paid = defaultdict(lambda: ZERO)
        self.pnl = defaultdict(lambda: ZERO)
        self.events: list[dict[str, Any]] = []
        self.seen: set[str] = set()
        self.record("INITIAL", capital_krw=self.initial_krw)
        self.assert_invariants()

    def advance(self, at: str | datetime):
        ts = utc(at)
        if ts < self.at:
            raise ValueError("Event time reversal")
        self.at = ts

    def record(self, kind: str, **details):
        self.events.append({"seq": len(self.events), "at": self.at.isoformat(), "kind": kind,
                            **{k: str(v) if isinstance(v, Decimal) else v for k, v in details.items()}})

    def unique(self, event_id: str):
        if event_id in self.seen:
            raise ValueError(f"Duplicate event: {event_id}")
        self.seen.add(event_id)

    def rate(self, currency: str) -> Decimal:
        if currency not in self.fx:
            raise ValueError(f"Missing observed FX: {currency}")
        return self.fx[currency]

    def observe_fx(self, currency: str, krw_per_unit: Any, available_at: str | datetime):
        stamp, rate = utc(available_at), dec(krw_per_unit)
        if stamp > self.at or rate <= 0 or (currency == "KRW" and rate != 1):
            raise ValueError("Invalid or future FX quote")
        if currency in self.fx_at and stamp < self.fx_at[currency]:
            raise ValueError("Out-of-order FX quote")
        if currency in self.fx:
            exposed = self.cash[currency] + sum(r.amount for r in self.receivables.values() if r.currency == currency)
            self.pnl["cash_fx"] += exposed * (rate - self.fx[currency])
        self.fx[currency], self.fx_at[currency] = rate, stamp
        self.record("FX_MARK", currency=currency, rate=rate, available_at=stamp.isoformat())

    def available(self, sleeve: str, currency: str, excluding: str | None = None):
        reserved = sum(r.amount for key, r in self.reservations.items()
                       if r.sleeve == sleeve and r.currency == currency and key != excluding)
        return self.claims[(sleeve, currency)] - reserved - self.tax_reserve[(sleeve, currency)]

    def reserve(self, order_id: str, sleeve: str, currency: str, amount: Any):
        amount = dec(amount)
        if order_id in self.reservations or order_id in self.seen:
            raise ValueError("Duplicate cash reservation")
        if amount < 0 or amount > self.available(sleeve, currency) + EPS:
            raise ValueError("Cash reservation exceeds available settled cash")
        self.reservations[order_id] = Reservation(order_id, sleeve, currency, amount)
        self.record("RESERVE", id=order_id, sleeve=sleeve, currency=currency, amount=amount)
        self.assert_invariants()

    def release(self, order_id: str, reason="CANCELLED"):
        r = self.reservations.pop(order_id)
        self.record("RELEASE", id=order_id, amount=r.amount, reason=reason)
        self.assert_invariants()

    def transfer(self, event_id: str, source: str, target: str, currency: str, amount: Any):
        amount = dec(amount)
        if amount < 0 or amount > self.available(source, currency) + EPS:
            raise ValueError("Internal transfer cannot use reserved or unsettled cash")
        self.unique(event_id)
        self.claims[(source, currency)] -= amount
        self.claims[(target, currency)] += amount
        self.record("INTERNAL_TRANSFER", id=event_id, source=source, target=target,
                    currency=currency, amount=amount, pnl_krw=ZERO)
        self.assert_invariants()

    def convert(self, event_id: str, sleeve: str, source: str, target: str,
                source_amount: Any, spread: Any, quote_available_at: str | datetime):
        amount, spread, quote_at = dec(source_amount), dec(spread), utc(quote_available_at)
        if source == target or amount < 0 or not ZERO <= spread < 1:
            raise ValueError("Invalid conversion")
        if quote_at > self.at or any(self.fx_at.get(c) != quote_at for c in [source, target] if c != "KRW"):
            raise ValueError("Conversion requires the exact observed quote timestamp")
        if amount > self.available(sleeve, source) + EPS:
            raise ValueError("Insufficient settled currency for FX")
        sr, tr = self.rate(source), self.rate(target)
        received = amount * sr / tr * (1 - spread)
        self.unique(event_id)
        self.cash[source] -= amount
        self.claims[(sleeve, source)] -= amount
        self.cash[target] += received
        self.claims[(sleeve, target)] += received
        cost = amount * sr * spread
        self.pnl["fx_cost"] += cost
        self.record("FX_CONVERSION", id=event_id, sleeve=sleeve, source=source, target=target,
                    source_amount=amount, received=received, fx_cost_krw=cost,
                    quote_available_at=quote_at.isoformat())
        self.assert_invariants()
        return received

    @staticmethod
    def quantity_for_budget(budget: Any, cash: Any, price: Any, fee_inclusive=True):
        budget, cash, price = dec(budget), dec(cash), dec(price)
        if min(budget, cash) < 0 or price <= 0:
            raise ValueError("Invalid order amounts")
        by_budget = budget / (price * (1 + FEE)) if fee_inclusive else budget / price
        return int(min(by_budget, cash / (price * (1 + FEE))).to_integral_value(rounding=ROUND_DOWN))

    def buy(self, event_id: str, sleeve: str, symbol: str, currency: str, quantity: int,
            price: Any, known_at: str | datetime, reservation_id: str | None = None,
            sector: str | None = None):
        price, known = dec(price), utc(known_at)
        if known > self.at or price <= 0 or not isinstance(quantity, int) or quantity <= 0:
            raise ValueError("Invalid/future buy")
        gross, fee = price * quantity, trading_fee(price * quantity)
        key = (sleeve, symbol)
        fx = self.rate(currency)
        if key in self.prices and known < self.prices[key][1]:
            raise ValueError("Stale fill quote cannot overwrite a later mark")
        if gross + fee > self.available(sleeve, currency, reservation_id) + EPS:
            raise ValueError("Buy exceeds settled available cash")
        if key in self.positions and self.positions[key].currency != currency:
            raise ValueError("Currency changed without corporate action")
        if reservation_id is not None:
            r = self.reservations.get(reservation_id)
            if r is None or (r.sleeve, r.currency) != (sleeve, currency):
                raise ValueError("Unknown or mismatched reservation")
        self.unique(event_id)
        if reservation_id is not None:
            self.reservations.pop(reservation_id)
        self.cash[currency] -= gross + fee
        self.claims[(sleeve, currency)] -= gross + fee
        if key in self.positions:
            p = self.positions[key]
            p.quantity += quantity
            p.cost_native += gross
            p.cost_krw += gross * fx
        else:
            self.positions[key] = Position(sleeve, symbol, currency, quantity, gross, gross * fx, sector)
        self.prices[key] = (price, known)
        self.pnl["trading_cost"] += fee * fx
        self.record("BUY", id=event_id, sleeve=sleeve, symbol=symbol, currency=currency,
                    quantity=quantity, price=price, fee=fee, fee_krw=fee * fx, fx=fx)
        self.assert_invariants()
        return gross + fee

    def sell(self, event_id: str, sleeve: str, symbol: str, quantity: int, price: Any,
             known_at: str | datetime, settlement_at: str | datetime):
        price, known, due = dec(price), utc(known_at), utc(settlement_at)
        key = (sleeve, symbol)
        p = self.positions.get(key)
        if p is None or not isinstance(quantity, int) or not 0 < quantity <= p.quantity:
            raise ValueError("Oversell or invalid quantity")
        if known > self.at or due < self.at or price <= 0:
            raise ValueError("Invalid/future sale or settlement")
        if key in self.prices and known < self.prices[key][1]:
            raise ValueError("Stale fill quote cannot overwrite a later mark")
        fx, gross = self.rate(p.currency), quantity * price
        fee = trading_fee(gross)
        fraction = D(quantity) / p.quantity
        basis_native, basis_krw = p.cost_native * fraction, p.cost_krw * fraction
        self.unique(event_id)
        p.quantity -= quantity
        p.cost_native -= basis_native
        p.cost_krw -= basis_krw
        self.pnl["realized_gross"] += gross * fx - basis_krw
        self.pnl["trading_cost"] += fee * fx
        self.receivables[event_id] = Receivable(event_id, sleeve, p.currency, gross - fee, due, "SALE")
        self.record("SELL", id=event_id, sleeve=sleeve, symbol=symbol, currency=p.currency,
                    quantity=quantity, price=price, fee=fee, fx=fx,
                    basis_native=basis_native, basis_krw=basis_krw,
                    gross_pnl_native=gross - basis_native, gross_pnl_krw=gross * fx - basis_krw,
                    settlement_at=due.isoformat())
        if p.quantity == 0:
            del self.positions[key]
        else:
            self.prices[key] = (price, known)
        self.assert_invariants()
        return gross - fee

    def settle(self):
        matured = [r for r in self.receivables.values() if r.due_at <= self.at]
        for r in sorted(matured, key=lambda x: (x.due_at, x.id)):
            self.cash[r.currency] += r.amount
            self.claims[(r.sleeve, r.currency)] += r.amount
            self.record("SETTLE", id=r.id, source=r.source, sleeve=r.sleeve,
                        currency=r.currency, amount=r.amount, due_at=r.due_at.isoformat())
            del self.receivables[r.id]
        self.assert_invariants()
        return matured

    def income(self, event_id: str, sleeve: str, currency: str, gross: Any,
               payment_at: str | datetime, kind="DIVIDEND", withholding_rate=0):
        gross, wr, due = dec(gross), dec(withholding_rate), utc(payment_at)
        if gross < 0 or not ZERO <= wr < 1 or due < self.at:
            raise ValueError("Invalid income event")
        fx = self.rate(currency)
        self.unique(event_id)
        self.receivables[event_id] = Receivable(event_id, sleeve, currency, gross * (1 - wr), due, kind)
        self.pnl["income"] += gross * fx
        self.pnl["tax_withheld"] += gross * wr * fx
        self.record(kind, id=event_id, sleeve=sleeve, currency=currency, gross=gross,
                    withholding=gross * wr, payment_at=due.isoformat())
        self.assert_invariants()

    def split(self, event_id: str, sleeve: str, symbol: str, numerator: int, denominator: int):
        p = self.positions[(sleeve, symbol)]
        new_quantity = D(p.quantity) * numerator / denominator
        if numerator <= 0 or denominator <= 0 or new_quantity != int(new_quantity):
            raise ValueError("Fractional entitlement requires explicit cash-in-lieu evidence")
        self.unique(event_id)
        p.quantity = int(new_quantity)
        price, stamp = self.prices[(sleeve, symbol)]
        self.prices[(sleeve, symbol)] = (price * denominator / numerator, stamp)
        self.record("SPLIT", id=event_id, sleeve=sleeve, symbol=symbol,
                    numerator=numerator, denominator=denominator, new_quantity=p.quantity)
        self.assert_invariants()

    def mark(self, sleeve: str, symbol: str, price: Any, available_at: str | datetime):
        price, stamp = dec(price), utc(available_at)
        key = (sleeve, symbol)
        if key not in self.positions or price <= 0 or stamp > self.at:
            raise ValueError("Invalid or future mark")
        if key in self.prices and stamp < self.prices[key][1]:
            raise ValueError("Stale mark cannot overwrite later information")
        self.prices[key] = price, stamp

    def accrue_tax(self, tax_year: int, liability_krw: Any):
        amount = dec(liability_krw)
        if amount < self.tax_paid[tax_year]:
            raise ValueError("Refunds need an explicit refund event")
        self.tax_liability[tax_year] = amount - self.tax_paid[tax_year]
        self.record("TAX_ESTIMATE", tax_year=tax_year, annual_liability_krw=amount,
                    remaining_liability_krw=self.tax_liability[tax_year])

    def reserve_tax(self, sleeve: str, amount_krw: Any):
        amount = dec(amount_krw)
        current = self.tax_reserve[(sleeve, "KRW")]
        if amount < 0 or amount > self.available(sleeve, "KRW") + current + EPS:
            raise ValueError("Tax reserve requires settled unencumbered KRW cash")
        self.tax_reserve[(sleeve, "KRW")] = amount
        self.record("TAX_RESERVE", sleeve=sleeve, amount_krw=amount)
        self.assert_invariants()

    def pay_tax(self, event_id: str, tax_year: int, sleeve: str, amount_krw: Any):
        amount = dec(amount_krw)
        if amount < 0 or amount > self.tax_liability[tax_year] + EPS:
            raise ValueError("Payment exceeds known liability")
        other_reserved = sum(r.amount for r in self.reservations.values()
                             if r.sleeve == sleeve and r.currency == "KRW")
        possible = self.claims[(sleeve, "KRW")] - other_reserved
        if amount > possible + EPS:
            self.record("TAX_CASH_SHORTFALL", tax_year=tax_year, required=amount, available=possible)
            return False
        self.unique(event_id)
        self.cash["KRW"] -= amount
        self.claims[(sleeve, "KRW")] -= amount
        self.tax_reserve[(sleeve, "KRW")] = max(ZERO, self.tax_reserve[(sleeve, "KRW")] - amount)
        self.tax_liability[tax_year] -= amount
        self.tax_paid[tax_year] += amount
        self.record("TAX_PAYMENT", id=event_id, tax_year=tax_year, sleeve=sleeve, amount_krw=amount)
        self.assert_invariants()
        return True

    def sleeve_nav(self, sleeve: str):
        cash = sum(v * self.rate(c) for (s, c), v in self.claims.items() if s == sleeve and v)
        rec = sum(r.amount * self.rate(r.currency) for r in self.receivables.values() if r.sleeve == sleeve)
        market = sum(p.quantity * self.prices[key][0] * self.rate(p.currency)
                     for key, p in self.positions.items() if p.sleeve == sleeve)
        return cash + rec + market

    def snapshot(self):
        cash = sum(v * self.rate(c) for c, v in self.cash.items() if v)
        receivable = sum(r.amount * self.rate(r.currency) for r in self.receivables.values())
        market = sum(p.quantity * self.prices[key][0] * self.rate(p.currency) for key, p in self.positions.items())
        unrealized = sum(p.quantity * self.prices[key][0] * self.rate(p.currency) - p.cost_krw
                         for key, p in self.positions.items())
        liability = sum(self.tax_liability.values())
        tax_total = liability + sum(self.tax_paid.values()) + self.pnl["tax_withheld"]
        gross_nav, net_nav = cash + receivable + market, cash + receivable + market - liability
        reconstructed = (self.initial_krw + self.pnl["realized_gross"] + unrealized + self.pnl["income"]
                         + self.pnl["cash_fx"] - self.pnl["trading_cost"] - self.pnl["fx_cost"] - tax_total)
        return {"at": self.at.isoformat(), "gross_nav_krw": gross_nav, "net_nav_krw": net_nav,
                "cash_krw": cash, "receivable_krw": receivable, "market_value_krw": market,
                "unrealized_gross_krw": unrealized, "tax_liability_krw": liability,
                "tax_paid_krw": sum(self.tax_paid.values()), "tax_withheld_krw": self.pnl["tax_withheld"],
                "realized_gross_krw": self.pnl["realized_gross"], "income_krw": self.pnl["income"],
                "cash_fx_krw": self.pnl["cash_fx"], "trading_cost_krw": self.pnl["trading_cost"],
                "fx_cost_krw": self.pnl["fx_cost"], "bridge_residual_krw": net_nav - reconstructed}

    def assert_invariants(self):
        currencies = set(self.cash) | {c for s, c in self.claims}
        for currency in currencies:
            if self.cash[currency] < -EPS:
                raise AssertionError("Negative physical cash")
            if abs(sum(v for (s, c), v in self.claims.items() if c == currency) - self.cash[currency]) > EPS:
                raise AssertionError("Cash claims duplicate or lose physical cash")
        for sleeve, currency in list(self.claims):
            if self.available(sleeve, currency) < -EPS:
                raise AssertionError("Negative available cash")
        if any(not isinstance(p.quantity, int) or p.quantity <= 0 or p.cost_native < -EPS or p.cost_krw < -EPS
               for p in self.positions.values()):
            raise AssertionError("Invalid position quantity or cost")
        if any(r.amount < -EPS for r in self.receivables.values()):
            raise AssertionError("Negative receivable")
        if all(c in self.fx for c in currencies):
            residual = self.snapshot()["bridge_residual_krw"]
            if abs(residual) > EPS:
                raise AssertionError(f"PnL bridge residual {residual}")
