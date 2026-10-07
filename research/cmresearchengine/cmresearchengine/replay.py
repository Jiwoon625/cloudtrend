"""One central research-only exception convention for every strategy.

A missing valid close on the current verified trading session is observed at its
close-availability time. The last valid close is a retrospective price proxy,
not an actual executable historical fill. Neither cash nor historical NAV is
backdated. Known admitted events and pending stock bridges run first.
"""
from . import runtime
from .immutable_session_rows import freeze_us_session_rows
from copy import deepcopy
from decimal import Decimal
import pandas as pd
from cm06.accounting import dec, utc
from cm06_fresh_host_v1 import FreshPolicyReplay, holding_issues
from cm06_comparison_execution import Replay as BaseReplay
from cm06_verified_reference_adapter_v1 import dispatch_verified_open
from cm06_exact_units_accounting_v1 import ExactComparisonEntitlementPosition
from cm06_fractional_signals_v1 import promote_us_adapter
from cm06_comparison_panels import MonthlyDayPanels, panel_records

POLICY_ID='RETROSPECTIVE_LAST_VALID_CLOSE_EXIT_V1'
POLICY={
    'policy_id':POLICY_ID,
    'trigger':'First verified trading-session close without a finite positive comparison_close while held',
    'reference_price':'Most recent finite positive comparison_close observed no later than trigger',
    'recognition':'Current missing-session close_available_at; never reference-price date',
    'cash_release':'Ordinary settlement sessions counted from trigger date',
    'known_events':'Preserve all verified 27 events and exact-unit bridge before fallback',
    'not_actual_fill':True,'retrospective_exit_proxy':True,'retroactive_nav_rewrite':False,
    'zero_volume':'A valid positive close remains a valuation; no ordinary zero-volume fill',
    'unresolved_rights':'No invented rights; quoted holdings continue, missing-close holding uses proxy',
}

def valid_price(value):
    try:return value is not None and pd.notna(value) and dec(value).is_finite() and dec(value)>0
    except (TypeError, ValueError, ArithmeticError):return False

class SplitMarketPanels(MonthlyDayPanels):
    """Independent views of the same verified K panel, without data rewriting."""
    def __init__(self, base, market):
        self.base=base;self.market=market
        self.immutable_session_cache=bool(getattr(base,'immutable_session_cache',False))
        self._records_day=None;self._records_cache=None
    def __iter__(self):return iter(self.base)
    def __len__(self):return len(self.base)
    def __contains__(self, day):return day in self.base
    def __getitem__(self, day):
        frame=self.base[day]
        return frame.loc[frame.market.eq(self.market)].copy()
    def records(self, day):
        if not self.immutable_session_cache:
            return self[day].to_dict('records')
        if self._records_day!=day:
            self._records_cache=self[day].to_dict('records')
            self._records_day=day
        return self._records_cache
    def __getattr__(self,name):return getattr(self.base,name)

class ResearchReplay(FreshPolicyReplay):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        self.proxy_last_close={}
        self.proxy_exits=[]
        self.proxy_unresolved_observations=[]
        self.proxy_seen_issues=set()
        self.host_binding=dict(self.host_binding,research_exception_policy=POLICY)
        # Base coordinator scheduled rows only. Missing whole cross-sections
        # must still trigger the same session-close test on every market.
        queued={(x[3],x[4],x[5]['session_date']) for x in self.queue if x[3] in ('OPEN','CLOSE')}
        for engine,calendar in self.calendars.items():
            first=min(self.panels[engine])
            for session in calendar:
                day=session['session_date']
                if not first<=day<=self.contract.end_date:continue
                for kind,priority,key in (('OPEN',20,'open_at'),('CLOSE',30,'close_available_at')):
                    if (kind,engine,day) not in queued:self.push(session[key],priority,kind,engine,session)

    def step(self):
        # Keep the existing atomic rollback intact. Only detached, read-only
        # scalar market rows may make its deepcopy an O(1) reference reuse.
        if self.queue and self.queue[0][4]=='U' and self.queue[0][3] in ('OPEN','CLOSE'):
            self.latest_rows['U']=freeze_us_session_rows(self.latest_rows['U'])
        # Fresh host rolls back US ledger writes on error. Include newly added
        # proxy state so a failed known event cannot leave a phantom audit exit.
        before=(dict(self.proxy_last_close),list(self.proxy_exits),
            list(self.proxy_unresolved_observations),set(self.proxy_seen_issues))
        try:return super().step()
        except BaseException:
            (self.proxy_last_close,self.proxy_exits,
             self.proxy_unresolved_observations,self.proxy_seen_issues)=before
            raise

    def _guard(self,day):
        # An unresolved legal-event hypothesis does not stop this explicitly
        # approved price-proxy study. Record encounters instead of inventing terms.
        for issue in holding_issues(self,day):
            key=(issue['event_id'],issue['symbol'])
            if key not in self.proxy_seen_issues:
                self.proxy_seen_issues.add(key)
                self.proxy_unresolved_observations.append(dict(issue,policy_id=POLICY_ID,
                    handling='CONTINUE_QUOTED_HOLDING_UNTIL_MISSING_CLOSE; RIGHTS_UNMODELED'))

    def _open(self,engine,session):
        if session['session_date'] not in self.panels[engine]:
            if engine=='U':
                if self.entitlement_bridge is not None:self.entitlement_bridge.create_open(self,session)
                dispatch_verified_open(self,self.corporate_action_registry,session,
                    contexts=self.corporate_action_contexts(session),pending_entitlements=self.pending_entitlement_keys)
                self._guard(session['session_date'])
            # Apply the original missing-row order-expiry rules even when the
            # entire market cross-section is absent. Missing data cannot extend
            # a one-open-only BUY into a later trading session.
            if session['session_date']>=self.contract.start_date:
                self._start()
                batch='pending-batch:'+engine
                if batch in self.ledger.reservations:self.ledger.release(batch,'EXECUTE_MARKET_ORDER_BATCH')
                for intent in self.adapters[engine].pending_intents():
                    if utc(intent['earliest_execution_at'])>self.ledger.at:continue
                    self._diagnostic(engine,intent,'MISSING_EXECUTION_OPEN')
                    if intent['side']=='BUY' and (intent['expiry']=='NEXT_MARKET_OPEN_ONLY' or
                        (engine in self.kr_engines and intent.get('market')=='KOSPI')):
                        self.adapters[engine].cancel(intent['signal_id'])
                self._reserve_pending_cash(engine)
            # No quote is no ordinary fill. The close records any proxy exit.
            return
        return super()._open(engine,session)

    def _proxy_exit(self,engine,symbol,session):
        key=(engine,symbol);position=self.ledger.positions[key]
        reference=self.proxy_last_close.get(key)
        if reference is None:
            raise ValueError('NO_PRIOR_VALID_CLOSE_FOR_PROXY: '+engine+' '+symbol)
        day=session['session_date'];at=utc(session['close_available_at'])
        if self.ledger.at!=at or utc(reference['available_at'])>at or reference['date']>day:
            raise ValueError('Proxy close observation time mismatch')
        settlement=self._settlement(engine,day)
        quantity=str(position.quantity);self.fill_counter+=1
        fill_id=f'fill:{self.fill_counter}'
        # known_at is recognition time, explicitly NOT reference-price time.
        # No stale quote is installed as a prior-time ledger event.
        self.ledger.sell(fill_id,engine,symbol,position.quantity,reference['price'],at,settlement)
        for event in reversed(self.ledger.events):
            if event.get('id')==fill_id:
                event.update(execution_class='RETROSPECTIVE_EXIT_PROXY',actual_historical_fill=False,
                    trigger_session_date=day,reference_price_date=reference['date'],
                    reference_price_available_at=reference['available_at'])
                break
        audit={'policy_id':POLICY_ID,'engine':engine,'symbol':symbol,'quantity':quantity,
            'trigger_session_date':day,'recognition_at':at.isoformat(),
            'reference_price_date':reference['date'],'reference_price_available_at':reference['available_at'],
            'reference_price':str(reference['price']),'fill_id':fill_id,
            'cash_available_at':settlement.isoformat(),'one_way_fee':'0.0015',
            'retrospective_exit_proxy':True,'actual_historical_fill':False,'retroactive_nav_rewrite':False}
        self.proxy_exits.append(audit)
        self.ledger.record('RETROSPECTIVE_EXIT_PROXY',**audit)
        meta=self.entry_meta.pop(key,{})
        self.holding_spans.append({'engine':engine,'symbol':symbol,'entry_date':meta.get('entry_date',day),'exit_date':day})
        self.adapters[engine].record_holding_span(symbol,meta.get('entry_date',day),day)
        for intent in self.adapters[engine].pending_intents():
            if intent['symbol']==symbol:self.adapters[engine].cancel(intent['signal_id'])
        self._reserve_pending_cash(engine)

    def _close(self,engine,session):
        day=session['session_date']
        # The known two-event entitlement bridge has priority over the generic
        # missing-close path. Pending nontradable rights are not sellable shares.
        if engine=='U' and self.entitlement_bridge is not None:
            self.entitlement_bridge.resolve_close(self,session)
            if any(type(p) is ExactComparisonEntitlementPosition for (e,_),p in self.ledger.positions.items() if e=='U'):
                self.adapters[engine]=promote_us_adapter(self.adapters['U'])
        records=panel_records(self.panels[engine],day) if day in self.panels[engine] else None
        rows={} if records is None else {r['symbol']:r for r in records}
        if any(utc(r['available_at'])>self.ledger.at for r in rows.values()):
            raise ValueError('Features unavailable at close')
        for symbol,row in rows.items():
            if valid_price(row.get('comparison_close')):
                self.proxy_last_close[(engine,symbol)]={'date':day,'available_at':row['available_at'],
                    'price':dec(row['comparison_close'])}
        if day>=self.contract.start_date:
            for symbol in list(self._holdings(engine)):
                if not valid_price(rows.get(symbol,{}).get('comparison_close')):
                    self._proxy_exit(engine,symbol,session)
        if not rows:
            self.ledger.record('MISSING_MARKET_CROSS_SECTION',engine=engine,session_date=day,
                policy_id=POLICY_ID,synthetic_signals_generated=False)
            adapter=self.adapters[engine]
            adapter.pending={k:v for k,v in adapter.pending.items()
                if v['expiry']!='NEXT_MARKET_OPEN_ONLY' and not
                (adapter.sleeve=='US_A0' and v['side']=='BUY')}
            if adapter.sleeve=='US_A0':
                adapter.us_state={'lastDate':day,'coreRanks':{},'betaWeakStreak':{}}
            else:
                for symbol,hist in list(adapter.history.items()):
                    previous=hist[-1] if hist else {}
                    missing={'symbol':symbol,'session_date':day,'available_at':self.ledger.at.isoformat(),
                        'score':None,'eligible':False,'observed':False,
                        'market':previous.get('market'),'sector':previous.get('sector')}
                    adapter.history[symbol]=(hist+[missing])[-2:]
                adapter.latest_gate=None
            adapter.last_date=day
            self._reserve_pending_cash(engine)
            self.latest_rows[engine]={}
            if engine=='E':self.previous_etf_exposure=dec('0')
            return
        return super()._close(engine,session)

    def result(self):
        result=super().result()
        result['retrospective_exit_proxy_audit']=pd.DataFrame(self.proxy_exits)
        result['unresolved_rights_encounters']=pd.DataFrame(self.proxy_unresolved_observations)
        result['exposure_diagnostics']=pd.DataFrame(self.exposure_records)
        result['research_policy']=POLICY
        return result
