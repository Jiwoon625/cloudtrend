"""Fresh diagnostic S05 entrypoint, source-locked and create-only resumable.

Uses fully restored normalized monthly inputs, never reference extraction windows.
The documented-action profile admits only independently source-bound known
events. Uncovered evidence remains an actual-held encounter gate. No historical
outcome is claimed by offline tests.
"""
from __future__ import annotations
from dataclasses import asdict
from pathlib import Path
from decimal import getcontext
import argparse,hashlib,importlib,io,json,os,random,signal,sys,tempfile,zipfile
import numpy as np
import pandas as pd
from cm06.accounting import FEE,dec
from cm06.registry import candidate_by_id
from cm06_comparison_execution import ExecutionContract
from cm06_comparison_signals import ONE_WAY_COST
from cm06_comparison_panels import MonthlyDayPanels,file_hash
from cm06_dated_action_contract_v1 import ActionRegistry,StableInstrumentIdentityMap
from cm06_us_cash_t5_policy_v1 import USSessionCalendar,POLICY_ID,PAYMENT_POLICY
from cm06_checkpoint_store import DirectoryStore
from cm06_fresh_host_v1 import FreshPolicyReplay,candidate_hazards,quote_cutoff_hazards,canonical,digest,HeldCandidateBlocked
from cm06_fresh_codec_v1 import bind_identity,pack,restore
from cm06_fresh_journal_v1 import CandidateJournal

PINNED={'pandas':'2.2.3','numpy':'2.3.5','scipy':'1.17.0','pyarrow':'23.0.1'}
BASIS='CLOSEADJ_FEATURES_AND_EXECUTION'
ORIGINAL_EXPERIMENT_SHA256='b905b3d0a532b90f2762ae86c4373863589e07509fe3718cedb67cb036ce4df8'
MODULES=('cm06.accounting','cm06.allocation','cm06.policies','cm06.registry','cm06.metrics',
 'cm06_comparison_execution','cm06_comparison_signals','cm06_comparison_panels','cm06_prepare_comparison',
 'cm06_comparison_prices','cm06_closeadj_features','cm06_cash_merger_registry_v1',
 'cm06_cash_merger_registry_v2','cm06_stock_merger_registry_v1','cm06_fractional_accounting_v1',
 'cm06_fractional_signals_v1','cm06_resume_state','cm06_exact_resume_mixin','cm06_checkpoint_store',
 'cm06_us_cash_t5_policy_v1','cm06_dated_action_contract_v1','cm06_dated_action_dispatcher_v1',
 'cm06_exact_units_accounting_v1','cm06_exact_units_exchange_v1','cm06_exact_units_execution_v1',
 'cm06_exact_units_resume_state_v1','cm06_verified_reference_adapter_v1','cm06_known_action_profile_v1',
 'cm06_stock_entitlement_bridge_v1','cm06_fresh_host_v1',
 'cm06_fresh_codec_v1','cm06_fresh_journal_v1')

def sha(data):return hashlib.sha256(data).hexdigest()

def original_experiment(path):
    """Reuse experiment specification only, never any legacy checkpoint/root."""
    raw=Path(path).read_bytes()
    if sha(raw)!=ORIGINAL_EXPERIMENT_SHA256:raise ValueError('Original S05 experiment descriptor hash mismatch')
    identity=json.loads(raw)['identity']
    if canonical(candidate_by_id('S05').to_dict())!=canonical(identity['candidate']):
        raise ValueError('Original S05 candidate definition changed')
    contract=ExecutionContract(**identity['execution'])
    if asdict(contract)!=identity['execution']:raise ValueError('Original execution contract changed')
    return contract,identity

def source_hashes():
    out={name:file_hash(Path(importlib.import_module(name).__file__)) for name in MODULES}
    out['cm06_fresh_driver_v1']=file_hash(__file__)
    return out

def write_once(path,data):
    path=Path(path)
    if any(p.is_symlink() for p in (path,*path.parents)):raise ValueError('Output symlink refused')
    path.parent.mkdir(parents=True,exist_ok=True)
    if path.exists():
        if path.read_bytes()!=data:raise ValueError('Existing artifact differs and is preserved: '+str(path))
        return
    fd,tmp=tempfile.mkstemp(prefix='.'+path.name,dir=path.parent)
    try:
        with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
        try:os.link(tmp,path)
        except FileExistsError:
            if path.read_bytes()!=data:raise ValueError('Concurrent artifact differs')
        directory=os.open(path.parent,os.O_RDONLY)
        try:os.fsync(directory)
        finally:os.close(directory)
    finally:os.unlink(tmp)

def contained(root,relative):
    root=Path(root).absolute();path=root/relative
    if any(p.is_symlink() for p in (path,*path.parents)) or not path.resolve().is_relative_to(root.resolve()):raise ValueError('Input path escape/symlink')
    return path

class PreparedFreshDiagnostic:
    def __init__(self,config):
        self.config=config
        for name,version in PINNED.items():
            if importlib.import_module(name).__version__!=version:raise ValueError('Dependency mismatch: '+name)
        if FEE!=dec('0.0015') or ONE_WAY_COST!=dec('0.0015'):raise ValueError('Frozen ordinary fee changed')
        if any(config.get(k) for k in ('s05_resume_trial_id','s05_accounting_resume_trial_id','seed_state','parent_checkpoint')):
            raise ValueError('Fresh policy cannot use any legacy seed or trial identity')
        self.sources=source_hashes()
        lock=json.loads(Path(config['source_lock']).read_text())
        if lock['source_files']!=self.sources:raise ValueError('Source lock mismatch')
        delivery_binding=config.get('delivery_binding')
        if delivery_binding!=lock.get('delivery_binding'):
            raise ValueError('Delivery source binding mismatch')
        if delivery_binding is not None:
            if not isinstance(delivery_binding,dict) or not delivery_binding:
                raise ValueError('Nonempty delivery source hash mapping required')
            from cm06_dated_action_contract_v1 import require_sha
            for name,value in delivery_binding.items():
                if not isinstance(name,str) or not name:raise ValueError('Invalid delivery source name')
                require_sha(value,'Delivery source '+name)
        for key in ('frozen_input_contract','candidate_registry','quote_rules','evidence_receipt','original_experiment'):
            if file_hash(config[key])!=lock['data_files'][key]:raise ValueError('Evidence source lock mismatch: '+key)
        self.work=Path(config['work']);self.inputs=self.work/'data/comparison_inputs_closeadj_v2'
        frozen=json.loads(Path(config['frozen_input_contract']).read_text())
        missing=[]
        for entry in frozen['outputs']:
            path=contained(self.work,entry['relative_path'])
            if not path.is_file():missing.append(entry['relative_path']);continue
            if path.stat().st_size!=entry['size'] or file_hash(path)!=entry['sha256']:
                raise ValueError('Frozen full-input hash/size mismatch: '+entry['relative_path'])
        if missing:raise FileNotFoundError('FULL_RESTORED_INPUTS_REQUIRED: '+canonical({'missing_count':len(missing),'first_missing':missing[:8]}).decode())
        self.prep=json.loads((self.inputs/'PREPARATION_RESULT.json').read_text())
        if self.prep.get('status')!='NORMALIZED_INPUTS_READY_NOT_BACKTESTED' or self.prep.get('signal_price_basis')!=BASIS:
            raise ValueError('Complete normalized CloseadjInputsV2 preparation required')
        ref=self.work/'outputs/colab_stage2_v1/reference_time'
        refs=json.loads((ref/'data/reference_time/manifest.json').read_text())
        self.calendars={e:json.loads(contained(ref,row['file']).read_text()) for e,row in refs['calendars'].items()}
        for e,row in refs['calendars'].items():
            if file_hash(contained(ref,row['file']))!=row['sha256']:raise ValueError('Calendar source mismatch')
        item=refs['fx']['h10_conservative'];path=contained(ref,item['file'])
        if file_hash(path)!=item['sha256']:raise ValueError('FX source mismatch')
        self.fx=pd.read_csv(path)
        self.contract,self.original_identity=original_experiment(config['original_experiment'])
        if self.original_identity['input_preparation_sha256']!=frozen['preparation_sha256']:
            raise ValueError('Original experiment and frozen preparation differ')
        identities={};identity_rows=0
        for e in 'KEU':
            panel=MonthlyDayPanels(self.inputs/e/'manifest.json',self.prep['engines'][e]['sha256'])
            # Complete calendar/session equality, all warmup included. A partial
            # extraction cannot masquerade as a full cross-section manifest.
            caldays={s['session_date'] for s in self.calendars[e]}
            if set(panel)-caldays:raise ValueError('Input session missing from verified calendar: '+e)
            if min(panel)>=self.contract.start_date:raise ValueError('Full pre-evaluation warmup absent: '+e)
            if e!='U':continue
            for part in panel.parts.values():
                frame=pd.read_parquet(contained(panel.root,part['path']),columns=['symbol','permaticker'])
                for symbol,permaticker in frame.drop_duplicates().itertuples(index=False,name=None):
                    if pd.isna(permaticker):
                        if symbol=='SPY':continue # reference-only frozen benchmark
                        raise ValueError('INPUT_IDENTITY_MISSING: '+symbol)
                    value=str(permaticker)
                    if value.endswith('.0') and value[:-2].isdigit():value=value[:-2]
                    if symbol in identities and identities[symbol]!=value:raise ValueError('TICKER_REUSE_REQUIRES_IDENTITY_AWARE_LEDGER: '+symbol)
                    identities[symbol]=value
                identity_rows+=len(frame)
        input_sha=digest(frozen)
        proof={'input_sha256':input_sha,'rows_scanned':identity_rows,'entries':sorted(identities.items()),
               'stable_per_symbol':True,'historical_identity_certified':False}
        self.identities=StableInstrumentIdentityMap(tuple(sorted(identities.items())),input_sha,digest(proof),True)
        self.identity_proof=proof
        records=[json.loads(line) for line in Path(config['candidate_registry']).read_text().splitlines() if line]
        if len(records)!=4478:raise ValueError('Complete 4478-candidate diagnostic universe required')
        calendar=USSessionCalendar(self.calendars['U'])
        self.hazards=candidate_hazards(records,calendar)+quote_cutoff_hazards(json.loads(Path(config['quote_rules']).read_text()),calendar)
        from cm06_verified_reference_adapter_v1 import documented_rule_catalog,QuoteRule
        catalog=documented_rule_catalog()
        if catalog!=json.loads(Path(config['quote_rules']).read_text()):
            raise ValueError('Runtime documented quote catalog differs from the source lock')
        self.quote_rules=tuple(QuoteRule(**row[key]) for row in catalog['events']
            for key in ('predecessor_quote_rule','successor_quote_rule') if key in row)
        from cm06_known_action_profile_v1 import build_known_profile
        profile=build_known_profile(calendar=calendar,instrument_identities=self.identities,
            candidate_records=records,hazards=self.hazards,evidence_parts=config['evidence_parts'],
            evidence_receipt=config['evidence_receipt'],source_sha256=digest(self.sources))
        self.registry=profile['registry'];self.contexts=profile['contexts']
        self.context_sha256=profile['context_sha256'];self.coverages=tuple(profile['coverages'])
        self.profile_report=profile['report']
        if not self.registry.events:raise ValueError('Documented known-action profile cannot release an empty registry')
        from cm06_stock_entitlement_bridge_v1 import build_stock_entitlement_bridge
        self.entitlement_bridge=build_stock_entitlement_bridge(calendar=calendar,instrument_identities=self.identities,
            candidate_records=records,hazards=self.hazards,evidence_parts=config['evidence_parts'],
            evidence_receipt=config['evidence_receipt'],source_sha256=digest(self.sources))
        self.admitted_event_count=len(self.registry.events)+len(self.entitlement_bridge.events)
        self.covered_candidate_count=len(self.coverages)+len(self.entitlement_bridge.coverages)
        self.base_identity={'schema':'CM06_FRESH_DIAGNOSTIC_TRIAL_V1','scope':'FRESH_S05_DOCUMENTED_ACTION_POLICY_DIAGNOSTIC',
            'candidate':candidate_by_id('S05').to_dict(),'execution':asdict(self.contract),'signal_basis':BASIS,
            'original_experiment_sha256':ORIGINAL_EXPERIMENT_SHA256,
            'source_sha256':digest(self.sources),'input_sha256':input_sha,'evidence_sha256':lock['data_files'],
            'policy_id':POLICY_ID,'payment_policy':PAYMENT_POLICY,'one_way_fee':'0.0015',
            'ordinary_buy_units':'INTEGER_UNCHANGED','entitlement_units':'EXACT_PROPORTIONAL_RATIONAL',
            'additional_cash_dividends':False,'additional_etf_distributions':False,
            'initialization':'FRESH_EVENT_ZERO_WITH_FULL_WARMUP','legacy_seed_allowed':False,
            'admitted_event_count':self.admitted_event_count,'covered_candidate_count':self.covered_candidate_count,
            'direct_action_count':len(self.registry.events),'deferred_stock_action_count':len(self.entitlement_bridge.events),
            'approved_entitlement_bridge':self.entitlement_bridge.binding,
            'known_action_profile':self.profile_report,'candidate_count':len(records),'batch_execution_authorized':False,
            'historical_source_parity_certified':False,'deterministic_seed':70620261005}
        if delivery_binding is not None:self.base_identity['delivery_binding']=delivery_binding
        self.identity=bind_identity(self.base_identity,self.factory())
        self.trial_key='cm06-fresh-s05-'+digest(self.identity)

    def factory(self):
        if source_hashes()!=self.sources:raise ValueError('Source changed after preflight')
        panels={e:MonthlyDayPanels(self.inputs/e/'manifest.json',self.prep['engines'][e]['sha256']) for e in 'KEU'}
        return FreshPolicyReplay(candidate_by_id('S05'),self.contract,panels,self.calendars,self.fx,
            registry=self.registry,contexts=self.contexts,instrument_identities=self.identities,
            hazards=self.hazards,coverages=self.coverages,quote_rules=self.quote_rules,
            entitlement_bridge=self.entitlement_bridge,context_sha256=self.context_sha256)


def trial_descriptor(prepared,*,first_commit_id=None,completed_id=None):
    """Allow already-generated remote IDs; never invent a Google Drive ID."""
    if (first_commit_id is None)!=(completed_id is None):
        raise ValueError('Supply both pre-generated journal root IDs together')
    if first_commit_id is not None:
        from cm06_checkpoint_store import _id
        _id(first_commit_id);_id(completed_id)
        if first_commit_id==completed_id:raise ValueError('Journal root IDs must be distinct')
    identity=prepared.identity
    return {'schema':'CM06_FRESH_DIAGNOSTIC_DESCRIPTOR_V1','identity':identity,'trial_key':prepared.trial_key,
       'first_commit_id':first_commit_id or 'first_'+digest(identity),
       'completed_id':completed_id or 'complete_'+digest(identity),
       'initialization':'FRESH_EVENT_ZERO_WITH_FULL_WARMUP','legacy_seed_allowed':False}


def run_trial(prepared,store,trial_dir,*,event_limit=None,stop_requested=None,descriptor=None):
    """Initial event-zero state is committed before any warmup event executes."""
    trial_dir=Path(trial_dir);identity=prepared.identity
    if descriptor is None:
        # A remote caller must supply IDs that its store actually generated and
        # a descriptor already durably read back before this event-zero commit.
        if not isinstance(store,DirectoryStore):
            raise ValueError('Remote store requires a durable generated-ID descriptor')
        descriptor=trial_descriptor(prepared)
    else:
        expected=trial_descriptor(prepared,first_commit_id=descriptor.get('first_commit_id'),
            completed_id=descriptor.get('completed_id'))
        if descriptor!=expected:raise ValueError('Fresh descriptor identity/schema mismatch')
    write_once(trial_dir/'descriptor.json',canonical(descriptor))
    journal=CandidateJournal(store,descriptor['first_commit_id'],descriptor['completed_id'],identity)
    journal.scan();runner=prepared.factory()
    if journal.head:journal.load(runner)
    else:
        random.seed(identity['deterministic_seed']);np.random.seed(identity['deterministic_seed']%(2**32))
        if runner._resume_events or runner.started or runner.fill_counter:raise ValueError('Factory is not fresh')
        journal.commit(runner,False)
    processed_on_entry=runner._resume_events
    def checkpoint(obj,finished):
        row=journal.commit(obj,finished)
        print('FRESH_S05_CHECKPOINT '+canonical({'trial_key':prepared.trial_key,'sequence':row['sequence'],'at':row['at'],'events':row['processed_events'],'finished':finished}).decode(),flush=True)
    def stop():return bool((event_limit is not None and runner._resume_events-processed_on_entry>=event_limit) or (stop_requested and stop_requested()))
    if journal.head['finished']:
        return {'status':'DIAGNOSTIC_PATH_FINISHED','trial_key':prepared.trial_key,'resumed_completed_state':True,
                'historical_paths_completed':0,'repaired_policy_path_certified':False,'batch_execution_authorized':False}
    try:
        result=runner.run(checkpoint,seconds=180,sessions=252,stop_requested=stop)
        status='DIAGNOSTIC_PATH_FINISHED' if result is not None else 'DIAGNOSTIC_PAUSED_AT_VERIFIED_CHECKPOINT'
        receipt={'status':status,'trial_key':prepared.trial_key,'processed_at':runner.ledger.at.isoformat(),
            'processed_events':runner._resume_events,'fill_count':runner.fill_counter,'checkpoint_sequence':journal.sequence,
            'historical_paths_completed':0,'repaired_policy_path_certified':False,'batch_execution_authorized':False}
    except Exception as exc:
        receipt={'status':'DIAGNOSTIC_STOPPED_NO_NEW_COMPLETION','trial_key':prepared.trial_key,
            'error_type':type(exc).__name__,'error':str(exc),'actual_holding_issues':getattr(exc,'issues',[]),
            'last_verified_checkpoint_sequence':journal.sequence,'last_verified_checkpoint_at':journal.head['at'],
            'failed_event_at':(runner.queue[0][0].isoformat() if getattr(exc,'atomic_event_rollback_verified',False) and runner.queue else runner.ledger.at.isoformat()),'failed_mid_event':runner._resume_poisoned,
            'atomic_event_rollback_verified':getattr(exc,'atomic_event_rollback_verified',False),
            'historical_paths_completed':0,'repaired_policy_path_certified':False,'batch_execution_authorized':False}
    attempts=trial_dir/'attempts';attempts.mkdir(exist_ok=True)
    # Content-addressed immutable outcomes, so a resumed attempt preserves prior diagnostics.
    write_once(attempts/(digest(receipt)+'.json'),canonical(receipt))
    return receipt


def main():
    p=argparse.ArgumentParser();p.add_argument('--config');p.add_argument('--preflight-only',action='store_true')
    p.add_argument('--write-source-lock');p.add_argument('--frozen-input-contract');p.add_argument('--candidate-registry');p.add_argument('--quote-rules')
    p.add_argument('--evidence-receipt')
    p.add_argument('--original-experiment')
    p.add_argument('--event-limit',type=int)
    args=p.parse_args()
    if args.write_source_lock:
        lock={'schema':'CM06_FRESH_SOURCE_LOCK_V1','source_files':source_hashes(),
            'data_files':{k:file_hash(getattr(args,k)) for k in ('frozen_input_contract','candidate_registry','quote_rules','evidence_receipt','original_experiment')}}
        write_once(args.write_source_lock,canonical(lock));return 0
    if not args.config:p.error('--config is required')
    if args.event_limit is not None and args.event_limit<1:p.error('--event-limit must be positive')
    config=json.loads(Path(args.config).read_text())
    try:prepared=PreparedFreshDiagnostic(config)
    except Exception as exc:
        receipt={'status':'FRESH_PREFLIGHT_BLOCKED','error_type':type(exc).__name__,'error':str(exc),'historical_paths_completed':0}
        print(canonical(receipt).decode());return 2
    ready={'status':'FRESH_DIAGNOSTIC_READY','identity':prepared.identity,'trial_key':prepared.trial_key,
           'admitted_events':prepared.admitted_event_count,'candidate_hazards':len(prepared.hazards),
           'covered_candidate_records':prepared.covered_candidate_count,'known_action_profile':prepared.profile_report,
           'approved_entitlement_bridge':prepared.entitlement_bridge.binding,
           'historical_paths_completed':0}
    directory=Path(config['state_root'])/prepared.trial_key
    write_once(directory/'ready.json',canonical(ready));write_once(directory/'input_identity_proof.json',canonical(prepared.identity_proof))
    if args.preflight_only:print(canonical(ready).decode());return 0
    stop=[False]
    def request_stop(*_):stop[0]=True
    signal.signal(signal.SIGINT,request_stop);signal.signal(signal.SIGTERM,request_stop)
    receipt=run_trial(prepared,DirectoryStore(directory/'blobs'),directory,event_limit=args.event_limit,stop_requested=lambda:stop[0])
    print(canonical(receipt).decode())
    return 2 if receipt['status']=='DIAGNOSTIC_STOPPED_NO_NEW_COMPLETION' else (75 if 'PAUSED' in receipt['status'] else 0)

if __name__=='__main__':raise SystemExit(main())
