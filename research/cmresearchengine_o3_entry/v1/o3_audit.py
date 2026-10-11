"""O3-only copy of the existing final accounting checks, with private reporting."""
import csv
import hashlib
import io
import json
import re
from datetime import datetime
from decimal import Decimal
from cmresearchengine import runtime
from cmresearchengine.runner import read_result
from o3_manifest import manifest, digest
from o3_report import prepare_report, publish_report


def audit_entry_evidence(files, execution, policy_options):
    """Independently recount serialized deliveries and re-evaluate every review."""
    import pandas as pd
    from o3_policy import target
    from o3_signals import SIGNAL_COLUMNS, OBSERVATION_COLUMNS

    def records(name, columns):
        reader = csv.DictReader(io.StringIO(files[name].decode('utf-8-sig')))
        if not set(columns).issubset(reader.fieldnames or []):
            raise ValueError('Missing O3 ENTRY audit schema')
        return list(reader)

    signals = records('o3_entry_signals.csv', SIGNAL_COLUMNS)
    observations = records('o3_signal_observations.csv', OBSERVATION_COLUMNS)
    calendar_rows = records('o3_source_calendar.csv', ['engine', 'session_date', 'open_at', 'close_available_at'])
    calendars = {e: [{k: v for k, v in row.items() if k != 'engine'} for row in calendar_rows if row['engine'] == e]
                 for e in 'KEU'}
    start, end = execution['start_date'], execution['end_date']
    months = sorted({r['session_date'][:7] for r in calendars['K'] if start <= r['session_date'] <= end})
    expected = [month for month in months if all(
        max(r['session_date'] for r in calendars[e] if r['session_date'].startswith(month)) <= end for e in 'KEU')]
    reviews = json.loads(files['reviews.json'])
    if [r['month'] for r in reviews] != expected:
        raise ValueError('O3 expected monthly review sequence mismatch')
    previous = policy_options['initial_weights']
    for review in reviews:
        recalculated = target(review['month'], review['at'], signals, calendars, observations, start,
                              previous, policy_options)
        if recalculated['diagnostics'] != review['policy']:
            raise ValueError('O3 serialized ENTRY recount mismatch')
        if ({e: Decimal(str(w)) for e, w in recalculated['weights'].items()} !=
            {e: Decimal(str(w)) for e, w in review['movement']['targets'].items()}):
            raise ValueError('O3 target weights mismatch')
        previous = recalculated['weights']
    unique = {(r['engine'], r['symbol'], r['origin_date']) for r in signals}
    if len(unique) != len(signals):
        raise ValueError('Duplicate O3 source ENTRY deliveries')
    return {'entry_deliveries_checked': len(signals), 'entry_month_reviews_checked': len(reviews),
            'entry_observations_checked': len(observations)}

def audit(store, candidate, identity):
    plan=manifest()["definition_sha256"]
    path=f'results/{plan}/{candidate}/{identity}/'
    assert store.verify_private_bucket()['public'] is False
    completion_raw=store.get_object(path+'completion.json',max_bytes=1000000)
    summary_raw=store.get_object(path+'summary.json',max_bytes=1000000)
    checkpoint=store.scoped_checkpoints(plan,candidate)
    marker_raw=checkpoint.get_bytes('complete_'+identity)
    assert marker_raw==completion_raw, 'Completion marker/posting byte mismatch'
    completion=json.loads(completion_raw)
    assert isinstance(completion['outputs_size'],int) and completion['outputs_size']>0
    assert len(completion['outputs_sha256'])==64
    files=read_result(completion,checkpoint)
    assert files['summary.json']==summary_raw,'Public private posted summary mismatch'
    file_manifest=json.loads(files['file_manifest.json'])['files']
    assert set(file_manifest)==set(files)-{'file_manifest.json'}
    for name,record in file_manifest.items():
        content=files[name]
        assert len(content)==record['size'],f'{name}: size'
        assert hashlib.sha256(content).hexdigest()==record['sha256'],f'{name}: SHA256'
    summary=json.loads(summary_raw)
    assert summary['candidate_id']==candidate
    assert summary['schema']=='CM_RESEARCH_RESULT_V1'
    assert summary['historical_pit_certified'] is False
    assert summary['actual_historical_execution_certified'] is False
    assert summary['policy']['policy_id']=='RETROSPECTIVE_LAST_VALID_CLOSE_EXIT_V1'
    assert Decimal(summary['ordinary_and_proxy_sales_share_one_way_fee'])==Decimal('0.0015')
    assert summary['evaluation_start']=='2017-08-21' and summary['evaluation_end']=='2026-09-11'
    assert 'final_snapshot' in summary and 'performance' in summary

    def rows(filename):
        return list(csv.DictReader(io.StringIO(files[filename].decode('utf-8-sig'))))
    def D(x):
        return Decimal(str(x))
    def dt(x):
        return datetime.fromisoformat(str(x).replace('Z','+00:00'))
    events=rows('events.csv')
    nav=rows('nav.csv')
    proxies=rows('retrospective_exit_proxy_audit.csv')
    assert len(nav)>0 and len(events)>0
    kinds={'BUY','SELL'}
    trades=[r for r in events if r.get('kind') in kinds]
    assert len({e['id'] for e in trades})==len(trades),'Duplicate trade IDs'
    for e in trades:
        assert D(e['quantity'])>0 and D(e['price'])>0
        assert abs(D(e['fee'])-D(e['quantity'])*D(e['price'])*Decimal('0.0015'))<=Decimal('0.01'),'Fee reconciliation mismatch'
        if e['kind']=='SELL':
            assert dt(e['settlement_at'])>=dt(e['at']),'Backdated cash settlement'
    by_id={e['id']:e for e in trades}
    proxy_sells={e['id'] for e in trades if e['kind']=='SELL' and e.get('execution_class')=='RETROSPECTIVE_EXIT_PROXY'}
    assert len(proxies)==summary['proxy_exit_count']==len(proxy_sells),'Proxy count mismatch'
    assert len({p['fill_id'] for p in proxies})==len(proxies),'Duplicate proxy fill IDs'
    for p in proxies:
        e=by_id[p['fill_id']]
        assert p['fill_id'] in proxy_sells
        assert p['policy_id']=='RETROSPECTIVE_LAST_VALID_CLOSE_EXIT_V1'
        assert str(p['actual_historical_fill']).lower()=='false'
        assert str(p['retroactive_nav_rewrite']).lower()=='false'
        assert dt(p['reference_price_available_at'])<=dt(p['recognition_at'])
        assert str(p['reference_price_date'])<=str(p['trigger_session_date'])
        assert dt(p['cash_available_at'])>=dt(p['recognition_at'])
        assert dt(p['recognition_at'])==dt(e['at'])
        assert dt(p['cash_available_at'])==dt(e['settlement_at'])
        assert D(p['reference_price'])==D(e['price'])
    for r in nav:
        assert D(r['gross_nav_krw'])>0,'Nonpositive NAV'
        for k in ('cash_krw','receivable_krw','market_value_krw'):
            if k in r and r[k]:
                assert D(r[k]).is_finite(),f'Invalid {k}'
    residual=summary['final_snapshot'].get('bridge_residual_krw')
    assert residual is not None and abs(D(residual))<=Decimal('0.01'),'Final balance bridge residual'
    assert int(summary['unresolved_rights_encounter_count'])>=0
    entry_checks = audit_entry_evidence(files, completion['identity']['execution'],
                                       completion['identity']['o3_extension_plan']['contract']['boundary_options'])
    return {"trade_fee_checks":len(trades),"proxy_exit_checks":len(proxies),"nav_rows_checked":len(nav),
            **entry_checks}


def verify_and_publish(store, identity, environ):
    plan = manifest()
    path = f"results/{plan['definition_sha256']}/O3/{identity}/completion.json"
    completion = json.loads(store.get_object(path, max_bytes=1000000))
    descriptor = completion["identity"]
    if (digest(descriptor) != identity or descriptor["o3_extension_plan"] != plan or
            descriptor["code_hashes"] != runtime.code_hashes() or
            descriptor["execution"]["fx_spread"] != "0" or
            descriptor["execution"]["cash_movement"] != "MONTHLY"):
        raise ValueError("O3 final identity changed")
    if environ.get("GITHUB_ACTIONS") != "true" or environ.get("GITHUB_WORKFLOW") != "CMresearchengine O3 ENTRY manual extension":
        raise ValueError("Explicit O3 workflow required")
    run_id, attempt, commit = (environ.get(k, "") for k in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_SHA"))
    if not re.fullmatch(r"[1-9][0-9]*", run_id) or not re.fullmatch(r"[1-9][0-9]*", attempt) or not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("Invalid O3 audit context")
    checks = audit(store, "O3", identity)
    report = prepare_report(store, "O3", identity, {"run_id":run_id,"attempt":int(attempt),"commit":commit}, {"O3"})
    report_hash = publish_report(store, report)
    return {"status":"O3_PRIVATE_AUDIT_VERIFIED","report_sha256":report_hash,**checks}
