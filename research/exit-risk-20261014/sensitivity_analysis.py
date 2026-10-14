from pathlib import Path
import json,sys
import numpy as np,pandas as pd
from analyze_results import lines,clean
R=Path(__file__).resolve().parent
def run(market):
 result=json.load(open(R/'results'/market/'analysis.json'));base='K0'if market=='KOSPI'else'OFF';b=pd.DataFrame(lines(R/'results'/market/base/'nav.jsonl'));bv=b.nav.astype(float).to_numpy();br=bv/np.r_[1e8,bv[:-1]]-1;bd=bv/np.maximum.accumulate(np.r_[1e8,bv])[1:]-1
 report={};rng=np.random.default_rng(20261014);block=20;repeats=2000;mapping=json.load(open(R/'official-history/src/lib/engine/etfResearchMapping.json'));meta=json.load(open(R/'inputs/derived/meta.json'));names={x['symbol']:x['name']for x in meta['instruments']}
 for ident in result['all']:
  p=R/'results'/market/ident;n=pd.DataFrame(lines(p/'nav.jsonl'));v=n.nav.astype(float).to_numpy();ret=v/np.r_[1e8,v[:-1]]-1;diff=ret-br;sample=[]
  for j in range(repeats):
   starts=rng.integers(0,len(diff)-block+1,int(np.ceil(len(diff)/block)));indices=(starts[:,None]+np.arange(block)).ravel()[:len(diff)];sample.append(diff[indices].mean()*252)
  tr=json.load(open(p/'lifecycle.json'));closed=[t for t in tr if t.get('exit')];contributions={};subtypes={}
  for t in closed:
   s=t['symbol'];contributions[s]=contributions.get(s,0)+t['pnl']
   if market=='ETF':
    info=mapping.get(s,{});covered=info.get('assetClass')=='option_overlay'or '커버드콜'in names.get(s,'');region=info.get('region','UNKNOWN');label=('covered_call'if covered else'general_equity')+'|'+('domestic_KR'if region=='KR'else'foreign_'+region)
    a=subtypes.setdefault(label,{'closedTrades':0,'pnlWon':0,'returnSum':0,'wins':0});a['closedTrades']+=1;a['pnlWon']+=t['pnl'];a['returnSum']+=t['returnNet'];a['wins']+=t['pnl']>0
  for a in subtypes.values():a['meanTradeReturn']=a['returnSum']/a['closedTrades'];a['winRate']=a['wins']/a['closedTrades']
  expo=1-n.cash.astype(float).to_numpy()/v
  losses={label:{'sessions':int(mask.sum()),'meanExposure':float(expo[mask].mean())if mask.any()else None}for label,mask in [('baseline_drawdown_below_10pct',bd<=-.10),('baseline_drawdown_0_to_10pct',(bd<0)&(bd>-.10)),('baseline_at_high',bd>=0)]}
  sortedp=sorted(contributions.items(),key=lambda x:x[1],reverse=True);positive=sum(max(0,a)for a in contributions.values());top5=sum(max(0,a)for _,a in sortedp[:5]);cases=sum(contributions.get(s,0)for s in ['010950','490590'])
  report[ident]={'blockBootstrapAnnualArithmeticExcessCI95':list(np.quantile(sample,[.025,.975])),'bootstrapPositiveFraction':float(np.mean(np.array(sample)>0)),'blockSessions':block,'repetitions':repeats,'top5PositivePnlShare':top5/positive if positive else None,'topContributors':sortedp[:10],'caseSymbolsRealizedPnl':cases,'realizedPnlExcludingCaseSymbols':sum(contributions.values())-cases,'subtypesTradeAttributionOnly':subtypes,'exposureInBaselineLossIntervals':losses,'note':'Retrospective dependent data; bootstrap and reused validation are not untouched OOS. Subtypes and symbol removals are PnL attribution, not separately resimulated accounts.'}
 (R/'results'/market/'sensitivity.json').write_text(json.dumps(clean(report),ensure_ascii=False,indent=2));print('Sensitivity complete',market,len(report))
if __name__=='__main__':run(sys.argv[1])
