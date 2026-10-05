"""Load only the reviewed source tree. Input archives can never supply code."""
import hashlib
import importlib.metadata
import platform
import json
from pathlib import Path
import sys
ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / 'vendor'

def activate():
    paths = json.loads((ROOT / 'RUNTIME_PATHS.json').read_text())
    for path in reversed(paths):
        target = VENDOR / path
        if target.is_dir() and str(target) not in sys.path:
            sys.path.insert(0, str(target))

def code_hashes():
    return {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for folder in ('vendor', 'cmresearchengine') for p in sorted((ROOT / folder).rglob('*.py'))}

def fingerprint():
    """Patch-level runtime changes must never reuse an old resume identity."""
    names=('numpy','pandas','scipy','pyarrow','python-dateutil','pytz','tzdata','six')
    return {'python':platform.python_version(),
            **{name:importlib.metadata.version(name) for name in names}}

activate()
