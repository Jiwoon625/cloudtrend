"""Fresh warmup S05 host. Candidate evidence is a stop gate, never an admission."""
from __future__ import annotations
from bisect import bisect_left, bisect_right
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from datetime import date,timedelta
from copy import copy,deepcopy
from decimal import getcontext,setcontext
import random
import numpy as np
import hashlib
import json
from cm06.accounting import utc
from cm06_exact_resume_mixin import ExactResumeMixin
from cm06_exact_units_execution_v1 import ExactEntitlementExecutionReplay
from cm06_exact_units_accounting_v1 import ExactComparisonEntitlementPosition
from cm06_fractional_signals_v1 import promote_us_adapter
from cm06_dated_action_dispatcher_v1 import DatedActionPanels
from cm06_verified_reference_adapter_v1 import dispatch_verified_open,QuoteRule
from cm06_dated_action_contract_v1 import ActionRegistry, StableInstrumentIdentityMap,DatedAction

HOST_SCHEMA='CM06_FRESH_POLICY_HOST_V1'
HOST_STATIC={'corporate_action_registry','corporate_action_contexts',
             'corporate_action_instrument_identities','candidate_hazards','candidate_coverages','quote_rules','entitlement_bridge','host_binding'}

def canonical(x):return json.dumps(x,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()
def digest(x):return hashlib.sha256(canonical(x)).hexdigest()


class DocumentedQuotePanels(Mapping):
    """Filter only proven identity/date quote boundaries, including warmup.

    This neither grants an accounting action nor treats zero volume as an
    invalid valuation. Unresolved candidate records never enter this filter.
    """
    def __init__(self,panels,rules):
        self.panels=panels;self.rules=tuple(rules)
        if any(type(rule) is not QuoteRule for rule in self.rules):
            raise TypeError('Immutable documented quote rules required')
    def __len__(self):return len(self.panels)
    def __iter__(self):return iter(self.panels)
    def __contains__(self,day):return day in self.panels
    def __getattr__(self,name):return getattr(self.panels,name)
    def __getitem__(self,day):
        frame=self.panels[day]
        active=[r for r in self.rules if ((r.first_legal_trade_date and day<r.first_legal_trade_date)
                or (r.last_legal_trade_date and day>r.last_legal_trade_date))]
        if not active:return frame
        keep=[]
        for row in frame.to_dict('records'):
            relevant=[r for r in active if r.symbol==row['symbol']]
            identity=row.get('permaticker')
            if relevant and (identity is None or str(identity) in ('','nan','None')):
                raise ValueError('DOCUMENTED_QUOTE_FILTER_IDENTITY_REQUIRED: '+row['symbol'])
            keep.append(not any(str(identity)==r.permaticker for r in relevant))
        return frame.loc[keep].copy()
@dataclass(frozen=True)
class CandidateHazard:
    event_id:str
    symbol:str
    permaticker:str|None
    boundary_date:str|None
    terminal:bool
    evidence_kind:str
    source_record_sha256:str
    unresolved_gates:tuple[str,...]

@dataclass(frozen=True)
class CandidateCoverage:
    admitted_event_id:str
    candidate_event_id:str
    candidate_record_sha256:str
    permaticker:str
    candidate_boundary_date:str|None
    admitted_recognition_at:str
    coverage_proof_sha256:str
    boundary_correction_source_sha256:str|None=None


def validate_coverages(registry,hazards,coverages,additional_events=()):
    all_events=(*registry.events,*additional_events)
    if len({e.event_id for e in all_events})!=len(all_events):raise ValueError('Duplicate covered accounting event')
    for event in additional_events:
        if type(event) is not DatedAction:raise ValueError('Source-bound deferred accounting event required')
        event.validate_boundary(registry.calendar)
    events={e.event_id:e for e in all_events};candidates={h.event_id:h for h in hazards};seen=set()
    for c in coverages:
        if type(c) is not CandidateCoverage or c.candidate_event_id in seen:raise ValueError('Unique immutable candidate coverage required')
        seen.add(c.candidate_event_id)
        e=events.get(c.admitted_event_id);h=candidates.get(c.candidate_event_id)
        if e is None or h is None or e.kind=='UNRESOLVED_RIGHT':raise ValueError('Coverage requires specific admitted economic event and candidate')
        if (c.candidate_record_sha256!=h.source_record_sha256 or c.permaticker!=e.predecessor_identity or
            (h.permaticker is not None and c.permaticker!=h.permaticker) or e.predecessor!=h.symbol or
            c.candidate_boundary_date!=h.boundary_date or utc(c.admitted_recognition_at)!=utc(e.recognition_at)):
            raise ValueError('Candidate coverage source/identity/boundary mismatch')
        from cm06_dated_action_contract_v1 import require_sha
        require_sha(c.coverage_proof_sha256,'Specific candidate coverage proof')
        if h.boundary_date!=e.recognition_session_date:
            require_sha(c.boundary_correction_source_sha256,'Documented candidate boundary correction')
        if h.evidence_kind=='DOCUMENTED_CONDITIONAL_DIAGNOSTIC_BOUNDARY' and h.event_id not in e.payload.get('resolved_right_event_ids',[]):
            raise ValueError('Distinct conditional rights cannot be suppressed by transaction coverage')


class HeldCandidateBlocked(ValueError):
    def __init__(self,issues):
        self.issues=issues
        super().__init__('UNRESOLVED_HELD_CANDIDATE: '+canonical(issues).decode())

def candidate_hazards(records,us_calendar):
    """Diagnostic dates only. Provider last-trade is never a legal effective date.

    Keep all candidate IDs, including duplicate transaction evidence. Resolution
    requires explicitly resolving every applicable ID in a new source identity.
    Conditional nonterminal rights gate at their boundary only. A later purchase
    cannot acquire the earlier right. Missing dates gate only actually held names.
    """
    days=[s.session_date for s in us_calendar.sessions]
    out=[]
    for row in records:
        if row.get('activation_authorized') is not False:
            raise ValueError('This input must remain the unadmitted candidate registry')
        b=row['activation_boundary_provenance'];origin=row['origin']
        # This research-only hold was expressly never installed. Preserve the
        # existing SHLM CVR exclusion; cash-event candidates remain unresolved.
        if row.get('event_id')=='HOLD:SHLM:2018-08-21:SHLM_CONTINGENT_VALUE_RIGHT':
            preserved=row.get('active_comparison_policy',{}).get('preserved_other_rights_policy',{})
            if preserved!={'behavior_preserved':True,'legacy_policy':'SHLM_CVR_EXCLUSION_RETAINED; CANDIDATE_REVIEW_HOLD_NOT_INSTALLED'}:
                raise ValueError('Explicit unchanged SHLM rights policy evidence required')
            continue
        if origin=='CONDITIONAL_RIGHTS_HOLD_SNAPSHOT':
            anchor=b.get('documented_boundary_date');i=bisect_left(days,anchor) if anchor else 0
            terminal=b.get('terminal',True);kind='DOCUMENTED_CONDITIONAL_DIAGNOSTIC_BOUNDARY'
        else:
            anchor=b.get('documented_last_trade_date') or b.get('provider_last_trade_date')
            i=bisect_right(days,anchor) if anchor else 0
            terminal=True;kind='AFTER_REPORTED_LAST_TRADE_NOT_LEGAL_RECOGNITION'
        # A risk later than calendar coverage cannot be reached by this replay.
        if not anchor:boundary=None
        elif i<len(days):boundary=days[i]
        elif origin=='CONDITIONAL_RIGHTS_HOLD_SNAPSHOT':boundary=anchor
        else:
            # A last-trade cutoff at/after the calendar frontier cannot become
            # a missing-date immediate hold. This exclusive lower bound is
            # outside all supplied sessions; it does not invent a trading day.
            boundary=(date.fromisoformat(anchor)+timedelta(days=1)).isoformat()
        out.append(CandidateHazard(row['event_id'],row['symbol'],str(row['permaticker']) if row.get('permaticker') else None,
            boundary,terminal,kind,digest(row),tuple(row.get('unresolved_gates',()))))
    if len({h.event_id for h in out})!=len(out):raise ValueError('Duplicate candidate event ID')
    return tuple(out)

def quote_cutoff_hazards(document,us_calendar):
    """Independently bounded predecessor quotes tighten diagnostic stop dates.

    A cutoff proves quote invalidity, not an executable conversion/recognition.
    It never causes a global exclusion or automatic action admission.
    """
    days=[s.session_date for s in us_calendar.sessions];out=[]
    if document.get('runtime_admissions')!=0 or document.get('rules_are_not_event_admissions') is not True:
        raise ValueError('Quote evidence must not carry runtime admissions')
    for row in document['events']:
        rule=row.get('predecessor_quote_rule',{});last=rule.get('last_legal_trade_date')
        if not last:continue
        index=bisect_right(days,last)
        boundary=days[index] if index<len(days) else (date.fromisoformat(last)+timedelta(days=1)).isoformat()
        out.append(CandidateHazard('QUOTE_CUTOFF:'+row['event_id'],rule['symbol'],rule['permaticker'],
            boundary,True,'DOCUMENTED_QUOTE_CUTOFF_NOT_ACTION_ADMISSION',digest(row),
            ('LEGAL_QUOTE_CUTOFF_REACHED_WITH_UNRESOLVED_HELD_EVENT',)))
    return tuple(out)


def holding_issues(replay,day):
    """No ownership => no stop, no panel blacklist, no rights created."""
    admitted={c.candidate_event_id for c in replay.candidate_coverages}
    pending=replay.pending_entitlement_keys
    issues=[]
    for h in replay.candidate_hazards:
        if h.event_id in admitted:continue
        key=('U',h.symbol);right=(*key,h.event_id)
        held=key in replay.ledger.positions
        if not held and right not in pending:continue
        known_identity=replay.corporate_action_instrument_identities.identity(h.symbol) if held else None
        if held and h.permaticker is not None and known_identity!=h.permaticker and right not in pending:continue
        due=h.boundary_date is None or (day>=h.boundary_date if h.terminal else day==h.boundary_date)
        if right in pending or (held and due):
            issues.append({'event_id':h.event_id,'symbol':h.symbol,'actual_permaticker':known_identity,
                'candidate_permaticker':h.permaticker,'session_date':day,'diagnostic_boundary_date':h.boundary_date,
                'diagnostic_date_is_legal_recognition':False,'evidence_kind':h.evidence_kind,
                'quantity':str(replay.ledger.positions[key].quantity) if held else None,
                'owns_pending_entitlement':right in pending,'unresolved_gates':list(h.unresolved_gates)})
    return issues

class FreshPolicyReplay(ExactResumeMixin,ExactEntitlementExecutionReplay):
    def __init__(self,*args,registry,contexts,instrument_identities,hazards=(),coverages=(),quote_rules=(),entitlement_bridge=None,context_sha256,**kwargs):
        if type(registry) is not ActionRegistry or type(instrument_identities) is not StableInstrumentIdentityMap:
            raise ValueError('Fresh explicit registry and stable source identities required')
        if not callable(contexts):raise TypeError('Source-bound context provider required')
        if kwargs.get('corporate_actions') or kwargs.get('distributions') or kwargs.get('tax_hook'):
            raise ValueError('No extra split/dividend/tax path in fresh comparison host')
        super().__init__(*args,**kwargs)
        # CMresearchengine generalizes the reviewed accounting host to preregistered candidates.
        if not self.contract.strict_positive_volume:raise ValueError('Zero-volume execution guard required')
        self.corporate_action_registry=registry
        self.corporate_action_contexts=contexts
        self.corporate_action_instrument_identities=instrument_identities
        self.candidate_hazards=tuple(hazards)
        self.entitlement_bridge=entitlement_bridge
        self.bridge_pending={}
        self._bridge_open_active=False
        self.candidate_coverages=tuple(coverages)+tuple(entitlement_bridge.coverages if entitlement_bridge else ())
        self.quote_rules=tuple(quote_rules)
        validate_coverages(registry,self.candidate_hazards,self.candidate_coverages,
            entitlement_bridge.events if entitlement_bridge else ())
        self.pending_entitlement_keys=frozenset()
        self.host_binding={'schema':HOST_SCHEMA,'initialization':'FRESH_EVENT_ZERO_WITH_FULL_WARMUP',
            'registry_sha256':registry.binding_sha256,'registry_trial_id':registry.new_trial_id,
            'instrument_identity_sha256':instrument_identities.fingerprint,
            'hazards_sha256':digest([asdict(h) for h in self.candidate_hazards]),
            'documented_quote_rules_sha256':digest([asdict(r) for r in self.quote_rules]),
            'entitlement_bridge':entitlement_bridge.binding if entitlement_bridge else None,
            'context_sha256':context_sha256,'candidate_coverage_sha256':digest([asdict(c) for c in self.candidate_coverages])}
        self.panels['U']=DatedActionPanels(DocumentedQuotePanels(self.panels['U'],self.quote_rules),registry)
        # All verified US OPENs in input coverage must get a guard even on a
        # wholly missing cross-section; never create a synthetic price row.
        queued={event[5]['session_date'] for event in self.queue if event[3]=='OPEN' and event[4]=='U'}
        earliest=min(self.panels['U'])
        for session in self.calendars['U']:
            if earliest<=session['session_date']<=self.contract.end_date and session['session_date'] not in queued:
                self.push(session['open_at'],20,'OPEN','U',session)

    def step(self):
        # Only US OPEN can dispatch mandatory actions/new fills. Snapshot its
        # exact write-set before the ordinary event loop advances/settles/pops.
        # Immutable panels and prior snapshots are not duplicated each session.
        atomic=self.queue and (self.queue[0][3:5]==('OPEN','U') or
            (self.entitlement_bridge is not None and self.queue[0][3:5]==('CLOSE','U')))
        if not atomic:
            return super().step()
        before=dict(self.__dict__)
        ledger=copy(self.ledger)
        # The exact codec intentionally retains mapping insertion order. Keep
        # the original slot of events rather than remove/reinsert it last: even
        # equal values must restore the identical pre-event checkpoint bytes.
        ledger.__dict__={k:(list(v) if k=='events' else deepcopy(v))
                         for k,v in self.ledger.__dict__.items()}
        before['ledger']=ledger
        before['adapters']=dict(self.adapters);before['adapters']['U']=deepcopy(self.adapters['U'])
        for name in ('entry_meta','holding_spans','initial_native','demand_events','order_diagnostics','bridge_pending'):
            before[name]=deepcopy(getattr(self,name))
        before['latest_rows']=dict(self.latest_rows);before['latest_rows']['U']=deepcopy(self.latest_rows['U'])
        before['exposure_records']=list(self.exposure_records)
        before['queue']=list(self.queue)
        py_rng=random.getstate();np_rng=np.random.get_state();decimal_context=getcontext().copy()
        try:return super().step()
        except BaseException as exc:
            # No failed fill, receivable release, event pop or random/decimal
            # change survives. Preserve detailed exception as external evidence.
            self.__dict__=before;random.setstate(py_rng);np.random.set_state(np_rng);setcontext(decimal_context)
            try:exc.atomic_event_rollback_verified=True
            except Exception:pass
            raise

    def _guard(self,day):
        issues=holding_issues(self,day)
        if issues:raise HeldCandidateBlocked(issues)

    def _holdings(self,e):
        holdings=super()._holdings(e)
        if e=='U' and self.entitlement_bridge is not None and not self._bridge_open_active:
            hidden=self.entitlement_bridge.nontradable_symbols(self)
            return {symbol:value for symbol,value in holdings.items() if symbol not in hidden}
        return holdings

    def _close(self,e,session):
        if e=='U' and self.entitlement_bridge is not None:
            self.entitlement_bridge.resolve_close(self,session)
            if any(type(p) is ExactComparisonEntitlementPosition for (owner,_),p in self.ledger.positions.items() if owner=='U'):
                self.adapters['U']=promote_us_adapter(self.adapters['U'])
            self._guard(session['session_date'])
        return super()._close(e,session)

    def _open(self,e,session):
        if e=='U':
            if self.entitlement_bridge is not None:self.entitlement_bridge.create_open(self,session)
            self._guard(session['session_date'])
            dispatch_verified_open(self,self.corporate_action_registry,session,
                contexts=self.corporate_action_contexts(session),pending_entitlements=self.pending_entitlement_keys)
            if any(type(p) is ExactComparisonEntitlementPosition for (owner,_),p in self.ledger.positions.items() if owner=='U'):
                self.adapters['U']=promote_us_adapter(self.adapters['U'])
            if session['session_date'] not in self.panels['U']:
                if any(owner=='U' for owner,_ in self.ledger.positions):
                    raise ValueError('MISSING_US_CROSS_SECTION_WITH_ACTUAL_HOLDINGS: '+session['session_date'])
                return
        # Pending stock rights still consume a portfolio slot during ordinary
        # OPEN sizing. They have no price row or executable order. Hide them
        # only from signal inputs, after first-quote CLOSE resolution.
        self._bridge_open_active=e=='U' and self.entitlement_bridge is not None
        try:result=super()._open(e,session)
        finally:self._bridge_open_active=False
        # A newly filled position in a still-quoted retired candidate must fail
        # this entire event before checkpoint, rather than survive until tomorrow.
        if e=='U':self._guard(session['session_date'])
        return result
