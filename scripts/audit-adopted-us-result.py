"""Hash-pinned private US result verification; no strategy rerun or original writes."""
from __future__ import annotations
import base64
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import tempfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('adopted_private_job', ROOT / 'scripts/run-adopted-backtest-job.py')
job = importlib.util.module_from_spec(spec)
spec.loader.exec_module(job)
REQUEST = ROOT / '.github/adopted-us-audit-request.json'
FIELDS = {'source_run', 'manifest_sha256', 'manifest_bytes', 'catalog_sha256', 'source_commit'}
RESULT_FILES = {'summary.json', 'US_A0.trades.jsonl', 'US_A0.final-state.json', 'math-audit.json'}


def validate_request(value):
    job.require(isinstance(value, dict) and set(value) == FIELDS, 'INVALID_AUDIT_REQUEST')
    job.require(isinstance(value['source_run'], str) and re.fullmatch(r'[1-9][0-9]*-[1-9][0-9]*', value['source_run']), 'INVALID_SOURCE_RUN')
    job.check_hash(value['manifest_sha256']); job.check_hash(value['catalog_sha256'])
    job.require(type(value['manifest_bytes']) is int and 0 < value['manifest_bytes'] <= 1024 * 1024, 'INVALID_MANIFEST_SIZE')
    job.validated_code_commit({'GITHUB_SHA': value['source_commit']})
    return value


def authorize(environment):
    job.require(environment.get('GITHUB_ACTIONS') == 'true' and environment.get('GITHUB_WORKFLOW') == 'Audit completed US A0 result' and environment.get('GITHUB_EVENT_NAME') == 'push' and environment.get('GITHUB_REF') == job.REQUEST_BRANCH, 'EXPLICIT_AUDIT_REQUEST_REQUIRED')
    event = job.read_local_json(environment.get('GITHUB_EVENT_PATH'), 10 * job.CHUNK, 'INVALID_AUDIT_EVENT')
    message = event.get('head_commit', {}).get('message', '')
    job.require(isinstance(message, str) and message.splitlines() and message.splitlines()[0] == 'audit(adopted-backtest): result', 'AUDIT_REQUEST_COMMIT_MISMATCH')
    return job.validated_code_commit(environment)


def stage_result(storage, request, directory):
    source_prefix = storage.owner + '/research/adopted-full-period/runs/' + request['source_run'] + '/'
    key = source_prefix + 'run-manifest.json'
    storage.input_keys.add(key)
    manifest_path = directory / 'source-run-manifest.json'
    storage.download(key, manifest_path, {'bytes': request['manifest_bytes'], 'sha256': request['manifest_sha256']})
    manifest = job.read_local_json(manifest_path, 1024 * 1024, 'INVALID_COMPLETED_MANIFEST')
    job.require(manifest.get('status') == 'COMPLETE' and manifest.get('mode') == 'full' and manifest.get('market') == 'us' and manifest.get('codeCommit') == request['source_commit'] and manifest.get('catalogSha256') == request['catalog_sha256'], 'COMPLETED_MANIFEST_SCOPE_MISMATCH')
    job.require(isinstance(manifest.get('outputs'), list), 'RESULT_OUTPUTS_MISSING')
    selected = {}
    for item in manifest['outputs']:
        job.require(isinstance(item, dict) and isinstance(item.get('path'), str), 'INVALID_RESULT_OUTPUT')
        relative = item['path']
        if relative.startswith('result/') and relative[7:] in RESULT_FILES:
            job.require(relative not in selected and type(item.get('bytes')) is int and 0 < item['bytes'] <= 100 * job.CHUNK, 'INVALID_RESULT_OUTPUT_SIZE')
            job.check_hash(item.get('sha256')); selected[relative] = item
    job.require(set(selected) == {'result/' + name for name in RESULT_FILES}, 'AUDIT_RESULT_FILES_MISSING')
    target = directory / 'result'; target.mkdir(mode=0o700)
    for relative, evidence in selected.items():
        key = source_prefix + relative; storage.input_keys.add(key)
        storage.download(key, target / relative[7:], evidence)
    return target


def bounded_metadata(value):
    job.require(isinstance(value, dict) and value.get('schema') == 'us-a0-roundtrip-summary-v1' and value.get('status') == 'VERIFIED', 'INVALID_AUDIT_METADATA')
    def walk(item, depth=0):
        job.require(depth <= 8, 'AUDIT_METADATA_TOO_DEEP')
        if isinstance(item, dict):
            job.require(len(item) <= 70 and all(isinstance(k, str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,63}', k) for k in item), 'INVALID_AUDIT_METADATA_KEYS')
            for key, child in item.items():
                job.require(not re.search(r'secret|token|owner|path|url', key, re.I), 'PRIVATE_AUDIT_METADATA_KEY')
                walk(child, depth + 1)
        elif isinstance(item, list):
            job.require(len(item) <= 20, 'AUDIT_METADATA_LIST_TOO_LONG')
            for child in item: walk(child, depth + 1)
        elif isinstance(item, str):
            job.require(len(item) <= 96 and bool(re.fullmatch(r'[A-Za-z0-9_.:+ -]*', item)), 'INVALID_AUDIT_METADATA_TEXT')
        elif isinstance(item, (float, int)) and not isinstance(item, bool):
            job.require(math.isfinite(item), 'INVALID_AUDIT_METADATA_NUMBER')
        else: job.require(item is None or isinstance(item, bool), 'INVALID_AUDIT_METADATA_VALUE')
    walk(value)
    header = base64.b64encode(job.json_bytes(value)).decode('ascii')
    job.require(len(header) <= 8192, 'AUDIT_METADATA_TOO_LARGE')
    return header


def create_summary(storage, local, aggregate):
    key = storage.run_prefix + 'run-manifest.json'; storage.output_keys.add(key)
    evidence = job.digest_file(local); header = bounded_metadata(aggregate)
    storage.verify_private_bucket(evidence['bytes'])
    with tempfile.TemporaryDirectory(prefix='audit-readback-') as directory:
        readback = Path(directory) / 'object'
        if storage.download(key, readback, evidence, optional=True): return evidence
        uncertain = False
        try:
            with Path(local).open('rb') as data:
                with job.safe_response(storage.session, 'POST', storage._url(key, write=True), headers={**storage.headers, 'x-upsert': 'false', 'x-metadata': header, 'Content-Type': 'application/octet-stream', 'Content-Length': str(evidence['bytes'])}, data=data, timeout=(20, 300)) as response:
                    job.require(response.status_code in (200, 201, 400, 409), 'AUDIT_CREATE_FAILED')
        except job.JobError as error:
            if str(error) != 'NETWORK_OR_SESSION_ERROR': raise
            uncertain = True
        exists = storage.download(key, readback, evidence, optional=True)
        job.require(exists, 'UNCERTAIN_AUDIT_CREATE' if uncertain else 'AUDIT_READBACK_MISSING')
    return evidence


def main():
    storage = None
    try:
        environment = dict(os.environ); commit = authorize(environment)
        request = validate_request(job.read_local_json(REQUEST, 4096, 'AUDIT_REQUEST_UNAVAILABLE'))
        run = environment.get('GITHUB_RUN_ID', '') + '-' + environment.get('GITHUB_RUN_ATTEMPT', '')
        import requests
        storage = job.PrivateStorage(requests.Session(), environment.get('SUPABASE_URL', ''), environment.get('SUPABASE_USER_ID', ''), environment.get('SUPABASE_SERVICE_ROLE_KEY', ''), request['catalog_sha256'], run)
        storage.run_prefix = storage.owner + '/research/adopted-full-period/audits/' + run + '/'
        storage.verify_private_bucket()
        with tempfile.TemporaryDirectory(prefix='adopted-us-audit-', dir=environment.get('RUNNER_TEMP')) as folder:
            directory = Path(folder); os.chmod(directory, 0o700)
            result_dir = stage_result(storage, request, directory)
            from audit_us_roundtrips import audit_directory
            aggregate, cycles = audit_directory(result_dir)
            require_verified = aggregate.get('status') == 'VERIFIED' and aggregate.get('sourceLedgerChecksPassed') is True
            job.require(require_verified, 'ROUNDTRIP_VERIFICATION_FAILED')
            cycle_file = directory / 'closed-positions.jsonl'
            with cycle_file.open('xb') as output:
                os.chmod(cycle_file, 0o600)
                for cycle in cycles: output.write(job.json_bytes(cycle) + b'\n')
            cycle_evidence = storage.create_result('result/closed-positions.jsonl', cycle_file)
            aggregate.update(sourceRun=request['source_run'], sourceCommit=request['source_commit'], auditCommit=commit, sourceManifestSha256=request['manifest_sha256'], cyclesSha256=cycle_evidence['sha256'])
            bounded_metadata(aggregate)
            report = directory / 'audit-summary.json'; job.local_json(report, aggregate)
            evidence = create_summary(storage, report, aggregate)
        output = {'status': 'VERIFIED', 'sourceRun': request['source_run'], 'auditRun': run, 'summarySha256': evidence['sha256']}
    except job.JobError as error:
        output = {'status': 'STOPPED', 'code': str(error)}
    except Exception as error:
        code = str(error)
        if type(error).__name__ not in ('AuditError', 'RoundtripError') or not re.fullmatch(r'[A-Z][A-Z0-9_]{1,95}', code): code = 'AUDIT_FAILED_NO_PRIVATE_DETAILS_LOGGED'
        output = {'status': 'STOPPED', 'code': code}
    finally:
        if storage is not None: storage.close()
    print(json.dumps(output, sort_keys=True))
    return 0 if output['status'] == 'VERIFIED' else 1


if __name__ == '__main__': raise SystemExit(main())
