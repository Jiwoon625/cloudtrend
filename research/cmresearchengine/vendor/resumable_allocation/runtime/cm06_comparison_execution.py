"""Causal normalized-panel execution coordinator, research-only.

This module accepts explicitly documented comparison inputs/calendars and delegates frozen
signal logic to adapters.frozen_signals. It does not silently manufacture them.
The stricter settlement/volume/holiday layer is distinct from source-engine
compatibility parity and must be identified in every run manifest.
"""
from __future__ import annotations
from dataclasses import dataclass, asdict
from decimal import Decimal, ROUND_DOWN
import heapq
from typing import Any
import pandas as pd
from cm06.accounting import Ledger, dec, utc, ZERO
from cm06.allocation import move_idle_cash
from cm06.policies import policy_target
from cm06_comparison_signals import FrozenIntentAdapter
from cm06_comparison_panels import normalized_day_panels, panel_records

ENGINE_ADAPTER = {"K":"KR_MIXED", "E":"ETF_V02", "U":"US_A0"}
CURRENCY = {"K":"KRW", "E":"KRW", "U":"USD"}


@dataclass(frozen=True)
class ExecutionContract:
    start_date: str
    end_date: str
    initial_capital_krw: int = 100_000_000
    cash_movement: str = "MONTHLY"
    fx_spread: str = "0.001"
    fx_spread_status: str = "explicit research assumption, not broker actual"
    # None retains current US 1% ADV cap and no added K/E participation limit.
    participation_limit: float | None = None
    capacity_mode: str = "FROZEN_BASELINE"
    us_current_participation: float = 0.01
    settlement_sessions_kr: int = 2
    settlement_sessions_us_pre_20240528: int = 2
    settlement_sessions_us_post_20240528: int = 1
    source_parity_mode: bool = False
    strict_positive_volume: bool = True
    long_run_budget: str = "initial sleeve capital remains fixed beyond year one; research assumption"
    max_stale_sessions: int = 0

    def __post_init__(self):
        if self.end_date < self.start_date:
            raise ValueError("Invalid evaluation period")
        if self.cash_movement not in ("MONTHLY","QUARTERLY","DRIFT_5PP","NONE"):
            raise ValueError("Unknown movement policy")
        if not 0 <= dec(self.fx_spread) < 1:
            raise ValueError("Invalid FX cost")
        if self.capacity_mode not in ("FROZEN_BASELINE","UNIFORM_ADV"):
            raise ValueError("Unknown capacity contract")
        if self.capacity_mode=="FROZEN_BASELINE" and self.participation_limit is not None:
            raise ValueError("Uniform participation scenarios require capacity_mode=UNIFORM_ADV")
        if self.participation_limit is not None and not 0<self.participation_limit<=1:
            raise ValueError("Invalid participation rate")


class Replay:
    """A runner with no market data I/O and no connection to production accounts.

    panels[e]: normalized DataFrame, full daily cross-section for each engine.
    calendars[e]: list of session_date/open_at/close_available_at; include future
    settlement sessions and complete warm-up before the evaluation start.
    fx: available_at + krw_per_usd, never an observation-date-only series.
    Current-vintage metadata proxies must be labelled in the run manifest; no PIT certification is conferred.
    """

    def __init__(self, candidate, contract: ExecutionContract, panels: dict,
                 calendars: dict, fx: pd.DataFrame, reference_nav=None,
                 reference_demands=None, reference_capital=None, distributions=None,
                 corporate_actions=None, structural_split=False, tax_hook=None,
                 tax_payment_times=None):
        self.candidate, self.contract = candidate, contract
        self.currency = {"P":"KRW","Q":"KRW","E":"KRW","U":"USD"} if structural_split else dict(CURRENCY)
        self.kr_engines = ("P","Q") if structural_split else ("K",)
        adapter_names = {"P":"KR_MIXED","Q":"KR_MIXED","E":"ETF_V02","U":"US_A0"} if structural_split else ENGINE_ADAPTER
        if structural_split and candidate.policy_id is not None:
            raise ValueError("Split-KR dynamic policies were not preregistered")
        if set(candidate.initial_weights) != set(self.currency)|{"C"}:
            raise ValueError("Candidate engine structure mismatch")
        self.panels, self.calendars = {}, {}
        self.reference_nav = reference_nav
        self.reference_demands = reference_demands
        self.reference_capital = reference_capital
        self.distributions = distributions
        self.tax_hook = tax_hook
        self.tax_results = []
        self.queue, self.sequence = [], 0
        self.session_lookup, self.session_indexes = {}, {}
        self.adapters = {e: FrozenIntentAdapter(adapter_names[e], historical_policy=True) for e in self.currency}
        for adapter in self.adapters.values():adapter.set_research_start(contract.start_date)
        self.latest_rows = {e:{} for e in self.currency}
        self.entry_meta, self.fill_counter = {}, 0
        self.holding_spans = []
        self.target = dict(candidate.initial_weights)
        self.initial_native = {}
        self.snapshots, self.target_reviews, self.demand_events, self.order_diagnostics = [], [], [], []
        self.previous_etf_exposure = ZERO
        self.started = False
        for e in self.currency:
            if e not in panels or e not in calendars:
                raise ValueError(f"Missing engine input: {e}")
            self.panels[e] = normalized_day_panels(panels[e], e, structural_split)
            cal = sorted(calendars[e],key=lambda s:s["session_date"])
            if len({s["session_date"] for s in cal}) != len(cal):
                raise ValueError("Duplicate calendar date")
            self.calendars[e] = cal
            self.session_lookup[e] = {s["session_date"]:s for s in cal}
            self.session_indexes[e] = {s["session_date"]:i for i,s in enumerate(cal)}
            for s in cal:
                if utc(s["open_at"]) >= utc(s["close_available_at"]):
                    raise ValueError("Invalid session times")
                if s["session_date"] in self.panels[e] and s["session_date"] <= contract.end_date:
                    self.push(s["open_at"],20,"OPEN",e,s)
                    self.push(s["close_available_at"],30,"CLOSE",e,s)
        if not {"available_at","krw_per_usd"}.issubset(fx.columns):
            raise ValueError("FX requires a causal availability timestamp")
        for row in fx.to_dict("records"):
            self.push(row["available_at"],10,"FX",None,row)
        for action in corporate_actions or []:
            if utc(action["available_at"])>utc(action["effective_at"]):
                raise ValueError("Corporate action was unavailable at its effective event")
            if action["kind"] not in ("SPLIT","DIVIDEND"):
                raise ValueError("Unsupported corporate action requires an explicit adapter")
            self.push(action["effective_at"],15,"CORPORATE_ACTION",action["engine"],action)
        for at in tax_payment_times or []:
            self.push(at,18,"TAX_REVIEW",None,None)
        # Decisions occur after BOTH relevant month-end market observations,
        # including a last session on a different local holiday calendar.
        months = sorted({s["session_date"][:7] for s in self.calendars[self.kr_engines[0]]
                         if contract.start_date <= s["session_date"] <= contract.end_date})
        for month in months:
            endings = []
            for e in (self.kr_engines[0],"U"):
                rows = [s for s in self.calendars[e] if s["session_date"].startswith(month)]
                if not rows:
                    raise ValueError(f"Missing verified month calendar {e} {month}")
                endings.append(rows[-1])
            if max(s["session_date"] for s in endings) <= contract.end_date:
                self.push(max(utc(s["close_available_at"]) for s in endings),40,"REVIEW",None,month)
        # A common daily UTC cutoff after all observations for each trading date.
        cutoffs = {}
        for e in (self.kr_engines[0],"U"):
            for s in self.calendars[e]:
                if contract.start_date <= s["session_date"] <= contract.end_date:
                    cutoffs[s["session_date"]] = max(cutoffs.get(s["session_date"],utc(s["close_available_at"])),utc(s["close_available_at"]))
        for d,t in cutoffs.items():self.push(t,50,"SNAPSHOT",None,d)
        eval_opens=[utc(s["open_at"]) for e in self.currency for s in self.calendars[e]
                    if contract.start_date <= s["session_date"] <= contract.end_date]
        if not eval_opens:raise ValueError("No evaluation sessions")
        self.start_at=min(eval_opens)
        self.end_at=max(cutoffs.values())
        self.ledger=Ledger(contract.initial_capital_krw,min(x[0] for x in self.queue),candidate.initial_weights)

    def push(self,at,priority,kind,engine,payload):
        self.sequence+=1
        heapq.heappush(self.queue,(utc(at),priority,self.sequence,kind,engine,payload))

    def _holdings(self,e):
        return {symbol:{"quantity":p.quantity,"shares":p.quantity,"sector":p.sector,
                        **self.entry_meta.get((e,symbol),{})}
                for (owner,symbol),p in self.ledger.positions.items() if owner==e}

    def _next_session(self,e,day,lag=1):
        idx=self.session_indexes[e][day]+lag
        if idx>=len(self.calendars[e]):raise ValueError("Calendar does not cover next open/settlement")
        return self.calendars[e][idx]

    def _settlement(self,e,day):
        if self.contract.source_parity_mode:return self.ledger.at
        lag=self.contract.settlement_sessions_kr if e in (*self.kr_engines,"E") else (
            self.contract.settlement_sessions_us_post_20240528 if day>="2024-05-28"
            else self.contract.settlement_sessions_us_pre_20240528)
        return utc(self._next_session(e,day,lag)["open_at"])

    def _start(self):
        if self.started:return
        if self.target.get("U",0)>0:
            amount=self.ledger.available("U","KRW")
            self.ledger.convert("INITIAL_USD","U","KRW","USD",amount,self.contract.fx_spread,
                                self.ledger.fx_at["USD"])
        self.initial_native={e:self.ledger.claims[(e,self.currency[e])] for e in self.currency}
        self.started=True
        self.ledger.record("RESEARCH_START",candidate_id=self.candidate.candidate_id,contract=asdict(self.contract))

    def _capacity(self,e,row,price,used):
        cap=(self.contract.us_current_participation if e=="U" else None) if self.contract.capacity_mode=="FROZEN_BASELINE" else self.contract.participation_limit
        if cap is None:return 10**18
        previous=self.latest_rows[e].get(row["symbol"],{})
        adv=previous.get("adv20_usd" if e=="U" else "average_trading_value20")
        if adv is None or not pd.notna(adv) or adv < 0:return 0
        return max(0,int((dec(adv)*dec(cap)-used.get(row["symbol"],ZERO))/price))

    def _diagnostic(self,e,it,reason,**extra):
        self.order_diagnostics.append({"at":self.ledger.at.isoformat(),"engine":e,
            "signal_id":it["signal_id"],"symbol":it["symbol"],"side":it["side"],"reason":reason,**extra})

    def _reserve_pending_cash(self,e):
        """Reserve a sleeve order batch without changing frozen within-open order priority.

        Per-name close-time cash earmarks would change US next-open share-delta
        ordering. A batch reservation instead protects cash from cross-sleeve
        transfers and is released only while that market's ordered fills run.
        """
        key=f"pending-batch:{e}"
        if key in self.ledger.reservations:self.ledger.release(key,"RECOMPUTE_PENDING_BATCH")
        demand=ZERO
        for it in self.adapters[e].pending_intents():
            if it["side"]!="BUY":continue
            budget=dec(it.get("remaining_budget",it["target_budget"]))
            demand+=budget if it["budget_fee_inclusive"] else budget*dec("1.0015")
        amount=min(max(ZERO,demand),self.ledger.available(e,self.currency[e]))
        if amount>0:self.ledger.reserve(key,e,self.currency[e],amount)

    def _open(self,e,s):
        day=s["session_date"]
        if day<self.contract.start_date:return
        self._start()
        batch_key=f"pending-batch:{e}"
        if batch_key in self.ledger.reservations:self.ledger.release(batch_key,"EXECUTE_MARKET_ORDER_BATCH")
        records=panel_records(self.panels[e],day)
        rows={r["symbol"]:r for r in records}
        sold,used=set(),{}
        for symbol,h in self._holdings(e).items():
            row=rows.get(symbol)
            if row and pd.notna(row.get("comparison_open")) and row["comparison_open"]>0:
                self.ledger.mark(e,symbol,row["comparison_open"],self.ledger.at)
        pending=[it for it in self.adapters[e].pending_intents()
                 if utc(it["earliest_execution_at"])<=self.ledger.at]
        # Lock all current US target quantities before ordering them by share delta.
        for it in pending:
            row=rows.get(it["symbol"])
            if (e=="U" and it["side"]=="BUY" and row and pd.notna(row.get("comparison_open"))\n                    and row["comparison_open"]>0):
                it["delta"]=self.adapters[e].on_execution_open(it["signal_id"],row["comparison_open"],
                    self.ledger.positions.get((e,it["symbol"])).quantity if (e,it["symbol"]) in self.ledger.positions else 0)
        pending.sort(key=lambda it:(0 if it["side"]=="SELL" else 1,
            (it.get("delta",10**18),it["sequence"]) if e=="U" else tuple(it["priority"])))
        for it in pending:
            symbol=it["symbol"];row=rows.get(symbol);p=self.ledger.positions.get((e,symbol))
            if not row or not pd.notna(row.get("comparison_open")) or row["comparison_open"]<=0:
                self._diagnostic(e,it,"MISSING_EXECUTION_OPEN")
                if it["side"]=="BUY" and (it["expiry"]=="NEXT_MARKET_OPEN_ONLY" or (e in self.kr_engines and it.get("market")=="KOSPI")):
                    # An observed legal suspension may wait; a missing row is not a suspension.
                    if not row or not row.get("observed_suspension",False):self.adapters[e].cancel(it["signal_id"])
                continue
            if (self.contract.strict_positive_volume or (e in self.kr_engines and it["side"]=="BUY" and it.get("market")=="KOSPI")) and (not pd.notna(row.get("source_volume")) or row["source_volume"]<=0):
                self._diagnostic(e,it,"NO_EXECUTABLE_VOLUME")
                continue
            price=dec(row["comparison_open"])
            capacity=self._capacity(e,row,price,used)
            if it["side"]=="SELL":
                if p is None:self.adapters[e].cancel(it["signal_id"]);continue
                quantity=min(p.quantity,capacity)
                if quantity<=0:self._diagnostic(e,it,"CAPACITY_ZERO");continue
                self.fill_counter+=1
                self.ledger.sell(f"fill:{self.fill_counter}",e,symbol,quantity,price,self.ledger.at,self._settlement(e,day))
                self.ledger.settle()
                self.adapters[e].on_fill(it["signal_id"],quantity,float(price),p.quantity)
                sold.add(symbol);used[symbol]=used.get(symbol,ZERO)+quantity*price
                if (e,symbol) not in self.ledger.positions:
                    meta=self.entry_meta.pop((e,symbol),{})
                    self.holding_spans.append({"engine":e,"symbol":symbol,"entry_date":meta.get("entry_date",day),"exit_date":day})
                    self.adapters[e].record_holding_span(symbol,meta.get("entry_date",day),day)
                continue
            if self.target.get(e,0)<=0 or self.initial_native.get(e,ZERO)<=0:
                self._diagnostic(e,it,"TARGET_OR_INITIAL_BUDGET_ZERO");self.adapters[e].cancel(it["signal_id"]);continue
            if symbol in sold or (p is not None and e!="U"):
                self._diagnostic(e,it,"ALREADY_HELD_OR_SAME_DAY_SOLD");self.adapters[e].cancel(it["signal_id"]);continue
            holdings=self._holdings(e)
            if p is None and len(holdings)>=it["target_positions"]:
                self._diagnostic(e,it,"SLOT_LIMIT")
                if e!="U":self.adapters[e].cancel(it["signal_id"])
                continue
            if e in self.kr_engines and p is None and sum(h.get("sector")==it.get("sector") for h in holdings.values())>=it["sector_max_positions"]:
                self._diagnostic(e,it,"SECTOR_SLOT_LIMIT");self.adapters[e].cancel(it["signal_id"]);continue
            # Any delayed KOSPI entry must pass the latest completed gate again.
            if e in self.kr_engines and it.get("market")=="KOSPI":
                gate=self.adapters[e].latest_gate
                previous_date=self.calendars[e][self.session_indexes[e][day]-1]["session_date"] if self.session_indexes[e][day]>0 else None
                if (not gate or gate.get("date")!=previous_date or gate.get("evaluatedCount")!=4
                    or gate.get("issues") or gate.get("status") in ("UNKNOWN","RISK_OFF") or gate.get("incomplete")):
                    self._diagnostic(e,it,"PRIOR_COMPLETED_KOSPI_GATE_BLOCK");self.adapters[e].cancel(it["signal_id"]);continue
                if any(h["engine"]==e and h["symbol"]==symbol and h["entry_date"]<=day and h["exit_date"]>=it["origin_date"] for h in self.holding_spans):
                    self._diagnostic(e,it,"HELD_DURING_ORIGIN_EXECUTION_WINDOW");self.adapters[e].cancel(it["signal_id"]);continue
            current=self.adapters[e].pending.get(it["signal_id"],it)
            budget=current.get("remaining_budget",it["target_budget"])
            # Deduplication happens by stable signal ID in the policy module. Only
            # executable non-cash-gated demand enters O1/O2, never raw signal count.
            if capacity>0:
                self.demand_events.append({"engine":e,"demand_id":it["signal_id"],
                    "session_at":self.ledger.at.isoformat(),"available_at":self.ledger.at.isoformat(),
                    "desired_amount":budget,"eligible":True})
            quantity=self.ledger.quantity_for_budget(budget,self.ledger.available(e,self.currency[e]),price,it["budget_fee_inclusive"])
            if e=="U":quantity=min(quantity,it.get("delta",0))
            quantity=min(quantity,capacity)
            if quantity<=0:
                self._diagnostic(e,it,"CASH_BUDGET_OR_CAPACITY_ZERO")
                if e!="U":self.adapters[e].cancel(it["signal_id"])
                continue
            self.fill_counter+=1
            self.ledger.buy(f"fill:{self.fill_counter}",e,symbol,self.currency[e],quantity,price,self.ledger.at,sector=it.get("sector"))
            self.adapters[e].on_fill(it["signal_id"],quantity,float(price),quantity+(p.quantity if p else 0))
            self.entry_meta.setdefault((e,symbol),{"entry_date":day,"valid_bar_count":0,"market":row["market"]})
            used[symbol]=used.get(symbol,ZERO)+quantity*price
            self._diagnostic(e,it,"FILLED",quantity=quantity,price=float(price))
        self._reserve_pending_cash(e)

    def _close(self,e,s):
        day=s["session_date"]
        records=panel_records(self.panels[e],day)
        if any(utc(r["available_at"])>self.ledger.at for r in records):
            raise ValueError("Features unavailable at session decision")
        rows={r["symbol"]:r for r in records}
        if day>=self.contract.start_date:
            for symbol,h in list(self._holdings(e).items()):
                row=rows.get(symbol)
                if row and pd.notna(row.get("comparison_close")) and row["comparison_close"]>0:
                    self.ledger.mark(e,symbol,row["comparison_close"],self.ledger.at)
                    if pd.notna(row.get("comparison_open")) and row["comparison_open"]>0:
                        self.entry_meta[(e,symbol)]["valid_bar_count"]+=1
                    if e in self.kr_engines and self.entry_meta[(e,symbol)]["valid_bar_count"]>=60:
                        if self.contract.strict_positive_volume and (not pd.notna(row.get("source_volume")) or row["source_volume"]<=0):
                            self.ledger.record("H60_UNEXECUTABLE_CLOSE",engine=e,symbol=symbol)
                            # Create a frozen-expiry order for the next executable open;
                            # never manufacture a zero-volume close fill.
                            next_open=utc(self._next_session(e,day)["open_at"]).isoformat()
                            it=self.adapters[e]._intent(row,"SELL",self.ledger.at.isoformat(),next_open,
                                                       "H60_UNEXECUTABLE_CLOSE",day,priority=(0,symbol),expiry="UNTIL_EXECUTABLE_OPEN")
                            self.adapters[e].pending[it["signal_id"]]=it
                            continue
                        p=self.ledger.positions[(e,symbol)];self.fill_counter+=1
                        self.ledger.sell(f"fill:{self.fill_counter}",e,symbol,p.quantity,row["comparison_close"],self.ledger.at,self._settlement(e,day))
                        self.ledger.settle();meta=self.entry_meta.pop((e,symbol),{})
                        self.holding_spans.append({"engine":e,"symbol":symbol,"entry_date":meta.get("entry_date",day),"exit_date":day})
                        self.adapters[e].record_holding_span(symbol,meta.get("entry_date",day),day)
                        for it in self.adapters[e].pending_intents():
                            if it["symbol"]==symbol:self.adapters[e].cancel(it["signal_id"])
                        self.ledger.record("H60_CLOSE",engine=e,symbol=symbol)
                else:
                    raise ValueError(f"Held position has missing close, cannot silently freeze NAV: {e} {symbol} {day}")
            if e=="E" and self.distributions:
                self.distributions.accrue(self.ledger,day,self.previous_etf_exposure,e)
        next_open=utc(self._next_session(e,day)["open_at"]).isoformat()
        initial=self.initial_native.get(e,ZERO)
        if day<self.contract.start_date:
            initial=dec(self.contract.initial_capital_krw)*dec(self.candidate.initial_weights[e])
            if e=="U" and "USD" in self.ledger.fx:initial/=self.ledger.rate("USD")
        emitted=self.adapters[e].on_close(records,self._holdings(e),self.ledger.available(e,self.currency[e]),
            float(initial),float(self.ledger.sleeve_nav(e)),next_open,self.ledger.at.isoformat())
        if day<self.contract.start_date:
            for it in self.adapters[e].pending_intents():self.adapters[e].cancel(it["signal_id"])
        else:self._reserve_pending_cash(e)
        self.latest_rows[e]=rows
        if e=="E":
            self.previous_etf_exposure=sum(p.quantity*self.ledger.prices[key][0] for key,p in self.ledger.positions.items() if p.sleeve=="E")

    def _review(self,month):
        if not self.started:return
        if self.contract.cash_movement=="QUARTERLY" and int(month[-2:])%3:return
        diagnostics={"status":"static"}
        if self.candidate.policy_id:
            if self.reference_nav is None:raise ValueError("Dynamic path requires frozen external reference NAV")
            result=policy_target(self.candidate.policy_id,self.reference_nav,self.ledger.at,self.target,
                self.reference_demands,self.reference_capital,
                {e:[s["open_at"] for s in cal] for e,cal in self.calendars.items()})
            self.target=result.weights;diagnostics=result.diagnostics
        for e in self.currency:
            if self.target.get(e,0)<=0:
                for it in self.adapters[e].pending_intents():
                    if it["side"]=="BUY":self.adapters[e].cancel(it["signal_id"])
                self._reserve_pending_cash(e)
        if self.contract.cash_movement=="NONE":
            self.target_reviews.append({"at":self.ledger.at.isoformat(),"month":month,"policy":diagnostics,
                "movement":{"moved":False,"reason":"NO_INTER_SLEEVE_CASH_MOVEMENT","targets":dict(self.target)}})
            return
        movement=move_idle_cash(self.ledger,self.target,self.currency,self.contract.fx_spread,f"review:{month}",
                               .05 if self.contract.cash_movement=="DRIFT_5PP" else None, engine_order=tuple(self.currency))
        self.target_reviews.append({"at":self.ledger.at.isoformat(),"month":month,"policy":diagnostics,"movement":movement})

    def _corporate_action(self,e,action):
        symbol=action["symbol"];p=self.ledger.positions.get((e,symbol))
        if action["kind"]=="SPLIT":
            if p is not None:
                self.ledger.split(action["action_id"],e,symbol,int(action["numerator"]),int(action["denominator"]))
            # Fixed pending target quantity follows the split; its unspent gross
            # currency budget does not get multiplied and initial capital is fixed.
            ratio=dec(action["numerator"])/dec(action["denominator"])
            for it in self.adapters[e].pending.values():
                if it["symbol"]==symbol and "fixed_target_shares" in it:
                    for key in ("fixed_target_shares","filled_shares"):
                        if key in it:
                            q=dec(it[key])*ratio
                            if q!=int(q):raise ValueError("Fractional pending split entitlement unsupported")
                            it[key]=int(q)
        elif action["kind"]=="DIVIDEND" and p is not None:
            if e=="E" and self.distributions is not None:
                raise ValueError("Actual and hypothetical ETF dividends cannot be stacked")
            self.ledger.income(action["action_id"],e,p.currency,p.quantity*dec(action["amount_per_share"]),
                action["payment_at"],"ACTUAL_DISTRIBUTION",action.get("withholding_rate",0))

    def run(self):
        while self.queue:
            ts,priority,seq,kind,e,payload=heapq.heappop(self.queue)
            if ts>self.end_at:break
            self.ledger.advance(ts);self.ledger.settle()
            if self.tax_hook and self.started and kind in ("OPEN","CLOSE","REVIEW","SNAPSHOT","TAX_REVIEW"):
                result=self.tax_hook(self.ledger)
                self.tax_results.append(result)
                if result.get("status")=="UNSUPPORTED":
                    raise ValueError(f"T2 input gate failed: {result.get('missing_fields',[])}")
            if kind=="FX":self.ledger.observe_fx("USD",payload["krw_per_usd"],ts)
            elif kind=="CORPORATE_ACTION":self._corporate_action(e,payload)
            elif kind=="OPEN":self._open(e,payload)
            elif kind=="CLOSE":self._close(e,payload)
            elif kind=="REVIEW":self._review(payload)
            elif kind=="SNAPSHOT" and self.started:
                row=self.ledger.snapshot();row["session_date"]=payload
                for sleeve in (*self.currency,"C"):
                    row[f"nav_{sleeve}"]=self.ledger.sleeve_nav(sleeve)
                    row[f"target_{sleeve}"]=self.target.get(sleeve,0)
                self.snapshots.append(row)
        self.ledger.assert_invariants()
        return {"candidate_id":self.candidate.candidate_id,"contract":asdict(self.contract),
                "nav":pd.DataFrame(self.snapshots),"events":pd.DataFrame(self.ledger.events),
                "orders":pd.DataFrame(self.order_diagnostics),"reviews":self.target_reviews,
                "tax_results":self.tax_results,
                "demands":pd.DataFrame(self.demand_events,columns=["engine","demand_id","session_at","available_at","desired_amount","eligible"]),"final_snapshot":self.ledger.snapshot(),
                "initial_native_capital":self.initial_native}
