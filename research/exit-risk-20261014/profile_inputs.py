from pathlib import Path
import json,hashlib
import pyarrow.parquet as pq
import pandas as pd
root=Path(__file__).resolve().parent
m=json.loads((root/'inputs/research/source-manifest.json').read_text());out=[]
for x in m['orderedFiles']:
 p=root/'inputs/research/raw'/x['sourcePath'];h=hashlib.sha256(p.read_bytes()).hexdigest();assert h==x['sha256']
 fields=['symbol','date','market','securityType','open','high','low','close','volume','etfUnderlyingIndexClose','krxTradingValue']
 t=pq.read_table(p,columns=fields).to_pandas();dt=t.date.astype(str);sym=t.symbol.astype(str)
 out.append(dict(path=x['sourcePath'],driveFileId=x['driveFileId'],sourceGroup=x['sourceGroup'],bytes=p.stat().st_size,sha256=h,rows=len(t),symbols=sym.nunique(),firstDate=dt.min(),lastDate=dt.max(),withinFileDuplicatePairs=int(t.duplicated(['symbol','date']).sum()),missingRates={c:float((t[c].isna()|t[c].astype(str).eq('')).mean())for c in fields},nonpositiveOpen=int((pd.to_numeric(t.open,errors='coerce')<=0).sum()),zeroVolume=int(pd.to_numeric(t.volume,errors='coerce').eq(0).sum())))
 print('Profiled',x['sourcePath'],len(t),flush=True)
(root/'results').mkdir(exist_ok=True);(root/'results/input-coverage.json').write_text(json.dumps(out,ensure_ascii=False,indent=2))
print('Coverage files',len(out),'raw rows',sum(x['rows']for x in out))
