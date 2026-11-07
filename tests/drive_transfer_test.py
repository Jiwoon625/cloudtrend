import hashlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
import os
import tempfile
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location("transfer", Path(__file__).parents[1] / "scripts/drive-screening-transfer.py")
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)


def zipped(files):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w", compression=zipfile.ZIP_DEFLATED) as z:
        for name, data in files:
            z.writestr(name, data)
    return b.getvalue()


def fixture(change=None):
    csv = b'symbol,securityType,date,close\n005930,STOCK,2026-11-06,100\nKOSPI,INDEX,2026-11-06,2500\nKOSDAQ,INDEX,2026-11-06,800\n'
    m = {"runId": "synthetic_run_123", "mode": "SCREENING", "complete": True, "missingSymbolCount": 0,
         "missingSymbols": [], "missingIndexSymbols": [], "actualLatestPriceDate": "2026-11-06",
         "cutoffDateInclusive": "2026-11-06", "krxPublicationEvidence": {"phase": "PRELIMINARY"},
         "requestedSymbols": ["005930"], "rowCount": 3,
         "csv": [{"file": "input.csv", "bytes": len(csv), "sha256": hashlib.sha256(csv).hexdigest()}]}
    if change:
        change(m)
    return zipped([("kr-outputs/collection_manifest.json", json.dumps(m)), ("kr-outputs/input.csv", csv)])


class TransportTests(unittest.TestCase):
    def test_result_publication_restores_prior_drive_deltas_without_source_upload(self):
        current=fixture()
        previous=fixture(lambda m:m.update(runId='previous_run_123'))
        old_manifest,raw,_=t.inspect_archive(previous,'previous_run_123')
        head={'version':'drive-input-head-v1','drivePublication':{'version':'drive-result-publication-v1',
            'asOfDate':'2026-11-06','sources':[{'archiveFileId':'parentArchive12345',
                'archiveSha256':hashlib.sha256(previous).hexdigest(),
                'record':{'validation_result':{'krPublication':{'requestId':'previous_run_123',
                    'manifestSha256':'sha256:'+hashlib.sha256(raw).hexdigest()}}}}]}}
        class Drive:
            def children(self,_):return [{'id':'currentArchive12345','name':'kr-outputs.zip'}]
            def download(self,file_id):return previous if file_id=='parentArchive12345' else current
        requested=[]
        def read(request,**_):
            requested.append(request.get_method())
            return io.BytesIO(json.dumps(head).encode())
        with tempfile.TemporaryDirectory() as temp,patch.dict(os.environ,{
                'SUPABASE_URL':'https://synthetic.supabase.co','SUPABASE_SERVICE_ROLE_KEY':'not-real',
                'SUPABASE_USER_ID':'00000000-0000-4000-8000-000000000001'}),patch.object(t.urllib.request,'urlopen',side_effect=read):
            output=Path(temp)
            t.prepare(Drive(),'folder1234567','synthetic_run_123',output,'publish')
            spec=json.loads((output/'input.json').read_text())
            self.assertEqual(spec['parents'],['parent-000'])
            self.assertEqual(requested,['GET'])
            parent=json.loads((output/'parent-000/input.json').read_text())
            self.assertEqual(parent['runId'],'previous_run_123')
            self.assertEqual((output/'parent-000/input.csv').read_bytes(),t.inspect_archive(previous,'previous_run_123')[2][0]['bytes'])
            head['drivePublication']['sources'][0]['archiveSha256']='0'*64
            with self.assertRaisesRegex(ValueError,'archive hash mismatch'):
                t.prepare(Drive(),'folder1234567','synthetic_run_123',output,'publish')
    def test_verified_manifest_inputs_only(self):
        m, raw, parts = t.inspect_archive(fixture(), "synthetic_run_123")
        self.assertEqual(m["krxPublicationEvidence"]["phase"], "PRELIMINARY")
        self.assertEqual(len(parts), 1)
        self.assertEqual(json.loads(raw), m)

    def test_incomplete_or_tampered_inputs_fail_before_writes(self):
        changes = [lambda m: m.update(complete=False), lambda m: m.update(rowCount=9),
                   lambda m: m.update(requestedSymbols=["missing"]), lambda m: m["csv"][0].update(sha256="0" * 64),
                   lambda m: m.update(missingSymbolCount=1)]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(ValueError):
                t.inspect_archive(fixture(change), "synthetic_run_123")
        with self.assertRaisesRegex(ValueError, "Run ID"):
            t.inspect_archive(fixture(), "different_run_123")

    def test_unsafe_or_duplicate_archive_paths(self):
        for name in ("../escaped.csv", "/absolute.csv", "kr-outputs/../../escaped.csv", "back\\slash"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                t.archive_files(zipped([(name, b"x")]))
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            t.archive_files(zipped([("same", b"x"), ("same", b"y")]))

    def test_no_pickle_is_deserialized(self):
        self.assertEqual(t.archive_files(zipped([("unknown.pkl", b"not a pickle")])), {"unknown.pkl": b"not a pickle"})


if __name__ == "__main__":
    unittest.main()
