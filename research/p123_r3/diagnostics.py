"""Timestamp, dated cost and source-accounting diagnostics; no rule fitting."""
import argparse,json,pathlib,datetime,copy
from zoneinfo import ZoneInfo
from collections import defaultdict
from decimal import Decimal as D
import numpy as np,pandas as pd
from metrics import save,table,trade_stats,sha
from recent_replay_legacy import replay
def read(p):return json.loads(pathlib.Path(p).read_text())
def ts(x):return pd.Timestamp(x).to_pydatetime()
def opening(day,market):return datetime.datetime.fromisoformat(day+'T'+('09:00' if market=='KOSDAQ' else '09:30')).replace(tzinfo=ZoneInfo('Asia/Seoul' if market=='KOSDAQ' else 'America/New_York')).astimezone(datetime.timezone.utc)
def closing(day,market):return datetime.datetime.fromisoformat(day+'T'+('15:30' if market=='KOSDAQ' else '16:00')).replace(tzinfo=ZoneInfo('Asia/Seoul' if market=='KOSDAQ' else 'America/New_York')).astimezone(datetime.timezone.utc)
def available_replay(events,bars,availability,market,fee,end,score_max=None,stop=None):
 """Sensitivity to current evidence timestamps, NOT the actual investor account.
 Source closes are never usable before that exchange's close. Before each
 observed open, ingest all already released records in release order. A stale
 buy superseded by a recorded exit before any fill is cancelled explicitly.
 """
 dates=sorted({b['date'] for bs in bars.values() for b in bs if b['date']<=end});by={s:{b['date']:b for b in bs} for s,bs in bars.items()};queue=sorted([(max(ts(availability[e['date']]),closing(e['date'],market)),e) for e in events if e['date'] in availability],key=lambda x:(x[0],x[1]['date']));i=0;held={};pending={};done=[];audit=[];ticket=1000 if market=='US_A0' else 1e6
 for day in dates:
  op=opening(day,market)
  while i<len(queue) and queue[i][0]<op:
   released,e=queue[i]
   for s in e['signals']:
    sym=s['symbol']
    if s.get('sell'):
     if sym in held:pending[sym]=dict(side='SELL',signal_date=e['date'],released=released.isoformat())
     elif pending.get(sym,{}).get('side')=='BUY':del pending[sym];audit.append(dict(day=day,symbol=sym,action='CANCEL_STALE_BUY_BEFORE_FILL'))
    # An exit crossing on an entry Onset is a held-position exit, not a
    # prohibition on a flat book's entry. Preserve the original precedence.
    if s.get('buy') and sym not in held and sym not in pending and (score_max is None or s.get('score') is not None and s['score']<score_max):pending[sym]=dict(side='BUY',signal_date=e['date'],released=released.isoformat())
   i+=1
  for sym,order in sorted(list(pending.items()),key=lambda x:x[1]['side']!='SELL'):
   b=by[sym].get(day)
   if not b or not b.get('open') or b['open']<=0 or b.get('volume',0)<=0:continue
   if order['side']=='BUY':held[sym]=dict(symbol=sym,signal_date=order['signal_date'],entry_date=day,entry_price=b['open'],quantity=ticket/(b['open']*(1+fee)),cost=ticket,mark=b['open'],exit_date=None,exit_price=None)
   else:
    z=held.pop(sym);z.update(exit_date=day,exit_price=b['open'],pnl=z['quantity']*b['open']*(1-fee)-ticket);done.append(z)
   audit.append(dict(day=day,symbol=sym,action=order['side'],signal_date=order['signal_date'],released=order['released']));del pending[sym]
  for sym,z in held.items():
   b=by[sym].get(day)
   if b and b.get('close',0)>0:
    z['mark']=b['close']
    if stop is not None and z['mark']<=z['entry_price']*(1-stop) and sym not in pending:pending[sym]=dict(side='SELL',signal_date=day,released=closing(day,market).isoformat())
 for z in held.values():z['pnl']=z['quantity']*z['mark']-ticket;done.append(z)
 for z in done:z['return']=z['pnl']/ticket
 return done,audit,pending
def main():
 p=argparse.ArgumentParser();p.add_argument('--evidence',type=pathlib.Path,required=True);p.add_argument('--recent',type=pathlib.Path,required=True);p.add_argument('--long-analysis',type=pathlib.Path,default=pathlib.Path('runs/p123-r3-long-analysis'));p.add_argument('--account-inputs',type=pathlib.Path,default=pathlib.Path('runs/p123-r3-account-inputs'));p.add_argument('--official-accounts',type=pathlib.Path,default=pathlib.Path('runs/p123-r3-accounts-final'));p.add_argument('--output',type=pathlib.Path,required=True);a=p.parse_args();E=a.evidence;R=a.recent;O=a.output;inp=read(R/'inputs_extended.json');times={};timing=[];timing_results=[]
 kh=read(E/'R2/inputs/krattr/source/kr-history.json')+[read(E/'journal-KR-2026-11-05.json')];times['KOSDAQ']={x['date']:x['savedAt'] for x in kh};orig=read(E/'R2/inputs/krzip/original-kr-20261026.json');times['KOSDAQ']['2026-10-26']=orig['run']['createdAt'];times['US_A0']={x['date']:pd.Timestamp(x['created_at']).isoformat() for x in read(E/'us-dated-signal-ranks.json')}
 for market in ['KOSDAQ','US_A0']:
  dates=sorted({b['date'] for bs in inp[market]['bars'].values() for b in bs});events=[e for e in inp[market]['events'] if e['date'] in times[market]]
  for e in inp[market]['events']:
   day=e['date'];nxt=next((d for d in dates if d>day),None);saved=times[market].get(day);late=bool(nxt and saved and ts(saved)>=opening(nxt,market));earliest=next((d for d in dates if d>day and saved and opening(d,market)>max(ts(saved),closing(day,market))),None)
   timing.append(dict(market=market,signal_date=day,stored_at=saved,next_model_open=nxt,available_after_model_open=late if saved else None,first_evidenced_open=earliest,coverage=e.get('coverage','STORED_JOURNAL'),interpretation='current retained save timestamp; earlier publication not exhaustively ruled out'))
  for fee in [.0015,.003]:
   logical=replay(events,inp[market]['bars'],dict(ticket=1000 if market=='US_A0' else 1000000,fee=fee),'2026-11-06');rr=[dict(t,**{'return':t['pnl']/t['cost']}) for t in logical['trades']];actual,audit,pending=available_replay(events,inp[market]['bars'],times[market],market,fee,'2026-11-06')
   for label,rows in [('logical_next_open_same_known_timing_events',rr),('retained_save_timestamp_available_open',actual)]:timing_results.append(dict(market=market,fee_oneway=fee,model=label,**trade_stats(rows),not_actual_account=True,not_oos=True,unknown_timing_events_excluded=[e['date'] for e in inp[market]['events'] if e['date'] not in times[market]]))
   save(O/(market+'_availability_'+str(fee)+'.json'),dict(trades=actual,audit=audit,pending=pending,availability=times[market],limitations='not a reconstruction of original website publication; current savedAt may be later replacement; source original run only restores preliminary KR exits'))
 table(O/'signal_availability_audit.csv',timing);table(O/'signal_availability_sensitivity.csv',timing_results)
 clock_candidates=[]
 for fee in [.0015,.003]:
  for name,opts in [('baseline',{}),('score9',{'score_max':9}),('stop10',{'stop':.1}),('score9_stop10',{'score_max':9,'stop':.1})]:
   rr,aa,pp=available_replay(inp['KOSDAQ']['events'],inp['KOSDAQ']['bars'],times['KOSDAQ'],'KOSDAQ',fee,'2026-11-06',**opts);clock_candidates.append(dict(market='KOSDAQ',variant=name,fee_oneway=fee,**trade_stats(rr),not_actual_account=True,not_oos=True));save(O/('clock_KOSDAQ_'+name+'_'+str(fee)+'.json'),dict(trades=rr,audit=aa,pending=pp))
 table(O/'clock_candidate_sensitivity.csv',clock_candidates)
 # Dated operating US cost sensitivity leaves the entry path unchanged.
 tr=pd.read_csv(R/'trades.csv');z=tr[(tr.scope=='extended_observed')&(tr.market_key=='US_A0')&(tr.variant=='baseline')];costrows=[]
 for t in z.to_dict('records'):
  f=.0025 if t['entry_date']<'2026-10-08' else .0015;exit_fee=(.0025 if str(t['exit_date'])<'2026-10-08' else .0015) if isinstance(t['exit_date'],str) else 0;p=t['exit_price'] if isinstance(t['exit_date'],str) else t['mark'];v=1000/(t['entry_price']*(1+f))*p*(1-exit_fee)-1000;costrows.append(dict(symbol=t['symbol'],entry_date=t['entry_date'],oneway_entry=f,oneway_exit=exit_fee,uniform15_pnl=t['pnl'],dated_cost_pnl=v,delta=v-t['pnl']))
 table(O/'us_dated_operating_cost_sensitivity.csv',costrows)
 # Explicit exploratory pullback/bounce hypothesis, kept outside frozen candidates.
 groups=[]
 for market in ['KOSDAQ','US_A0']:
  sub=tr[(tr.scope=='extended_observed')&(tr.market_key==market)&(tr.variant=='baseline')].copy();sub['exploratory_pullback_bounce']=(sub.pullback5<=-.05)&(sub.one_day>0)
  for val,g in sub.groupby('exploratory_pullback_bounce'):groups.append(dict(market=market,group=bool(val),definition='close at least 5% below last 5 close high AND latest close return positive',exploratory_after_primary_results=True,**trade_stats(g.to_dict('records'))))
 table(O/'exploratory_pullback_bounce.csv',groups)
 # US existing full-account source: recompute cash from actual fills and marks
 # from independently aggregated stored holdings. This checks accounting, not
 # an independent certification of the underlying historical mark prices.
 U=E/'cm05-e/CM05E/deliverables';events=[json.loads(l) for l in (U/'trades_reference.jsonl').read_text().splitlines()];flows=defaultdict(lambda:D(0));fee_sum=D(0);fills=0
 for t in events:
  if t['status'] not in ('EXECUTED','PARTIAL'):continue
  g=D(str(t['modelNotional']));f=D(str(t['feeUsd']));fee_sum+=f;flows[t['executionDate']]+=(-g-f if t['side'] in ('BUY','REBALANCE_BUY') else g-f);fills+=1
 nav=pd.read_csv(U/'daily_nav_reference.csv');held=pd.read_csv(U/'holdings_reference.csv');held['mv']=held.shares*held.lastPrice;mv=held.groupby('date').mv.sum().to_dict();cash=D('100000');ce=ne=0.
 for n in nav.to_dict('records'):
  cash+=flows[n['date']];ce=max(ce,abs(float(cash)-n['cash']));ne=max(ne,abs(float(cash)+mv.get(n['date'],0)-n['nav']))
 assert ce<1e-6 and ne<1e-6,(ce,ne)
 save(O/'us_historical_existing_account_audit.json',dict(status='PASS',sessions=len(nav),filled_events=fills,daily_cash_max_error=ce,daily_nav_from_stored_holdings_max_error=ne,fees_total=str(fee_sum),final_nav=nav.iloc[-1]['nav'],source_code_policy='CM05E fixed20 overlay, not latest dated operating allocation',price_pit_certified=False,not_new_full_candidate_backtest=True))
 # Proxy liquidation sensitivity of the historical fixed-opportunity comparison.
 ep=pd.read_csv(a.long_analysis/'us_historical_episodes.csv');out=[]
 for exclude in [False,True]:
  e=ep[~ep.proxy] if exclude else ep
  for cond in ['all','spy_sma20','spy_momentum20']:
   g=e if cond=='all' else e[e[cond]];r=g.to_dict('records');r=[dict(t,pnl=1000*t['return']) for t in r];out.append(dict(exclude_proxy=exclude,condition=cond,**trade_stats(r),terminal_open_excluded=20))
 table(O/'us_historical_proxy_sensitivity.csv',out)
 # Hold date range, entry/exit events, quantities, capital and price source fixed.
 # Any remaining difference is engine/allocation, not a different market sample.
 engine_bridge=[]
 for market,tag in [('KOSDAQ','KR'),('US_A0','US')]:
  ai=read(a.account_inputs/(tag.lower()+'_account_input.json'));start=ai['start'];events=[e for e in inp[market]['events'] if e['date']>=start];oldbars={s:[b for b in bs if b['date']>=start] for s,bs in inp[market]['bars'].items()}
  if tag=='US':
   sourcebars={}
   for session in ai['sessions']:
    for r in session['rows']:sourcebars.setdefault(r['symbol'],[]).append({k:r[k] for k in ['date','open','high','low','close','volume']})
  else:sourcebars={s:[dict(b,date=b['tradeDate']) for b in bs if b['tradeDate']>=start] for s,bs in ai['bars'].items()}
  cfg=dict(ticket=1000 if tag=='US' else 1000000,capital=ai['initial_capital'],integer=True,fee=.0015);old=replay(events,oldbars,cfg,ai['end']);same=replay(events,sourcebars,cfg,ai['end'])
  # Official US fixed20 targets a GROSS notional slot; the original R2 ticket
  # includes entry fees. Align that contract before calling a difference a bug.
  aligned=replay(events,sourcebars,dict(cfg,ticket=cfg['ticket']*(1+cfg['fee'])) if tag=='US' else cfg,ai['end']);official=read(a.official_accounts/(tag+'_baseline_30bp/nav.json'))[-1];same_nav=same['nav'][-1]['nav'];aligned_nav=aligned['nav'][-1]['nav'];off_nav=float(official['nav']);err=aligned_nav-off_nav;assert abs(err)<.011,(market,err)
  engine_bridge.append(dict(market=market,start=start,end=ai['end'],legacy_original_price_nav=old['nav'][-1]['nav'],legacy_same_price_nav=same_nav,legacy_same_price_and_gross_budget_nav=aligned_nav,official_nav=off_nav,price_source_effect=same_nav-old['nav'][-1]['nav'],gross_budget_contract_effect=aligned_nav-same_nav,remaining_same_input_engine_error=err,capital=ai['initial_capital'],not_actual_account=True));save(O/(tag+'_common_input_engine_bridge.json'),dict(legacy_original=old,legacy_same_source=same,legacy_same_gross_budget=aligned,official_last_nav=official))
 table(O/'common_input_engine_bridge.csv',engine_bridge)
 save(O/'COMPLETE.json',dict(status='PASS',independent_oos=False,timing_delays=sum(t['available_after_model_open'] is True for t in timing),files={str(p.relative_to(O)):sha(p) for p in O.rglob('*') if p.is_file() and p.name!='COMPLETE.json'}));print(json.dumps({'status':'PASS','timing_late_by_market':{m:sum(t['available_after_model_open'] is True for t in timing if t['market']==m) for m in times},'dated_cost_delta':sum(r['delta'] for r in costrows),'us_long_cash_error':ce,'us_long_nav_error':ne}))
if __name__=='__main__':main()
