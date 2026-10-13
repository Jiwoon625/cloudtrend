"""Read-only acceptance checks for downloaded, hash-verified CM05 outputs."""
import json,sys
from pathlib import Path
import numpy as np
import pandas as pd
from core import require,fdr

def validate(build,analysis):
    b,a=Path(build),Path(analysis)
    panel=pd.read_parquet(b/'sector_panel.parquet')
    lab=pd.read_parquet(b/'candidate_labels.parquet')
    c=pd.read_parquet(a/'leadlag_results.parquet')
    d=pd.read_parquet(a/'confirmation_results.parquet')
    co=pd.read_parquet(a/'leadlag_observations.parquet')
    do=pd.read_parquet(a/'confirmation_observations.parquet')
    require(not panel.duplicated(['market','sector','date']).any(),'duplicate sector panel')
    require(panel.coverage.dropna().between(0,1).all(),'invalid coverage')
    require((panel.n<=panel.denominator).all(),'invalid prior denominator')
    require(panel.ready.eq((panel.n>=10)&(panel.coverage>=.8)).all(),'readiness contract mismatch')
    require(panel.loc[~panel.ready,'X1'].isna().all(),'unready source filled')
    require((pd.to_datetime(panel.open_at,utc=True)<pd.to_datetime(panel.available_at,utc=True)).all(),'close before open')
    candidates=sum(len(pd.read_parquet(b/f'{m}_candidates.parquet')) for m in ['kr','us'])
    require(len(lab)==3*candidates,'candidate silently excluded')
    require(not lab.duplicated(['date','symbol','market','horizon']).any(),'duplicate outcome')
    require(lab.loc[lab.status.eq('OBSERVED'),'target'].notna().all(),'missing observed outcome')
    require(lab.loc[~lab.status.eq('OBSERVED'),'target'].isna().all(),'unobserved return invented')
    for f in [co,do]:
        ok=f.source_available_at.notna()
        require((pd.to_datetime(f.loc[ok,'source_available_at'],utc=True)<pd.to_datetime(f.loc[ok,'decision_at'],utc=True)).all(),'future source')
        require(f.loc[ok,'source_age_hours'].between(0,72,inclusive='right').all(),'stale source')
    cp=c.loc[c.period.eq('validation')&c.horizon.eq(5)]
    dp=d.loc[d.period.eq('validation')&d.horizon.eq(20)]
    require(len(cp)==56 and len(dp)==6,'missing preregistered family')
    require(np.allclose(cp.q_fdr56,fdr(cp.p_block,56),equal_nan=True),'C FDR mismatch')
    require(np.allclose(dp.q_fdr6,fdr(dp.p_block,6),equal_nan=True),'D FDR mismatch')
    require((dp.selected_n<=dp.common_baseline_n).all(),'selection count invalid')
    require((dp.common_baseline_n<=dp.observed_baseline_n).all(),'baseline count invalid')
    require((dp.all_candidates==dp.observed_baseline_n+dp.endpoint_or_boundary_n).all(),'outcome accounting mismatch')
    require((dp.observed_baseline_n==dp.common_baseline_n+dp.source_missing_n).all(),'coverage accounting mismatch')
    return {'status':'PASS','panel_rows':len(panel),'candidate_signals':candidates,'outcome_rows':len(lab),'C_primary':len(cp),'D_primary':len(dp),'checks':['hashes checked by download helper','unique keys','prior membership denominator','coverage gates','availability strictly before decision','maximum source age','all candidates retained','unobserved outcomes remain missing','56/6 fixed families','FDR recalculation','baseline/selection accounting']}
if __name__=='__main__':print(json.dumps(validate(sys.argv[1],sys.argv[2]),indent=2))
