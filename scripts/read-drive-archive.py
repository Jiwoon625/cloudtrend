"""Bounded historical object reader for a mounted Drive; no network or Supabase writes."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys
import tempfile
import zipfile

BLOCK = 1024 * 1024


def require(ok, message):
    if not ok:
        raise ValueError(message)


def verified(path, size, digest):
    require(path.stat().st_size == size, 'Archive size mismatch')
    with path.open('rb') as f:
        require(hashlib.file_digest(f, 'sha256').hexdigest() == digest, 'Archive SHA256 mismatch')
    return path


def within(root, relative):
    p = PurePosixPath(relative)
    require(not p.is_absolute() and all(x not in ('', '.', '..') for x in relative.split('/'))
            and '\\' not in relative, 'Unsafe archive path')
    target = (root / relative).resolve()
    require(target.is_relative_to(root), 'Archive path escapes root')
    return target


def read(index, pin, key, max_bytes):
    require(index.stat().st_size <= 32 * BLOCK, 'Index exceeds limit')
    raw = index.read_bytes()
    require(re.fullmatch('[a-f0-9]{64}', pin) and hashlib.sha256(raw).hexdigest() == pin, 'Index hash mismatch')
    doc = json.loads(raw)
    require(doc.get('sourceBucket') == 'cloudtrend-data', 'Wrong archive bucket')
    records = [o for o in doc['objects'] if o['name'] == key]
    require(len(records) == 1, 'Missing/duplicate archive key')
    record = records[0]
    require(type(record['size']) is int and 0 <= record['size'] <= max_bytes, 'Object exceeds limit')
    packages = [p for p in doc['packages'] if p['name'] == record['package']]
    require(len(packages) == 1, 'Missing/duplicate package')
    package = packages[0]
    require(re.fullmatch('[a-f0-9]{64}', package['sha256']), 'Invalid package hash')
    root = Path(os.environ.get('CLOUDTREND_DRIVE_ROOT', index.parent.parent)).resolve()
    cache = Path(os.environ.get('CLOUDTREND_ARCHIVE_CACHE', Path(tempfile.gettempdir()) / 'cloudtrend-drive-archive')).resolve()
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / (package['sha256'] + '.zip')
    if package.get('chunks'):
        if target.exists():
            verified(target, package['size'], package['sha256'])
        else:
            chunks = sorted(package['chunks'], key=lambda c: c['chunk'])
            require([c['chunk'] for c in chunks] == list(range(1, len(chunks) + 1)), 'Missing/duplicate ZIP part')
            require(sum(c['size'] for c in chunks) == package['size'], 'ZIP part sizes mismatch')
            fd, temporary = tempfile.mkstemp(dir=cache, suffix='.partial')
            try:
                with os.fdopen(fd, 'wb') as out:
                    for c in chunks:
                        source = verified(within(root, c['driveRelativePath']), c['size'], c['sha256'])
                        with source.open('rb') as f:
                            while block := f.read(BLOCK):
                                out.write(block)
                verified(Path(temporary), package['size'], package['sha256'])
                os.replace(temporary, target)
            finally:
                Path(temporary).unlink(missing_ok=True)
    else:
        target = verified(within(root, package['driveRelativePath']), package['size'], package['sha256'])
    with zipfile.ZipFile(target) as z:
        matches = [i for i in z.infolist() if i.filename == key]
        require(len(matches) == 1 and matches[0].file_size == record['size'], 'Invalid ZIP member')
        with z.open(matches[0]) as f:
            data = f.read(max_bytes + 1)
    require(len(data) == record['size'] and hashlib.sha256(data).hexdigest() == record['sha256'], 'Object hash mismatch')
    return data


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--index', type=Path, required=True)
    parser.add_argument('--index-sha256', required=True)
    parser.add_argument('--key', required=True)
    parser.add_argument('--max-bytes', type=int, default=80 * BLOCK)
    args = parser.parse_args()
    try:
        sys.stdout.buffer.write(read(args.index.resolve(), args.index_sha256, args.key, args.max_bytes))
    except Exception:
        print('Verified Drive archive read failed', file=sys.stderr)
        sys.exit(1)
