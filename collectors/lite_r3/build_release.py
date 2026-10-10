"""Rebuild the immutable Lite runtime ZIP and source manifest deterministically.

After committing the release, update the private notebook's commit and SHA-256
pins together. Never publish the account-configured notebook in this repository.
"""
from pathlib import Path
import hashlib
import json
import zipfile

ROOT = Path(__file__).resolve().parent
RUNTIME = ROOT / 'runtime'


def build():
    manifest_path = RUNTIME / 'manifest.json'
    manifest = json.loads(manifest_path.read_text())
    # Read the literal without importing or executing runtime stages.
    for line in (RUNTIME / '__init__.py').read_text().splitlines():
        if line.startswith('RUNTIME_VERSION = '):
            manifest['version'] = line.split(' = ', 1)[1].strip("'\"")
    files = sorted(RUNTIME.rglob('*.py'))
    manifest['files'] = [
        {'path': str(path.relative_to(RUNTIME)), 'bytes': len(path.read_bytes()),
         'characters': len(path.read_text()),
         'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
        for path in files
    ]
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    with zipfile.ZipFile(ROOT / 'runtime.zip', 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in files:
            info = zipfile.ZipInfo('cloudtrend_lite_r3_runtime/' + str(path.relative_to(RUNTIME)),
                                   date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, path.read_bytes(), compresslevel=9)
    digest = hashlib.sha256((ROOT / 'runtime.zip').read_bytes()).hexdigest()
    print(json.dumps({'runtimeVersion': manifest['version'], 'runtimeSha256': digest}, indent=2))


if __name__ == '__main__':
    build()
