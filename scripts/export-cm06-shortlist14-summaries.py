"""Export exactly 28 already completed private objects; never run research.

No archive/checkpoint reads, raw logging, public artifacts, or source writes.
This verifies identities/contracts, NOT ZIP membership or underlying accounting.
"""
from __future__ import annotations
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import re

PLAN = 'ce6be8c497e45fa22a41d3a7b924913a23b18588fd05efd33ee14eb961ec7c2c'
PROJECT_SHA = 'fbbf335151136670437c171e937b5b655839b2c783c54dea0a1d080fd9dd453b'
OWNER_PREFIX_SHA = '02cda348b37a8e14924375ddfa2e81980ad18196534286b8f3e87b23fb3371e8'
MANIFEST_SHA = '2dc0fedb0433950ed0fecfb0a65961b71f083905d8b7f1e29c16db9a3fd8a4f7'
MANIFEST = Path(__file__).with_name('data') / 'cm06-shortlist14-summary-allowlist.json'
SCHEMA = 'CM06_PRIVATE_SHORTLIST14_SUMMARY_V1'
GRADE = 'SUMMARY_IDENTITY_VERIFIED_NOT_ARCHIVE_AUDITED'
METRICS = ('cagr', 'mdd', 'cumulative_return', 'annualized_volatility', 'sharpe',
           'sortino', 'worst_rolling_3m', 'worst_rolling_6m', 'worst_rolling_12m',
           'mdd_recovery_days', 'mdd_time_underwater_days', 'max_underwater_calendar_days')
MAX_HEADER = 8192


class ExportError(RuntimeError):
    """Only constant, sanitized error codes may be used."""


def require(value, code):
    if not value:
        raise ExportError(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'DUPLICATE_JSON_KEY')
        result[key] = value
    return result


def parse(raw):
    return json.loads(raw, object_pairs_hook=unique_object,
                      parse_constant=lambda _: (_ for _ in ()).throw(ExportError('NONFINITE_JSON')))


def number(value, optional=False):
    if optional and value is None:
        return None
    require(type(value) in (float, int) and math.isfinite(value), 'INVALID_NUMBER')
    return value


def count(value):
    require(type(value) is int and 0 <= value <= 2**53-1, 'INVALID_COUNT')
    return value


def hash_value(value):
    require(isinstance(value, str) and re.fullmatch('[0-9a-f]{64}', value), 'INVALID_HASH')
    return value


def load_allowlist():
    raw = MANIFEST.read_bytes()
    require(sha(raw) == MANIFEST_SHA, 'ALLOWLIST_CHANGED')
    rows = parse(raw)
    require(type(rows) is dict and len(rows) == 14, 'EXACT_14_REQUIRED')
    total = 0
    for candidate, row in rows.items():
        require(re.fullmatch(r'K10_P[0-9]{3}_Q[0-9]{3}_E[0-9]{3}_U[0-9]{3}_C[0-9]{3}', candidate) and
                type(row) is dict and set(row) == {'identity_sha256', 'summary_bytes', 'completion_bytes'},
                'INVALID_ALLOWLIST_ENTRY')
        hash_value(row['identity_sha256'])
        for key in ('summary_bytes', 'completion_bytes'):
            require(type(row[key]) is int and 0 < row[key] <= 65536, 'INVALID_ALLOWLIST_SIZE')
            total += row[key]
    require(total == 605798, 'INVALID_ALLOWLIST_SET')
    return rows


def resolve_targets(store, approved):
    """Bounded metadata-only lookup under each exact approved candidate.

    Public code pins hashes of private identities, not private storage paths.
    No bucket-wide list, arbitrary prefix, object content, or pagination crawl.
    A full page fails closed rather than expanding the lookup scope.
    """
    targets = {}
    for candidate, row in approved.items():
        relative = f'results/{PLAN}/{candidate}/'
        request = canonical({'prefix': store.prefix + relative, 'limit': 100, 'offset': 0,
                             'sortBy': {'column': 'name', 'order': 'asc'}})
        raw = store._request('POST', 'object/list/cloudtrend-data',
                             lambda response: store._bounded(response, 65536), data=request,
                             headers={'Content-Type': 'application/json'})
        entries = parse(raw)
        require(type(entries) is list and len(entries) < 100, 'METADATA_LOOKUP_INCOMPLETE')
        matches = []
        for entry in entries:
            require(type(entry) is dict and isinstance(entry.get('name'), str), 'INVALID_METADATA_ENTRY')
            name = entry['name']
            if re.fullmatch('[0-9a-f]{64}', name) and sha(name.encode()) == row['identity_sha256']:
                matches.append(name)
        require(len(matches) == 1, 'EXACT_IDENTITY_NOT_FOUND')
        identity = matches[0]
        targets[candidate] = {'identity': identity, 'files': {
            kind: (relative + identity + '/' + kind + '.json', row[kind + '_bytes'])
            for kind in ('summary', 'completion')}}
    return targets


def prepare_report(candidate, target, raw_files):
    summary_raw, completion_raw = raw_files['summary'], raw_files['completion']
    summary, completion = parse(summary_raw), parse(completion_raw)
    identity = completion['identity']
    require(completion['schema'] == 'CM06_FRESH_COMPLETED_V1' and
            sha(canonical(identity)) == target['identity'] and
            identity['candidate']['candidate_id'] == candidate and
            identity['plan_sha256'] == PLAN, 'COMPLETION_IDENTITY_MISMATCH')
    require(summary['schema'] == 'CM_RESEARCH_RESULT_V1' and summary['candidate_id'] == candidate and
            summary['scope'] == 'RESEARCH_COMPARISON_ONLY', 'SUMMARY_IDENTITY_MISMATCH')
    require(summary['execution_contract'] == identity['execution'], 'EXECUTION_CONTRACT_MISMATCH')
    require(summary['evaluation_start'] == '2017-08-21' and summary['evaluation_end'] == '2026-09-11' and
            summary['execution_contract']['initial_capital_krw'] == 100000000 and
            summary['ordinary_and_proxy_sales_share_one_way_fee'] == '0.0015', 'CONTRACT_CHANGED')
    for key in ('historical_pit_certified', 'actual_historical_execution_certified', 'full_tax_supported'):
        require(summary[key] is False, 'LIMITATIONS_CHANGED')
    require(count(completion['outputs_size']) > 0, 'EMPTY_OUTPUT_ARCHIVE')
    p = summary['performance']
    require(p['supported'] is True and p['status'] == 'ok' and p['cagr_days_per_year'] == 365.2425 and
            p['annualization_sessions'] == 252 and p['annual_cash_rate'] == 0, 'PERFORMANCE_CONTRACT_CHANGED')
    metrics = {k: number(p[k], optional=k not in ('cagr', 'mdd', 'cumulative_return')) for k in METRICS}
    require(-1 < metrics['mdd'] <= 0 and metrics['cumulative_return'] > -1, 'INVALID_RETURN_DOMAIN')
    years = []
    require(type(p['yearly_returns']) is list and len(p['yearly_returns']) == 10, 'INVALID_YEARS')
    for expected_year, row in zip(range(2017, 2027), p['yearly_returns'], strict=True):
        require(type(row['year']) is int and row['year'] == expected_year and
                type(row['partial_start']) is bool and type(row['partial_end']) is bool, 'INVALID_YEAR')
        years.append({'year': row['year'], 'return': number(row['return']),
                      'partial_start': row['partial_start'], 'partial_end': row['partial_end']})
    return {'schema': SCHEMA, 'verification_grade': GRADE, 'plan_sha256': PLAN,
            'candidate_id': candidate, 'identity': target['identity'],
            'summary_sha256': sha(summary_raw), 'completion_sha256': sha(completion_raw),
            'declared_outputs_sha256': hash_value(completion['outputs_sha256']),
            'archive_verified': False, 'accounting_recomputed': False, 'rolling_24m_available': False,
            'start': '2017-08-21', 'end': '2026-09-11', 'one_way_fee': '0.0015',
            'historical_pit_certified': False, 'actual_historical_execution_certified': False,
            'full_tax_supported': False, 'metrics': metrics, 'yearly_returns': years,
            'performance_observations': count(p['observations']),
            'proxy_exit_count': count(summary['proxy_exit_count']),
            'unresolved_rights_encounter_count': count(summary['unresolved_rights_encounter_count'])}


def report_payload(report):
    raw = canonical(report)
    digest = sha(raw)
    header = base64.b64encode(canonical({**report, 'report_sha256': digest})).decode('ascii')
    require(len(raw) <= MAX_HEADER and len(header) <= MAX_HEADER, 'METADATA_TOO_LARGE')
    target = f"results/reports/shortlist14-summary/{PLAN}/{report['candidate_id']}/{report['identity']}/{digest}.json"
    return target, raw, header


def publish(store, payload):
    from cmresearchengine.storage import _DuplicateObject
    target, raw, header = payload
    # Immutable content-addressed target, checked before retry; never overwrite.
    try:
        existing = store.get_object(target, max_bytes=len(raw))
    except FileNotFoundError:
        existing = None
    if existing is not None:
        require(existing == raw, 'EXISTING_REPORT_CONFLICT')
        return
    require(store.verify_private_bucket()['public'] is False, 'PRIVATE_BUCKET_REQUIRED')
    try:
        store._request('POST', store._object_route(target), lambda response: store._bounded(response, 65536),
                       data=raw, headers={'Content-Type': 'application/json', 'x-upsert': 'false', 'x-metadata': header})
    except _DuplicateObject:
        pass
    require(store.get_object(target, max_bytes=len(raw)) == raw, 'PRIVATE_REPORT_READBACK_FAILED')


def export(store=None, environ=None):
    env = os.environ if environ is None else environ
    require(env.get('GITHUB_ACTIONS') == 'true' and env.get('GITHUB_EVENT_NAME') == 'workflow_dispatch' and
            env.get('GITHUB_WORKFLOW') == 'CMresearchengine shortlist14 private summary export' and
            env.get('GITHUB_REPOSITORY') == 'Jiwoon625/cloudtrend', 'MANUAL_OWNER_WORKFLOW_REQUIRED')
    prefix = env.get('SUPABASE_USER_ID', '') + '/research/cm/'
    require(sha(env.get('SUPABASE_URL', '').rstrip('/').encode()) == PROJECT_SHA and
            sha(prefix.encode()) == OWNER_PREFIX_SHA, 'PROJECT_OWNER_MISMATCH')
    approved = load_allowlist()
    if store is None:
        from cmresearchengine.storage import SupabaseCMStore
        store = SupabaseCMStore.from_env()
    require(store.prefix == prefix and store.bucket == 'cloudtrend-data' and
            store.verify_private_bucket()['public'] is False, 'PRIVATE_OWNER_BUCKET_REQUIRED')
    targets = resolve_targets(store, approved)
    reports = []
    for candidate, target in targets.items():
        raw_files = {}
        for kind, (path, size) in target['files'].items():
            raw = store.get_object(path, max_bytes=size)
            require(len(raw) == size, 'SOURCE_SIZE_CHANGED')
            raw_files[kind] = raw
        reports.append(prepare_report(candidate, target, raw_files))
    # Validate all sources and all bounded payloads before the first new write.
    payloads = [report_payload(r) for r in reports]
    for payload in payloads:
        publish(store, payload)
    print('{"status":"PRIVATE_SUMMARY_OBJECTS_VERIFIED_METADATA_READBACK_REQUIRED","count":14,"source_objects":28}')


def main():
    try:
        export()
    except Exception:
        # No raw JSON, error bodies, metrics, URLs or credential values in logs.
        print('{"status":"PRIVATE_SUMMARY_EXPORT_BLOCKED"}')
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
