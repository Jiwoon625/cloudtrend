"""Host static-input wrapper; does not mutate any frozen codec allowlist."""
from copy import copy
import gzip,json
import cm06_exact_units_resume_state_v1 as exact
from cm06_fresh_host_v1 import HOST_STATIC,canonical,digest
SCHEMA='CM06_FRESH_WARMUP_EXACT_STATE_V1'

def bind_identity(identity,runner):
    out=exact.bind_identity(identity)
    out['fresh_host']=runner.host_binding
    return out

def _proxy(runner):
    proxy=copy(runner)
    proxy.__dict__={k:v for k,v in runner.__dict__.items() if k not in HOST_STATIC}
    return proxy

def pack(runner,identity):
    if identity!=bind_identity(identity,runner):raise ValueError('Fresh host identity mismatch')
    raw=exact.pack(_proxy(runner),identity)
    # Inner codec binds every exact dependency and runtime/RNG/Decimal setting.
    doc={'schema':SCHEMA,'host_binding':runner.host_binding,'identity_sha256':digest(identity),
         'inner':json.loads(gzip.decompress(raw))}
    return gzip.compress(canonical(doc),compresslevel=6,mtime=0)

def restore(runner,payload,identity):
    doc=json.loads(gzip.decompress(payload))
    if identity!=bind_identity(identity,runner) or doc.get('schema')!=SCHEMA or doc.get('host_binding')!=runner.host_binding or doc.get('identity_sha256')!=digest(identity):
        raise ValueError('Fresh checkpoint identity mismatch; legacy seq8 seeds are forbidden')
    proxy=_proxy(runner)
    exact.restore(proxy,gzip.compress(canonical(doc['inner']),mtime=0),identity)
    # The inner codec validates before publishing, but its update-style API
    # retains optional fields already present on an advanced target. Replace
    # the whole dynamic field set in the checkpoint's encoded order instead.
    # In particular event-zero must remove a later _resume_last_event.
    restored_names=[name for name,_ in doc['inner']['state']['v']]
    static=HOST_STATIC|exact.STATIC_FIELDS|exact.EPHEMERAL_FIELDS
    runner.__dict__={k:v for k,v in runner.__dict__.items() if k in static}
    runner.__dict__.update((name,proxy.__dict__[name]) for name in restored_names)
    return runner
