"""Cash audits, paired original-entry exits, exposure controls and chronology."""
import argparse,bisect,gzip,json,pathlib
from collections import defaultdict
from decimal import Decimal as D
import numpy as np,pandas as pd
from metrics import save,table,sha,trade_stats,nav_stats,excursion,cluster_selection_ci
def read(p):return json.loads(pathlib.Path(p).read_text())
def lines(p):return [json.loads(s) for s in pathlib.Path(p).read_text().splitlines() if s]
def trade_row(t,bars,end):
 basis=t['buyAmount']+t['entryFee'];p=t['realizedPnl'] if t['exitDate'] else t['shares']*t['currentPrice']-basis
 r=dict(symbol=t['symbol'],entry_date=t['entryDate'],signal_date=t['signalDate'],entry_price=t['entryPrice'],exit_date=t['exitDate'],exit_price=t['exitPrice'],exit_reason=t['exitReason'],mark=t['currentPrice'],shares=t['shares'],score=t['entryTechnicalPoints'],cost=basis,pnl=p,closed=bool(t['exitDate']),**{'return':p/basis});r.update(excursion([dict(b,date=b['tradeDate']) for b in bars[t['symbol']]],t['entryDate'],t['exitDate'],end,t['entryPrice'],t['exitPrice'] if t['exitDate'] else t['currentPrice']));return r
def fixed_exit(t,bs,calendar,spec,fee,end,timing):
 basecost=t['entryPrice']*(1+fee);baseprice=t['exitPrice'] if t['exitDate'] else t['currentPrice'];ret=baseprice*(1-fee if t['exitDate'] else 1)/basecost-1;row=dict(symbol=t['symbol'],entry_date=t['entryDate'],score=t['entryTechnicalPoints'],base_return=ret,exit_date=t['exitDate'],exit_price=baseprice,exit_reason=t['exitReason'],closed=bool(t['exitDate']),**{'return':ret})
 applicable=spec.get('highScoreMin') is None or t.get('entryTechnicalPoints') is not None and t['entryTechnicalPoints']>=spec['highScoreMin'];sig=[]
 if applicable:
  if spec.get('maxHold'):
   i=bisect.bisect_left(calendar,t['entryDate'])+spec['maxHold']-1
   if i<len(calendar):sig.append((calendar[i],'R4_MAXHOLD'))
  if spec.get('trail') is not None:
   peak=D(str(t['entryPrice']));entry=peak
   for b in bs:
    if b['tradeDate']<t['entryDate']:continue
    if b['tradeDate']>end:break
    if not b.get('close') or b['close']<=0:continue
    c=D(str(b['close']));peak=max(peak,c)
    if peak>=entry*(1+D(str(spec.get('trailActivate',0)))) and c<=peak*(1-D(str(spec['trail']))):sig.append((b['tradeDate'],'R4_TRAIL'));break
 if sig:
  day,reason=min(sig);b=next((b for b in bs if day<b['tradeDate']<=end and b.get('open',0)>0 and b.get('volume',0)>0 and b.get('openObserved',True) and b.get('volumeObserved',True)),None)
  if b and (not t['exitDate'] or b['tradeDate']<t['exitDate'] or b['tradeDate']==t['exitDate'] and timing=='CLOSE'):
   ret=b['open']*(1-fee)/basecost-1;row.update(exit_date=b['tradeDate'],exit_price=b['open'],exit_reason=reason,closed=True,**{'return':ret})
 row.update(pnl=1000000*row['return'],delta_return=row['return']-row['base_return']);row.update(excursion([dict(b,date=b['tradeDate']) for b in bs],t['entryDate'],row['exit_date'],end,t['entryPrice'],row['exit_price']));return row
def paired_ci(rows,key):
 f=pd.DataFrame(rows)
 if not len(f):return None
 if key=='month':f['month']=f.entry_date.str[:7]
 gs=[g for _,g in f.groupby(key)];stats=np.array([[len(g),g.delta_return.sum()] for g in gs]);rng=np.random.default_rng(20261108);s=stats[rng.integers(0,len(gs),size=(1500,len(gs)))].sum(axis=1);v=s[:,1]/s[:,0];return dict(clusters=len(gs),mean=f.delta_return.mean(),lo=np.quantile(v,.025),hi=np.quantile(v,.975),reps=1500,descriptive_reused_sample=True)
def fixed_engine_plan(t,plan,bs,fee,end):
 basis=t['entryPrice']*(1+fee);oldprice=t['exitPrice'] if t['exitDate'] else t['currentPrice'];old=oldprice*(1-fee if t['exitDate'] else 1)/basis-1
 if plan:day=plan['exitDate'];price=plan['exitPrice'];reason=plan['reason'];closed=True
 else:day=None;price=next(b['close'] for b in reversed(bs) if b['tradeDate']<=end and b.get('close',0)>0);reason=None;closed=False
 ret=price*(1-fee if closed else 1)/basis-1;r=dict(symbol=t['symbol'],entry_date=t['entryDate'],score=t['entryTechnicalPoints'],base_return=old,exit_date=day,exit_price=price,exit_reason=reason,closed=closed,pnl=1e6*ret,delta_return=ret-old,**{'return':ret});r.update(excursion([dict(b,date=b['tradeDate']) for b in bs],t['entryDate'],day,end,t['entryPrice'],price));return r
def main():
 p=argparse.ArgumentParser();p.add_argument('--workspace',type=pathlib.Path,required=True);p.add_argument('--accounts',type=pathlib.Path,required=True);p.add_argument('--inputs',type=pathlib.Path,required=True);p.add_argument('--long-inputs',type=pathlib.Path,required=True);p.add_argument('--protocol',type=pathlib.Path,required=True);p.add_argument('--output',type=pathlib.Path,required=True);p.add_argument('--strict-observed-exits',action='store_true');a=p.parse_args();W=a.workspace;A=a.accounts;I=a.inputs;O=a.output;pr=read(a.protocol);states=read(I/'index_states.json');recent=read(I/'recent_account_input.json');meta=read(a.long_inputs/'meta.json');longbars=json.loads(gzip.decompress((a.long_inputs/'KOSDAQ.bars.json.gz').read_bytes()));allrows=[];audits=[];alltrades={};navs={};rawtrades={};timings={};annual=[];parity=[]
 for scope in ['long','recent']:
  bars=longbars if scope=='long' else recent['bars'];calendar=meta['sessions'] if scope=='long' else recent['sessions'];capital=1e8 if scope=='long' else recent['initial_capital'];end='2026-09-11' if scope=='long' else recent['end'];prices={s:{b['tradeDate']:b for b in bs} for s,bs in bars.items()}
  for folder in sorted((A/scope).iterdir()):
   c=read(folder/'COMPLETE.json');spec=c['spec'];name=spec['name'];fee=spec['fee'];label=folder.name;nv=lines(folder/'nav.jsonl');ts=lines(folder/'trades.jsonl');ac=read(folder/'accounting.json');timing=read(folder/'timing.json');rawtrades[(scope,label)]=ts;timings[(scope,label)]=timing;flows=defaultdict(lambda:D(0));entries=defaultdict(list);exits=defaultdict(list);gross_turn=0.;fees=D(0);proxy=0
   for f in c['files']:assert sha(folder/f['name'])==f['sha256']
   for t in ts:
    assert t['entryDate']>t['signalDate'] and isinstance(t['shares'],int) and t['shares']>0
    buy=prices[t['symbol']][t['entryDate']];assert buy['open']==t['entryPrice'] and buy['volume']>0
    fee_entry=D(ac['fees'][t['id']]['entry']);g=D(str(t['entryPrice']))*t['shares'];flows[t['entryDate']]-=g+fee_entry;entries[t['entryDate']].append(t);gross_turn+=float(g);fees+=fee_entry
    if t['exitDate']:
     f=D(ac['fees'][t['id']]['exit']);g=D(str(t['exitPrice']))*t['shares'];flows[t['exitDate']]+=g-f;exits[t['exitDate']].append(t);gross_turn+=float(g);fees+=f;isproxy=t['exitReason'].startswith('모델 가정');proxy+=isproxy
     if not isproxy:
      b=prices[t['symbol']][t['exitDate']];expected=b['open'] if timing[t['id']]=='OPEN' else b['close'];assert expected==t['exitPrice']
      if timing[t['id']]=='OPEN':assert t['exitDate']>t['exitSignalDate'] and b['volume']>0
     if t['exitReason'].startswith('RESEARCH_') and spec.get('highScoreMin') is not None:assert t['entryTechnicalPoints']>=spec['highScoreMin']
   cash=D(str(capital));positions={};marks={};ce=ne=0.;stale=0
   for n in nv:
    d=n['date'];cash+=flows[d]
    for t in entries[d]:positions[t['id']]=t;marks[t['id']]=t['entryPrice']
    for t in exits[d]:positions.pop(t['id'],None);marks.pop(t['id'],None)
    mv=D(0)
    for k,t in positions.items():
     b=prices[t['symbol']].get(d)
     if b and b.get('close',0)>0:marks[k]=b['close']
     else:stale+=1
     mv+=D(str(marks[k]))*t['shares']
    ce=max(ce,abs(float(cash)-float(n['cash'])));ne=max(ne,abs(float(cash+mv)-float(n['nav'])))
   assert ce<.011 and ne<.011 and cash==D(ac['cash']),(scope,label,ce,ne)
   if a.strict_observed_exits:assert proxy==0,'A strict account still contains a synthetic prior-open exit'
   # Check every admitted risk-off entry against held names before its open.
   gate_entries=0
   if spec.get('gateSlots') is not None:
    for i,t in enumerate(ts):
     prev=calendar[bisect.bisect_left(calendar,t['entryDate'])-1];state=states.get(prev,'UNKNOWN');assert state!='UNKNOWN'
     if state=='BELOW':
      gate_entries+=1;active=sum(u['entryDate']<=t['entryDate'] and (not u['exitDate'] or u['exitDate']>t['entryDate'] or u['exitDate']==t['entryDate'] and timing[u['id']]=='CLOSE') for u in ts[:i]);assert active<spec['gateSlots'],(scope,label,active,t['id'])
   rr=[trade_row(t,bars,end) for t in ts];alltrades[(scope,label)]=rr;navs[(scope,label)]=nv;st=trade_stats(rr);st.update(nav_stats(nv,capital));st.update(scope=scope,variant=name,fee_oneway=fee,fees_total=float(fees),turnover_gross_over_initial=gross_turn/capital,turnover_gross_over_avg_nav=gross_turn/np.mean([float(n['nav']) for n in nv]),closed=sum(t['closed'] for t in rr),terminal_open=sum(not t['closed'] for t in rr),high9_entries=sum(t.get('score') is not None and t['score']>=9 for t in rr),proxy_exits=proxy,pending_additional_exits=len(read(folder/'pending-additional-exits.json')),gate_rejections=sum(x['decision'].startswith('R4_GATE') for x in read(folder/'candidates.json')),unknown_gate_rejections=sum(x['decision']=='R4_GATE_UNKNOWN' for x in read(folder/'candidates.json')),new_oos=False);allrows.append(st);assert abs(st['pnl']-(st['ending_nav']-capital))<.011
   audits.append(dict(scope=scope,variant=label,daily_cash_max_error=ce,daily_nav_max_error=ne,stale_marks=stale,proxy_exits=proxy,risk_off_admitted=gate_entries,files_verified=len(c['files'])));table(O/'trades'/scope/(label+'.csv'),rr)
   if scope=='long':
    f=pd.DataFrame(nv);f.nav=f.nav.astype(float);f.cash=f.cash.astype(float);prior=capital
    for y,g in f.groupby(f.date.str[:4],sort=True):
     v=g.nav.to_numpy();seq=np.r_[prior,v];annual.append(dict(variant=name,fee_oneway=fee,year=y,nav_return=v[-1]/prior-1,mdd=np.min(seq/np.maximum.accumulate(seq)-1),avg_exposure=np.mean(1-g.cash/g.nav),terminal_nav=v[-1]));prior=v[-1]
   if name=='baseline':
    cost='30bp' if fee==.0015 else '60bp'
    if scope=='long' and not a.strict_observed_exits:
     ref=W/'runs/p123-r3-long-kr'/('baseline_'+cost)
     for filename in ['nav.jsonl','trades.jsonl','budgets.json','accounting.json','timing.json','summary.json','evidence.json','partial-fills.json']:assert sha(ref/filename)==sha(folder/filename);parity.append(dict(scope=scope,cost=cost,file=filename,byte_equal=True))
    elif scope=='recent':
     ref=W/'runs/p123-r3-accounts-final'/('KR_baseline_'+cost);assert read(ref/'nav.json')==nv and read(ref/'trades.json')==ts and read(ref/'accounting.json')==ac;parity.append(dict(scope=scope,cost=cost,economic_arrays_equal=True))
 table(O/'account_comparison.csv',allrows);table(O/'annual_continuous_account.csv',annual);save(O/'accounting_audit.json',audits);save(O/'r3_baseline_parity.json',parity)
 bridges=[];controls=[];fixed_summary=[];paired_rows=[];cis=[];regimes=[]
 for scope in ['long','recent']:
  bars=longbars if scope=='long' else recent['bars'];calendar=meta['sessions'] if scope=='long' else recent['sessions'];capital=1e8 if scope=='long' else recent['initial_capital'];end='2026-09-11' if scope=='long' else recent['end']
  for fee,cost in [(.0015,'30bp'),(.003,'60bp')]:
   label='baseline_'+cost;base=alltrades[(scope,label)];bm={(r['symbol'],r['entry_date'],r['entry_price']):r for r in base};bn=navs[(scope,label)];bv=np.array([float(n['nav']) for n in bn]);bc=np.array([float(n['cash']) for n in bn]);base_exposure=np.mean(1-bc/bv)
   fixedbase=rawtrades[(scope,label)];timing=timings[(scope,label)]
   for spec in pr['variants']:
    name=spec['name'];label=name+'_'+cost
    if name!='baseline':
     cand=alltrades[(scope,label)];cm={(r['symbol'],r['entry_date'],r['entry_price']):r for r in cand};both=bm.keys()&cm.keys();removed=bm.keys()-cm.keys();new=cm.keys()-bm.keys();z=dict(scope=scope,variant=name,fee_oneway=fee,common=len(both),removed=len(removed),new=len(new),same_entry_effect=sum(cm[k]['pnl']-bm[k]['pnl'] for k in both),avoided_effect=-sum(bm[k]['pnl'] for k in removed),new_entry_effect=sum(cm[k]['pnl'] for k in new),delta=sum(r['pnl'] for r in cand)-sum(r['pnl'] for r in base));assert abs(z['same_entry_effect']+z['avoided_effect']+z['new_entry_effect']-z['delta'])<.011;bridges.append(z)
     target=next(r for r in allrows if r['scope']==scope and r['variant']==name and r['fee_oneway']==fee);tar=target['avg_exposure']
     if tar<=base_exposure+1e-9:
      lo=0.;hi=1.
      for _ in range(60):
       w=(lo+hi)/2;v=capital+w*(bv-capital);cash=capital+w*(bc-capital)
       if np.mean(1-cash/v)<tar:lo=w
       else:hi=w
      w=(lo+hi)/2;v=capital+w*(bv-capital);cash=capital+w*(bc-capital);c=nav_stats([dict(date=n['date'],nav=x,cash=y) for n,x,y in zip(bn,v,cash)],capital);controls.append(dict(scope=scope,variant=name,fee_oneway=fee,feasible=True,**c,candidate_return=target['nav_return'],candidate_cagr=target['cagr'],candidate_mdd=target['mdd'],candidate_minus_control=target['nav_return']-c['nav_return'],posthoc_cash_control=True))
     else:controls.append(dict(scope=scope,variant=name,fee_oneway=fee,feasible=False,reason='Candidate has higher exposure; no cash-only baseline dilution possible',candidate_return=target['nav_return'],candidate_cagr=target['cagr'],candidate_mdd=target['mdd']))
    if spec.get('gateSlots') is not None:continue
    if spec.get('replaceProfitExitOnHighScore'):
     plans={r['id']:r['plan'] for r in read(A/scope/label/'fixed-entry-plans.json')};rr=[fixed_engine_plan(t,plans[t['id']],bars[t['symbol']],fee,end) for t in fixedbase]
    else:rr=[fixed_exit(t,bars[t['symbol']],calendar,spec,fee,end,timing.get(t['id'],'OPEN')) for t in fixedbase]
    for cohort in ['all','high9']:
     sub=rr if cohort=='all' else [r for r in rr if r['score'] is not None and r['score']>=9];z=trade_stats(sub);z.update(scope=scope,variant=name,fee_oneway=fee,cohort=cohort,mean_delta=np.mean([r['delta_return'] for r in sub]) if sub else None);fixed_summary.append(z)
     if fee==.0015 and name in pr['primary']:cis.append(dict(scope=scope,variant=name,cohort=cohort,issuer=paired_ci(sub,'symbol'),entry_month=paired_ci(sub,'month')))
    paired_rows.extend([dict(scope=scope,variant=name,fee_oneway=fee,**r) for r in rr])
   selected=[]
   for t in base:
    d=calendar[bisect.bisect_left(calendar,t['entry_date'])-1];t=dict(t,regime=states[d],selected=states[d]!='BELOW');selected.append(t)
   for reg in ['ABOVE','BELOW']:
    for cohort in ['all','high9']:
     sub=[r for r in selected if r['regime']==reg and (cohort=='all' or r.get('score') is not None and r['score']>=9)];regimes.append(dict(scope=scope,fee_oneway=fee,regime=reg,cohort=cohort,**trade_stats(sub)))
   if fee==.0015:cis.append(dict(scope=scope,variant='gate_stop_original_entries',issuer_selection=cluster_selection_ci(selected),entry_month_selection=cluster_selection_ci([dict(t,month=t['entry_date'][:7]) for t in selected],'month')))
 table(O/'entry_path_bridge.csv',bridges);table(O/'same_exposure_cash_control.csv',controls);table(O/'fixed_original_entry_exit_summary.csv',fixed_summary);table(O/'fixed_original_entry_pairs.csv',paired_rows);table(O/'baseline_regime_cohorts.csv',regimes);save(O/'cluster_intervals.json',cis)
 save(O/'COMPLETE.json',dict(status='PASS',accounts=len(allrows),variants=len(pr['variants']),costs=2,r3_parity=not a.strict_observed_exits,strict_observed_exits=a.strict_observed_exits,independent_oos=False,files={str(p.relative_to(O)):sha(p) for p in O.rglob('*') if p.is_file() and p.name!='COMPLETE.json'}));print(json.dumps(dict(status='PASS',accounts=len(allrows),max_nav_error=max(r['daily_nav_max_error'] for r in audits),parity_files=len(parity))))
if __name__=='__main__':main()
