"""R3 ticket baseline plus new exit/gate candidates and a separate save-time clock."""
import argparse,copy,json,pathlib,sys
import numpy as np
from metrics import save,table,sha,trade_stats,excursion
from replay import replay

def annotate(st,bars,end):
 result=[]
 for t in st['trades']:
  r=dict(t,**{'return':t['pnl']/t['cost']});price=t['exit_price'] if t['exit_date'] else t['mark'];r.update(excursion(bars[t['symbol']],t['entry_date'],t['exit_date'],end,t['entry_price'],price));result.append(r)
 return result
def available(events,bars,cfg,through,timestamps):
 # Same retained-save-time sensitivity as R3: only already published records
 # may create an order before an open; actual first website publication unknown.
 import datetime
 from zoneinfo import ZoneInfo
 import pandas as pd
 clock=lambda d,hh:datetime.datetime.fromisoformat(d+'T'+hh).replace(tzinfo=ZoneInfo('Asia/Seoul')).astimezone(datetime.timezone.utc)
 queue=sorted([(max(pd.Timestamp(timestamps[e['date']]).to_pydatetime(),clock(e['date'],'15:30')),e) for e in events if e['date'] in timestamps],key=lambda x:(x[0],x[1]['date']))
 days=sorted({b['date'] for bs in bars.values() for b in bs if b['date']<=through});by={s:{b['date']:b for b in bs} for s,bs in bars.items()};i=0;held={};pending={};trades=[];rejected=[];fee=cfg['fee'];ticket=cfg['ticket']
 for day in days:
  while i<len(queue) and queue[i][0]<clock(day,'09:00'):
   released,e=queue[i]
   for s in e['signals']:
    sym=s['symbol']
    if s.get('sell'):
     if sym in held:
      suppress=cfg.get('replaceProfitExitOnHighScore') and held[sym].get('entry_score') is not None and held[sym]['entry_score']>=9 and s['sell']=='UP90'
      if not suppress:pending[sym]=dict(side='SELL',signal_date=e['date'],reason='RECORDED_EXIT')
     elif pending.get(sym,{}).get('side')=='BUY':del pending[sym];rejected.append(dict(day=day,symbol=sym,reason='STALE_BUY_REPLACED_BY_EXIT'))
    if s.get('buy') and sym not in held and sym not in pending:pending[sym]=dict(s,side='BUY',signal_date=e['date'])
   i+=1
  for sym,o in sorted(list(pending.items()),key=lambda x:x[1]['side']!='SELL'):
   b=by[sym].get(day)
   if not b or b.get('open',0)<=0 or b.get('volume',0)<=0:continue
   if o['side']=='BUY':
    prior=next((d for d in reversed(days) if d<day),None);state=cfg.get('gate_states',{}).get(prior,'UNKNOWN')
    if cfg.get('gateSlots') is not None and (state=='UNKNOWN' or state=='BELOW' and len(held)>=cfg['gateSlots']):rejected.append(dict(day=day,symbol=sym,reason='GATE_'+state));del pending[sym];continue
    t=dict(symbol=sym,name=o.get('name',sym),entry_score=o.get('score'),signal_date=o['signal_date'],entry_date=day,entry_price=b['open'],quantity=ticket/(b['open']*(1+fee)),cost=ticket,mark=b['open'],mark_date=day,peak=b['open'],exit_date=None,exit_price=None,exit_signal_date=None,exit_reason=None);held[sym]=t;trades.append(t)
   else:
    t=held.pop(sym);t.update(exit_date=day,exit_price=b['open'],exit_signal_date=o['signal_date'],exit_reason=o['reason'])
   del pending[sym]
  for sym,t in held.items():
   b=by[sym].get(day);eligible=cfg.get('highScoreMin') is None or t.get('entry_score') is not None and t['entry_score']>=cfg['highScoreMin'];reason=None
   if b and b.get('close',0)>0:
    t.update(mark=b['close'],mark_date=day,peak=max(t['peak'],b['close']))
    if eligible and cfg.get('trail') is not None and t['peak']>=t['entry_price']*(1+cfg.get('trailActivate',0)) and t['mark']<=t['peak']*(1-cfg['trail']):reason='R4_TRAIL'
   if eligible and cfg.get('maxHold') is not None and sum(t['entry_date']<=d<=day for d in days)>=cfg['maxHold']:reason=reason or 'R4_MAXHOLD'
   if reason and sym not in pending:pending[sym]=dict(side='SELL',signal_date=day,reason=reason)
 for t in trades:t['pnl']=t['quantity']*(t['exit_price']*(1-fee) if t['exit_date'] else t['mark'])-t['cost']
 return dict(trades=trades,pending=pending,rejected=rejected,positions={s:1 for s in held})
def main():
 p=argparse.ArgumentParser();p.add_argument('--workspace',type=pathlib.Path,required=True);p.add_argument('--inputs',type=pathlib.Path,required=True);p.add_argument('--protocol',type=pathlib.Path,required=True);p.add_argument('--output',type=pathlib.Path,required=True);a=p.parse_args();W=a.workspace;I=a.inputs;O=a.output;data=json.loads((I/'recent_input.json').read_text());states=json.loads((I/'index_states.json').read_text());pr=json.loads(a.protocol.read_text());bars=data['bars'];events=data['events'];timestamps=json.loads((I/'availability.json').read_text());allrows=[];attrs=[];results={}
 for fee in pr['costs_oneway']:
  for spec in pr['variants']:
   cfg=dict(ticket=1e6,fee=fee,**{k:v for k,v in spec.items() if k!='name'});cfg.update(gate_states=states)
   for clock in ['logical','retained_save_time']:
    st=replay(events,bars,cfg,'2026-11-06') if clock=='logical' else available(events,bars,cfg,'2026-11-06',timestamps);rr=annotate(st,bars,'2026-11-06');z=trade_stats(rr);z.update(variant=spec['name'],fee_oneway=fee,clock=clock,closed=sum(bool(t['exit_date']) for t in rr),open=sum(not t['exit_date'] for t in rr),high9=sum(t.get('entry_score') is not None and t['entry_score']>=9 for t in rr));allrows.append(z);results[(spec['name'],fee,clock)]=rr
    attrs.extend([dict(variant=spec['name'],fee_oneway=fee,clock=clock,**r) for r in rr]);save(O/'checkpoints'/(spec['name']+'_'+str(fee)+'_'+clock+'.json'),dict(config=cfg,state=st,input_hashes={f:sha(I/f) for f in ['recent_input.json','index_states.json']}))
 # The new baseline must retain the exact R3 trade outcomes, not merely a rounded total.
 r3=json.loads((I/'r3_ticket_baseline.json').read_text());r4=results[('baseline',.0015,'logical')];assert len(r3)==len(r4)==26
 for x,y in zip(r3,r4):assert all(x[k]==y[k] for k in ['symbol','entry_date','exit_date','quantity','pnl'])
 timing_ref=json.loads((I/'r3_clock_baseline.json').read_text());assert abs(sum(r['pnl'] for r in timing_ref)-sum(r['pnl'] for r in results[('baseline',.0015,'retained_save_time')]))<1e-6
 table(O/'ticket_comparison.csv',allrows);table(O/'ticket_trades.csv',attrs);save(O/'COMPLETE.json',dict(status='PASS',models=len(allrows),r3_baseline_exact=True,r3_clock_baseline_match=True,independent_oos=False,files={str(p.relative_to(O)):sha(p) for p in O.rglob('*') if p.is_file() and p.name!='COMPLETE.json'}));print(json.dumps({'status':'PASS','models':len(allrows),'baseline':trade_stats(r4)}))
if __name__=='__main__':main()
