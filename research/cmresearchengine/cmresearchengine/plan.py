"""Generate the existing preregistered grids; never choose weights after ranking."""
from . import runtime
from cm06.registry import base_registry, simplex_grid, Candidate, manifest_definition
import hashlib
import json

def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()).hexdigest()

REFERENCE_CONTRACT = {
    'schema': 'CM_INDEPENDENT_REFERENCE_V1',
    'engines': ['K', 'E', 'U'],
    'initial_capital_krw_each': 100_000_000,
    'cash_movement': 'NONE',
    'allocation_feedback': False,
    'capital_basis': 'Each reference has its own initial KRW100m; U converts at start-observable FX',
    'normalization': 'Individual gross KRW NAV / individual initial KRW100m',
    'demand_capital_basis': 'Initial native-currency capital; frozen once at each reference start',
    'policy_information_clock': 'available_at <= monthly decision cutoff only',
    'performance_adaptation': False,
}

def candidates(stage):
    if stage == 'base': return base_registry()
    if stage == 'fine': return simplex_grid(10, prefix='F10')
    if stage == 'split25': return simplex_grid(25, assets=('P','Q','E','U','C'), prefix='K25')
    if stage == 'split10': return simplex_grid(10, assets=('P','Q','E','U','C'), prefix='K10')
    if stage == 'references':
        return [Candidate('REF_'+e, 'independent_reference', {x:float(x==e) for x in ('K','E','U','C')}, stage='references') for e in 'KEU']
    raise ValueError('Unknown preregistered stage')

def manifest():
    definition = manifest_definition()
    document = {'schema':'CM_RESEARCH_PLAN_V1', 'source_plan':definition,
        'authorization_scope':'52 base + 286 fine + K-split comparisons; manual bounded batches',
        'stage_counts':{s:len(candidates(s)) for s in ('base','fine','split25','split10')},
        'stages':{s:[c.to_dict() for c in candidates(s)] for s in ('base','fine','split25','split10')},
        'reference_contract':REFERENCE_CONTRACT,
        'comparison_costs':{'one_way_fee':'0.0015','round_trip_fee':'0.0030','fx_spread':'0'},
        'period':{'start_date':'2017-08-21','end_date':'2026-09-11','initial_capital_krw':100_000_000},
        'exception_policy':'RETROSPECTIVE_LAST_VALID_CLOSE_EXIT_V1',
        'known_event_count':27,
        'production_changes':False}
    document['definition_sha256'] = digest(document)
    return document

def choose(stage, offset=0, count=1, ids=None):
    rows=candidates(stage)
    if ids:
        by_id={c.candidate_id:c for c in rows}
        if len(ids)!=len(set(ids)): raise ValueError('Duplicate strategy request')
        unknown=set(ids)-set(by_id)
        if unknown:raise ValueError('Unknown strategy IDs: '+','.join(sorted(unknown)))
        return [by_id[i] for i in ids]
    if offset<0 or count<1:raise ValueError('Invalid batch bounds')
    return rows[offset:offset+count]
