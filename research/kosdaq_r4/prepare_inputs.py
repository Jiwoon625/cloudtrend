"""Verify original index provenance and use actual KOSDAQ index, never ETF proxy."""
import argparse,json,pathlib,hashlib
import pandas as pd
from metrics import save,table,sha
def main():
 p=argparse.ArgumentParser();p.add_argument('--workspace',type=pathlib.Path,required=True);p.add_argument('--output',type=pathlib.Path,required=True);a=p.parse_args();W=a.workspace.resolve();E=W/'evidence';O=a.output.resolve();O.mkdir(parents=True,exist_ok=True)
 bp=next((E/'CM_results').rglob('build-38394794357/benchmark_KOSDAQ.parquet'));idx=json.loads((E/'archive-index.json').read_text());obj=next(o for o in idx['objects'] if o['name'].endswith('build-38394794357/benchmark_KOSDAQ.parquet'));assert sha(bp)==obj['sha256']
 old=pd.read_parquet(bp);gap=E/'r4/kosdaq-index-september-gap-source.csv';new=E/'kr-outputs/kr-outputs/publish_prepared/publish_20260922_20261106_000.csv';n=pd.read_csv(new,dtype={'symbol':str},low_memory=False);n=n[n.symbol.eq('KOSDAQ')][['date','open','close']];g=pd.read_csv(gap)[['date','open','close']];overlaps=[]
 parts=[]
 for label,f in [('CM05_frozen_benchmark',old),('verified_archived_Sept_source',g),('published_dated_KR_source',n)]:
  f=f.copy();f['source']=label;parts.append(f)
 allf=pd.concat(parts,ignore_index=True)
 for day,f in allf.groupby('date'):
  if len(f)>1:assert f.close.max()-f.close.min()<1e-8;overlaps.append(dict(date=day,n=len(f),close_difference=f.close.max()-f.close.min()))
 f=allf.drop_duplicates('date',keep='first').sort_values('date');f['sma20']=f.close.rolling(20,min_periods=20).mean();f['state']=f.apply(lambda r:'UNKNOWN' if pd.isna(r.sma20) else 'BELOW' if r.close<r.sma20 else 'ABOVE',axis=1)
 recent=json.loads((W/'runs/p123-r3-recent/inputs_extended.json').read_text())['KOSDAQ'];days=sorted({b['date'] for bs in recent['bars'].values() for b in bs});s=f.set_index('date');assert all(d in s.index and s.loc[d,'state']!='UNKNOWN' for d in days)
 ref=json.loads((E/'homepage-publication/publication/results/screening-20261106232701-c8386e79/screening-bundle.json').read_text())['result']['kosdaq'];assert abs(s.loc['2026-11-06','sma20']-ref['ma20'])<1e-7;assert abs(s.loc['2026-11-06','close']-ref['close'])<1e-7
 table(O/'kosdaq_index.csv',f.to_dict('records'));save(O/'index_states.json',{r['date']:r['state'] for r in f.to_dict('records')});save(O/'recent_input.json',recent)
 # Retain dated sector/entry classification and partial journals from R3.
 portfolio=json.loads((W/'runs/p123-r3-account-inputs/kr_account_input.json').read_text());save(O/'recent_account_input.json',portfolio)
 hist=json.loads((E/'R2/inputs/krattr/source/kr-history.json').read_text())+[json.loads((E/'journal-KR-2026-11-05.json').read_text())];timestamps={r['date']:r['savedAt'] for r in hist};timestamps['2026-10-26']=json.loads((E/'R2/inputs/krzip/original-kr-20261026.json').read_text())['run']['createdAt'];save(O/'availability.json',timestamps)
 save(O/'r3_ticket_baseline.json',json.loads((W/'runs/p123-r3-recent/checkpoints/extended_observed_KOSDAQ_baseline_0.0015.json').read_text())['state']['trades']);save(O/'r3_clock_baseline.json',json.loads((W/'runs/p123-r3-diagnostics/KOSDAQ_availability_0.0015.json').read_text())['trades'])
 meta=json.loads((E/'kosdaq-long/CloudTrend_KOSDAQ_Fixed05to20_Analysis_20261023/frozen_research/inputs-cap-restored/meta.json').read_text());assert all(d in s.index and s.loc[d,'state']!='UNKNOWN' for d in meta['sessions'])
 save(O/'PROVENANCE.json',dict(experiment='kosdaq-exits-gates-r4-20261108',index_code='KOSDAQ',ETF_proxy=False,benchmark_object=obj,files=[dict(path=str(x.relative_to(W)),sha256=sha(x)) for x in [bp,gap,new]],gap_receipt=json.loads((E/'r4/gap-source-receipt.json').read_text()),overlap_checks=overlaps,last_index_vs_original_result=dict(close_error=s.loc['2026-11-06','close']-ref['close'],sma20_error=s.loc['2026-11-06','sma20']-ref['ma20']),recent_market_sessions=len(days),recent_unknown_sma20=0,kr_signal_gaps=['2026-09-08','2026-09-14','2026-11-06'],kr_partial='2026-10-26_PRELIMINARY_EXIT_ONLY',long_universe='R3 frozen 325-symbol legacy roster NOT PIT certified',independent_oos=False))
 print('Actual KOSDAQ index verified:',len(f),'rows; latest SMA20',s.loc['2026-11-06','sma20'],'no missing recent regime states')
if __name__=='__main__':main()
