"""Live-rational entitlement execution seam, retaining frozen target-delta priority.

This subclass composes AFTER the cash-v2 replay and BEFORE the frozen comparison
replay in the MRO. Only _open is copied; all ordinary no-entitlement opens call
super directly. Changes are the entry guard, explicit canceled-subunit skip,
and Decimal BUY floor after frozen sizing bounds, never its sort key.
"""
from decimal import Decimal, ROUND_DOWN
import pandas as pd
from cm06.accounting import dec, utc, ZERO
from cm06_comparison_execution import Replay as BaseReplay
from cm06_fractional_accounting_v1 import ComparisonEntitlementPosition
from cm06_exact_units_accounting_v1 import ExactComparisonEntitlementPosition, execution_sale_quantity


class ExactEntitlementExecutionReplay(BaseReplay):
    def _open(self,e,s):
        if not any(type(p) in (ComparisonEntitlementPosition, ExactComparisonEntitlementPosition) for (owner,_),p in self.ledger.positions.items() if owner==e):
            return super()._open(e,s)
        day=s["session_date"]
        if day<self.contract.start_date:return
        self._start()
        batch_key=f"pending-batch:{e}"
        if batch_key in self.ledger.reservations:self.ledger.release(batch_key,"EXECUTE_MARKET_ORDER_BATCH")
        rows={r["symbol"]:r for r in self.panels[e][day].to_dict("records")}
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
            if (e=='U' and it['side']=='BUY' and isinstance(it.get('delta'),Decimal)
                    and 0<it['delta']<1 and it['signal_id'] not in self.adapters[e].pending):
                # The adapter canceled an unpurchasable entitlement top-up.
                # Its stale local snapshot must not become executable demand.
                self._diagnostic(e,it,'MANDATORY_ENTITLEMENT_SUBUNIT_BUY_REMAINDER_CANCELLED',
                    remaining_comparison_delta=str(it['delta']),quantity=0)
                continue
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
                quantity=execution_sale_quantity(p,capacity)
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
            # Preserve the exact frozen delta sort key and all budget/capacity
            # bounds above; only the new BUY quantity is whole-unit floored.
            if isinstance(quantity,Decimal):
                if type(p) not in (ComparisonEntitlementPosition, ExactComparisonEntitlementPosition):
                    raise ValueError('Decimal purchase delta lacks mandatory entitlement provenance')
                quantity=int(quantity.to_integral_value(rounding=ROUND_DOWN))
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
