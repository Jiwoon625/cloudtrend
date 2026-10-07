"""One-session in-memory memo for candidate-independent US market analysis.

Enabled only by the bounded lockstep group runner. It never persists market
analysis, candidate state, credentials, holdings, orders or fills.
"""
from __future__ import annotations
from copy import deepcopy

_ACTIVE=None
_ENTRY=None
_STATS=None

def activate_shared_us_analysis(binding):
    global _ACTIVE,_ENTRY,_STATS
    if _ACTIVE is not None:raise RuntimeError('Shared US analysis is already active')
    if (not isinstance(binding,dict) or binding.get('mode') not in
        ('LOCKSTEP_SHARED_US_ANALYSIS_V1','HYBRID_2X2_SHARED_US_ANALYSIS_V1')):
        raise ValueError('Explicit shared US analysis binding required')
    _ACTIVE=deepcopy(binding);_ENTRY=None
    _STATS={'hits':0,'misses':0,'row_checks':0,'max_cached_rows':0,'active':True}

def shared_us_analysis_stats():
    return dict(_STATS or {'hits':0,'misses':0,'row_checks':0,'max_cached_rows':0,'active':False})

def deactivate_shared_us_analysis():
    global _ACTIVE,_ENTRY,_STATS
    _ACTIVE=None;_ENTRY=None;_STATS=None

def shared_us_session_analysis(rows,previous,compute):
    global _ENTRY
    if _ACTIVE is None:return compute()
    if not rows:raise ValueError('Shared US analysis requires non-empty session rows')
    date=rows[0].get('session_date')
    if not date or any(row.get('session_date')!=date for row in rows):
        raise ValueError('Shared US analysis requires one raw session date')
    if _ENTRY is not None and _ENTRY['date']==date:
        _STATS['row_checks']+=1
        if previous!=_ENTRY['previous']:raise ValueError('Shared US analysis prior market state diverged')
        if rows!=_ENTRY['rows']:raise ValueError('Shared US analysis raw session rows diverged')
        _STATS['hits']+=1
        return _ENTRY['result']
    if _ENTRY is not None and date<_ENTRY['date']:raise ValueError('Shared US analysis session time reversed')
    result=compute()
    _ENTRY={'date':date,'rows':list(rows),'previous':deepcopy(previous),'result':result}
    _STATS['misses']+=1
    _STATS['max_cached_rows']=max(_STATS['max_cached_rows'],len(rows))
    return result
