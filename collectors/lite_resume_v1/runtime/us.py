"""Read-only dated inventory. Missing atomic inputs never become current rosters."""
from .planning import plan_market
from .state import canonical, digest


def gap_inventory(ns, state):
    api = ns['_CT_US_ARCHIVE']['UsArchiveApi'](ns['SUPABASE_URL'], ns['SUPABASE_SERVICE_ROLE_KEY'],
        ns['SUPABASE_USER_ID'], ns.get('GITHUB_TOKEN'), ns['requests'])
    models = {}
    for kind in ('US_A0', 'US_A2', 'US_B3'):
        rows = api.rows('ledger_model_sessions', {'series_id': 'eq.adopted-shadow-2026-10-12-v1:' + kind,
            'select': 'session_date,state_hash', 'order': 'session_date.desc', 'limit': '1'})
        if len(rows) != 1:
            raise RuntimeError('Verified US predecessor missing: ' + kind)
        models[kind] = rows[0]['session_date']
    latest = api.rows('us_screening_ingest', {'select': 'as_of_date,data_hash'})
    target = ns['_CT_US_CALENDAR']['date']
    dates, cursor, calendar = [], target, []
    minimum = min(models.values())
    while cursor >= min(minimum, '2026-10-12'):
        if len(dates) >= 1000:
            raise RuntimeError('US calendar exceeds explicit 1000-session inspection limit')
        body, _ = ns['toss_get']('/api/v1/market-calendar/US', {'date': cursor})
        days = list(body['result'].values())
        selected = [d for d in days if d.get('date') == cursor and d.get('regularMarket')]
        if len(selected) != 1:
            raise RuntimeError('US regular session calendar evidence missing: ' + cursor)
        from datetime import timedelta
        from .planning import timestamp
        calendar.append({'date': cursor,
            'confirmedAt': (timestamp(selected[0]['regularMarket']['endTime']) + timedelta(minutes=30)).isoformat()})
        dates.append(cursor)
        prior = body['result']['previousBusinessDay']['date']
        if prior >= cursor:
            raise RuntimeError('US calendar predecessor did not move backwards')
        cursor = prior
    calendar.sort(key=lambda d: d['date'])
    inputs = {}
    for day in dates:
        if day <= minimum:
            continue
        try:
            source, _, _ = ns['_CT_US_ARCHIVE']['read_us_atomic_archive'](ns['DATED_ARCHIVE_DIR'], day)
        except FileNotFoundError:
            inputs[day] = {'asOfDate': day, 'missing': ['dated input.csv/roster.json/source.json'], 'validated': False}
        else:
            inputs[day] = {**source, 'asOfDate': day, 'kind': source['pit']['kind'],
                'rosterHash': source['pit']['rosterHash'], 'validated': True}
    plan = plan_market(market='US', now=state.plan['startedAt'], sessions=calendar,
        coverage_start='2026-10-12', coverage_end=state.plan['startedAt'][:10],
        calendar_source='Toss regularMarket endTime + previousBusinessDay (saved response versions)',
        collected_through=latest[0]['as_of_date'] if latest else None,
        model_through=models, inputs=inputs)
    state.save_json('us-gap-plan', {'target': target, 'models': models}, plan)
    ns['_CT_US_GAP_PLAN'] = plan
    print('미국 복구 계획:', len(plan['rows']), '거래일 / 입력 대기:', plan['blockedDates'])
    return plan
