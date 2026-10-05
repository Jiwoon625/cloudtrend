"""Versioned data-only checkpoints. No pickle, eval, dynamic imports or code payloads."""
from collections import defaultdict
from dataclasses import asdict
from datetime import datetime, date
from decimal import Decimal, getcontext, setcontext, Context, localcontext
import decimal
import gzip, hashlib, json, math, platform, random
import numpy as np
import pandas as pd
import scipy
from cm06.accounting import Ledger, Position, Receivable, Reservation, ZERO
from cm06_comparison_signals import FrozenIntentAdapter

SCHEMA = 'CM06_EXACT_EVENT_STATE_V1'
CLASSES = {c.__name__: c for c in (Ledger, Position, Receivable, Reservation, FrozenIntentAdapter)}
# Reconstructed from verified inputs before loading state. Large immutable panels
# and references are never copied into checkpoints. No credentials live here.
STATIC_FIELDS = {'candidate','contract','panels','calendars','session_lookup','session_indexes',
                 'reference_nav','reference_demands','reference_capital','tax_hook','distributions'}
EPHEMERAL_FIELDS = {'profile_started','reported_month','_resume_last_checkpoint_time','_resume_last_checkpoint_sessions'}
REQUIRED_FIELDS = {'ledger','queue','sequence','adapters','latest_rows','entry_meta','fill_counter',
    'holding_spans','target','initial_native','snapshots','target_reviews','demand_events',
    'order_diagnostics','previous_etf_exposure','started','tax_results','start_at','end_at','currency','kr_engines'}


def encode(x):
    if x is None or type(x) in (str,bool,int): return x
    if isinstance(x,np.generic): return encode(x.item())
    if isinstance(x,float):
        return x if math.isfinite(x) else {'t':'float','v':repr(x)}
    if isinstance(x,Decimal): return {'t':'decimal','v':str(x)}
    if isinstance(x,datetime): return {'t':'datetime','v':x.isoformat()}
    if isinstance(x,date): return {'t':'date','v':x.isoformat()}
    if isinstance(x,np.ndarray):
        if x.dtype.kind not in 'biuf': raise TypeError('Only numeric array state is supported')
        return {'t':'array','dtype':x.dtype.str,'v':encode(x.tolist())}
    if type(x) in (list,tuple,set,frozenset):
        values=list(x)
        if type(x) in (set,frozenset): values=sorted(values,key=lambda v:json.dumps(encode(v),sort_keys=True))
        return {'t':type(x).__name__,'v':[encode(v) for v in values]}
    if isinstance(x,dict):
        tag='defaultdict' if isinstance(x,defaultdict) else 'dict'
        if isinstance(x,defaultdict) and x.default_factory() != ZERO: raise TypeError('Unsupported default factory')
        return {'t':tag,'v':[[encode(k),encode(v)] for k,v in x.items()]}
    if type(x) in CLASSES.values(): return {'t':'object','class':type(x).__name__,'v':encode(x.__dict__)}
    raise TypeError('Unsupported checkpoint state type: '+str(type(x)))


def decode(x):
    if not isinstance(x,dict): return x
    t=x.get('t'); v=x.get('v')
    if t=='float':
        if v not in ('nan','inf','-inf'): raise ValueError('Invalid tagged float')
        return float(v)
    if t=='decimal': return Decimal(v)
    if t=='datetime': return datetime.fromisoformat(v)
    if t=='date': return date.fromisoformat(v)
    if t=='array':
        dt=np.dtype(x['dtype'])
        if dt.kind not in 'biuf': raise ValueError('Non-numeric array rejected')
        return np.array(decode(v),dtype=dt)
    if t in ('list','tuple','set','frozenset'):
        return {'list':list,'tuple':tuple,'set':set,'frozenset':frozenset}[t](decode(a) for a in v)
    if t in ('dict','defaultdict'):
        out=defaultdict(lambda:ZERO) if t=='defaultdict' else {}
        for k,value in v:
            key=decode(k)
            if key in out: raise ValueError('Duplicate checkpoint key')
            out[key]=decode(value)
        return out
    if t=='object':
        if x.get('class') not in CLASSES: raise ValueError('Unknown checkpoint object')
        obj=CLASSES[x['class']].__new__(CLASSES[x['class']]); fields=decode(v)
        if not isinstance(fields,dict) or any(not isinstance(k,str) or k.startswith('__') for k in fields):
            raise ValueError('Invalid object fields')
        obj.__dict__.update(fields); return obj
    raise ValueError('Unknown checkpoint type')


def canonical(x): return json.dumps(x,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()
def digest(x): return hashlib.sha256(canonical(x)).hexdigest()
def versions(): return {'python':platform.python_version(),'numpy':np.__version__,'pandas':pd.__version__,'scipy':scipy.__version__}


def frame_fingerprint(frame):
    if frame is None:return None
    if not isinstance(frame,pd.DataFrame):raise TypeError('Frozen reference must be a DataFrame')
    values=pd.util.hash_pandas_object(frame,index=True).values.tobytes()
    return {'columns':list(frame.columns),'dtypes':[str(t) for t in frame.dtypes],
            'index_dtype':str(frame.index.dtype),'rows':len(frame),'sha256':hashlib.sha256(values).hexdigest()}


def static_binding(runner):
    # These small immutable inputs are re-bound on every save/load. Large panel
    # bytes remain bound by the preflight input manifest hash in identity.
    return {'candidate':runner.candidate.to_dict(),'execution':asdict(runner.contract),
            'calendars_sha256':digest(encode(runner.calendars)),
            'reference_nav':frame_fingerprint(runner.reference_nav),
            'reference_demands':frame_fingerprint(runner.reference_demands),
            'reference_capital':encode(runner.reference_capital)}


def runner_state(runner):
    if getattr(runner,'_resume_poisoned',False) or getattr(runner,'_resume_in_event',False):
        raise ValueError('Unsafe mid-event/failed runner cannot be checkpointed')
    if runner.tax_hook is not None or runner.distributions is not None:
        raise ValueError('Stateful tax/distribution plugins are outside this approved comparison scope')
    state={k:v for k,v in runner.__dict__.items() if k not in STATIC_FIELDS|EPHEMERAL_FIELDS}
    if not REQUIRED_FIELDS.issubset(state): raise ValueError('Incomplete runner state')
    return state


def pack(runner,identity):
    runner.ledger.assert_invariants()
    context=getcontext()
    doc={'schema':SCHEMA,'identity':identity,'versions':versions(),
         'decimal_context':{'prec':context.prec,'rounding':context.rounding,'Emin':context.Emin,'Emax':context.Emax,
                            'capitals':context.capitals,'clamp':context.clamp,
                            'traps':{k.__name__:v for k,v in context.traps.items()},
                            'flags':{k.__name__:v for k,v in context.flags.items()}},
         'static_binding':static_binding(runner),'state':encode(runner_state(runner)),
         'python_random':encode(random.getstate()),'numpy_random':encode(np.random.get_state())}
    return gzip.compress(canonical(doc),compresslevel=6,mtime=0)


def restore(runner,payload,identity):
    # Integrity must also be checked by the storage manifest before this call.
    doc=json.loads(gzip.decompress(payload))
    if doc.get('schema')!=SCHEMA or doc.get('identity')!=identity: raise ValueError('Checkpoint identity/config/input/code mismatch')
    if doc.get('versions')!=versions(): raise ValueError('Checkpoint dependency/runtime version mismatch')
    if canonical(doc.get('static_binding'))!=canonical(static_binding(runner)):raise ValueError('Checkpoint candidate/contract/reference/calendar mismatch')
    settings=dict(doc['decimal_context'])
    traps=settings.pop('traps');flags=settings.pop('flags')
    context=Context(**settings)
    known={k.__name__:k for k in context.traps}
    if set(traps)!=set(known) or set(flags)!=set(known):raise ValueError('Decimal signal schema mismatch')
    for k,signal in known.items():
        if type(traps[k]) is not bool or type(flags[k]) is not bool:raise ValueError('Invalid Decimal signal')
        context.traps[signal]=traps[k];context.flags[signal]=flags[k]
    python_rng=decode(doc['python_random']);numpy_rng=decode(doc['numpy_random'])
    random.Random().setstate(python_rng);np.random.RandomState().set_state(numpy_rng)
    state=decode(doc['state'])
    fresh=runner_state(runner)
    allowed=set(fresh)|{'_resume_events','_resume_last_event','_resume_finished','exposure_records'}
    if not REQUIRED_FIELDS.issubset(state) or set(state)-allowed: raise ValueError('Checkpoint runner field mismatch')
    if state['start_at']!=runner.start_at or state['end_at']!=runner.end_at: raise ValueError('Evaluation interval changed')
    with localcontext(context):state['ledger'].assert_invariants()
    queue=state['queue']
    if state.get('_resume_poisoned') or state.get('_resume_in_event'):raise ValueError('Unsafe checkpoint event boundary')
    if type(state['sequence']) is not int or state['sequence']<max((e[2] for e in queue),default=0):raise ValueError('Checkpoint sequence counter is inconsistent')
    fill_numbers={int(x.split(':')[1]) for x in state['ledger'].seen if x.startswith('fill:') and x.split(':')[1].isdigit()}
    if type(state['fill_counter']) is not int or fill_numbers!=set(range(1,state['fill_counter']+1)):
        raise ValueError('Checkpoint fill counter is inconsistent')
    if len({event[2] for event in queue})!=len(queue): raise ValueError('Duplicate scheduled event')
    if any(event[0]<state['ledger'].at for event in queue): raise ValueError('Checkpoint event time reversal')
    last=state.get('_resume_last_event')
    if last is not None and (last[0]!=state['ledger'].at or any(event[:3]<=last[:3] for event in queue)):
        raise ValueError('Checkpoint same-timestamp event order reversal')
    if any(queue[(i-1)//2]>queue[i] for i in range(1,len(queue))): raise ValueError('Checkpoint event heap corrupted')
    if set(state['adapters'])!=set(runner.adapters):raise ValueError('Adapter set changed')
    for e,adapter in state['adapters'].items():
        if type(adapter) is not FrozenIntentAdapter or adapter.sleeve!=runner.adapters[e].sleeve: raise ValueError('Adapter identity mismatch')
    # Everything above validates into isolated objects. Publish state only after
    # all checks pass; a rejected checkpoint leaves runner and RNG untouched.
    runner.__dict__.update(state)
    setcontext(context)
    random.setstate(python_rng);np.random.set_state(numpy_rng)
    return runner
