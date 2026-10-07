"""Read-only scalar US rows for the existing atomic rollback deepcopy.

The exact checkpoint codec encodes dict subclasses as ordinary ordered dicts.
Only detached maps of explicitly immutable scalars qualify. Unsupported values
retain the legacy mutable representation and therefore its ordinary deepcopy.
No ledger, intent, adapter, queue, RNG or Decimal state is shared here.
"""
from datetime import date, datetime
from decimal import Decimal
import numpy as np
import pandas as pd

_ATOM_TYPES = frozenset((str, bool, int, float, type(None), Decimal,
                         date, datetime, pd.Timestamp, type(pd.NaT)))


def _is_atom(value):
    if type(value) in _ATOM_TYPES:
        return True
    return isinstance(value, np.generic) and value.dtype.kind in "biufUSmM"


class _ReadOnlyDict(dict):
    __slots__ = ()

    def __new__(cls, source=()):
        values = dict(source)
        if any(type(key) is not str for key in values):
            raise TypeError("Read-only session keys must be strings")
        if any(not (_is_atom(value) or type(value) is _ReadOnlyDict)
               for value in values.values()):
            raise TypeError("Read-only session values must be immutable")
        instance = dict.__new__(cls)
        dict.update(instance, values)
        return instance

    def __init__(self, source=()):
        # Construction occurs once in __new__; reinitialization cannot mutate.
        pass

    def _deny(self, *args, **kwargs):
        raise TypeError("Read-only US session data; replace the whole session")

    __setitem__ = __delitem__ = clear = pop = popitem = setdefault = update = __ior__ = _deny

    def __copy__(self):
        return self

    def __deepcopy__(self, memo):
        memo[id(self)] = self
        return self


def freeze_us_session_rows(rows):
    """Detach one flat scalar cross-section; retain exact values and key order.

    Already frozen sessions are O(1). Restored checkpoints contain ordinary
    dicts and are safely frozen on the next US event. Mutable/unknown nested
    payloads fall back, rather than weakening rollback or changing their types.
    """
    if type(rows) is _ReadOnlyDict:
        return rows
    if type(rows) is not dict:
        return rows
    frozen = {}
    for symbol, row in rows.items():
        if type(symbol) is not str or type(row) is not dict:
            return rows
        if any(type(key) is not str or not _is_atom(value)
               for key, value in row.items()):
            return rows
        frozen[symbol] = _ReadOnlyDict(row)
    return _ReadOnlyDict(frozen)
