"""Export named review tables from completed, parity-approved replay artifacts."""
from pathlib import Path
import hashlib, json, os, shutil, zipfile
import numpy as np
import pandas as pd
OUT=Path(os.environ['US38_RESULT_DIR'])
assert OUT.parent.name=='US38_robustness_gate_20260928'
assert json.loads((OUT/'simulation_complete.json').read_text())['status']=='REPLAY_AND_DIAGNOSTICS_COMPLETE'
assert json.loads((OUT/'baseline_gate.json').read_text())['passed']
shutil.copy2(__file__,OUT/'export_us38_review.py')
m=pd.read_csv(OUT/'all_metrics.csv');cases=json.loads((OUT/'case_manifest.json').read_text())
for field in ['kind','start','capital','mode','sector']:
    m['case_'+field]=m['case'].map(lambda c:cases[c]['diagnostic'].get(field,''))
for field in ['weight','frequency','beta_cut','beta_days','initial_capital','cost','participation','persist_orders']:
    m[field]=m['case'].map(lambda c:cases[c]['config'][field])
baseline=m[m.phase=='baseline'].copy();baseline.to_csv(OUT/'baseline_metrics.csv',index=False)
core=m[(m.case_kind=='core_surface')|m['case'].isin(['B3_w50','B3_w55'])].copy()
beta=m[(m.case_kind=='beta_surface')|(m['case']=='B3_beta60d3')].copy()
cadence=m[m.case_kind=='fixed_session_surface'].copy()
fresh=m[(m.case_kind=='fresh_cash')|(m.phase=='baseline')].copy()
fresh['cashStartYear']=fresh.case_start.replace('', '2017-01-01').str[:4].astype(int)
stress=m[(m.case_kind=='execution_stress')|(m.phase=='baseline')].copy()
stress.loc[stress.phase=='baseline','case_capital']='USD100K'
stress.loc[stress.phase=='baseline','case_mode']='R1'
tables={'core_weight_surface':core,'beta_exit_surface':beta,'trading_day_rebalance_surface':cadence,'fresh_cash_start_results':fresh,'execution_stress_results':stress,'exclusion_replay_results':m[m.phase=='exclusion_replays']}
for name,df in tables.items():df.to_csv(OUT/f'{name}.csv',index=False)
annual=m[m.period.str.fullmatch(r'\d{4}')].copy()
annual['calendarYearReturn']=annual.totalReturn
annual['spyCalendarYearReturn']=(1+annual.SPY_CAGR)**(annual.days/252)-1
annual['calendarYearExcess']=annual.calendarYearReturn-annual.spyCalendarYearReturn
annual['partialYear']=annual.period=='2026'
annual.to_csv(OUT/'annual_returns.csv',index=False)
assert core['case'].nunique()==4 and beta['case'].nunique()==9 and cadence['case'].nunique()==10
assert fresh['case'].nunique()==63 and stress['case'].nunique()==108
assert len(cases)==245
aud=pd.read_csv(OUT/'execution_audit.csv');assert (aud.capacityViolations==0).all()
pbo=pd.read_csv(OUT/'cscv_pbo.csv');boots=pd.read_csv(OUT/'paired_bootstrap_maxT.csv')
rolling=pd.read_csv(OUT/'rolling_3y_5y.csv')
roll=rolling.groupby(['variant','window']).agg(windows=('CAGR','size'),medianCAGR=('CAGR','median'),worstCAGR=('CAGR','min'),medianMDD=('MDD','median'),fractionBeatingSPY=('excessCAGR',lambda s:float((s>0).mean()))).reset_index()
roll.to_csv(OUT/'rolling_summary.csv',index=False)
cols=['case','variant','CAGR','MDD','Sharpe','annualTurnover','SPY_CAGR','excessCAGR']
review={'runDirectory':str(OUT),'counts':{k:int(v['case'].nunique()) for k,v in tables.items()},'totalReplayCases':len(cases),'baseline':baseline[baseline.period=='full'][cols].to_dict('records'),'surfaces':{name:df[df.period=='full'][cols+['weight','beta_cut','beta_days','frequency']].to_dict('records') for name,df in tables.items() if 'surface' in name},'freshCash':fresh[fresh.period=='full'][cols+['cashStartYear']].to_dict('records'),'stress':stress[stress.period=='full'][cols+['case_capital','case_mode']].to_dict('records'),'exclusion':m[(m.phase=='exclusion_replays')&(m.period=='full')][cols].to_dict('records'),'pbo':pbo.groupby('basis')[['pboMass','legacyBelowMedianMass']].mean().to_dict('index'),'maxTIntervalsExcludingZero':int(((boots.simultaneousLow>0)|(boots.simultaneousHigh<0)).sum()),'capacityViolations':int(aud.capacityViolations.sum()),'PIT':json.loads((OUT/'pit_source_audit.json').read_text())['gate']}
(OUT/'review_results.json').write_text(json.dumps(review,indent=2,ensure_ascii=False))
(OUT/'method_references.json').write_text(json.dumps({'PBO':'https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf','DSR':'https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf','note':'PBO finite-nine diagnostic only; DSR withheld without justified trial count; max-T uses fixed bootstrap SE approximation.'},indent=2))
with zipfile.ZipFile(OUT/'review_bundle.zip','w',zipfile.ZIP_DEFLATED) as z:
    for p in sorted(OUT.iterdir()):
        if p.suffix in ['.csv','.json','.py','.log'] and p.name!='artifact_sha256.json':z.write(p,p.name)
    for p in sorted((OUT/'baseline').glob('*.csv')):z.write(p,'baseline/'+p.name)
def sha(p):
    h=hashlib.sha256()
    with p.open('rb') as f:
        for b in iter(lambda:f.read(8*1024*1024),b''):h.update(b)
    return h.hexdigest()
(OUT/'artifact_sha256.json').write_text(json.dumps({str(p.relative_to(OUT)):sha(p) for p in OUT.rglob('*') if p.is_file() and p.name!='artifact_sha256.json'},indent=2))
print('REVIEW_EXPORT_VERIFIED',json.dumps({'replayCases':len(cases),'surfaces':[4,9,10],'freshCash':63,'executionStress':108,'capacityViolations':int(aud.capacityViolations.sum())}))
