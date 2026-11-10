"""Offline contract for the verified US Drive handover fetch; every request is a mock."""
import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('us_drive_input', ROOT / 'scripts/us-drive-input.py')
handover = importlib.util.module_from_spec(spec)
spec.loader.exec_module(handover)

CSV = (b'date,symbol,name,open,high,low,close,volume,ret120,ret252,beta60_spy,'
       b'ichimoku_tk_gap,relvol1_20,adv20_usd,amihud20,active20,toss_tradable,is_common_share\n'
       b'2026-11-10,SPY,SPY,100,102,99,101,10000,0.1,0.2,1,0.1,1,10000000,0.0001,true,true,false\n')
FILE_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456'
META_ID = '1ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543'


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def record(file_id=FILE_ID, raw=CSV):
    return json.dumps({
        'user_id': 'owner',
        'as_of_date': '2026-11-10',
        'storage_bucket': 'google-drive',
        'storage_path': 'drive://' + file_id,
        'row_count': 1,
        'symbol_count': 1,
        'data_hash': 'sha256:' + sha(raw),
        'schema_version': 'us-prospective-v1',
        'source_provider': 'TOSS_OPEN_API',
        'collected_at': '2026-11-10T21:00:00+00:00',
        'metadata': {'confirmedRegularClose': True, 'failedSymbols': 0,
                     'previousSessionDate': '2026-11-07'},
    }, ensure_ascii=False).encode()


class FakeDrive:
    def __init__(self, objects):
        self.objects = objects
        self.reads = []

    def download(self, file_id):
        raw = self.objects[file_id]
        self.reads.append({'backend': 'drive', 'fileId': file_id, 'bytes': len(raw)})
        return raw


class HandoverTest(unittest.TestCase):
    def run_prepare(self, objects, file_sha=None, meta_sha=None, file_id=FILE_ID, meta_id=META_ID):
        drive = FakeDrive(objects)
        out = tempfile.mkdtemp()
        with patch.object(handover, 'Drive', return_value=drive):
            result = handover.prepare(file_id, file_sha or sha(objects[file_id]),
                                      meta_id, meta_sha or sha(objects[meta_id]), out)
        return result, Path(out)

    def objects(self, metadata=None, csv=CSV):
        return {FILE_ID: csv, META_ID: metadata if metadata is not None else record(raw=csv)}

    def test_verifies_both_objects_and_writes_receipt(self):
        result, out = self.run_prepare(self.objects())
        self.assertEqual(result['asOfDate'], '2026-11-10')
        self.assertEqual((out / 'us_screening_input.csv').read_bytes(), CSV)
        receipt = json.loads((out / 'drive-input-receipt.json').read_text())
        self.assertEqual(receipt['inputSha256'], sha(CSV))
        self.assertEqual(receipt['supabaseSourceUploads'], 0)
        self.assertEqual(receipt['supabaseSourceDownloads'], 0)
        self.assertEqual(len(receipt['driveReads']), 2)

    def test_rejects_changed_csv(self):
        objects = self.objects()
        with self.assertRaisesRegex(ValueError, 'SHA256 mismatch'):
            self.run_prepare(objects, file_sha='0' * 64)

    def test_rejects_changed_metadata(self):
        objects = self.objects()
        with self.assertRaisesRegex(ValueError, 'SHA256 mismatch'):
            self.run_prepare(objects, meta_sha='0' * 64)

    def test_rejects_record_for_another_object(self):
        objects = self.objects(metadata=record(file_id='1DifferentDriveObjectId123'))
        with self.assertRaisesRegex(ValueError, 'another Drive object|does not describe'):
            self.run_prepare(objects)

    def test_rejects_record_for_another_csv(self):
        objects = self.objects(metadata=record(raw=b'date,symbol\n2026-11-10,SPY\n'))
        with self.assertRaisesRegex(ValueError, 'does not describe'):
            self.run_prepare(objects)

    def test_requires_hex_identities(self):
        with self.assertRaisesRegex(ValueError, 'SHA256'):
            handover.prepare(FILE_ID, 'sha256:abc', META_ID, '0' * 64, tempfile.mkdtemp())
        with self.assertRaisesRegex(ValueError, 'SHA256'):
            handover.prepare(FILE_ID, '0' * 64, META_ID, '0' * 63, tempfile.mkdtemp())

    def test_stops_at_the_size_limit(self):
        big = CSV + b'x' * (handover.MAX_INPUT_BYTES + 1)
        objects = {FILE_ID: big, META_ID: record(raw=big)}
        with self.assertRaisesRegex(ValueError, 'limit'):
            self.run_prepare(objects)


if __name__ == '__main__':
    unittest.main()
