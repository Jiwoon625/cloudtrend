"""Narrow US order boundary for existing mandatory Decimal comparison units."""
from decimal import Decimal
from cm06_comparison_signals import FrozenIntentAdapter


class EntitlementAwareIntentAdapter(FrozenIntentAdapter):
    def on_execution_open(self, signal_id, price, current_shares=0):
        delta = super().on_execution_open(signal_id, price, current_shares)
        # Preserve frozen exact-delta sorting as well as budgets and targets.
        # The execution boundary floors a NEW purchase only after sorting.
        if isinstance(delta, Decimal):
            if not delta.is_finite() or delta < 0:
                raise ValueError('Invalid mandatory-entitlement purchase delta')
            if 0 < delta < 1:
                # A sub-unit top-up is not an allowed purchase. Close only this
                # new Decimal path so its batch reservation can be recomputed.
                # Keep a checkpointed audit reason without modifying holdings,
                # the original frozen target, or unspent cash.
                intent = self.pending[signal_id]
                if not hasattr(self, 'entitlement_remainder_cancellations'):
                    self.entitlement_remainder_cancellations = []
                self.entitlement_remainder_cancellations.append({
                    'signal_id': signal_id,
                    'reason': 'MANDATORY_ENTITLEMENT_SUBUNIT_BUY_REMAINDER_CANCELLED',
                    'remaining_comparison_delta': str(delta),
                    'current_comparison_units': str(current_shares),
                    'fixed_target_shares': str(intent['fixed_target_shares']),
                    'unspent_budget': intent['remaining_budget'],
                    'integer_purchase_quantity': 0,
                })
                self.cancel(signal_id)
        return delta


def promote_us_adapter(adapter):
    if type(adapter) is EntitlementAwareIntentAdapter:
        return adapter
    if type(adapter) is not FrozenIntentAdapter or adapter.sleeve != 'US_A0':
        raise TypeError('Only the exact frozen US adapter can be upgraded')
    upgraded = EntitlementAwareIntentAdapter.__new__(EntitlementAwareIntentAdapter)
    upgraded.__dict__.update(adapter.__dict__)
    return upgraded
