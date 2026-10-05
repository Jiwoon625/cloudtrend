"""Load only the reviewed source tree. Input archives can never supply code."""
import hashlib
import importlib.metadata
import platform
import json
from pathlib import Path
import sys
ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / 'vendor'

_activation_sources = None

def activate():
    global _activation_sources
    # Only this controlled initialization establishes which source bytes can
    # back the in-memory CM modules. A same-path preloaded module can still be
    # stale after a notebook checkout/edit, so path checks alone are insufficient.
    reviewed=VENDOR.resolve()
    for name,module in tuple(sys.modules.items()):
        if name=='cm06' or name.startswith(('cm06.','cm06_')):
            origin=getattr(module,'__file__',None)
            if not origin or not Path(origin).resolve().is_relative_to(reviewed):
                raise RuntimeError('CM module outside reviewed source tree: '+name+'; use a fresh process')
            if _activation_sources is None:
                raise RuntimeError('Preloaded CM module cannot be source-verified: '+name+'; use a fresh process')
    current=code_hashes()
    if _activation_sources is not None and current!=_activation_sources:
        raise RuntimeError('CM source changed after controlled initialization; use a fresh process')
    paths=json.loads((ROOT/'RUNTIME_PATHS.json').read_text())
    roots=[]
    for relative in paths:
        target=(VENDOR/relative).resolve()
        if not target.is_relative_to(reviewed):
            raise RuntimeError('CM import root escapes reviewed source tree')
        if target.is_dir() and str(target) not in roots:roots.append(str(target))
    # Already-present roots must MOVE ahead of cwd; skipping them leaves a
    # shadowing cwd module eligible before the reviewed implementation.
    sys.path[:]=roots+[path for path in sys.path if path not in roots]
    if _activation_sources is None:_activation_sources=current

def code_hashes():
    return {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for folder in ('vendor', 'cmresearchengine') for p in sorted((ROOT / folder).rglob('*.py'))}

def fingerprint():
    """Patch-level runtime changes must never reuse an old resume identity."""
    names=('numpy','pandas','scipy','pyarrow','python-dateutil','pytz','tzdata','six')
    return {'python':platform.python_version(),
            **{name:importlib.metadata.version(name) for name in names}}

activate()
