"""Compare execution definitions and risk measures without selecting parameters."""
import argparse,gzip,json,pathlib
from collections import defaultdict
import numpy as np,pandas as pd
from metrics import save,table,sha
def lines(p):return [json.loads(s) for s in pathlib.Path(p).read_text().splitlines() if s]
def main():
 p=argparse.ArgumentParser();p.add_argument('--legacy',type=pathlib.Path,required=True);p.add_argument('--strict',type=pathlib.Path,required=True);p.add_argument('--legacy-analysis',type=pathlib.Path,required=True);p.add_argument('--strict-analysis',type=pathlib.Path,required=True);p.add_argument('--long-inputs',type=pathlib.Path,required=True);p.add_argument('--recent-input',type=pathlib.Path,required=True);p.add_argument('--output',type=pathlib.Path,required=True);a=p.parse_args();O=a.output;lb=json.loads(gzip.decompress((a.long_inputs/'KOSDAQ.bars.json.gz').read_bytes()));rb=json.loads(a.recent_input.read_text())['bars'];risk=[];definitions=[];zero_marks=[]
 summaries={'legacy':pd.read_csv(a.legacy_analysis/'account_comparison.csv'),'strict':pd.read_csv(a.strict_analysis/'account_comparison.csv')}
 for mode,root in [('legacy',a.legacy),('strict',a.strict)]:
  for scope in ['long','recent']:
   bars=lb if scope=='long' else rb;index={s:{b['tradeDate']:b for b in bs} for s,bs in bars.items()}
   for folder in (root/scope).iterdir():
    marker=json.loads((folder/'COMPLETE.json').read_text());spec=marker['spec'];nv=lines(folder/'nav.jsonl');ts=lines(folder/'trades.jsonl');v=np.r_[1e8 if scope=='long' else 3e7,[float(n['nav']) for n in nv]];ret=v[1:]/v[:-1]-1;sd=ret.std(ddof=1);down=np.sqrt(np.mean(np.minimum(ret,0)**2));m=summaries[mode];r=m[m.scope.eq(scope)&m.variant.eq(spec['name'])&m.fee_oneway.eq(spec['fee'])].iloc[0]
    risk.append(dict(mode=mode,scope=scope,variant=spec['name'],fee_oneway=spec['fee'],sharpe_zero_rf=np.mean(ret)/sd*np.sqrt(252) if sd else None,sortino_zero_rf=np.mean(ret)/down*np.sqrt(252) if down else None,calmar=r.cagr/abs(r.mdd) if scope=='long' and r.mdd else None,definition='daily returns, 252 sessions; zero risk-free descriptive comparison'))
    zero=0;stale=0;terminal=[]
    enters=defaultdict(list);exits=defaultdict(list);active={}
    for t in ts:
     enters[t['entryDate']].append(t)
     if t['exitDate']:exits[t['exitDate']].append(t)
    for n in nv:
     d=n['date']
     for t in enters[d]:active[t['id']]=t
     for t in exits[d]:active.pop(t['id'],None)
     for t in active.values():
      b=index[t['symbol']].get(d)
      if not b:stale+=1
      elif b.get('volume',0)<=0:zero+=1
    for t in ts:
     if not t['exitDate']:
      b=index[t['symbol']].get(nv[-1]['date']);terminal.append(dict(symbol=t['symbol'],last_mark=t['markDate'],current_price=t['currentPrice'],end_bar_present=bool(b),end_volume=b.get('volume') if b else None))
    zero_marks.append(dict(mode=mode,scope=scope,variant=spec['name'],fee_oneway=spec['fee'],held_zero_volume_mark_days=zero,held_missing_bar_days=stale,terminal_positions=terminal))
    if mode=='strict':assert all(not (t.get('exitReason') or '').startswith('모델 가정') for t in ts)
 for scope in ['long','recent']:
  a0=summaries['legacy'];b0=summaries['strict'];z=a0[a0.scope.eq(scope)].merge(b0[b0.scope.eq(scope)],on=['scope','variant','fee_oneway'],suffixes=('_legacy','_strict'))
  for r in z.to_dict('records'):
   definitions.append(dict(scope=scope,variant=r['variant'],fee_oneway=r['fee_oneway'],legacy_cagr=r['cagr_legacy'],strict_cagr=r['cagr_strict'],legacy_mdd=r['mdd_legacy'],strict_mdd=r['mdd_strict'],legacy_return=r['nav_return_legacy'],strict_return=r['nav_return_strict'],legacy_proxy_exits=r['proxy_exits_legacy'],strict_proxy_exits=r['proxy_exits_strict'],strict_minus_legacy_nav=r['ending_nav_strict']-r['ending_nav_legacy']))
   if scope=='recent':assert abs(r['ending_nav_strict']-r['ending_nav_legacy'])<.011
 table(O/'risk_measures.csv',risk);table(O/'execution_definition_sensitivity.csv',definitions);save(O/'illiquidity_and_terminal_marks.json',zero_marks);save(O/'COMPLETE.json',dict(status='PASS',recent_modes_match=True,strict_proxy_exits=0,files={str(p.relative_to(O)):sha(p) for p in O.rglob('*') if p.is_file() and p.name!='COMPLETE.json'}));print('Execution definitions and risk diagnostics PASS')
if __name__=='__main__':main()
