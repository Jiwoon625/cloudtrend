"""Independent cash/NAV audits of the official engine subwindow experiments."""
import argparse,json,pathlib
from collections import defaultdict
from decimal import Decimal as D
import numpy as np,pandas as pd
from metrics import save,table,sha,nav_stats,trade_stats,excursion
from analyze_long import kr_trade
def read(p):return json.loads(pathlib.Path(p).read_text())
def us_episodes(events,prices,end,fee):
 held={};done=[];flows=defaultdict(lambda:D(0));fill_by_day=defaultdict(list);turn=0.;fees=0.
 for t in events:
  if t['status'] not in ('EXECUTED','PARTIAL'):continue
  q=D(str(t['modelShares']));px=D(str(t['modelPrice']));gross=q*px;f=gross*D(str(fee));day=t['executionDate'];s=t['symbol'];buy=t['side'] in ('BUY','REBALANCE_BUY')
  assert abs(float(gross)-t['modelNotional'])<1e-7 and abs(float(f)-t['feeUsd'])<1e-7
  assert day>t['signalDate'],'same-day execution from close signal'
  flows[day]+=(-gross-f if buy else gross-f);fill_by_day[day].append((s,q,px,buy));turn+=float(gross);fees+=float(f)
  if buy:
   p=held.setdefault(s,dict(symbol=s,entry_date=day,signal_date=t['signalDate'],sector=t['sector'],quantity=D(0),cost=D(0),gross_buy=D(0),recovered=D(0)))
   p['quantity']+=q;p['cost']+=gross+f;p['gross_buy']+=gross
  else:
   p=held[s];p['quantity']-=q;p['recovered']+=gross-f
   if p['quantity']==0:
    p.update(exit_date=day,exit_price=float(px),pnl=float(p['recovered']-p['cost']),closed=True);done.append(p);del held[s]
 for s,p in held.items():
  mark=prices[s][end]['close'];p.update(exit_date=None,exit_price=mark,pnl=float(p['recovered']+p['quantity']*D(str(mark))-p['cost']),closed=False);done.append(p)
 result=[]
 for p in done:
  z={k:(float(v) if isinstance(v,D) else v) for k,v in p.items()};z['return']=z['pnl']/z['cost']
  # These recent cases have no rebalance or partial entry; use the actual first fill.
  buy=next(t for t in events if t['symbol']==p['symbol'] and t['executionDate']==p['entry_date'] and t['side']=='BUY' and t['status'] in ('EXECUTED','PARTIAL'))
  z['entry_price']=buy['modelPrice'];z.update(excursion(list(prices[p['symbol']].values()),p['entry_date'],p['exit_date'],end,z['entry_price'],z['exit_price']));result.append(z)
 return result,flows,fill_by_day,turn,fees
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--inputs',type=pathlib.Path,required=True);ap.add_argument('--accounts',type=pathlib.Path,required=True);ap.add_argument('--output',type=pathlib.Path,required=True);a=ap.parse_args();O=a.output;rows=[];audits=[];trades={};bridges=[];controls=[];navs={}
 for folder in sorted(a.accounts.iterdir()):
  marker=read(folder/'COMPLETE.json');market=marker['market'];name=marker['name'];fee=marker['fee'];ip=a.inputs/(market.lower()+'_account_input.json');assert sha(ip)==marker['inputHash']
  for f in marker['files']:assert sha(folder/f['name'])==f['sha256']
  inp=read(ip);nv=read(folder/'nav.json');ts=read(folder/'trades.json');capital=inp['initial_capital'];flows=defaultdict(lambda:D(0));entries=defaultdict(list);exits=defaultdict(list);turn=0.;fees=0.;stale=0;positions={};marks={};running=D(str(capital));ce=ne=0.
  if market=='KR':
   ac=read(folder/'accounting.json');price={s:{b['tradeDate']:b['close'] for b in bs} for s,bs in inp['bars'].items()}
   for t in ts:
    fs=ac['fees'][t['id']];f=D(fs['entry']);gross=D(str(t['entryPrice']))*t['shares'];flows[t['entryDate']]-=gross+f;entries[t['entryDate']].append(t);turn+=float(gross);fees+=float(f)
    assert t['entryDate']>t['signalDate']
    if t['exitDate']:
     g=D(str(t['exitPrice']))*t['shares'];f=D(fs['exit']);flows[t['exitDate']]+=g-f;exits[t['exitDate']].append(t);turn+=float(g);fees+=float(f);assert t['exitDate']>t['exitSignalDate']
   for n in nv:
    day=n['date'];running+=flows[day]
    for t in entries[day]:positions[t['id']]=t;marks[t['id']]=t['entryPrice']
    for t in exits[day]:positions.pop(t['id'],None);marks.pop(t['id'],None)
    mv=D(0)
    for k,t in positions.items():
     mark=price[t['symbol']].get(day)
     if mark is not None and mark>0:marks[k]=mark
     else:stale+=1
     mv+=D(str(marks[k]))*t['shares']
    ce=max(ce,abs(float(running)-float(n['cash'])));ne=max(ne,abs(float(running+mv)-float(n['nav'])))
   rr=[kr_trade(t,inp['bars'],inp['end']) for t in ts]
  else:
   prices={}
   for session in inp['sessions']:
    for r in session['rows']:prices.setdefault(r['symbol'],{})[session['date']]=r
   rr,flows,byday,turn,fees=us_episodes(ts,prices,inp['end'],fee)
   for n in nv:
    day=n['date'];running+=flows[day]
    for s,q,px,buy in byday[day]:positions[s]=positions.get(s,D(0))+(q if buy else -q);marks[s]=px
    mv=D(0)
    for s,q in positions.items():
     if q==0:continue
     r=prices.get(s,{}).get(day)
     if r and r['close']>0:marks[s]=D(str(r['close']))
     else:stale+=1
     mv+=q*marks[s]
    ce=max(ce,abs(float(running)-float(n['cash'])));ne=max(ne,abs(float(running+mv)-float(n['nav'])))
   state=read(folder/'state.json');assert running==D(state['modelCashExact']);assert abs(fees-float(state['modelFeesExact']))<1e-7
  assert ce<.011 and ne<.011,(folder,ce,ne)
  assert abs(sum(t['pnl'] for t in rr)-(float(nv[-1]['nav'])-capital))<.011
  z=dict(**nav_stats(nv,capital),**trade_stats(rr),market=market,variant=name,fee_oneway=fee,turnover_gross_over_initial=turn/capital,turnover_gross_over_avg_nav=turn/np.mean([float(n['nav']) for n in nv]),fees_total=fees,closed=sum(t['closed'] for t in rr),terminal_open=sum(not t['closed'] for t in rr),same_window_flat_start=True,new_oos=False);rows.append(z);trades[folder.name]=rr;navs[folder.name]=nv
  audits.append(dict(account=folder.name,daily_cash_error=ce,daily_nav_error=ne,stale_marks=stale,files_verified=len(marker['files']),input_hash=marker['inputHash'],signal_gaps=inp.get('missing_signal_dates',[]),partial_signal_dates=inp.get('partial_signal_dates',{})))
  table(O/(folder.name+'_episodes.csv'),rr)
 for market in ['KR','US']:
  for cost in ['30bp','60bp']:
   key=market+'_baseline_'+cost;bm={(t['symbol'],t['entry_date']):t for t in trades[key]};bn=navs[key];cap=read(a.inputs/(market.lower()+'_account_input.json'))['initial_capital'];bv=np.array([float(n['nav']) for n in bn]);bc=np.array([float(n['cash']) for n in bn])
   for label,rr in trades.items():
    if not label.startswith(market+'_') or not label.endswith('_'+cost) or label==key:continue
    cm={(t['symbol'],t['entry_date']):t for t in rr};common=bm.keys()&cm.keys();remove=bm.keys()-cm.keys();add=cm.keys()-bm.keys();d=sum(t['pnl'] for t in rr)-sum(t['pnl'] for t in bm.values());x=dict(account=label,common=len(common),removed=len(remove),new=len(add),same_entry_effect=sum(cm[k]['pnl']-bm[k]['pnl'] for k in common),avoided_effect=-sum(bm[k]['pnl'] for k in remove),replacement_effect=sum(cm[k]['pnl'] for k in add),delta=d);assert abs(x['same_entry_effect']+x['avoided_effect']+x['replacement_effect']-d)<.011;bridges.append(x)
    candidate=next(r for r in rows if r['market']==market and r['variant']==label[len(market)+1:-5] and r['fee_oneway']==(.0015 if cost=='30bp' else .003));target=candidate['avg_exposure'];lo=0.;hi=1.
    for _ in range(60):
     w=(lo+hi)/2;v=cap+w*(bv-cap);cash=cap+w*(bc-cap)
     if np.mean(1-cash/v)<target:lo=w
     else:hi=w
    w=(lo+hi)/2;v=cap+w*(bv-cap);cash=cap+w*(bc-cap);ctrl=nav_stats([dict(date=n['date'],nav=vv,cash=cc) for n,vv,cc in zip(bn,v,cash)],cap);controls.append(dict(account=label,**ctrl,candidate_return=candidate['nav_return'],candidate_mdd=candidate['mdd'],descriptive_posthoc_control=True))
 table(O/'official_account_comparison.csv',rows);table(O/'entry_path_bridge.csv',bridges);table(O/'matched_exposure_control.csv',controls);save(O/'accounting_audit.json',audits);save(O/'COMPLETE.json',dict(status='PASS',accounts=len(rows),independent_oos=False,files={str(p.relative_to(O)):sha(p) for p in O.rglob('*') if p.is_file() and p.name!='COMPLETE.json'}));print(json.dumps({'status':'PASS','accounts':len(rows),'max_nav_error':max(r['daily_nav_error'] for r in audits)}))
if __name__=='__main__':main()
