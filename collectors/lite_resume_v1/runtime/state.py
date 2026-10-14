"""Content-addressed, fail-closed run state. No credentials or scheduler.

The caller must hold RunLock while changing a run. flock support is required;
remote Drive/FUSE lock semantics must be verified before production adoption.
"""
import contextlib
import hashlib
import json
import os
import re
import tempfile
from pathlib import Path

VERSION = 'cloudtrend-resume-state-v1'


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def digest(raw):
    return 'sha256:' + hashlib.sha256(raw).hexdigest()


def atomic_write(path, raw):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        if path.read_bytes() != raw:
            raise RuntimeError('Saved artifact readback mismatch')
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class RunLock:
    def __init__(self, root):
        self.path = Path(root) / 'execution.lock'
        self.stream = None

    def __enter__(self):
        import fcntl
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.stream = self.path.open('a+b')
        try:
            fcntl.flock(self.stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            self.stream.close()
            raise RuntimeError('Run already locked or filesystem locking unsupported; no collection started') from exc
        return self

    def __exit__(self, *_):
        import fcntl
        fcntl.flock(self.stream.fileno(), fcntl.LOCK_UN)
        self.stream.close()


class RunState:
    def __init__(self, root, run_id, identity, *, started_at=None):
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', run_id):
            raise ValueError('Invalid run ID')
        self.root = Path(root) / run_id
        self.root.mkdir(parents=True, exist_ok=True)
        self.identity_hash = digest(canonical(identity))
        path = self.root / 'plan.json'
        if path.exists():
            self.plan = json.loads(path.read_text())
            body = {k: v for k, v in self.plan.items() if k != 'planHash'}
            if digest(canonical(body)) != self.plan.get('planHash'):
                raise RuntimeError('Corrupt run plan; original preserved')
            if self.plan.get('version') != VERSION or self.plan.get('identityHash') != self.identity_hash:
                raise RuntimeError('Runtime/schema/configuration changed; create a separate run')
        else:
            if started_at is None:
                raise RuntimeError('Unknown run ID; explicit new-run timestamp required')
            body = dict(version=VERSION, runId=run_id, startedAt=started_at,
                        identity=identity, identityHash=self.identity_hash)
            self.plan = dict(body, planHash=digest(canonical(body)))
            atomic_write(path, canonical(self.plan))

    def put_blob(self, raw):
        key = digest(raw)
        path = self.root / 'blobs' / key[7:]
        if path.exists():
            if path.read_bytes() != raw:
                raise RuntimeError('Immutable blob conflict')
        else:
            atomic_write(path, raw)
        return key

    def blob(self, key):
        if not re.fullmatch(r'sha256:[a-f0-9]{64}', key):
            raise RuntimeError('Invalid artifact hash')
        raw = (self.root / 'blobs' / key[7:]).read_bytes()
        if digest(raw) != key:
            raise RuntimeError('Checkpoint artifact corrupted; cannot reuse')
        return raw

    def freeze(self, name, value):
        """Freeze a plan dependency once; caller must use the returned saved value."""
        path = self.root / 'frozen' / (name + '.json')
        if path.exists():
            envelope = json.loads(path.read_text())
            return json.loads(self.blob(envelope['hash']))
        key = self.put_blob(canonical(value))
        atomic_write(path, canonical({'hash': key}))
        return value

    def frozen(self, name):
        path = self.root / 'frozen' / (name + '.json')
        return json.loads(self.blob(json.loads(path.read_text())['hash'])) if path.exists() else None

    def save(self, stage, dependencies, artifacts, status='COMPLETE'):
        if not re.fullmatch(r'[a-zA-Z0-9_-]+', stage):
            raise ValueError('Invalid stage')
        if status not in ('COMPLETE', 'WAITING_INPUT', 'REQUEST_UNCERTAIN', 'REQUEST_ACCEPTED'):
            raise ValueError('Invalid stage status')
        body = dict(version=VERSION, planHash=self.plan['planHash'], stage=stage,
                    dependencyHash=digest(canonical(dependencies)), artifacts=artifacts, status=status)
        # Earlier revisions stay available as immutable blobs.
        key = self.put_blob(canonical(body))
        atomic_write(self.root / 'stages' / (stage + '.json'), canonical({'hash': key}))
        return key

    def load(self, stage, dependencies):
        path = self.root / 'stages' / (stage + '.json')
        if not path.exists():
            return None
        body = json.loads(self.blob(json.loads(path.read_text())['hash']))
        if body['planHash'] != self.plan['planHash']:
            raise RuntimeError('Checkpoint belongs to another run')
        if body['dependencyHash'] != digest(canonical(dependencies)):
            return None  # Only the affected stage is invalidated; prior blobs remain.
        for key in body['artifacts'].values():
            self.blob(key)
        return body

    def save_json(self, stage, dependencies, values):
        return self.save(stage, dependencies, {'payload': self.put_blob(canonical(values))})

    def load_json(self, stage, dependencies):
        saved = self.load(stage, dependencies)
        if saved is None or saved['status'] != 'COMPLETE':
            return None
        return json.loads(self.blob(saved['artifacts']['payload']))
