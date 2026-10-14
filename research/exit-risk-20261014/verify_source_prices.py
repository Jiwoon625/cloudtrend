from pathlib import Path
import json,gzip,hashlib
import pyarrow.parquet as pq
import pandas as pd
R=Path(__file__).resolve().parent;m=json.load(open(R/'inputs/research/source-manifest.json'));frames=[]
for x in m['orderedFiles']:
 p=R/'inputs/research/raw'/x['sourcePath'];d=pq.read_table(p,columns=['symbol','date','open','close']).to_pandas();d['symbol']=d.symbol.astype(str).str.strip().str.upper();numeric=d.symbol.str.fullmatch(r'\d+');d.loc[numeric,'symbol']=d.loc[numeric,'symbol'].str.zfill(6)
 if x['sha256']=='238b43699209438ed1d706f182878ef9ba2192bb769d0daedcee68fd475c8ead':
  names=pq.read_table(p,columns=['name']).column(0).to_pylist();mask=pd.Series(names).eq('KODEX 200커버드콜액티브');d.loc[mask,'symbol']='0219E0'
 d['date']=d.date.astype(str);d['open']=pd.to_numeric(d.open);d['close']=pd.to_numeric(d.close);frames.append(d)
raw=pd.concat(frames,ignore_index=True);del frames
duplicates=int(raw.duplicated(['symbol','date']).sum());merged=raw.drop_duplicates(['symbol','date'],keep='last').set_index(['symbol','date']).sort_index();del raw
symbol_set=set(merged.index.get_level_values(0))
checked=0;missing=0;different=0;examples=[]
for market in ['KOSPI','ETF']:
 b=json.loads(gzip.decompress((R/'inputs/derived'/f'{market}.bars.json.gz').read_bytes()))
 for symbol,rows in b.items():
  if symbol not in symbol_set:missing+=len(rows);continue
  exp=merged.xs(symbol);actual=pd.DataFrame(rows).set_index('tradeDate');checked+=len(rows)
  common=actual.index.intersection(exp.index);missing+=len(actual)-len(common)
  left=actual.loc[common,['open','close']].astype(float);right=exp.loc[common,['open','close']].astype(float)
  mask=(left.to_numpy()!=right.to_numpy()).any(axis=1);different+=int(mask.sum())
  if len(examples)<5:
   for date in common[mask][:5-len(examples)]:examples.append({'symbol':symbol,'date':date,'rawOpen':float(exp.loc[date,'open']),'parsedOpen':float(actual.loc[date,'open']),'rawClose':float(exp.loc[date,'close']),'parsedClose':float(actual.loc[date,'close'])})
  print(market,symbol,'checked',len(rows),flush=True)
report={'status':'PASS'if not different and not missing else'FAIL','checkedCanonicalKOSPIETFObservations':checked,'missingRawPairs':missing,'priceDifferences':different,'rawDuplicatePairs':duplicates,'rule':'Original ordered source rows; last nonempty open and close. All input opens/closes present; independent direct Arrow read. Explicit pinned 0219E0 identifier repair retained.','examples':examples}
(R/'results/SOURCE_PRICE_PARITY.json').write_text(json.dumps(report,indent=2));print(report);assert report['status']=='PASS'
