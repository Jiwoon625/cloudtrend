"""Approved current-vintage comparison prices; never historical raw execution.

This adapter only transforms a quote. It does not confer historical eligibility,
create shares, recalculate liquidity, or certify a backtest. Signals derived from
another price basis cannot be relabeled as closeadj signals.
"""
from math import isfinite

BASIS = 'CLOSEADJ_OHLC_RATIO_COMPARISON_V1'
APPROVAL_KST = '2026-10-04T03:54:00+09:00'
ONE_WAY_COST = '0.0015'


def _positive(value, field):
    if isinstance(value, bool):
        raise ValueError('Invalid price: ' + field)
    try:
        x = float(value)
    except (ValueError, TypeError, OverflowError) as exc:
        raise ValueError('Invalid price: ' + field) from exc
    if not isfinite(x) or x <= 0:
        raise ValueError('Invalid price: ' + field)
    return x


def comparison_quote(row):
    """Return separate comparison fields, preserving every original input field.

    The ratio comes exclusively from this row. No preceding/following adjustment
    ratio is substituted. Invalid observations are rejected for explicit handling.
    Shares and market liquidity cannot be reconstructed from this transformation.
    """
    values = {k: _positive(row.get(k), k)
              for k in ('open', 'high', 'low', 'close', 'closeadj')}
    if values['high'] < max(values[k] for k in ('open', 'close', 'low')):
        raise ValueError('Inconsistent source high')
    if values['low'] > min(values[k] for k in ('open', 'close', 'high')):
        raise ValueError('Inconsistent source low')
    ratio = values['closeadj'] / values['close']
    transformed = {k: values[k] * ratio for k in ('open', 'high', 'low')}
    if not isfinite(ratio) or ratio <= 0 or any(
            not isfinite(v) or v <= 0 for v in transformed.values()):
        raise ValueError('Invalid or overflowing comparison ratio')
    additions = {
        **{'comparison_' + k: v for k, v in transformed.items()},
        'comparison_close': values['closeadj'],
        'comparison_ratio': ratio,
        'comparison_price_basis': BASIS,
        'comparison_unit_semantics': 'INTEGER_COMPARISON_UNITS_NOT_HISTORICAL_SHARES',
    }
    if set(additions).intersection(row):
        raise ValueError('Comparison fields already exist; no implicit overwrite')
    return dict(row, **additions)
