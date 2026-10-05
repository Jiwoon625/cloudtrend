"""Monthly target review transfers only idle settled cash. Never resizes holdings."""
from __future__ import annotations
from decimal import Decimal
from .accounting import Ledger, dec, ZERO, EPS


def move_idle_cash(ledger: Ledger, weights: dict, currencies: dict, fx_spread,
                   review_id: str, drift_threshold=None, engine_order=("K","E","U")):
    w = {k: dec(v) for k, v in weights.items()}
    if any(v < 0 for v in w.values()) or abs(sum(w.values()) - 1) > EPS:
        raise ValueError("Targets must be long-only including cash and sum to one")
    if "C" not in w:
        raise ValueError("An explicit central-cash target is required")
    nav = ledger.snapshot()["gross_nav_krw"]
    sleeves = [s for s in engine_order if s in w] + sorted(set(w)-set(engine_order)-{"C"})
    before = {s: ledger.sleeve_nav(s) for s in [*sleeves, "C"]}
    if drift_threshold is not None:
        if max(abs(before[s] / nav - w[s]) for s in w) < dec(drift_threshold):
            return {"moved": False, "reason": "DRIFT_BELOW_THRESHOLD", "targets": w, "before": before}
    seq = 0
    def transfer(source, target, c, amount):
        nonlocal seq
        if amount > EPS:
            seq += 1
            ledger.transfer(f"{review_id}:transfer:{seq}", source, target, c, amount)
    # Drain only excess free cash, considering positions and receivables as NAV.
    for s in sleeves:
        excess = max(ZERO, before[s] - nav * w[s])
        for c in sorted({c for (owner,c) in ledger.claims if owner == s}):
            amount = min(ledger.available(s, c), excess / ledger.rate(c))
            transfer(s, "C", c, amount)
            excess -= amount * ledger.rate(c)
    # Deficits compete deterministically by the registered engine ID. With sleeve
    # targets their sum is bounded; no dynamic winner gets implicit leverage.
    for s in sleeves:
        c = currencies[s]
        deficit = max(ZERO, nav * w[s] - ledger.sleeve_nav(s))
        central_excess = max(ZERO, ledger.sleeve_nav("C") - nav * w["C"])
        if deficit <= EPS or central_excess <= EPS:
            continue
        amount = min(ledger.available("C", c), deficit / ledger.rate(c),central_excess/ledger.rate(c))
        transfer("C", s, c, amount)
        deficit -= amount * ledger.rate(c)
        for source in sorted({cur for (owner,cur) in ledger.claims if owner == "C" and cur != c}):
            if deficit <= EPS:
                break
            spread = dec(fx_spread)
            # Pay conversion costs from the amount available. Never spend more
            # than the source claim or invent a target-exact pre-fee transfer.
            central_excess = max(ZERO, ledger.sleeve_nav("C") - nav * w["C"])
            source_amount = min(ledger.available("C", source), deficit / (ledger.rate(source) * (1-spread)),central_excess/ledger.rate(source))
            if source_amount <= EPS:
                continue
            seq += 1
            quote_at = ledger.fx_at[c if c != "KRW" else source]
            received = ledger.convert(f"{review_id}:fx:{seq}", "C", source, c, source_amount, spread, quote_at)
            transfer("C", s, c, received)
            deficit -= received * ledger.rate(c)
    after = {s: ledger.sleeve_nav(s) for s in [*sleeves, "C"]}
    ledger.assert_invariants()
    return {"moved": bool(seq), "targets": w, "before": before, "after": after,
            "unreachable_krw": {s: max(ZERO, nav*w[s]-after[s]) for s in sleeves}}
