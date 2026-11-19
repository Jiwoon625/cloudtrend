"""Non-expiring, token-conditional single-writer guard for shared Drive journals.

Requires the reviewed collector_run_locks table. No TTL takeover: a paused VM
must never regain write access after another VM assumes its expired lease.
An abandoned lock requires confirmed termination and explicit token-bound release.
"""
import hashlib
import json
import os
import tempfile
import uuid
from pathlib import Path


class DatabaseLock:
    def __init__(self, url, key, user_id, token, http, lock_name='lite-resume-v1'):
        if not url.startswith('https://') or not key:
            raise RuntimeError('Secure collector lock configuration required')
        self.url = url.rstrip('/') + '/rest/v1/collector_run_locks'
        self.headers = {'apikey': key, 'Authorization': 'Bearer ' + key,
                        'Prefer': 'return=representation'}
        self.user_id, self.token = str(uuid.UUID(user_id)), str(uuid.UUID(token))
        self.http, self.name = http, lock_name

    def _read(self):
        response = self.http.get(self.url, headers=self.headers,
            params={'user_id': 'eq.' + self.user_id, 'lock_name': 'eq.' + self.name,
                    'select': 'owner_token'}, timeout=30)
        response.raise_for_status()
        rows = response.json()
        if not isinstance(rows, list) or len(rows) > 1:
            raise RuntimeError('Invalid collector lock response')
        return rows[0]['owner_token'] if rows else None

    def acquire(self):
        try:
            response = self.http.post(self.url, headers=self.headers,
                json={'user_id': self.user_id, 'lock_name': self.name,
                      'owner_token': self.token}, timeout=30)
            if response.status_code != 409:
                response.raise_for_status()
        except Exception:
            # Lost acknowledgement is not absence. Only exact token readback
            # permits work; no blind retry, no replacement, no forced takeover.
            if self._read() != self.token:
                raise RuntimeError('Collector lock outcome uncertain; no collection started') from None
            return
        if self._read() != self.token:
            raise RuntimeError('Another VM owns this collector; no collection started')

    def release(self):
        response = self.http.delete(self.url, headers=self.headers,
            params={'user_id': 'eq.' + self.user_id, 'lock_name': 'eq.' + self.name,
                    'owner_token': 'eq.' + self.token}, timeout=30)
        response.raise_for_status()
        if self._read() == self.token:
            raise RuntimeError('Collector lock release not confirmed')


class SharedDriveLock:
    def __init__(self, root, settings):
        self.root, self.settings = Path(root), settings

    def __enter__(self):
        import fcntl
        import requests
        identity = hashlib.sha256(str(self.root.resolve()).encode()).hexdigest()
        local = Path(tempfile.gettempdir()) / 'cloudtrend-resume-local-locks' / identity
        local.mkdir(parents=True, exist_ok=True)
        self.stream = (local / 'execution.lock').open('a+b')
        try:
            fcntl.flock(self.stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            path = local / 'owner.json'
            self.owner_path = path
            if path.exists():
                token = json.loads(path.read_text())['ownerToken']
            else:
                token = str(uuid.uuid4())
                # Local lock excludes another local writer; this is never stored
                # in Drive, where another VM could copy the ownership token.
                path.write_text(json.dumps({'ownerToken': token}))
                path.chmod(0o600)
            def credential(name, required=True):
                value = self.settings.get(name) or os.environ.get(name)
                if not value:
                    from google.colab import userdata
                    try:
                        value = userdata.get(name)
                    except userdata.SecretNotFoundError:
                        value = None
                if not value and required:
                    raise RuntimeError('Collector lock credential unavailable: ' + name)
                return value
            url, key = credential('SUPABASE_URL'), credential('SUPABASE_SERVICE_ROLE_KEY')
            owner = credential('SUPABASE_USER_ID', required=False)
            if not owner:
                # Same owner discovery as the existing common_init stage.
                response = requests.get(url.rstrip('/') + '/rest/v1/analysis_source_files',
                    headers={'apikey': key, 'Authorization': 'Bearer ' + key},
                    params={'select': 'user_id', 'limit': '1000'}, timeout=30)
                response.raise_for_status()
                rows = response.json()
                if not isinstance(rows, list) or len(rows) >= 1000:
                    raise RuntimeError('Set SUPABASE_USER_ID; owner discovery is incomplete')
                owners = {row['user_id'] for row in rows}
                if len(owners) != 1:
                    raise RuntimeError('Set SUPABASE_USER_ID; collector owner is ambiguous')
                owner = owners.pop()
                self.settings['SUPABASE_USER_ID'] = owner
            self.remote = DatabaseLock(url, key, owner, token, requests)
            self.remote.acquire()
        except BaseException:
            self.stream.close()
            raise
        return self

    def __exit__(self, *_):
        try:
            # Never reuse a token after a release request: a late DELETE from
            # this attempt must not unlock a later attempt on the same VM.
            self.owner_path.unlink(missing_ok=True)
            self.remote.release()
        finally:
            self.stream.close()
