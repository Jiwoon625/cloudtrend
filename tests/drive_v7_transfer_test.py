"""Offline transport/adapter contracts: every external request is a mock."""
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
import urllib.error
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('v7_adapter', ROOT / 'scripts/drive-history-transfer.py')
v7 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v7)
t = v7.transfer
ENV = {'SUPABASE_URL': 'https://example.supabase.co', 'SUPABASE_SERVICE_ROLE_KEY': 'fixture-only',
       'SUPABASE_USER_ID': '00000000-0000-4000-8000-000000000001'}
MANIFEST_ID = 'manifest_fixture_123'
DELTA_ID = 'delta_archive_12345'
FOLDER_ID = 'result_folder_12345'


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def zipped(files):
    b = io.BytesIO()
    with zipfile.ZipFile(b, 'w') as z:
        for name, raw in files:
            z.writestr(name, raw)
    return b.getvalue()


def fixture(run_id='current_run_123', members=None):
    if members is None:
        members = [
            ('KOSPI.csv', b'symbol,securityType,date,close\nKOSPI,INDEX,2026-11-06,2500\n'),
            ('005930.csv', '\ufeffsymbol,name,securityType,date,close\n005930,"삼성,전자",STOCK,2026-11-06,100\n'.encode()),
            ('KOSDAQ.csv', b'symbol,securityType,date,close\nKOSDAQ,INDEX,2026-11-06,800\n')]
    archive = zipped(members)
    manifest = {'version': 'drive-history-collector-v7.0-preview', 'complete': True,
        'history_backend': 'drive', 'baselineSha256': t.V7_BASELINE_SHA,
        'parentManifestSha256': t.V7_BASELINE_SHA, 'runId': run_id,
        'mode': 'SCREENING', 'createdAt': '2026-11-07T00:00:00Z',
        'actualLatestPriceDate': '2026-11-06', 'cutoffDateInclusive': '2026-11-06',
        'krxPublicationEvidence': {'phase': 'PRELIMINARY', 'calendar': {'sessions': ['2026-11-05', '2026-11-06']}}, 'missingSymbols': [],
        'missingIndexSymbols': [], 'missingSymbolCount': 0, 'correctionCount': 0,
        'requestedSymbols': ['005930'],
        'deltaMembers': [{'name': name, 'sha256': sha(raw), 'bytes': len(raw)} for name, raw in members],
        'files': [{'name': 'delta.zip', 'fileId': DELTA_ID, 'sha256': sha(archive), 'bytes': len(archive)}]}
    raw = json.dumps(manifest, ensure_ascii=False, indent=2).encode()
    return raw, archive


class FakeDrive:
    def __init__(self, objects=None):
        self.objects = dict(objects or {})
        self.listed, self.reads, self.uploads = [], [], []

    def download(self, file_id):
        self.reads.append(file_id)
        return self.objects[file_id]

    def call(self, route, *, query):
        assert route == 'files'
        return json.dumps({'files': self.listed}).encode()

    def upload(self, folder, name, data):
        self.uploads.append((folder, name, data))
        identity = 'derived_archive_12345'
        self.objects[identity] = data
        self.listed = [{'id': identity, 'name': name}]
        return {'id': identity}


def make_derived(run_id='previous_run_123'):
    raw, delta = fixture(run_id)
    with tempfile.TemporaryDirectory() as d:
        drive = FakeDrive({MANIFEST_ID: raw, DELTA_ID: delta})
        v7.prepare_run(drive, MANIFEST_ID, sha(raw), d)
        return v7.build_adapter(d, MANIFEST_ID, sha(raw))


def proof_entries(archive_id, archive, raw, parts, layout=None):
    m = json.loads(raw)
    entries = []
    for part in parts:
        prefix = 'delta' if layout else 'kr-outputs'
        entry = {'archiveFileId': archive_id, 'archiveSha256': sha(archive), 'csvFile': part['name'],
            'record': {'id': f"drive-{m['runId']}-{part['sha256'][:16]}",
                'file_hash': 'sha256:' + part['sha256'], 'file_size_bytes': len(part['bytes']),
                'storage_bucket': 'google-drive', 'storage_path': f"drive://{archive_id}/{prefix}/{part['name']}",
                'validation_result': {'krPublication': {'requestId': m['runId'],
                    'manifestSha256': 'sha256:' + sha(raw), 'manifestText': raw.decode()}}}}
        if layout:
            entry['layout'] = layout
        entries.append(entry)
    return entries


def head(entries):
    return {'version': 'drive-input-head-v1', 'drivePublication': {
        'version': 'drive-result-publication-v1', 'asOfDate': '2026-11-06', 'sources': entries}}


class AdapterTests(unittest.TestCase):
    def test_deterministic_adapter_preserves_origin_and_identical_header_groups(self):
        raw, delta = fixture()
        drive = FakeDrive({MANIFEST_ID: raw, DELTA_ID: delta})
        with tempfile.TemporaryDirectory() as d:
            v7.prepare_run(drive, MANIFEST_ID, sha(raw), d)
            first = v7.build_adapter(d, MANIFEST_ID, sha(raw))
            second = v7.build_adapter(d, MANIFEST_ID, sha(raw))
            self.assertEqual(first[0], second[0])
            self.assertEqual((Path(d) / 'run-manifest.json').read_bytes(), raw)
            archive, manifest, derived_raw, parts = first
            self.assertEqual(len(parts), 2)
            self.assertEqual(manifest['rowCount'], 3)
            self.assertEqual(manifest['originalV7ManifestSha256'], sha(raw))
            self.assertEqual(manifest['originalV7ManifestFileId'], MANIFEST_ID)
            self.assertEqual(manifest['originalV7DeltaArchiveSha256'], sha(delta))
            self.assertNotIn('deltaMembers', manifest)
            self.assertNotIn('files', manifest)
            self.assertIn('"삼성,전자"', parts[0]['bytes'].decode())
            self.assertNotIn(b'\xef\xbb\xbf', parts[0]['bytes'])
            self.assertEqual(parts[1]['bytes'].count(b'symbol,securityType,date,close'), 1)
            with zipfile.ZipFile(io.BytesIO(archive)) as z:
                self.assertEqual(z.read('kr-outputs/v7-origin.json'), raw)
                self.assertTrue(all(i.date_time == (1980, 1, 1, 0, 0, 0) for i in z.infolist()))
            self.assertEqual(t.inspect_archive(archive, manifest['runId'])[1], derived_raw)

    def test_resume_reuses_only_hash_verified_derived_archive(self):
        archive, _, _, _ = make_derived()
        drive = FakeDrive()
        first = v7.save_adapter(drive, FOLDER_ID, archive)
        second = v7.save_adapter(drive, FOLDER_ID, archive)
        self.assertEqual(first[:2], second[:2])
        self.assertEqual((first[2], second[2]), (False, True))
        self.assertEqual(len(drive.uploads), 1)
        drive.objects[first[0]] += b'tampered'
        with self.assertRaisesRegex(ValueError, 'readback mismatch'):
            v7.save_adapter(drive, FOLDER_ID, archive)
        self.assertEqual(len(drive.uploads), 1)
        drive.listed *= 2
        with self.assertRaisesRegex(ValueError, 'Ambiguous'):
            v7.save_adapter(drive, FOLDER_ID, archive)

    def test_coalescing_rechecks_original_bytes_and_rejects_column_mismatch(self):
        raw, delta = fixture()
        drive = FakeDrive({MANIFEST_ID: raw, DELTA_ID: delta})
        with tempfile.TemporaryDirectory() as d:
            manifest = v7.prepare_run(drive, MANIFEST_ID, sha(raw), d)
            (Path(d) / 'delta/005930.csv').write_bytes(b'tampered')
            with self.assertRaisesRegex(ValueError, 'changed before adaptation'):
                v7.coalesce_delta(manifest, d)
        bad = [('005930.csv', b'symbol,date,close\n005930,2026-11-06,10,extra\n')]
        raw, delta = fixture(members=bad)
        drive = FakeDrive({MANIFEST_ID: raw, DELTA_ID: delta})
        with tempfile.TemporaryDirectory() as d:
            manifest = v7.prepare_run(drive, MANIFEST_ID, sha(raw), d)
            with self.assertRaisesRegex(ValueError, 'column count'):
                v7.coalesce_delta(manifest, d)

    def test_row_boundary_splits_and_part_count_fail_closed(self):
        members = [(f'{i:06}.csv', f'symbol,date,close\n{i:06},2026-11-06,10\n'.encode()) for i in range(5)]
        raw, delta = fixture(members=members)
        with tempfile.TemporaryDirectory() as d:
            manifest = v7.prepare_run(FakeDrive({MANIFEST_ID: raw, DELTA_ID: delta}), MANIFEST_ID, sha(raw), d)
            with patch.object(v7, 'ADAPTER_PART_BYTES', 65):
                parts, count = v7.coalesce_delta(manifest, d)
                self.assertEqual(count, 5)
                self.assertGreater(len(parts), 1)
                self.assertTrue(all(len(p['bytes']) <= 65 and p['bytes'].endswith(b'\n') for p in parts))
                with patch.object(v7, 'MAX_ADAPTER_PARTS', 1), self.assertRaisesRegex(ValueError, 'Too many'):
                    v7.coalesce_delta(manifest, d)

    def test_duplicate_keys_fail_legacy_validation(self):
        raw, delta = fixture()
        with zipfile.ZipFile(io.BytesIO(delta)) as z:
            members = [(name, z.read(name)) for name in z.namelist()]
        members.append(('duplicate.csv', members[1][1]))
        raw, delta = fixture(members=members)
        with tempfile.TemporaryDirectory() as d:
            v7.prepare_run(FakeDrive({MANIFEST_ID: raw, DELTA_ID: delta}), MANIFEST_ID, sha(raw), d)
            with self.assertRaisesRegex(ValueError, 'Duplicate symbol/session'):
                v7.build_adapter(d, MANIFEST_ID, sha(raw))

    def test_prepare_calculation_and_publish_have_same_parents_and_no_source_writes(self):
        raw, delta = fixture()
        old_archive, _, old_raw, old_parts = make_derived()
        old_id = 'previous_archive_12345'
        published = head(proof_entries(old_id, old_archive, old_raw, old_parts))
        for publish in (False, True):
            with self.subTest(publish=publish), tempfile.TemporaryDirectory() as d:
                drive = FakeDrive({MANIFEST_ID: raw, DELTA_ID: delta, old_id: old_archive})
                with patch.object(v7, 'prepare_baseline') as baseline, patch.object(t, 'read_published_head', return_value=published):
                    receipt = v7.prepare(drive, MANIFEST_ID, sha(raw), d, FOLDER_ID, publish)
                baseline.assert_called_once()
                prepared = json.loads((Path(d) / 'prepared/input.json').read_text())
                self.assertEqual(prepared['mode'], 'publish' if publish else 'drive')
                self.assertNotIn('layout', prepared)
                self.assertEqual(prepared['parents'], ['parent-000'])
                self.assertEqual(prepared['expectedHeadHash'], sha(json.dumps(published, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()))
                self.assertEqual(len(drive.uploads), 1)
                self.assertEqual(drive.uploads[0][0], FOLDER_ID)
                self.assertEqual(receipt['sourceUploadsToSupabase'], 0)
                self.assertEqual((Path(d) / 'run-manifest.json').read_bytes(), raw)

    def test_source_capacity_failure_happens_before_archive_upload(self):
        raw, delta = fixture()
        drive = FakeDrive({MANIFEST_ID: raw, DELTA_ID: delta})
        with tempfile.TemporaryDirectory() as d, patch.object(v7, 'prepare_baseline'), patch.object(t, 'read_published_head', return_value=None), patch.object(t, 'MAX_PARENT_SOURCES', 1):
            with self.assertRaisesRegex(ValueError, 'publication source limit'):
                v7.prepare(drive, MANIFEST_ID, sha(raw), d, FOLDER_ID)
            self.assertEqual(drive.uploads, [])

    def test_baseline_only_publish_rejected_and_calculation_needs_no_metadata(self):
        with tempfile.TemporaryDirectory() as d, patch.object(v7, 'prepare_baseline') as baseline, patch.object(t, 'read_published_head') as read:
            self.assertTrue(v7.prepare(FakeDrive(), None, None, d, FOLDER_ID)['baselineOnly'])
            with self.assertRaisesRegex(ValueError, 'completed run'):
                v7.prepare(FakeDrive(), None, None, d, FOLDER_ID, True)
            self.assertEqual(baseline.call_count, 1)
            read.assert_not_called()
            (Path(d) / 'run-manifest.json').write_text('{}')
            with self.assertRaisesRegex(ValueError, 'Existing completed-run artifacts'):
                v7.prepare(FakeDrive(), None, None, d, FOLDER_ID)


class ParentTests(unittest.TestCase):
    def test_exact_group_and_part_order_is_retained(self):
        old_archive, _, old_raw, old_parts = make_derived('previous_run_123')
        newer_archive, _, newer_raw, newer_parts = make_derived('newer_run_12345')
        ids = ['older_archive_12345', 'newer_archive_12345']
        entries = proof_entries(ids[0], old_archive, old_raw, list(reversed(old_parts))) + proof_entries(ids[1], newer_archive, newer_raw, newer_parts)
        drive = FakeDrive(dict(zip(ids, (old_archive, newer_archive))))
        with tempfile.TemporaryDirectory() as d, patch.object(t, 'read_published_head', return_value=head(entries)):
            result = t.prepare_published_parents(drive, d, '2026-11-06')
            self.assertEqual(result['parents'], ['parent-000', 'parent-001'])
            self.assertEqual(drive.reads, ids)
            first = json.loads((Path(d) / 'parent-000/input.json').read_text())
            self.assertEqual([p['path'] for p in first['parts']], [p['name'] for p in reversed(old_parts)])

    def test_unpublished_raw_v7_layout_is_rejected(self):
        raw, archive = fixture('previous_run_123')
        _, _, parts = t.inspect_v7_archive(archive, raw)
        entries = proof_entries(DELTA_ID, archive, raw, parts, 'v7-delta')
        drive = FakeDrive({DELTA_ID: archive})
        with tempfile.TemporaryDirectory() as d, patch.object(t, 'read_published_head', return_value=head(entries)):
            with self.assertRaisesRegex(ValueError, 'Unsupported historical Drive layout'):
                t.prepare_published_parents(drive, d, '2026-11-06')
            self.assertEqual(drive.reads, [])

    def test_metadata_tamper_inventory_and_duplicate_sources_fail_closed(self):
        archive, _, raw, parts = make_derived()
        archive_id = 'previous_archive_12345'
        original = proof_entries(archive_id, archive, raw, parts)
        cases = []
        changed = copy.deepcopy(original); changed[0]['archiveSha256'] = '0' * 64; cases.append(changed)
        changed = copy.deepcopy(original); changed[0]['record']['validation_result']['krPublication']['manifestText'] += ' '; cases.append(changed)
        changed = copy.deepcopy(original); changed[0]['record']['storage_path'] = 'drive://other/input.csv'; cases.append(changed)
        cases.extend((original[:1], original + original[:1]))
        for entries in cases:
            with self.subTest(entries=entries), tempfile.TemporaryDirectory() as d, patch.object(t, 'read_published_head', return_value=head(entries)):
                with self.assertRaises(ValueError):
                    t.prepare_published_parents(FakeDrive({archive_id: archive}), d, '2026-11-06')

    def test_source_count_archive_bytes_and_future_heads_are_bounded(self):
        archive, _, raw, parts = make_derived()
        archive_id = 'previous_archive_12345'
        published = head(proof_entries(archive_id, archive, raw, parts))
        with tempfile.TemporaryDirectory() as d, patch.object(t, 'read_published_head', return_value=published):
            drive = FakeDrive({archive_id: archive})
            with patch.object(t, 'MAX_PARENT_SOURCES', 1), self.assertRaisesRegex(ValueError, 'source count'):
                t.prepare_published_parents(drive, d, '2026-11-06')
            with patch.object(t, 'MAX_PARENT_BYTES', 1), self.assertRaisesRegex(ValueError, 'byte limit'):
                t.prepare_published_parents(drive, d, '2026-11-06')
            with self.assertRaisesRegex(ValueError, 'older than'):
                t.prepare_published_parents(drive, d, '2026-11-05')

    def test_only_bounded_result_metadata_get_and_missing_head(self):
        requests = []
        def read(request, **kwargs):
            requests.append(request)
            return io.BytesIO(b'{"version":"drive-input-head-v1"}')
        with patch.dict(os.environ, ENV), patch.object(t.urllib.request, 'urlopen', side_effect=read):
            t.read_published_head()
        self.assertEqual([r.get_method() for r in requests], ['GET'])
        self.assertIn('/results/drive-screening/input-head/latest.json?cacheNonce=', requests[0].full_url)
        with patch.dict(os.environ, ENV), patch.object(t.urllib.request, 'urlopen', return_value=io.BytesIO(b'x' * 5)), patch.object(t, 'MAX_HEAD', 4):
            with self.assertRaisesRegex(ValueError, 'exceeds limit'):
                t.read_published_head()
        error = urllib.error.HTTPError('https://example', 404, 'missing', {}, io.BytesIO(b'{}'))
        with patch.dict(os.environ, ENV), patch.object(t.urllib.request, 'urlopen', side_effect=error):
            self.assertIsNone(t.read_published_head())


class DeltaSafetyTests(unittest.TestCase):
    def test_paths_symlinks_duplicates_unexpected_members_and_hashes(self):
        raw, archive = fixture()
        manifest = json.loads(raw)
        for name in ('../escaped.csv', '/absolute.csv', 'back\\slash.csv', 'dir/input.csv'):
            changed = copy.deepcopy(manifest)
            changed['deltaMembers'][0]['name'] = name
            with self.subTest(name=name), self.assertRaises(ValueError):
                t.v7_manifest(json.dumps(changed).encode())
        changed = copy.deepcopy(manifest)
        changed['deltaMembers'].append(changed['deltaMembers'][0])
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            t.v7_manifest(json.dumps(changed).encode())
        bad_archives = []
        with zipfile.ZipFile(io.BytesIO(archive)) as z:
            members = [(name, z.read(name)) for name in z.namelist()]
        bad_archives.append(zipped(members + [('extra.csv', b'x')]))
        bad_archives.append(zipped(members + [members[0]]))
        symlink = zipfile.ZipInfo(members[0][0]); symlink.create_system = 3
        symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
        bad_archives.append(zipped([(symlink, members[0][1])] + members[1:]))
        for bad in bad_archives:
            changed = copy.deepcopy(manifest)
            changed['files'][0].update(bytes=len(bad), sha256=sha(bad))
            with self.assertRaises(ValueError):
                t.inspect_v7_archive(bad, json.dumps(changed).encode())
        with self.assertRaisesRegex(ValueError, 'archive hash/size'):
            t.inspect_v7_archive(archive + b'tamper', raw)


if __name__ == '__main__':
    unittest.main()
