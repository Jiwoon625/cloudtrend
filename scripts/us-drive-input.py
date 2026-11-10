"""Fetch one verified US screening handover from private Drive.

The input CSV and the collector's registered-source record live only in Drive, so
this step performs no Supabase Storage read or write. Every byte is checked against
the identity the collector dispatched; a mismatch stops before the engine runs.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'collectors' / 'drive_history_v7'))
from history import Drive, atomic, require  # noqa: E402

HEX = r'[0-9a-f]{64}'
MAX_INPUT_BYTES = 24 * 1024 * 1024


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def fetch(drive, file_id, expected, limit):
    raw = drive.download(file_id)
    require(len(raw) <= limit, 'Drive input exceeds the screening handover limit')
    require(digest(raw) == expected, 'Drive input SHA256 mismatch')
    return raw


def _hex(value, message):
    import re
    require(isinstance(value, str) and re.fullmatch(HEX, value), message)
    return value.lower()


def prepare(file_id, file_sha, metadata_id, metadata_sha, output):
    _hex(file_sha, 'Input SHA256 must be 64 lowercase hex characters')
    _hex(metadata_sha, 'Metadata SHA256 must be 64 lowercase hex characters')
    drive = Drive()
    raw = fetch(drive, file_id, file_sha, MAX_INPUT_BYTES)
    metadata_raw = fetch(drive, metadata_id, metadata_sha, 1024 * 1024)
    record = json.loads(metadata_raw.decode('utf-8'))
    require(isinstance(record, dict) and record.get('as_of_date'), 'Invalid US source record')
    require(record.get('data_hash') == 'sha256:' + file_sha,
            'US source record does not describe the handed-over CSV')
    require(record.get('storage_path') == 'drive://' + file_id,
            'US source record points at another Drive object')
    out = Path(output)
    atomic(out / 'us_screening_input.csv', raw)
    atomic(out / 'us_screening_source.json', metadata_raw)
    atomic(out / 'drive-input-receipt.json', json.dumps({
        'version': 'us-drive-input-v1',
        'asOfDate': record.get('as_of_date'),
        'inputFileId': file_id,
        'inputSha256': file_sha,
        'inputBytes': len(raw),
        'metadataFileId': metadata_id,
        'metadataSha256': metadata_sha,
        'supabaseSourceUploads': 0,
        'supabaseSourceDownloads': 0,
        'driveReads': drive.reads,
    }, ensure_ascii=False, indent=2).encode('utf-8'))
    return {'asOfDate': record.get('as_of_date'), 'bytes': len(raw), 'files': len(drive.reads)}


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--file-id', required=True)
    p.add_argument('--file-sha256', required=True)
    p.add_argument('--metadata-file-id', required=True)
    p.add_argument('--metadata-sha256', required=True)
    p.add_argument('--output', default='us-drive-input')
    a = p.parse_args()
    try:
        result = prepare(a.file_id, a.file_sha256, a.metadata_file_id, a.metadata_sha256, a.output)
    except Exception as error:  # no provider text, no partial input
        print(f'US Drive input rejected: {type(error).__name__}: {error}', file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
