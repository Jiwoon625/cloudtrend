"""Source-bound known-action recipes instantiated against the restored US calendar.

Date-to-OPEN recognition is the existing documented-event comparison convention,
not a claim of recorded legal-notice arrival or historical PIT certification.
"""
from __future__ import annotations
from copy import deepcopy
from dataclasses import asdict
from pathlib import Path
import hashlib,json
from cm06_verified_reference_adapter_v1 import (
    VerifiedEvidenceStore,QuoteRule,bind_comparison_availability,
    build_cash_context,build_linear_context,canonical,digest,validate_context_binding)
from cm06_dated_action_contract_v1 import DatedAction,ActionRegistry,StableInstrumentIdentityMap
from cm06_cash_merger_registry_v1 import CashMerger
from cm06_exact_units_exchange_v1 import LinearExchangeTerms,LINEAR_POLICY,MODEL_CONTRACT_ID
from cm06_us_cash_t5_policy_v1 import PAYMENT_POLICY,USSessionCalendar

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]
RECIPES_PATH=HERE/'known_profile/KNOWN_EVENT_REFERENCE_RECIPES.json'
RECIPES_SHA256='11a57f819e8aae19693cbbb5d93126c4c57d69906d81e7aed43abcaa11b06a4c'
RECOGNITION_BASIS='DOCUMENTED_LAST_TRADE_TO_FIRST_UNAVAILABLE_US_OPEN_COMPARISON_CONVENTION_NOT_NOTICE_ARRIVAL'


def recipe_document():
    raw=RECIPES_PATH.read_bytes()
    if hashlib.sha256(raw).hexdigest()!=RECIPES_SHA256:
        raise ValueError('KNOWN_EVENT_RECIPE_SOURCE_HASH_CHANGED')
    return json.loads(raw)


def documented_profile_rules():
    """Reviewed existing declarations supplement rules, never admit a registry."""
    return recipe_document()['recipes']


def build_known_profile(*,calendar,instrument_identities,candidate_records,hazards,
                        evidence_parts,evidence_receipt,source_sha256):
    from cm06_fresh_host_v1 import CandidateCoverage, digest as candidate_digest
    if type(calendar) is not USSessionCalendar or type(instrument_identities) is not StableInstrumentIdentityMap:
        raise ValueError('Verified runtime calendar and instrument identities required')
    document=recipe_document()
    store=VerifiedEvidenceStore(evidence_parts,evidence_receipt)
    for name,expected in document.get('source_bindings',{}).items():
        if '/drive_parts/' in name:
            data=store.checked_bytes(Path(name).name)
        elif name.endswith('/INDEPENDENT_VERIFICATION_RECEIPT.json'):
            data=Path(evidence_receipt).read_bytes()
        else:
            data=(ROOT/name).read_bytes()
        if hashlib.sha256(data).hexdigest()!=expected:
            raise ValueError('KNOWN_EVENT_RECIPE_UPSTREAM_SOURCE_CHANGED: '+name)
    if store.receipt_sha256!=document['evidence_receipt_sha256']:
        raise ValueError('KNOWN_PROFILE_EXTRACTION_RECEIPT_CHANGED')
    by_id={r['event_id']:r for r in candidate_records}
    if len(by_id)!=len(candidate_records):raise ValueError('Duplicate candidate record ID')
    hazard_by_id={h.event_id:h for h in hazards}
    events=[]; contexts={}; resolutions=[]; omitted=[]; coverages=[]
    blocked=[{'event_id':r['event_id'],'symbol':r['predecessor']['symbol'],
        'reason':'APPROVED_CARRYING_VALUE_BRIDGE_REQUIRED_SEPARATELY_OWNED',
        'actual_holding_or_owned_right_required':True} for r in document.get('blocked_recipes',[])]
    for recipe in document['recipes']:
        symbol=recipe['predecessor']['symbol'];pid=recipe['predecessor']['permaticker']
        try:actual=instrument_identities.identity(symbol)
        except ValueError:
            omitted.append({'event_id':recipe['event_id'],'reason':'PREDECESSOR_NOT_IN_RESTORED_INPUT_UNIVERSE'});continue
        if actual!=pid:raise ValueError('KNOWN_PROFILE_PREDECESSOR_IDENTITY_CHANGED: '+symbol)
        last=recipe['last_trade_date'];effective=recipe['legal_effective_date']
        try:
            boundary=calendar.after(last,1)
            if effective>boundary.session_date:raise ValueError('Legal effective date after first unavailable OPEN')
            old=store.load(recipe['old_locator'])
            old_rule=QuoteRule(**recipe['predecessor_quote_rule'])
            old_clock=bind_comparison_availability(old,store,calendar)
            if recipe.get('cash_per_raw_equivalent','0')!='0':calendar.t_plus_five(effective)
            successor=recipe.get('successor');new=None
            if successor:
                if instrument_identities.identity(successor['symbol'])!=successor['permaticker']:
                    raise ValueError('Known successor identity differs from restored universe')
                new=store.load(recipe['new_locator'])
                new_rule=QuoteRule(**recipe['successor_quote_rule'])
                new_clock=bind_comparison_availability(new,store,calendar)
            proof=digest({'recipe':recipe,'calendar_sha256':calendar.fingerprint,
                          'identity_sha256':instrument_identities.fingerprint,
                          'extraction_receipt_sha256':store.receipt_sha256,
                          'recognition_basis':RECOGNITION_BASIS})
            payload={'reference_context_proof_sha256':proof,'recognition_basis':RECOGNITION_BASIS,
                     'recorded_notice_arrival_verified':False,'historical_point_in_time_certified':False,
                     'shlm_cvr_exclusion_retained':symbol=='SHLM'}
            if successor:
                payload.update(share_ratio=recipe['share_ratio'],
                    cash_per_raw_equivalent=recipe.get('cash_per_raw_equivalent','0'),
                    successor_reference_date=new.values['session_date'])
            else:payload['cash_per_share']=recipe['cash_per_raw_equivalent']
            event=DatedAction(event_id=recipe['event_id'],kind=recipe['kind'],
                predecessor=symbol,predecessor_identity=pid,legal_effective_date=effective,
                last_trade_date=last,recognition_session_date=boundary.session_date,
                recognition_at=boundary.open_at,boundary_evidence=RECOGNITION_BASIS,
                source_available_at=boundary.open_at,source_url=recipe['source_url'],
                source_sha256=proof,identity_receipt_sha256=instrument_identities.receipt_sha256,
                admission='RUNTIME_PREFLIGHT_APPROVED',
                successor=successor['symbol'] if successor else None,
                successor_identity=successor['permaticker'] if successor else None,
                payload_json=canonical(payload))
            if successor:
                terms=LinearExchangeTerms(event.event_id,symbol,successor['symbol'],pid,
                    successor['permaticker'],effective,boundary.open_at,last,new.values['session_date'],
                    recipe['share_ratio'],recipe.get('cash_per_raw_equivalent','0'),recipe['source_url'],
                    fractional_policy=LINEAR_POLICY,model_contract_id=MODEL_CONTRACT_ID,
                    complete_linear_consideration=True,causal_activation_verified=True,calendar_id='US')
                context=build_linear_context(event,terms,old,new,old_rule,new_rule,old_clock,new_clock)
            else:
                cash=CashMerger(symbol,effective,last,recipe['cash_per_raw_equivalent'],recipe['source_url'],
                    consideration_note=recipe.get('cash_declaration',{}).get('consideration_note','cash only; no additional distributions'),
                    payment_assumption=PAYMENT_POLICY)
                context=build_cash_context(event,cash,old,old_rule,old_clock)
            validate_context_binding(context,event,calendar)
            event.validate_boundary(calendar)
        except (ValueError,KeyError,TypeError) as exc:
            blocked.append({'event_id':recipe['event_id'],'symbol':symbol,'reason':str(exc),
                            'actual_holding_or_owned_right_required':True})
            continue
        covered=[]
        for entry in recipe.get('covered_candidate_records',[]):
            cid=entry['event_id'];row=by_id.get(cid)
            if row is None or candidate_digest(row)!=entry['canonical_record_sha256']:
                raise ValueError('KNOWN_PROFILE_CANDIDATE_COVERAGE_SOURCE_CHANGED: '+cid)
            hazard=hazard_by_id.get(cid)
            if hazard is None:continue
            if hazard.symbol!=symbol or (hazard.permaticker is not None and hazard.permaticker!=pid):
                raise ValueError('Known profile candidate coverage identity mismatch')
            correction=proof if hazard.boundary_date!=event.recognition_session_date else None
            coverages.append(CandidateCoverage(event.event_id,cid,hazard.source_record_sha256,pid,
                hazard.boundary_date,event.recognition_at,proof,correction));covered.append(cid)
        # Exact quote cutoff is the same reviewed recipe boundary. Unrelated
        # rights and other issuer events remain untouched.
        cutoff_ids={'QUOTE_CUTOFF:'+event.event_id}
        cutoff_ids.update('QUOTE_CUTOFF:'+cid for cid in covered)
        for cid in sorted(cutoff_ids):
            hazard=hazard_by_id.get(cid)
            if hazard is None:continue
            coverages.append(CandidateCoverage(event.event_id,cid,hazard.source_record_sha256,pid,
                hazard.boundary_date,event.recognition_at,proof,
                proof if hazard.boundary_date!=event.recognition_session_date else None))
        events.append(event);contexts[event.event_id]=context
        resolutions.append({'event_id':event.event_id,'symbol':symbol,'permaticker':pid,
            'recognition_at':event.recognition_at,'kind':event.kind,'covered_candidate_ids':covered,
            'reference_context_sha256':context['reference_adapter_binding_sha256'],
            'cash_due_at':calendar.t_plus_five(effective).isoformat() if recipe.get('cash_per_raw_equivalent','0')!='0' else None})
    registry=ActionRegistry.bind(tuple(events),calendar,source_sha256,trial_prefix='cm06-fresh-known-actions')
    context_hash=digest({'recipes_sha256':RECIPES_SHA256,'calendar_sha256':calendar.fingerprint,
        'identities_sha256':instrument_identities.fingerprint,
        'contexts':{k:v['reference_adapter_binding_sha256'] for k,v in contexts.items()}})
    def provide(session):
        # Future actions do not construct or demand runtime prerequisites.
        return {e.event_id:deepcopy(contexts[e.event_id]) for e in events
                if e.recognition_session_date==session['session_date']}
    report={'schema':'CM06_KNOWN_ACTION_PROFILE_V1','admitted_event_count':len(events),
        'runtime_preflight_performed':True,'calendar_sha256':calendar.fingerprint,
        'recipe_sha256':RECIPES_SHA256,'reference_receipt_sha256':store.receipt_sha256,
        'candidate_records_covered':len([c for c in coverages if not c.candidate_event_id.startswith('QUOTE_CUTOFF:')]),
        'quote_cutoffs_covered':len([c for c in coverages if c.candidate_event_id.startswith('QUOTE_CUTOFF:')]),
        'recognition_basis':RECOGNITION_BASIS,'recorded_notice_arrival_verified':False,
        'recorded_vendor_arrival_verified':False,'historical_point_in_time_certified':False,
        'ordinary_positive_volume_execution_guard_unchanged':True,
        'resolutions':resolutions,'blocked_known_events':blocked,'omitted_events':omitted,
        'remaining_candidate_hazards':len(hazards)-len(coverages),
        'remaining_hazards_are_actual_holding_conditional':True,'global_holding_blockers_inferred':0}
    return {'registry':registry,'contexts':provide,'context_sha256':context_hash,
            'coverages':tuple(coverages),'report':report}
