"""Append-only verified storage of policy and validation evidence."""
import hashlib
import json
import os
from pathlib import Path
from urllib.request import Request, urlopen

root = Path('etf-validation')
prefix = f"{os.environ['SUPABASE_USER_ID']}/results/etf-v01-implementation/20260911/{os.environ['GITHUB_RUN_ID']}"
base = os.environ['SUPABASE_URL'].rstrip('/') + '/storage/v1/object/cloudtrend-data/'
key = os.environ['SUPABASE_SERVICE_ROLE_KEY']
headers = {'Authorization': f'Bearer {key}', 'apikey': key, 'Content-Type': 'application/json', 'x-upsert': 'false'}
manifest = []
for name in ['confirmed-policy.json', 'unit-tests.json', 'environment-parity.json']:
    body = (root / name).read_bytes()
    path = prefix + '/' + name
    with urlopen(Request(base + path, data=body, headers=headers, method='POST'), timeout=60) as r:
        assert r.status in (200, 201)
    with urlopen(Request(base + path, headers={'Authorization': f'Bearer {key}', 'apikey': key}), timeout=60) as r:
        stored = r.read()
    assert stored == body, f'verification failed: {name}'
    manifest.append(dict(name=name, bytes=len(body), sha256=hashlib.sha256(body).hexdigest()))
body = json.dumps(dict(run=os.environ['GITHUB_RUN_ID'], code=os.environ['GITHUB_SHA'], files=manifest), indent=2).encode()
with urlopen(Request(base + prefix + '/manifest.json', data=body, headers=headers, method='POST'), timeout=60) as r:
    assert r.status in (200, 201)
with urlopen(Request(base + prefix + '/manifest.json', headers={'Authorization': f'Bearer {key}', 'apikey': key}), timeout=60) as r:
    assert r.read() == body
print(json.dumps(dict(prefix=prefix, verifiedFiles=len(manifest)+1)))
