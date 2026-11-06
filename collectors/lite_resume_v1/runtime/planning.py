"""Explicit exchange sessions, source provenance, and contiguous replay planning."""
from datetime import date, datetime, timezone
from .state import canonical, digest

START = '2026-10-12'


def timestamp(value):
    t = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if t.tzinfo is None:
        raise ValueError('Timezone-aware exchange timestamp required')
    return t.astimezone(timezone.utc)


def plan_market(*, market, now, sessions, coverage_start, coverage_end,
                calendar_source, collected_through, model_through, inputs, batch_size=31):
    """sessions includes verified regular close times, not a weekday approximation.

    Caller supplies complete calendar coverage and independently verified per-model
    watermarks. A source's existence is never sufficient evidence of input readiness.
    """
    clock = timestamp(now)
    if market not in ('KR', 'ETF', 'US') or not calendar_source:
        raise ValueError('Verified market/calendar source required')
    if not 1 <= batch_size <= 31 or not model_through:
        raise ValueError('Model watermarks and 1-31 session batch size required')
    dates = [s['date'] for s in sessions]
    if dates != sorted(set(dates)):
        raise ValueError('Calendar sessions must be unique and ascending')
    for d in dates:
        date.fromisoformat(d)
    if coverage_start > START or coverage_end < clock.date().isoformat():
        raise ValueError('Insufficient explicit calendar coverage')
    eligible = [s['date'] for s in sessions if timestamp(s['confirmedAt']) <= clock and s['date'] >= START]
    for model, end in model_through.items():
        if end is not None and end not in dates:
            raise ValueError('Model completion not in verified calendar: ' + model)
    needed = [d for d in eligible if any(end is None or d > end for end in model_through.values())]
    rows, ready, blocked = [], [], False
    for d in needed:
        evidence = inputs.get(d, {})
        reason = list(evidence.get('missing', []))
        kind = evidence.get('kind')
        if kind not in ('ATOMIC_DATED_SNAPSHOT', 'DATED_ROSTER_RECONSTRUCTION', 'KR_DATED_SOURCE'):
            reason.append('dated input/provenance missing')
        if not evidence.get('validated'):
            reason.append('input contract not verified')
        if evidence.get('asOfDate') != d:
            reason.append('input date mismatch')
        if not evidence.get('dataHash'):
            reason.append('input hash missing')
        if market == 'US':
            if not evidence.get('rosterHash'):
                reason.append('historical roster/non-price identity missing')
            if kind == 'DATED_ROSTER_RECONSTRUCTION' and not evidence.get('reconstructionProofHash'):
                reason.append('reviewed reconstruction proof missing')
        own_ready = not reason
        if not own_ready:
            blocked = True
        status = 'READY' if own_ready and not blocked else ('WAITING_PREDECESSOR' if own_ready else 'WAITING_INPUT')
        rows.append({'date': d, 'status': status, 'missing': sorted(set(reason)),
                     'models': [m for m, end in model_through.items() if end is None or d > end],
                     'source': evidence})
        if status == 'READY':
            ready.append(d)
    body = dict(version='dated-gap-plan-v1', market=market, frozenAt=now,
                calendarHash=digest(canonical(sessions)), calendarSource=calendar_source,
                collectedThrough=collected_through, modelThrough=model_through,
                targetDate=eligible[-1] if eligible else None, rows=rows,
                batches=[ready[i:i+batch_size] for i in range(0, len(ready), batch_size)],
                blockedDates=[r['date'] for r in rows if r['status'] != 'READY'])
    return dict(body, planHash=digest(canonical(body)))


def common_allocation_dates(required_by_date, completed_by_market):
    """Market holidays need no invented session; stop on the first missing dependency."""
    ready = []
    for day in sorted(required_by_date):
        if any(required not in completed_by_market.get(market, set())
               for market, required in required_by_date[day].items()):
            break
        ready.append(day)
    return ready


def classify_us_input(atomic, reconstruction):
    if atomic is not None:
        if not atomic.get('validated') or atomic.get('kind') != 'ATOMIC_DATED_SNAPSHOT':
            raise ValueError('Corrupt saved atomic input; do not replace it silently')
        return atomic
    if reconstruction is not None:
        if (reconstruction.get('kind') == 'DATED_ROSTER_RECONSTRUCTION'
                and reconstruction.get('validated') and reconstruction.get('reconstructionProofHash')):
            return reconstruction
        raise ValueError('Historical non-price evidence has not been verified')
    return {'kind': None, 'validated': False,
            'missing': ['preserved roster, eligibility, shares, sector and lifecycle evidence']}
