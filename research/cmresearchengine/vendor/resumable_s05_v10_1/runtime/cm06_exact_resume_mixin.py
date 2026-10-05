"""Event-boundary mixin for a separately pinned comparison/corporate-action replay.

No historical backtests or network calls occur on import. A checkpoint is written
only after a whole event commits in memory, never during a fill/settlement.
"""
from dataclasses import asdict
import heapq, time
import pandas as pd

class ExactResumeMixin:
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        self.exposure_records=[]
        self._resume_events=0;self._resume_finished=False
        self._resume_in_event=False;self._resume_poisoned=False

    def _close(self,e,session):
        super()._close(e,session)
        if session['session_date']<self.contract.start_date:return
        # Same derived exposure fields as the existing v9 S05 profiler; no
        # timer, hard-coded candidate label or wall-clock value enters state.
        values={k:float(p.quantity*self.ledger.prices[k][0]*self.ledger.rate(p.currency)) for k,p in self.ledger.positions.items()}
        snap=self.ledger.snapshot();nav=float(snap['gross_nav_krw']);ordered=sorted(values.values(),reverse=True)
        record={'at':self.ledger.at.isoformat(),'session_date':session['session_date'],'engine_close':e,
                'positions':len(values),'top1_nav_weight':(ordered[0]/nav if ordered else 0),
                'top5_nav_weight':sum(ordered[:5])/nav,'security_hhi_nav':sum((v/nav)**2 for v in ordered),
                'invested_weight':sum(ordered)/nav,'cash_weight':float(snap['cash_krw'])/nav,
                'receivable_weight':float(snap['receivable_krw'])/nav,
                'reserved_krw':sum(float(r.amount*self.ledger.rate(r.currency)) for r in self.ledger.reservations.values())}
        for owner in self.currency:
            record['invested_'+owner]=sum(v for (s,_),v in values.items() if s==owner)/nav
            record['positions_'+owner]=sum(s==owner for s,_ in values)
            record['available_'+owner]=float(self.ledger.available(owner,self.currency[owner]))
        self.exposure_records.append(record)

    def step(self):
        if self._resume_poisoned:raise RuntimeError('Replay failed mid-event; restore a prior checkpoint')
        if self._resume_in_event:raise RuntimeError('Reentrant replay event')
        self._resume_in_event=True
        try:return self._step_unchecked()
        except BaseException:
            self._resume_poisoned=True
            raise
        finally:self._resume_in_event=False

    def _step_unchecked(self):
        if not self.queue or self.queue[0][0]>self.end_at:
            # Match BaseReplay.run, which removes the first beyond-end event.
            if self.queue and not getattr(self,'_resume_finished',False): heapq.heappop(self.queue)
            self._resume_finished=True
            return False
        ts,priority,seq,kind,e,payload=heapq.heappop(self.queue)
        self.ledger.advance(ts);self.ledger.settle()
        if self.tax_hook and self.started and kind in ('OPEN','CLOSE','REVIEW','SNAPSHOT','TAX_REVIEW'):
            result=self.tax_hook(self.ledger);self.tax_results.append(result)
            if result.get('status')=='UNSUPPORTED':
                raise ValueError(f"T2 input gate failed: {result.get('missing_fields',[])}")
        if kind=='FX':self.ledger.observe_fx('USD',payload['krw_per_usd'],ts)
        elif kind=='CORPORATE_ACTION':self._corporate_action(e,payload)
        elif kind=='OPEN':self._open(e,payload)
        elif kind=='CLOSE':self._close(e,payload)
        elif kind=='REVIEW':self._review(payload)
        elif kind=='SNAPSHOT' and self.started:
            row=self.ledger.snapshot();row['session_date']=payload
            for sleeve in (*self.currency,'C'):
                row[f'nav_{sleeve}']=self.ledger.sleeve_nav(sleeve)
                row[f'target_{sleeve}']=self.target.get(sleeve,0)
            self.snapshots.append(row)
        self._resume_events=getattr(self,'_resume_events',0)+1
        self._resume_last_event=(ts,priority,seq,kind,e)
        return True

    def result(self):
        self.ledger.assert_invariants()
        return {'candidate_id':self.candidate.candidate_id,'contract':asdict(self.contract),
                'nav':pd.DataFrame(self.snapshots),'events':pd.DataFrame(self.ledger.events),
                'orders':pd.DataFrame(self.order_diagnostics),'reviews':self.target_reviews,
                'tax_results':self.tax_results,
                'demands':pd.DataFrame(self.demand_events,columns=['engine','demand_id','session_at','available_at','desired_amount','eligible']),
                'final_snapshot':self.ledger.snapshot(),'initial_native_capital':self.initial_native}

    def run(self,checkpoint=None,*,seconds=180,sessions=252,stop_requested=None,clock=time.monotonic):
        if seconds<=0 or sessions<=0:raise ValueError('Checkpoint interval must be positive')
        last_time=clock();last_sessions=len(self.snapshots)
        while self.step():
            now=clock()
            stop=bool(stop_requested and stop_requested())
            if checkpoint and (stop or now-last_time>=seconds or len(self.snapshots)-last_sessions>=sessions):
                checkpoint(self,False)
                last_time=clock();last_sessions=len(self.snapshots)
            if stop:
                if not checkpoint:raise ValueError('Cannot pause without durable checkpoint')
                return None
        if checkpoint:checkpoint(self,True)
        return self.result()


def resumable_type(replay_class):
    """Compose only locally imported, source-pinned classes; no code deserialization."""
    class PinnedResumableReplay(ExactResumeMixin,replay_class):
        pass
    return PinnedResumableReplay
