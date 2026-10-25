import base64
from contextlib import redirect_stdout
from copy import deepcopy
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('summary_export', Path(__file__).with_name('export-cm06-shortlist14-summaries.py'))
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
TEST_PROJECT = 'https://abcdefghijklmnopqrst.supabase.co'
TEST_PREFIX = '00000000-0000-0000-0000-000000000000/research/cm/'
ENV = {'GITHUB_ACTIONS': 'true', 'GITHUB_EVENT_NAME': 'workflow_dispatch',
       'GITHUB_WORKFLOW': 'CMresearchengine shortlist14 private summary export',
       'GITHUB_REPOSITORY': 'Jiwoon625/cloudtrend', 'SUPABASE_URL': TEST_PROJECT,
       'SUPABASE_USER_ID': TEST_PREFIX.split('/')[0]}


class Store:
    prefix = TEST_PREFIX
    bucket = 'cloudtrend-data'
    def __init__(self):
        self.objects = {}
        self.reads = []
        self.posts = []
        self.private = True
    def verify_private_bucket(self):
        return {'public': not self.private}
    def get_object(self, key, max_bytes):
        self.reads.append((key, max_bytes))
        if key not in self.objects:
            raise FileNotFoundError()
        raw = self.objects[key]
        m.require(len(raw) <= max_bytes, 'TOO_LARGE')
        return raw
    def _object_route(self, key):
        return key
    def _request(self, method, route, consume, *, data, headers):
        assert method == 'POST' and headers['x-upsert'] == 'false'
        assert route not in self.objects
        self.posts.append((route, data, headers))
        self.objects[route] = data


def fixture(candidate='K10_P000_Q040_E000_U040_C020'):
    execution = {'initial_capital_krw': 100000000}
    identity = {'candidate': {'candidate_id': candidate}, 'plan_sha256': m.PLAN, 'execution': execution}
    target = {'identity': m.sha(m.canonical(identity))}
    summary = {'schema': 'CM_RESEARCH_RESULT_V1', 'scope': 'RESEARCH_COMPARISON_ONLY', 'candidate_id': candidate,
               'execution_contract': execution, 'evaluation_start': '2017-08-21', 'evaluation_end': '2026-09-11',
               'ordinary_and_proxy_sales_share_one_way_fee': '0.0015', 'historical_pit_certified': False,
               'actual_historical_execution_certified': False, 'full_tax_supported': False,
               'proxy_exit_count': 0, 'unresolved_rights_encounter_count': 0,
               'private_unexported': 'DO_NOT_EXPORT_RAW_SECRET',
               'performance': {'supported': True, 'status': 'ok', 'cagr_days_per_year': 365.2425,
                 'annualization_sessions': 252, 'annual_cash_rate': 0, 'observations': 100,
                 **{k: 0.1 for k in m.METRICS}, 'mdd': -0.1,
                 'yearly_returns': [{'year': y, 'return': 0.1, 'partial_start': y == 2017,
                                    'partial_end': y == 2026} for y in range(2017, 2027)]}}
    completion = {'schema': 'CM06_FRESH_COMPLETED_V1', 'identity': identity, 'outputs_size': 100000000,
                  'outputs_sha256': 'b'*64}
    return candidate, target, {'summary': m.canonical(summary), 'completion': m.canonical(completion)}


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.project_patch = patch.object(m, 'PROJECT_SHA', m.sha(TEST_PROJECT.encode()))
        self.owner_patch = patch.object(m, 'OWNER_PREFIX_SHA', m.sha(TEST_PREFIX.encode()))
        self.project_patch.start(); self.owner_patch.start()
        self.addCleanup(self.project_patch.stop); self.addCleanup(self.owner_patch.stop)

    def test_exact_manifest(self):
        targets = m.load_allowlist()
        self.assertEqual(len(targets), 14)
        self.assertEqual(sum(r['summary_bytes'] + r['completion_bytes'] for r in targets.values()), 605798)
        self.assertTrue(all(set(r) == {'identity_sha256', 'summary_bytes', 'completion_bytes'} for r in targets.values()))

    def test_changed_manifest_fails_closed(self):
        for raw in (b'{}', m.MANIFEST.read_bytes()+b' ', b'{"../output.zip":1}', b'{"x":1,"x":2}'):
            with self.subTest(raw=raw[:20]), patch.object(Path, 'read_bytes', return_value=raw):
                with self.assertRaises(m.ExportError):
                    m.load_allowlist()

    def test_summary_only_grade_and_minimal_fields(self):
        c, t, raw = fixture()
        report = m.prepare_report(c, t, raw)
        self.assertEqual(report['verification_grade'], m.GRADE)
        self.assertFalse(report['archive_verified'])
        self.assertFalse(report['accounting_recomputed'])
        self.assertFalse(report['rolling_24m_available'])
        path, body, header = m.report_payload(report)
        self.assertNotIn(b'DO_NOT_EXPORT', body)
        self.assertLessEqual(len(header), 8192)
        self.assertEqual(json.loads(base64.b64decode(header))['report_sha256'], m.sha(body))
        self.assertEqual(report['summary_sha256'], m.sha(raw['summary']))
        self.assertTrue(path.startswith('results/reports/shortlist14-summary/'))

    def test_rejects_invalid_source(self):
        for field, value in [('candidate_id', 'other'), ('execution_contract', {}),
                             ('historical_pit_certified', True), ('evaluation_start', '2020-01-01')]:
            c, t, raw = fixture()
            s = json.loads(raw['summary']); s[field] = value; raw['summary'] = m.canonical(s)
            with self.subTest(field=field), self.assertRaises(m.ExportError):
                m.prepare_report(c, t, raw)
        c, t, raw = fixture(); t['identity'] = '0'*64
        with self.assertRaises(m.ExportError): m.prepare_report(c, t, raw)

    def test_bad_numbers_duplicates_and_metadata_size(self):
        for value in (True, '0.1', float('inf'), float('nan')):
            with self.assertRaises(m.ExportError): m.number(value)
        for raw in (b'{"a":1,"a":2}', b'{"a":NaN}'):
            with self.assertRaises(m.ExportError): m.parse(raw)
        with self.assertRaises(m.ExportError): m.report_payload({'extra': 'x'*10000})

    def test_publish_create_only_readback_and_idempotence(self):
        c, t, raw = fixture(); payload = m.report_payload(m.prepare_report(c, t, raw)); store = Store()
        m.publish(store, payload); m.publish(store, payload)
        self.assertEqual(len(store.posts), 1)
        store.objects[payload[0]] = b'wrong'
        with self.assertRaises(m.ExportError): m.publish(store, payload)
        self.assertEqual(len(store.posts), 1)

    def test_owner_project_private_and_manual_gates(self):
        for k, value in [('GITHUB_EVENT_NAME', 'push'), ('GITHUB_REPOSITORY', 'attacker/repo'),
                         ('SUPABASE_URL', 'https://example.com'), ('SUPABASE_USER_ID', 'wrong')]:
            store = Store()
            with self.subTest(k=k), self.assertRaises(m.ExportError): m.export(store, {**ENV, k: value})
            self.assertEqual(store.reads, []); self.assertEqual(store.posts, [])
        store = Store(); store.private = False
        with self.assertRaises(m.ExportError): m.export(store, ENV)
        self.assertEqual(store.reads, [])

    def test_full_bounded_pipeline_all_before_write(self):
        store = Store(); targets = {}
        for c in m.load_allowlist():
            c, t, raw = fixture(c)
            t['files'] = {}
            for kind, data in raw.items():
                path = f"results/{m.PLAN}/{c}/{t['identity']}/{kind}.json"
                t['files'][kind] = (path, len(data)); store.objects[path] = data
            targets[c] = t
        sources = deepcopy(store.objects)
        out = io.StringIO()
        with patch.object(m, 'resolve_targets', return_value=targets), redirect_stdout(out): m.export(store, ENV)
        self.assertEqual(len(store.posts), 14)
        self.assertEqual(store.reads[:28], [(p, n) for t in targets.values() for p,n in t['files'].values()])
        self.assertEqual({p: store.objects[p] for p in sources}, sources)
        self.assertNotIn('DO_NOT_EXPORT', out.getvalue())
        self.assertNotIn('cagr', out.getvalue())
        # Oversized final source stops before any write, never downloads a ZIP.
        store = Store(); store.objects = deepcopy(sources)
        last = list(store.objects)[-1]; store.objects[last] += b' '
        with patch.object(m, 'resolve_targets', return_value=targets), self.assertRaises(m.ExportError): m.export(store, ENV)
        self.assertEqual(store.posts, [])

    def test_metadata_lookup_is_bounded_and_hash_exact(self):
        candidate, target, _ = fixture()
        approved = {candidate: {'identity_sha256': m.sha(target['identity'].encode()),
                                'summary_bytes': 100, 'completion_bytes': 200}}
        store = Store()
        calls = []
        def request(method, route, consume, *, data, headers):
            calls.append((method, route, json.loads(data)))
            return m.canonical([{'name': 'e'*64}, {'name': target['identity']}])
        store._request = request
        targets = m.resolve_targets(store, approved)
        self.assertEqual(targets[candidate]['identity'], target['identity'])
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1], 'object/list/cloudtrend-data')
        self.assertEqual(calls[0][2]['prefix'], TEST_PREFIX + f'results/{m.PLAN}/{candidate}/')
        self.assertEqual(calls[0][2]['limit'], 100)
        self.assertEqual(store.reads, [])
        for entries in ([{'name': '../' + target['identity']}], [{'name': target['identity']}] * 2,
                        [{'name': target['identity']}] * 100, [{'name': 'x'*64}]):
            store._request = lambda *a, **kw: m.canonical(entries)
            with self.assertRaises(m.ExportError): m.resolve_targets(store, approved)

    def test_public_errors_sanitized(self):
        out = io.StringIO()
        with patch.object(m, 'export', side_effect=RuntimeError('PRIVATE_SECRET')), redirect_stdout(out):
            with self.assertRaises(SystemExit): m.main()
        self.assertNotIn('PRIVATE_SECRET', out.getvalue())

    def test_workflow_no_automatic_export_or_artifacts(self):
        text = Path('.github/workflows/cmresearchengine-shortlist14-summary-export.yml').read_text()
        self.assertIn('workflow_dispatch:', text)
        for forbidden in ('push:', 'pull_request:', 'upload-artifact', 'schedule:', 'contents: write', 'cmresearchengine.cli', 'pip install'):
            self.assertNotIn(forbidden, text)
        self.assertEqual(text.count('secrets.'), 3)


if __name__ == '__main__':
    unittest.main()
