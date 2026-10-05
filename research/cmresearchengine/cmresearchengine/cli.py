"""Manual research-only CLI. Never discovers or writes production data tables."""
from . import runtime
import argparse
from pathlib import Path
import hashlib
import json
import os
import signal
import time
from concurrent.futures import ProcessPoolExecutor, wait, FIRST_COMPLETED
from .plan import manifest, candidates, choose


def emit(status, **details):
    # No positions, private filenames, storage credentials or result data in
    # public GitHub Actions logs. Complete details live in private Storage only.
    print(json.dumps({'status':status,**details},sort_keys=True),flush=True)

def _parallel_static_worker(config, candidate, plan_hash, max_seconds, event_limit):
    """Run exactly one static candidate in an isolated child process.

    The parent has already restored and verified private inputs. The child only
    reads those local files and owns a candidate-specific ledger/checkpoint scope.
    """
    from .storage import SupabaseCMStore
    from .prepared import PreparedResearch
    from .runner import run_strategy, read_result
    from cm06.registry import candidate_by_id
    from cm06_fresh_host_v1 import canonical, digest

    if candidate.policy_id or candidate.stage == 'references':
        raise ValueError('Parallel worker accepts static non-reference candidates only')
    store=SupabaseCMStore.from_env()
    prototype=PreparedResearch(config,candidate_by_id('S05'))
    prepared=prototype.clone(candidate,None)
    scoped=store.scoped_checkpoints(plan_hash,candidate.candidate_id)
    receipt=run_strategy(prepared,scoped,max_seconds=max_seconds,event_limit=event_limit)
    store.put_object('results/'+plan_hash+'/'+candidate.candidate_id+'/attempts/'+digest(receipt)+'.json',canonical(receipt))
    if receipt['status']=='COMPLETED_VERIFIED':
        files=read_result(receipt['completion'],scoped)
        key='results/'+plan_hash+'/'+candidate.candidate_id+'/'+digest(prepared.identity)
        store.put_object(key+'/summary.json',files['summary.json'])
        store.put_object(key+'/completion.json',canonical(receipt['completion']))
    return receipt


def main(argv=None):
    parser=argparse.ArgumentParser(description='CMresearchengine research-only manual runner')
    parser.add_argument('mode',choices=('plan','preflight','run'))
    parser.add_argument('--stage',choices=('base','fine','split25','split10','references'),default='base')
    parser.add_argument('--offset',type=int,default=0)
    parser.add_argument('--count',type=int,default=1)
    parser.add_argument('--ids',help='Comma-separated exact registered strategy IDs')
    parser.add_argument('--max-seconds',type=int,default=3000)
    parser.add_argument('--workers',type=int,default=1)
    parser.add_argument('--event-limit',type=int)
    parser.add_argument('--work',default='.cm-private/work')
    args=parser.parse_args(argv)
    if not 1<=args.count<=16:parser.error('--count must be 1..16')
    if not 60<=args.max_seconds<=6300:parser.error('--max-seconds must be 60..6300')
    if not 1<=args.workers<=4:parser.error('--workers must be 1..4')
    if args.workers>args.count:parser.error('--workers cannot exceed --count')
    if args.event_limit is not None and args.event_limit<1:parser.error('--event-limit must be positive')
    plan=manifest();plan_hash=plan['definition_sha256']
    if args.mode=='plan':
        emit('PLAN_ONLY_NO_HISTORICAL_EXECUTION',stage_counts=plan['stage_counts'],plan_sha256=plan_hash)
        return 0
    selected=choose(args.stage,args.offset,args.count,args.ids.split(',') if args.ids else None)
    if not selected:raise ValueError('Batch offset is outside selected stage')
    from .storage import SupabaseCMStore
    from .ingest import restore_archives, restore_evidence
    from .prepared import PreparedResearch, configuration
    from .runner import run_strategy, read_result, build_references
    from cm06.registry import candidate_by_id
    from cm06_fresh_host_v1 import canonical,digest
    store=SupabaseCMStore.from_env()
    work=Path(args.work).resolve();work.mkdir(parents=True,exist_ok=True)
    source_manifest=restore_archives(store,work)
    restore_evidence(store,runtime.VENDOR)
    # Private data overlays are hash-verified and cannot contain code. Runtime
    # import roots and code remain the reviewed repository version throughout.
    config=configuration(work,runtime.VENDOR,work/'state')
    prototype=PreparedResearch(config,candidate_by_id('S05'))
    if prototype.admitted_event_count!=27:
        raise ValueError('Known-event profile no longer contains all 27 expected events')
    store.put_object('manifest.json',canonical(source_manifest))
    emit('PREFLIGHT_VERIFIED',normalized_files=389,reference_files=12,known_events=27,
        historical_paths_completed=0,plan_sha256=plan_hash)
    if args.mode=='preflight':return 0
    stop=[False]
    signal.signal(signal.SIGTERM,lambda *_:stop.__setitem__(0,True))
    signal.signal(signal.SIGINT,lambda *_:stop.__setitem__(0,True))
    deadline=time.monotonic()+args.max_seconds
    store.put_object('results/plans/'+plan_hash+'.json',canonical(plan))
    references=None
    receipts=[]
    def run_one(candidate,refs=None):
        remaining=int(deadline-time.monotonic())
        if stop[0] or remaining<=30:return None,None
        prepared=prototype.clone(candidate,refs)
        scoped=store.scoped_checkpoints(plan_hash,candidate.candidate_id)
        receipt=run_strategy(prepared,scoped,max_seconds=max(1,remaining-20),
            event_limit=args.event_limit,stop_requested=lambda:stop[0])
        emit(receipt['status'],candidate_id=candidate.candidate_id,
            processed_events=receipt.get('processed_events'),
            checkpoint_sequence=receipt.get('checkpoint_sequence'))
        store.put_object('results/'+plan_hash+'/'+candidate.candidate_id+'/attempts/'+digest(receipt)+'.json',canonical(receipt))
        if receipt['status']=='COMPLETED_VERIFIED':
            files=read_result(receipt['completion'],scoped)
            # Immutable content-addressed private result index, containing no
            # copied raw licensed source data. Checkpoint outputs hold full audit.
            key='results/'+plan_hash+'/'+candidate.candidate_id+'/'+digest(prepared.identity)
            store.put_object(key+'/summary.json',files['summary.json'])
            store.put_object(key+'/completion.json',canonical(receipt['completion']))
            return receipt,files
        return receipt,None
    if args.workers>1:
        if args.stage=='references' or any(candidate.policy_id for candidate in selected):
            raise ValueError('Parallel workers are limited to static non-reference candidates')
        pending=list(selected)
        active={}
        receipts_by_id={}
        with ProcessPoolExecutor(max_workers=args.workers) as pool:
            while pending or active:
                while pending and len(active)<args.workers:
                    remaining=int(deadline-time.monotonic())
                    if stop[0] or remaining<=45:break
                    candidate=pending.pop(0)
                    future=pool.submit(_parallel_static_worker,config,candidate,plan_hash,
                        max(1,remaining-25),args.event_limit)
                    active[future]=candidate
                if not active:break
                done,_=wait(tuple(active),return_when=FIRST_COMPLETED)
                for future in done:
                    candidate=active.pop(future)
                    receipt=future.result()
                    receipts_by_id[candidate.candidate_id]=receipt
                    emit(receipt['status'],candidate_id=candidate.candidate_id,
                        processed_events=receipt.get('processed_events'),
                        checkpoint_sequence=receipt.get('checkpoint_sequence'),
                        worker_mode='PROCESS_ISOLATED')
                if stop[0] or time.monotonic()>=deadline-45:
                    break
        receipts=[receipts_by_id[c.candidate_id] for c in selected if c.candidate_id in receipts_by_id]
        completed=sum(x['status']=='COMPLETED_VERIFIED' for x in receipts)
        emit('BATCH_VERIFIED',selected_count=len(selected),completed_in_selected_batch=completed,
            remaining_in_selected_batch=len(selected)-completed,
            all_planned_strategies_completion_checked=False,parallel_workers=args.workers)
        return 0

    if any(c.policy_id for c in selected):
        source_results={}
        for candidate in candidates('references'):
            receipt,files=run_one(candidate)
            if files is None:
                emit('BATCH_PAUSED_WAITING_FOR_INDEPENDENT_REFERENCES',historical_paths_completed=0)
                return 0
            source_results[candidate.candidate_id[-1]]=files
        references=build_references(source_results)
    for candidate in selected:
        receipt,files=run_one(candidate,references if candidate.policy_id else None)
        if receipt is None:break
        receipts.append(receipt)
        if receipt['status']!='COMPLETED_VERIFIED':break
    completed=sum(x['status']=='COMPLETED_VERIFIED' for x in receipts)
    emit('BATCH_VERIFIED',selected_count=len(selected),completed_in_selected_batch=completed,
        remaining_in_selected_batch=len(selected)-completed,
        all_planned_strategies_completion_checked=False)
    return 0

if __name__=='__main__':
    try:raise SystemExit(main())
    except Exception as exc:
        # Avoid dumping external response bodies or any credential-bearing repr.
        emit('RESEARCH_BLOCKED',error_type=type(exc).__name__,
            detail='Inspect private inputs, exact source hashes, dependency versions and verified checkpoint chain; no production change was made')
        raise SystemExit(2)
