"""Reconcile ambiguous create/upload outcomes before any retry."""


def create_verified(*, read, create, expected):
    """read returns bytes or None only for an explicit 404.

    All authorization/network/malformed-read errors propagate. A lost write
    response is successful only when an independent read proves exact bytes.
    """
    existing = read()
    if existing is not None:
        if existing != expected:
            raise RuntimeError('Immutable remote artifact differs; no write attempted')
        return 'REUSED'
    try:
        create()
    except Exception:
        if read() != expected:
            raise RuntimeError('Write outcome unresolved; preserve intent and reconcile before retry') from None
        return 'RECONCILED'
    if read() != expected:
        raise RuntimeError('Remote artifact readback mismatch')
    return 'CREATED'
