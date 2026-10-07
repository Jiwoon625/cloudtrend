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
from copy import deepcopy
from decimal import getcontext, setcontext
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


CHECKPOINT_SECONDS=600
CHECKPOINT_SNAPSHOTS=252

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
        if canonical(journal.completed())!=canonical(completed):raise RuntimeError('Completion verification mismatch')
        return {'status':'COMPLETED_VERIFIED','trial_key':prepared.trial_key,'completion':completed}
    start=time.monotonic();initial_events=runner._resume_events
    def stop():
        return (time.monotonic()-start>=max_seconds or
            (event_limit is not None and runner._resume_events-initial_events>=event_limit) or
            (stop_requested is not None and stop_requested()))
    def checkpoint(obj,finished):journal.commit(obj,finished)
    result=runner.run(checkpoint,seconds=CHECKPOINT_SECONDS,sessions=CHECKPOINT_SNAPSHOTS,stop_requested=stop)
    if result is None:
        return {'status':'PAUSED_VERIFIED','trial_key':prepared.trial_key,'processed_events':runner._resume_events,
            'checkpoint_sequence':journal.sequence,'processed_at':runner.ledger.at.isoformat()}
    completed=journal.complete(serialize_result(runner))
    if canonical(journal.completed())!=canonical(completed):raise RuntimeError('Completion readback mismatch')
    return {'status':'COMPLETED_VERIFIED','trial_key':prepared.trial_key,'completion':completed}



def _capture_runtime_context():
    state=np.random.get_state()
    numpy_state=(state[0],state[1].copy(),state[2],state[3],state[4])
    return (random.getstate(),numpy_state,getcontext().copy())

def _restore_runtime_context(state):
    python_state,numpy_state,decimal_context=state
    random.setstate(python_state);np.random.set_state(numpy_state)
    setcontext(decimal_context.copy())

def _group_pause_receipt(candidate_id, prepared, journal):
    head=journal.head
    if head is None:
        return {'status':'NOT_STARTED_DEADLINE','candidate_id':candidate_id,
            'trial_key':prepared.trial_key,'processed_events':0,'checkpoint_sequence':0}
    return {'status':'PAUSED_VERIFIED','candidate_id':candidate_id,
        'trial_key':prepared.trial_key,'processed_events':head['processed_events'],
        'checkpoint_sequence':journal.sequence,'processed_at':head['at']}

def run_strategy_group(items, *, max_seconds=3000, event_limit=None, stop_requested=None):
    """Run 2..4 static candidates in one lockstep process with independent state.

    The only shared objects are immutable market panels and one-session US market
    analysis. Each candidate retains its own runner, ledger, adapters, journal,
    checkpoint namespace and RNG/Decimal context.
    """
    if not 1<=max_seconds<=19800:raise ValueError('Time cap must be 1..19800 seconds')
    if event_limit is not None and event_limit<1:raise ValueError('Event limit must be positive')
    items=list(items)
    if not 2<=len(items)<=4:raise ValueError('Shared group must contain 2..4 candidates')
    if len({candidate_id for candidate_id,_,_ in items})!=len(items):
        raise ValueError('Shared group candidate IDs must be unique')
    optimization=items[0][1].identity.get('execution_optimization')
    if (not isinstance(optimization,dict) or
        optimization.get('schema')!='CM_EXECUTION_OPTIMIZATION_V1' or
        optimization.get('mode') not in ('LOCKSTEP_SHARED_US_ANALYSIS_V1','HYBRID_2X2_SHARED_US_ANALYSIS_V1') or
        optimization.get('shared_panels')!='READ_ONLY_SAME_INPUT_OBJECTS' or
        optimization.get('candidate_state')!='FULLY_INDEPENDENT'):
        raise ValueError('Prepared identity is not bound to an approved shared-analysis optimization')
    if optimization['mode']=='HYBRID_2X2_SHARED_US_ANALYSIS_V1' and len(items)!=2:
        raise ValueError('Hybrid shared-analysis child group must contain exactly two candidates')
    for candidate_id,prepared,_ in items:
        if prepared.identity.get('execution_optimization')!=optimization:
            raise ValueError('Prepared shared-analysis identities differ inside group')
    from cm06_shared_us_analysis_v1 import (
        activate_shared_us_analysis,deactivate_shared_us_analysis,shared_us_analysis_stats)
    base_runtime=_capture_runtime_context()
    contexts=[];receipts={}
    try:
        for candidate_id,prepared,store in items:
            identity=prepared.identity
            journal=CandidateJournal(store,'first_'+digest(identity),'complete_'+digest(identity),identity)
            verified=journal.completed()
            if verified:
                receipts[candidate_id]={'status':'COMPLETED_VERIFIED','candidate_id':candidate_id,
                    'trial_key':prepared.trial_key,'completion':verified,'already_complete':True}
                continue
            runner=prepared.factory();journal.load(runner)
            if not journal.head:
                setcontext(base_runtime[2].copy())
                random.seed(identity['deterministic_seed']);np.random.seed(identity['deterministic_seed']%(2**32))
                journal.commit(runner,False)
            runtime_state=_capture_runtime_context()
            if journal.head['finished']:
                _restore_runtime_context(runtime_state)
                completed=journal.complete(serialize_result(runner))
                if canonical(journal.completed())!=canonical(completed):
                    raise RuntimeError('Completion verification mismatch')
                receipts[candidate_id]={'status':'COMPLETED_VERIFIED','candidate_id':candidate_id,
                    'trial_key':prepared.trial_key,'completion':completed}
                continue
            contexts.append({'candidate_id':candidate_id,'prepared':prepared,'runner':runner,
                'journal':journal,'runtime':runtime_state,'initial_events':runner._resume_events,
                'last_snapshots':len(runner.snapshots)})
        if not contexts:
            return {'receipts':[receipts[candidate_id] for candidate_id,_,_ in items],
                'shared_us_analysis':{'hits':0,'misses':0,'row_checks':0,'max_cached_rows':0,'active':False}}

        leader=contexts[0]['runner']
        for context in contexts[1:]:
            other=context['runner']
            if other.calendars!=leader.calendars or set(other.panels)!=set(leader.panels):
                raise ValueError('Shared group market clocks/panel sets differ')
            other.panels=dict(other.panels)
            for engine,panel in leader.panels.items():
                if type(other.panels[engine]) is not type(panel):
                    raise ValueError('Shared group panel wrapper types differ')
                other.panels[engine]=panel

        activate_shared_us_analysis(optimization)
        start=time.monotonic();last_checkpoint=start;failed=None
        while contexts:
            first_event=contexts[0]['runner'].queue[0] if contexts[0]['runner'].queue else None
            for context in contexts[1:]:
                event=context['runner'].queue[0] if context['runner'].queue else None
                if event!=first_event:raise ValueError('Shared group event grids diverged')
            progressed=[]
            for context in contexts:
                _restore_runtime_context(context['runtime'])
                try:
                    alive=context['runner'].step()
                except Exception as exc:
                    context['runtime']=_capture_runtime_context();failed=(context,exc);break
                context['runtime']=_capture_runtime_context();progressed.append(alive)
            if failed is not None:break
            if len(set(progressed))!=1:raise RuntimeError('Shared group completion boundary diverged')
            if progressed and progressed[0] is False:
                for context in contexts:
                    _restore_runtime_context(context['runtime'])
                    context['journal'].commit(context['runner'],True)
                    context['runtime']=_capture_runtime_context()
                    completed=context['journal'].complete(serialize_result(context['runner']))
                    if canonical(context['journal'].completed())!=canonical(completed):
                        raise RuntimeError('Group completion readback mismatch')
                    receipts[context['candidate_id']]={'status':'COMPLETED_VERIFIED',
                        'candidate_id':context['candidate_id'],'trial_key':context['prepared'].trial_key,
                        'completion':completed}
                contexts.clear();break
            now=time.monotonic()
            stop=bool((now-start)>=max_seconds or
                (event_limit is not None and any(
                    context['runner']._resume_events-context['initial_events']>=event_limit for context in contexts)) or
                (stop_requested is not None and stop_requested()))
            snapshot_due=any(
                len(context['runner'].snapshots)-context['last_snapshots']>=CHECKPOINT_SNAPSHOTS
                for context in contexts)
            if stop or now-last_checkpoint>=CHECKPOINT_SECONDS or snapshot_due:
                for context in contexts:
                    _restore_runtime_context(context['runtime'])
                    context['journal'].commit(context['runner'],False)
                    context['runtime']=_capture_runtime_context()
                    context['last_snapshots']=len(context['runner'].snapshots)
                last_checkpoint=time.monotonic()
            if stop:
                for context in contexts:
                    receipts[context['candidate_id']]=_group_pause_receipt(
                        context['candidate_id'],context['prepared'],context['journal'])
                contexts.clear();break
        if failed is not None:
            failed_context,exc=failed
            for context in contexts:
                if context is failed_context:
                    receipts[context['candidate_id']]={'status':'WORKER_EXCEPTION',
                        'candidate_id':context['candidate_id'],'trial_key':context['prepared'].trial_key,
                        'error_type':type(exc).__name__,'processed_events':None,
                        'checkpoint_sequence':context['journal'].sequence}
                else:
                    receipts[context['candidate_id']]=_group_pause_receipt(
                        context['candidate_id'],context['prepared'],context['journal'])
        stats=shared_us_analysis_stats()
        return {'receipts':[receipts[candidate_id] for candidate_id,_,_ in items],
            'shared_us_analysis':stats}
    finally:
        deactivate_shared_us_analysis()
        _restore_runtime_context(base_runtime)

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
