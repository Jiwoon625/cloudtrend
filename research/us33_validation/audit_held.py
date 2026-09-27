from pathlib import Path
import os
import duckdb,pandas as pd,json,zipfile
OUT=Path(os.environ.get('US33_DATA_ROOT','/content/drive/MyDrive/미국주식데이터'))/'US33_validation_20260927'
RUNTIME=Path(os.environ.get('US33_RUNTIME_ROOT','/content'))
c=duckdb.connect(str(RUNTIME/'us33_validation.duckdb'))
missing=c.sql('SELECT DISTINCT p.ticker FROM prices p ANTI JOIN security s ON p.ticker=s.ticker').df()
missing.to_csv(OUT/'price_missing_metadata.csv',index=False)
meta=c.sql('SELECT ticker,category,isdelisted,name FROM security').df()
units=c.sql("SELECT DISTINCT ticker FROM actions WHERE action='spacunitseparation'").df().ticker.tolist()
sectors=pd.read_csv(OUT/'sector_map_extended.csv',keep_default_na=False)
rows=[]
for p in OUT.glob('trades_full_consistent_ledger_*.csv'):
 config=p.stem.replace('trades_full_consistent_ledger_','')
 if 'ZERO' in config or 'COST2' in config:continue
 t=pd.read_csv(p,keep_default_na=False)
 t=t.merge(meta,left_on='symbol',right_on='ticker',how='left').merge(sectors[['ticker','mapMethod','sectorCode']],on='ticker',how='left')
 t['has_spac_unit_separation_action']=t.symbol.isin(units);t['config']=config
 rows.append(t)
held=pd.concat(rows,ignore_index=True)
held.to_csv(OUT/'held_security_audit.csv',index=False)
held.groupby(['config','mapMethod']).agg(trades=('symbol','size'),uniqueSymbols=('symbol','nunique')).reset_index().to_csv(OUT/'held_sector_sources.csv',index=False)
held[held.has_spac_unit_separation_action].to_csv(OUT/'held_spac_action_review.csv',index=False)
terminal=pd.read_csv(OUT/'terminal_event_assumptions.csv',keep_default_na=False)
terminal[terminal.symbol.isin(held.symbol)].to_csv(OUT/'held_terminal_assumptions.csv',index=False)
# Auxiliary feature export retains preliminary SIC mapping; label it explicitly.
(OUT/'feature_export_notice.json').write_text(json.dumps({'file':'canonical_feature_inputs.parquet','sectorField':'preliminary SIC; NOT the primary validation classification','primaryClassification':'sector_map_extended.csv','primaryResults':'consistent_validation_summary.csv'},indent=2))
with zipfile.ZipFile(OUT/'validation_results.zip','w',zipfile.ZIP_DEFLATED) as z:
 for p in OUT.iterdir():
  if p.suffix in ['.csv','.json','.py'] and p.stat().st_size<100_000_000:z.write(p,p.name)
print('AUDIT_HELD',len(held),held.symbol.nunique(),'SPAC_ACTION',int(held.has_spac_unit_separation_action.sum()),flush=True)
c.close()
