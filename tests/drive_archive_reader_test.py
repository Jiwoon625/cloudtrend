import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('archive_reader', Path(__file__).resolve().parents[1] / 'scripts/read-drive-archive.py')
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)
sha = lambda b: hashlib.sha256(b).hexdigest()


class DriveArchiveReaderTest(unittest.TestCase):
    def test_split_zip_hashes_and_member_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            key = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/results/screening/old.json'
            body = b'{"preserved":true}'
            archive = root / 'original.zip'
            with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
                z.writestr(key, body)
            data = archive.read_bytes()
            parts = [data[:len(data)//2], data[len(data)//2:]]
            chunks = []
            for i, part in enumerate(parts, 1):
                name = f'archive.zip.part{i:03}'
                (root / name).write_bytes(part)
                chunks.append({'chunk': i, 'size': len(part), 'sha256': sha(part), 'driveRelativePath': name})
            doc = {'sourceBucket': 'cloudtrend-data', 'objects': [
                {'name': key, 'size': len(body), 'sha256': sha(body), 'package': 'archive.zip'}],
                'packages': [{'name': 'archive.zip', 'size': len(data), 'sha256': sha(data), 'chunks': chunks}]}
            index = root / 'index.json'
            index.write_text(json.dumps(doc))
            pin = sha(index.read_bytes())
            with patch.dict(os.environ, {'CLOUDTREND_DRIVE_ROOT': str(root), 'CLOUDTREND_ARCHIVE_CACHE': str(root / 'cache')}):
                self.assertEqual(reader.read(index, pin, key, 100), body)
                self.assertEqual(reader.read(index, pin, key, 100), body)
                with self.assertRaises(ValueError): reader.read(index, pin, key, 1)
                with self.assertRaises(ValueError): reader.read(index, '0'*64, key, 100)
                cached = root / 'cache' / (sha(data) + '.zip')
                cached.unlink()
                (root / chunks[-1]['driveRelativePath']).unlink()
                with self.assertRaises(FileNotFoundError): reader.read(index, pin, key, 100)
                (root / chunks[-1]['driveRelativePath']).write_bytes(b'x'*len(parts[-1]))
                with self.assertRaises(ValueError): reader.read(index, pin, key, 100)


if __name__ == '__main__':
    unittest.main()
