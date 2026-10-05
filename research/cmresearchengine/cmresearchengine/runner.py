"""Bounded execution and create-only verified completion for independent ledgers."""
from . import runtime
from .plan import manifest, REFERENCE_CONTRACT
from .replay import POLICY
from cm06_fresh_host_v1 import canonical, digest
from cm06_fresh_codec_v1 import pack, restore
from cm06_fresh_journal_v1 import CandidateJournal
from cm06.metrics import performance_metrics
import hashlib
import io
import json
import random
import time
import zipfile
import numpy as np
import pandas as pd


def serialize_result(runner):
    result=runner.result()
    files={}
    for key,value in result.items():
        if isinstance(value,pd.DataFrame):files[key+'.csv']=value.to_csv(index=False).encode()
    # Ordinary columns remain intact; the separate mandatory audit discloses
    # every retrospective proxy and both trigger/reference dates.
    summary={'schema':'CM_RESEARCH_RESULT_V1','candidate_id':runner.candidate.candidate_id,
        'scope':'RESEARCH_COMPARISON_ONLY','policy':POLICY,'full_tax_supported':False,
        'historical_pit_certified':False,'actual_historical_execution_certified':False,
        'evaluation_start':runner.contract.start_date,'evaluation_end':runner.contract.end_date,
        'processed_events':runner._resume_events,'ordinary_and_proxy_sales_share_one_way_fee':'0.0015',
        'proxy_exit_count':len(runner.proxy_exits),'unresolved_rights_encounter_count':len(runner.proxy_unresolved_observations),
        'initial_native_capital':{k:str(v) for k,v in runner.initial_native.items()},
        'execution_contract':result['contract'],'final_snapshot':result['final_snapshot']}
    nav=result['nav']
    if not nav.empty:
        series=pd.Series(nav['gross_nav_krw'].astype(float).to_numpy(),index=pd.to_datetime(nav['at'],utc=True))
        # Initial-capital baseline includes first-session execution costs.
        if pd.Timestamp(runner.start_at)<series.index[0]:
            series=pd.concat([pd.Series([float(runner.contract.initial_capital_krw)],index=pd.DatetimeIndex([runner.start_at])),series])
        summary['performance']=performance_metrics(series)
    # Decimal-rich summaries are JSON strings explicitly, never lossy float state.
    files['summary.json']=json.dumps(summary,sort_keys=True,default=str).encode()
    files['reviews.json']=json.dumps(result['reviews'],sort_keys=True,default=str).encode()
    files['file_manifest.json']=canonical({'files':{k:{'sha256':hashlib.sha256(v).hexdigest(),'size':len(v)} for k,v in files.items()}})
    output=io.BytesIO()
    with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as archive:
        for name,data in sorted(files.items()):
            info=zipfile.ZipInfo(name,(1980,1,1,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED
            archive.writestr(info,data)
    return output.getvalue()


def run_strategy(prepared, store, *, max_seconds=3000, event_limit=None, stop_requested=None):
    if not 1<=max_seconds<=19800:raise ValueError('Time cap must be 1..19800 seconds')
    if event_limit is not None and event_limit<1:raise ValueError('Event limit must be positive')
    identity=prepared.identity
    # Stable deterministic first/completion keys establish one chain per exact
    # strategy+input+code+policy identity. Subsequent commit IDs are generated.
    first='first_'+digest(identity);completed='complete_'+digest(identity)
    journal=CandidateJournal(store,first,completed,identity)
    verified=journal.completed()
    if verified:
        return {'status':'COMPLETED_VERIFIED','trial_key':prepared.trial_key,'completion':verified,'already_complete':True}
    runner=prepared.factory();journal.load(runner)
    if not journal.head:
        random.seed(identity['deterministic_seed']);np.random.seed(identity['deterministic_seed']%(2**32))
        journal.commit(runner,False)
    if journal.head['finished']:
        completed=journal.complete(serialize_result(runner))
        if journal.completed()!=completed:raise RuntimeError('Completion verification mismatch')
        return {'status':'COMPLETED_VERIFIED','trial_key':prepared.trial_key,'completion':completed}
    start=time.monotonic();initial_events=runner._resume_events
    def stop():
        return (time.monotonic()-start>=max_seconds or
            (event_limit is not None and runner._resume_events-initial_events>=event_limit) or
            (stop_requested is not None and stop_requested()))
    def checkpoint(obj,finished):journal.commit(obj,finished)
    result=runner.run(checkpoint,seconds=180,sessions=63,stop_requested=stop)
    if result is None:
        return {'status':'PAUSED_VERIFIED','trial_key':prepared.trial_key,'processed_events':runner._resume_events,
            'checkpoint_sequence':journal.sequence,'processed_at':runner.ledger.at.isoformat()}
    completed=journal.complete(serialize_result(runner))
    if journal.completed()!=completed:raise RuntimeError('Completion readback mismatch')
    return {'status':'COMPLETED_VERIFIED','trial_key':prepared.trial_key,'completion':completed}


def read_result(completion, store):
    raw=store.get_bytes(completion['outputs_id'])
    if len(raw)!=completion['outputs_size'] or hashlib.sha256(raw).hexdigest()!=completion['outputs_sha256']:
        raise ValueError('Output integrity changed')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        return {name:archive.read(name) for name in archive.namelist()}


def build_references(results):
    """Three independently completed reference paths only; no allocation feedback."""
    if set(results)!=set('KEU'):raise ValueError('All three independent references are required')
    navs=[];demands=[];capital={}
    for engine,files in results.items():
        summary=json.loads(files['summary.json'])
        if summary['candidate_id']!='REF_'+engine:raise ValueError('Reference strategy mismatch')
        if summary['execution_contract']['cash_movement']!='NONE':raise ValueError('Reference received allocation transfers')
        nav=pd.read_csv(io.BytesIO(files['nav.csv']))
        nav.index=pd.to_datetime(nav['at'],utc=True)
        if nav.index.has_duplicates or not nav.index.is_monotonic_increasing:raise ValueError('Reference timestamps invalid')
        navs.append(nav['gross_nav_krw'].astype(float).div(REFERENCE_CONTRACT['initial_capital_krw_each']).rename(engine))
        demand=pd.read_csv(io.BytesIO(files['demands.csv']))
        demands.append(demand.loc[demand.engine.eq(engine)])
        capital[engine]=float(summary['initial_native_capital'][engine])
    # Exact common cutoff rows, never forward/back fill any reference NAV.
    indexes=[x.index for x in navs]
    if any(not x.equals(indexes[0]) for x in indexes[1:]):raise ValueError('Reference cutoff grids differ')
    nav=pd.concat(navs,axis=1)
    if not np.isfinite(nav.to_numpy()).all() or (nav<=0).any().any():raise ValueError('Invalid reference NAV')
    nonempty=[d for d in demands if not d.empty]
    combined=pd.concat(nonempty,ignore_index=True) if nonempty else demands[0].iloc[:0].copy()
    return {'nav':nav,'demands':combined,'capital':capital}
