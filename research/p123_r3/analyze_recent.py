"""Reproduce R1/R2 once, then append only separately sourced observed sessions."""
import argparse,copy,hashlib,importlib.util,json,pathlib,sys
from collections import defaultdict
import pandas as pd
import numpy as np
from recent_replay_legacy import replay
from metrics import save,table,trade_stats,nav_stats,excursion,cluster_selection_ci,sha

def read(p):return json.loads(pathlib.Path(p).read_text())
def load_module(path,name):
    s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
def price_features(bs,date):
    a=[b for b in bs if b['date']<=date];d={'ret20':None,'ret5':None,'pullback5':None,'one_day':None}
    if len(a)>=21:d['ret20']=a[-1]['close']/a[-21]['close']-1
    if len(a)>=6:d['ret5']=a[-1]['close']/a[-6]['close']-1
    if len(a)>=5:d['pullback5']=a[-1]['close']/max(b['close'] for b in a[-5:])-1
    if len(a)>=2:d['one_day']=a[-1]['close']/a[-2]['close']-1
    return d
def annotate(state,inp,market,through,bench,history,sector,features=None):
    em={(e['date'],r['symbol']):r for e in inp['events'] for r in e['signals']};bm={b['date']:b for b in bench};out=[];last_exit={}
    for t in state['trades']:
        s=t['symbol'];bs=inp['bars'][s];sig=em.get((t['signal_date'],s),{});a=history.get((t['signal_date'],s),{})
        end=t['exit_date'] or t['mark_date'];p=t['exit_price'] if t['exit_date'] else t['mark'];r=dict(t,return_=t['pnl']/t.get('cost',1000 if market=='US_A0' else 1e6));r['return']=r.pop('return_')
        r.update(excursion(bs,t['entry_date'],t['exit_date'],end,t['entry_price'],p));feat=price_features((features or {}).get(s,bs),t['signal_date']);bf=price_features(bench,t['signal_date']);r.update(feat)
        r['score']=sig.get('score',a.get('technicalPoints'));r['score_delta']=a.get('scoreDelta1d')/10 if isinstance(a.get('scoreDelta1d'),(int,float)) else None
        r['sector']=a.get('sectorCode',a.get('sector'));r['relative_strength20']=feat['ret20']-bf['ret20'] if feat['ret20'] is not None and bf['ret20'] is not None else None
        r['sector_rs20']=None
        sr=sector.get((t['signal_date'],r['sector']))
        if sr and sr.get('ready'):r['sector_rs20']=sr.get('rs20')
        sb=next((b for b in bs if b['date']==t['signal_date']),None);r['gap']=t['entry_price']/sb['close']-1 if sb else None
        prior=last_exit.get(s);r['reentry_sessions']=sum(prior<d<=t['signal_date'] for d in sorted(bm)) if prior else None
        if t['exit_date']:last_exit[s]=t['exit_date']
        if t['entry_date'] in bm and end in bm:
            # Same-window benchmark; mark open positions without an exit fee.
            fee=state.get('research_fee',.0015);ticket=t.get('cost',1000 if market=='US_A0' else 1e6)
            price=bm[end]['open' if t['exit_date'] else 'close'];r['benchmark_pnl']=ticket/(bm[t['entry_date']]['open']*(1+fee))*price*(1-fee if t['exit_date'] else 1)-ticket
            r['residual_pnl']=t['pnl']-r['benchmark_pnl']
        else:r['benchmark_pnl']=r['residual_pnl']=None
        r['mfe_below3_loss']=r['return']<0 and r['mfe']<.03
        out.append(r)
    return out
def main():
    ap=argparse.ArgumentParser();ap.add_argument('--evidence',type=pathlib.Path,required=True);ap.add_argument('--output',type=pathlib.Path,required=True);args=ap.parse_args();E=args.evidence.resolve();O=args.output.resolve();O.mkdir(parents=True,exist_ok=True);R=E/'R2'
    old=load_module(R/'inputs/krzip/replay.py','original_r1');repros=[]
    variants={'baseline':{},'score_below9':{'score_max':9},'runup5_below20':{'runup_max':.20},'gap_below5':{'gap_max':.05},'cooldown3':{'cooldown':3},'combined':{'score_max':9,'runup_max':.2,'gap_max':.05,'cooldown':3},'stop8':{'stop':.08},'stop10':{'stop':.1},'trail10':{'trail':.1},'protect10_8':{'trail':.08,'activate':.1}}
    data={};historical={}
    for market in ['KOSDAQ','KOSPI','ETF','US_A0']:
        folder='uszip' if market=='US_A0' else 'krzip';inp=read(R/'inputs'/folder/(market+'_inputs.json'));data[market]=inp;expected=read(R/'inputs'/folder/'comparison.json')
        for r in expected:
            if r['market']!=market.replace('_',' '):continue
            cfg={'ticket':1000 if market=='US_A0' else 1000000,'fee':r['oneway_cost'],**variants[r['variant']]}
            full=old.replay(inp['events'],inp['bars'],cfg,'2026-11-04');part=old.replay(inp['events'],inp['bars'],cfg,'2026-10-16');assert full==old.replay(inp['events'],inp['bars'],cfg,'2026-11-04',part)
            err=sum(t['pnl'] for t in full['trades'])-r['pnl'];assert len(full['trades'])==r['trades'] and abs(err)<1e-7
            repros.append({'market':market,'variant':r['variant'],'fee':r['oneway_cost'],'pnl_error':err})
    assert len(repros)==75;save(O/'original75_reproduction.json',repros)
    kh=read(R/'inputs/krattr/source/kr-history.json');uh=read(R/'inputs/usattr/source/us-history.json')
    for x in kh:
        for r in x['entries']:historical[(x['date'],r['symbol'])]=r
    for x in uh:
        for r in x['signals']:historical[(x['date'],r['symbol'])]=r
    for f in E.glob('journal-*.json'):
        j=read(f)
        for r in j['entries']:historical[(j['date'],r['symbol'])]=r
    # Preserve all R2 prices; only append newly observed sessions, audit any old revisions.
    revisions=[];krnew=pd.read_csv(E/'kr-outputs/kr-outputs/publish_prepared/publish_20260922_20261106_000.csv',dtype={'symbol':str},low_memory=False)
    usnew=pd.read_csv(E/'bounded-us-inputs-r3-v2/prices_selected.csv',dtype={'symbol':str})
    us5=pd.read_csv(E/'us-20261105.csv',dtype={'symbol':str});usnew=pd.concat([usnew,us5[['date','symbol','open','high','low','close','volume']]],ignore_index=True).drop_duplicates(['date','symbol'],keep='last')
    sectorframe=pd.read_csv(E/'bounded-us-inputs-r3-v2/sector_asof.csv');sector={(r['date'],r['sector']):r for r in sectorframe.to_dict('records')}
    kb0={s:[dict(b,date=b['tradeDate']) for b in bs] for s,bs in read(R/'inputs/krattr/source/kr-bars.json')['bars'].items()}
    up=pd.read_parquet(R/'inputs/usattr/source/us-price.parquet');spy=up[up.symbol.eq('SPY')].sort_values('date').to_dict('records')
    ufeatures=pd.concat([usnew,up,usnew[usnew.date.gt('2026-11-04')]],ignore_index=True).drop_duplicates(['symbol','date'],keep='last').sort_values(['symbol','date'])
    feature_bars={s:g.to_dict('records') for s,g in ufeatures.groupby('symbol')}
    benchmarks={'KOSDAQ':kb0['229200'],'KOSPI':kb0['069500'],'US_A0':spy}
    newdata=copy.deepcopy(data)
    for market,inp in newdata.items():
        f=usnew if market=='US_A0' else krnew
        for s,bs in inp['bars'].items():
            for r in f[f.symbol.eq(s)].sort_values('date').to_dict('records'):
                if r['date']<='2026-11-04':
                    b=next((b for b in bs if b['date']==r['date']),None)
                    if b and any(abs(b[k]-r[k])>1e-7 for k in ['open','close','volume']):revisions.append({'market':market,'symbol':s,'date':r['date'],'action':'preserved_R2_original'})
                else:bs.append({k:r[k] for k in ['date','open','high','low','close','volume']})
            inp['bars'][s]=sorted({b['date']:b for b in bs}.values(),key=lambda b:b['date'])
        if market=='US_A0':
            for d in ['2026-11-05','2026-11-06']:
                j=read(E/('journal-US-'+d+'.json'));sg=[]
                for r in j['entries']:
                    if r['symbol'] not in inp['bars']:continue
                    a=r['evidence'];sg.append({'symbol':r['symbol'],'name':r['name'],'market':'US A0','buy':a['a0Entry'],'sell':'A0 recorded exit' if a['a0Exit'] or a.get('a0BetaExit') else None})
                inp['events'].append({'date':d,'signals':sg,'provenance':'OBSERVED_SIGNAL_JOURNAL'})
        else:
            j=read(E/'journal-KR-2026-11-05.json');sg=[]
            for r in j['entries']:
                if r['symbol'] not in inp['bars']:continue
                sg.append({'symbol':r['symbol'],'name':r['name'],'market':market,'score':r['technicalPoints'],'buy':r.get('kosdaq80Onset') if market=='KOSDAQ' else r.get('kospiEightPointEntry') if market=='KOSPI' else r.get('etfEntrySignal',False),'sell':r.get('exitSignal')})
            inp['events'].append({'date':'2026-11-05','signals':sg,'provenance':'OBSERVED_SIGNAL_JOURNAL'})
            # 11/6 general calculation is PRELIMINARY with 1750 pending rows.
            # Do not insert an empty signal event: price valuation continues, signals unknown.
        if market in benchmarks:
            s='SPY' if market=='US_A0' else '229200' if market=='KOSDAQ' else '069500';oldbs=benchmarks[market];fr=usnew if market=='US_A0' else krnew
            oldbs=oldbs+[r for r in fr[fr.symbol.eq(s)&fr.date.gt('2026-11-04')].to_dict('records')];benchmarks[market]=sorted({b['date']:b for b in oldbs}.values(),key=lambda b:b['date'])
    save(O/'old_price_revision_audit.json',revisions)
    configs={'KOSDAQ':{'baseline':{},'score_below9':{'score_max':9},'stop10':{'stop':.1},'score_below9_stop10':{'score_max':9,'stop':.1},'gap_below2':{'gap_max':.02},'cooldown3':{'cooldown':3}},'US_A0':{'baseline':{},'legacy_spy_momentum20':{'trend_key':'spy_mom20'},'spy_sma20':{'trend_key':'spy_sma20'},'rs20_positive':{'trend_key':'rs20_positive'},'stop10':{'stop':.1}},'KOSPI':{'baseline':{}},'ETF':{'baseline':{}}}
    rows=[];attrs=[];states={};recovery=[];quality=[];bridges=[];pairs=[];navs=[];cis=[]
    for scope,inputs,end in [('R2_reproduction',data,'2026-11-04'),('extended_observed',newdata,'2026-11-06')]:
        for market,inp0 in inputs.items():
            inp=copy.deepcopy(inp0);ticket=1000 if market=='US_A0' else 1e6;bmk=[b for b in benchmarks.get(market,[]) if b['date']<=end]
            bm={b['date']:i for i,b in enumerate(bmk)}
            for e in inp['events']:
                i=bm.get(e['date'],-1)
                for r in e['signals']:
                    r['spy_mom20']=i>=20 and bmk[i]['close']>bmk[i-20]['close']
                    r['spy_sma20']=bool(i>=19 and bmk[i]['close']>np.mean([b['close'] for b in bmk[i-19:i+1]]))
                    feat=price_features(feature_bars.get(r['symbol'],[]) if market=='US_A0' else inp['bars'].get(r['symbol'],[]),e['date']);bf=price_features(bmk,e['date'])
                    r['rs20_positive']=feat['ret20'] is not None and bf['ret20'] is not None and feat['ret20']>bf['ret20']
            for fee in [.0015,.003]:
                for name,opts in configs[market].items():
                    cfg={'ticket':ticket,'fee':fee,**opts};st=replay(inp['events'],inp['bars'],cfg,end);st['research_fee']=fee
                    ann=annotate(st,inp,market,end,bmk,historical,sector,feature_bars if market=='US_A0' else None);label=f'{scope}_{market}_{name}_{fee}'
                    stats=trade_stats(ann);stats.update(scope=scope,market=market,variant=name,fee_oneway=fee,closed=sum(t['exit_date'] is not None for t in ann),realized=sum(t['pnl'] for t in ann if t['exit_date']),unrealized=sum(t['pnl'] for t in ann if not t['exit_date']),benchmark_pnl=sum(t['benchmark_pnl'] for t in ann if t['benchmark_pnl'] is not None));rows.append(stats)
                    save(O/'checkpoints'/(label+'.json'),{'config':cfg,'state':st,'input_events_hash':hashlib.sha256(json.dumps(inp['events'],sort_keys=True).encode()).hexdigest(),'input_bars_hash':hashlib.sha256(json.dumps(inp['bars'],sort_keys=True).encode()).hexdigest()})
                    states[(scope,market,name,fee)]=(st,ann)
                    if fee==.0015:
                        attrs.extend([dict(scope=scope,market_key=market,variant=name,**r) for r in ann])
                        if name=='baseline':quality.append({'scope':scope,'market':market,'through':end,'missing_dates':st['missing_signal_dates'],'partial_dates':st['partial_signal_dates'],'issues':len(st['issues']),'pending':st['pending']})
                    if market in ['KOSDAQ','US_A0']:
                        capital=3e7 if market=='KOSDAQ' else 20000;cap=replay(inp['events'],inp['bars'],dict(cfg,capital=capital,integer=True),end)
                        ns=nav_stats(cap['nav'],capital);ns.update(scope=scope,market=market,variant=name,fee_oneway=fee,model='R2_cash_integer_no_sector_ADV',pnl=cap['nav'][-1]['nav']-capital,n=len(cap['trades']))
                        assert abs(ns['pnl']-sum(t['pnl'] for t in cap['trades']))<1e-5 and min(r['cash'] for r in cap['nav'])>=-1e-7
                        ns['turnover_notional_over_initial']=sum(t['quantity']*t['entry_price']+(t['quantity']*t['exit_price'] if t['exit_date'] else 0) for t in cap['trades'])/capital
                        navs.append(ns)
                        table(O/'nav'/(label+'.csv'),cap['nav'])
            base,ba=states[(scope,market,'baseline',.0015)];bm2={(t['symbol'],t['entry_date']):t for t in ba}
            for name in configs[market]:
                if name=='baseline':continue
                cand,ca=states[(scope,market,name,.0015)];cm={(t['symbol'],t['entry_date']):t for t in ca};common=bm2.keys()&cm.keys();removed=bm2.keys()-cm.keys();added=cm.keys()-bm2.keys()
                bridge={'scope':scope,'market':market,'variant':name,'same_entry_change':sum(cm[k]['pnl']-bm2[k]['pnl'] for k in common),'avoided_entry_effect':-sum(bm2[k]['pnl'] for k in removed),'new_entry_pnl':sum(cm[k]['pnl'] for k in added),'delta':sum(t['pnl'] for t in ca)-sum(t['pnl'] for t in ba)}
                assert abs(sum(bridge[k] for k in ['same_entry_change','avoided_entry_effect','new_entry_pnl'])-bridge['delta'])<1e-6;bridges.append(bridge)
                for k in common:pairs.append({'scope':scope,'market':market,'variant':name,'symbol':k[0],'entry_date':k[1],'base_return':bm2[k]['return'],'candidate_return':cm[k]['return'],'delta':cm[k]['return']-bm2[k]['return']})
                if market=='KOSDAQ' and name=='score_below9':
                    fixed=[dict(t,selected=t['score'] is not None and t['score']<9) for t in ba];cis.append({'scope':scope,'market':market,'variant':name,**cluster_selection_ci(fixed)})
                    for selected in [True,False]:
                        z=trade_stats([t for t in fixed if t['selected']==selected]);z.update(scope=scope,market=market,variant='same_opportunity_score9_'+str(selected),fee_oneway=.0015);rows.append(z)
            if scope=='R2_reproduction':
                loss=[t for t in ba if t['pnl']<0];recovery.append({'market':market,'losses':len(loss),'loss_mfe_below3':sum(t['mfe_below3_loss'] for t in loss)})
    checks={'KOSDAQ_baseline':(-1408552.0383912832,26),'KOSDAQ_score_below9':(-226437.0,19),'KOSDAQ_score_below9_stop10':(45747.0,21),'US_A0_baseline':(-1479.131882972376,18),'US_A0_legacy_spy_momentum20':(-760.01,10),'US_A0_stop10':(-1583.59,18)}
    errors=[]
    for key,(want,n) in checks.items():
        market='US_A0' if key.startswith('US_A0') else 'KOSDAQ';name=key[len(market)+1:];row=next(r for r in rows if r.get('scope')=='R2_reproduction' and r.get('market')==market and r.get('variant')==name and r.get('fee_oneway')==.0015);err=row['pnl']-want
        assert row['n']==n and abs(err)<1, (key,row);errors.append({'case':key,'error_currency':err,'rounding_tolerance':1})
    table(O/'comparison.csv',rows);table(O/'cash_account_comparison.csv',navs);table(O/'trades.csv',attrs);table(O/'fixed_entry_pairs.csv',pairs);table(O/'entry_path_bridge.csv',bridges);save(O/'quality.json',quality);save(O/'reproduction_key_checks.json',errors);save(O/'loss_mfe_reproduction.json',recovery);save(O/'issuer_bootstrap.json',cis);save(O/'inputs_extended.json',newdata);save(O/'benchmark_extended.json',benchmarks)
    groups=[]
    for market in ['KOSDAQ','US_A0']:
        aa=states[('extended_observed',market,'baseline',.0015)][1]
        tests={'score9':lambda t:None if t.get('score') is None else t['score']>=9,'gap2':lambda t:None if t.get('gap') is None else t['gap']>=.02,'rs20_positive':lambda t:None if t.get('relative_strength20') is None else t['relative_strength20']>0,'sector_rs20_positive':lambda t:None if t.get('sector_rs20') is None else t['sector_rs20']>0,'reentry3':lambda t:None if t['reentry_sessions'] is None else t['reentry_sessions']<=3,'runup5_20':lambda t:None if t['ret5'] is None else t['ret5']>=.2,'score_jump2':lambda t:None if t.get('score_delta') is None else t['score_delta']>=2}
        for kind,fn in tests.items():
            if market=='US_A0' and kind in ['score9','score_jump2']:continue
            for val in [True,False,None]:
                ss=[t for t in aa if fn(t) is val];g=trade_stats(ss);g.update(market=market,grouping=kind,group=str(val));groups.append(g)
    table(O/'cause_cohorts.csv',groups);save(O/'COMPLETE.json',{'status':'PASS','original_cases':75,'latest_price_date':'2026-11-06','kr_signal_date':'2026-11-05','kr_1106':'PRELIMINARY incomplete, not zero signals','us_signal_date':'2026-11-06','independent_oos':False,'files':{str(p.relative_to(O)):sha(p) for p in O.rglob('*') if p.is_file() and p.name!='COMPLETE.json'}})
    print(json.dumps({'status':'PASS','original_cases':75,'comparison_rows':len(rows),'accounts':len(navs),'reproduction':errors,'mfe':recovery},ensure_ascii=False))
if __name__=='__main__':main()
