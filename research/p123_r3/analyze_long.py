"""Audit eight frozen-engine accounts and historical fixed-opportunity controls."""
import argparse,json,pathlib,gzip,math
from collections import defaultdict
from decimal import Decimal as D
import pandas as pd
import numpy as np
from metrics import save,table,sha,trade_stats,nav_stats,excursion,cluster_selection_ci
def read(p):return json.loads(pathlib.Path(p).read_text())
def lines(p):return [json.loads(x) for x in pathlib.Path(p).read_text().splitlines() if x.strip()]
def kr_trade(t,bars,end):
    cost=t['buyAmount']+t['entryFee'];pnl=t['realizedPnl'] if t['exitDate'] else t['shares']*t['currentPrice']-cost
    r={'symbol':t['symbol'],'name':t['name'],'signal_date':t['signalDate'],'entry_date':t['entryDate'],'entry_price':t['entryPrice'],'exit_date':t['exitDate'],'exit_reason':t['exitReason'],'pnl':pnl,'return':pnl/cost,'score':t['entryTechnicalPoints'],'sector':t['sectorCode'],'cost':cost,'closed':bool(t['exitDate'])}
    bs=[dict(b,date=b['tradeDate']) for b in bars[t['symbol']]];r.update(excursion(bs,t['entryDate'],t['exitDate'],end,t['entryPrice'],t['exitPrice'] if t['exitDate'] else t['currentPrice']))
    return r
def main():
    ap=argparse.ArgumentParser();ap.add_argument('--evidence',type=pathlib.Path,required=True);ap.add_argument('--accounts',type=pathlib.Path,required=True);ap.add_argument('--output',type=pathlib.Path,required=True);a=ap.parse_args();E=a.evidence.resolve();A=a.accounts.resolve();O=a.output.resolve();O.mkdir(parents=True,exist_ok=True)
    frozen=next((E/'kosdaq-long').iterdir());bars=json.loads(gzip.decompress((frozen/'frozen_research/inputs-cap-restored/KOSDAQ.bars.json.gz').read_bytes()))
    allrows=[];annual=[];trades={};account_audits=[];navs={};br=[];common=[];cis=[];exposure=[]
    for p in sorted(A.iterdir()):
        c=read(p/'COMPLETE.json')
        for f in c['files']:assert sha(p/f['name'])==f['sha256']
        ts=lines(p/'trades.jsonl');nv=lines(p/'nav.jsonl');ac=read(p/'accounting.json');cash=D('100000000');flows=defaultdict(lambda:D(0));entries=defaultdict(list);exits=defaultdict(list)
        fees_total=D(0);notional_turn=0
        for t in ts:
            fees=ac['fees'][t['id']];buy=D(str(t['buyAmount']))+D(fees['entry']);cash-=buy;fees_total+=D(fees['entry']);flows[t['entryDate']]-=buy;entries[t['entryDate']].append(t);notional_turn+=t['buyAmount']
            if t['exitDate']:
                sell=D(str(t['exitPrice']))*t['shares']-D(fees['exit']);cash+=sell;fees_total+=D(fees['exit']);flows[t['exitDate']]+=sell;exits[t['exitDate']].append(t);notional_turn+=t['shares']*t['exitPrice']
        assert cash==D(ac['cash'])
        # Independent daily cash and held quantities; preserve stale marks if any.
        running=D('100000000');positions={};price_index={s:{b['tradeDate']:b['close'] for b in bs} for s,bs in bars.items()};marks={};max_nav_error=0.;max_cash_error=0.;stale=0
        for n in nv:
            day=n['date'];running+=flows[day]
            for t in entries[day]:positions[t['id']]=t;marks[t['id']]=t['entryPrice']
            for t in exits[day]:positions.pop(t['id'],None);marks.pop(t['id'],None)
            mv=D(0)
            for key,t in positions.items():
                v=price_index[t['symbol']].get(day)
                if v is not None and v>0:marks[key]=v
                else:stale+=1
                mv+=D(str(marks[key]))*t['shares']
            max_nav_error=max(max_nav_error,abs(float(running+mv)-float(n['nav'])));max_cash_error=max(max_cash_error,abs(float(running)-float(n['cash'])))
        assert max_cash_error<.011 and max_nav_error<.011,(p.name,max_cash_error,max_nav_error)
        rr=[kr_trade(t,bars,'2026-09-11') for t in ts];trades[p.name]=rr;navs[p.name]=nv
        result=nav_stats(nv,1e8);result.update(trade_stats(rr));result.update(variant=p.name,fee_oneway=c['spec']['fee'],fees_total=float(fees_total),turnover_gross_over_initial=notional_turn/1e8,closed=sum(r['closed'] for r in rr),terminal_open=sum(not r['closed'] for r in rr),universe='LEGACY_FROZEN_325_NOT_PIT',new_oos=False)
        result['turnover_gross_over_avg_nav']=notional_turn/np.mean([float(n['nav']) for n in nv]);allrows.append(result)
        account_audits.append({'variant':p.name,'cash_error':str(cash-D(ac['cash'])),'daily_cash_max_error':max_cash_error,'daily_nav_max_error':max_nav_error,'stale_position_marks':stale,'input_identity':c['identity'],'files_verified':len(c['files'])})
        f=pd.DataFrame(nv);f.date=f.date.astype(str);f.nav=f.nav.astype(float);f.cash=f.cash.astype(float);prior=1e8
        for year,g in f.groupby(f.date.str[:4],sort=True):
            v=g.nav.to_numpy();seq=np.r_[prior,v];annual.append({'variant':p.name,'year':year,'return':v[-1]/prior-1,'mdd':float(np.min(seq/np.maximum.accumulate(seq)-1)),'avg_exposure':float(np.mean(1-g.cash/g.nav)),'terminal_nav':v[-1]});prior=v[-1]
    for fee in ['30bp','60bp']:
        base=trades['baseline_'+fee];bm={(r['symbol'],r['entry_date'],r['entry_price']):r for r in base}
        for name in ['score9','stop10','score9_stop10']:
            label=name+'_'+fee;cm={(r['symbol'],r['entry_date'],r['entry_price']):r for r in trades[label]};both=bm.keys()&cm.keys();removed=bm.keys()-cm.keys();added=cm.keys()-bm.keys()
            z={'variant':label,'matched_entries':len(both),'removed_entries':len(removed),'new_entries':len(added),'same_entry_pnl_change':sum(cm[k]['pnl']-bm[k]['pnl'] for k in both),'removed_pnl_effect':-sum(bm[k]['pnl'] for k in removed),'new_pnl_effect':sum(cm[k]['pnl'] for k in added),'total_pnl_delta':sum(x['pnl'] for x in trades[label])-sum(x['pnl'] for x in base)}
            assert abs(z['same_entry_pnl_change']+z['removed_pnl_effect']+z['new_pnl_effect']-z['total_pnl_delta'])<.01;br.append(z)
            for k in both:common.append({'variant':label,'symbol':k[0],'entry_date':k[1],'score':bm[k]['score'],'base_return':bm[k]['return'],'candidate_return':cm[k]['return'],'delta_return':cm[k]['return']-bm[k]['return'],'both_closed':bm[k]['closed'] and cm[k]['closed']})
        fixed=[dict(t,selected=t['score']<9) for t in base];cis.append({'variant':'score9_'+fee,'issuer':cluster_selection_ci(fixed),'entry_month':cluster_selection_ci([dict(t,month=t['entry_date'][:7]) for t in fixed],'month')})
        for val in [True,False]:
            x=trade_stats([t for t in fixed if t['selected']==val]);x.update(variant='fixed_original_entries_score_below9_'+str(val)+'_'+fee,not_portfolio=True);allrows.append(x)
        # Descriptive constant cash dilution: solve scale for equal mean exposure.
        bnav=pd.DataFrame(navs['baseline_'+fee]);bv=bnav.nav.astype(float).to_numpy();bc=bnav.cash.astype(float).to_numpy()
        for name in ['score9','stop10','score9_stop10']:
            cand=next(r for r in allrows if r['variant']==name+'_'+fee);target=cand['avg_exposure'];lo=0.;hi=1.
            for _ in range(60):
                w=(lo+hi)/2;v=1e8+w*(bv-1e8);cash=1e8+w*(bc-1e8);ex=np.mean(1-cash/v)
                if ex<target:lo=w
                else:hi=w
            w=(lo+hi)/2;v=1e8+w*(bv-1e8);cash=1e8+w*(bc-1e8);ctrl=nav_stats([{'date':r['date'],'nav':n,'cash':c} for r,n,c in zip(navs['baseline_'+fee],v,cash)],1e8);ctrl.update(variant=name+'_'+fee,baseline_capital_scale=w,candidate_return=cand['nav_return'],candidate_mdd=cand['mdd'],return_minus_same_exposure_control=cand['nav_return']-ctrl['nav_return'],descriptive_posthoc_control=True);exposure.append(ctrl)
    table(O/'kr_portfolio_comparison.csv',allrows);table(O/'kr_continuous_account_annual.csv',annual);table(O/'kr_entry_path_bridge.csv',br);table(O/'kr_common_entry_exit_pairs.csv',common);table(O/'kr_matched_exposure_control.csv',exposure);save(O/'kr_selection_bootstrap.json',cis);save(O/'kr_accounting_audit.json',account_audits)
    for name,rr in trades.items():table(O/('kr_trades_'+name+'.csv'),rr)
    # Existing A0 full-account logs: independently reconstruct complete position episodes.
    U=E/'cm05-e/CM05E';events=lines(U/'deliverables/trades_reference.jsonl');held={};episodes=[];proxy=0
    for t in events:
        if t['status'] not in ('EXECUTED','PARTIAL'):continue
        s=t['symbol'];q=float(t['modelShares']);notional=float(t['modelNotional']);fee=float(t['feeUsd'])
        if t['side'] in ('BUY','REBALANCE_BUY'):
            p=held.setdefault(s,{'symbol':s,'sector':t['sector'],'signal_date':t['signalDate'],'entry_date':t['executionDate'],'shares':0.,'cost':0.,'recovered':0.,'proxy':False});p['shares']+=q;p['cost']+=notional+fee
        else:
            if s not in held:raise AssertionError('sell without buy')
            p=held[s];p['shares']-=q;p['recovered']+=notional-fee;p['proxy']|=bool(t.get('proxy'))
            if abs(p['shares'])<1e-9:
                p.update(exit_date=t['executionDate'],pnl=p['recovered']-p['cost']);p['return']=p['pnl']/p['cost'];episodes.append(p);del held[s]
    spy=pd.read_parquet(next((E/'CM_results').rglob('build-38394794357/benchmark_US.parquet'))).sort_values('date');spy['sma20']=spy.close.rolling(20,min_periods=20).mean();spy['momentum20']=spy.close/spy.close.shift(20)-1;sp=spy.set_index('date').to_dict('index')
    control=[]
    for t in episodes:
        d=sp.get(t['signal_date'],{});t['spy_sma20']=d.get('close',0)>d.get('sma20',np.inf);t['spy_momentum20']=d.get('momentum20',-np.inf)>0
        a=sp.get(t['entry_date']);b=sp.get(t['exit_date']);t['benchmark_return']=b['open']/a['open']*(1-.0015)/(1+.0015)-1 if a and b else None
    for condition in ['all','spy_sma20','spy_momentum20']:
        for cost in [.0015,.003]:
            rr=[]
            for t in episodes:
                if condition!='all' and not t[condition]:continue
                # Re-cost a complete episode exactly from observed aggregate gross buys/sales.
                gross_buy=t['cost']/(1+.0015);gross_sell=t['recovered']/(1-.0015);r=gross_sell*(1-cost)/(gross_buy*(1+cost))-1
                rr.append(dict(t,**{'return':r,'pnl':1000*r}))
            z=trade_stats(rr);z.update(condition=condition,fee_oneway=cost,comparison='historical_fixed_original_executed_entries_only',new_oos=False,terminal_open_excluded=len(held),proxy_episodes=sum(t['proxy'] for t in rr));control.append(z)
    table(O/'us_historical_same_entry_filter.csv',control);table(O/'us_historical_episodes.csv',episodes)
    ucis=[]
    for condition in ['spy_sma20','spy_momentum20']:
        ff=[dict(t,selected=t[condition]) for t in episodes];ucis.append({'variant':condition,'issuer':cluster_selection_ci(ff),'entry_month':cluster_selection_ci([dict(t,month=t['entry_date'][:7]) for t in ff],'month')})
    save(O/'us_historical_selection_bootstrap.json',ucis)
    annualus=[]
    for y in sorted({t['entry_date'][:4] for t in episodes}):
        for condition in ['all','spy_sma20','spy_momentum20']:
            rr=[dict(t,pnl=t['return']*1000) for t in episodes if t['entry_date'].startswith(y) and (condition=='all' or t[condition])];annualus.append(dict(year=y,condition=condition,**trade_stats(rr)))
    table(O/'us_same_entry_annual.csv',annualus)
    save(O/'COMPLETE.json',{'status':'PASS','kr_accounts':8,'kr_sessions':2221,'kr_period':['2017-08-21','2026-09-11'],'us_fixed_entry_episodes':len(episodes),'us_open_excluded':len(held),'us_period':['2017-08-21','2026-09-11'],'us_new_reallocated_portfolio_run':False,'legacy_universe_and_sector_pit_not_certified':True,'independent_oos':False,'files':{str(p.relative_to(O)):sha(p) for p in O.rglob('*') if p.is_file() and p.name!='COMPLETE.json'}})
    print(json.dumps({'status':'PASS','kr_accounts':8,'us_completed_episodes':len(episodes),'us_open':len(held),'accounting_audits':account_audits},ensure_ascii=False))
if __name__=='__main__':main()
