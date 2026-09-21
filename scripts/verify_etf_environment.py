#!/usr/bin/env python3
"""Verify leave-family-out independence, prefix causality and final policy math."""
import argparse,json,tempfile
from pathlib import Path
import pandas as pd,numpy as np
from research_etf_m0_environment import family,environment
from etf_m0_policy import priority_score,health_score,score_and_signals
from research_etf_m0_clean import save_json

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--base',required=True);ap.add_argument('--environment-results',required=True);ap.add_argument('--mapping',required=True);ap.add_argument('--output',required=True);a=ap.parse_args();out=Path(a.output);out.mkdir(parents=True,exist_ok=True)
    m=pd.read_csv(a.mapping,dtype={'symbol':str});m['family']=m.underlyingIndexName.map(family)
    d=pd.read_parquet(Path(a.base)/'clean-input-panel.parquet').merge(m[['symbol','family']],on='symbol');d=d[d.region=='US'].sort_values(['symbol','date']).reset_index(drop=True)
    cols=['peerTrend','peerContinuous','peerBreadth','peerMix']
    with tempfile.TemporaryDirectory() as tmp:
        root=Path(tmp);full=environment(d.copy(),root);prefix=environment(d[d.date<='2024-12-31'].copy(),root)
        f=full[full.date<='2024-12-31'].set_index(['symbol','date']).sort_index();p=prefix.set_index(['symbol','date']).sort_index()
        assert f.index.equals(p.index);assert np.allclose(f[cols],p[cols],equal_nan=True,rtol=1e-12,atol=1e-12)
        changed=d.copy();target=changed.family.eq('SP500');t=pd.factorize(changed.loc[target,'date'],sort=True)[0];changed.loc[target,'etfUnderlyingIndexClose']*=np.exp(.001*t)
        altered=environment(changed,root)
        target=full.family.eq('SP500');assert target.any()
        assert np.allclose(full.loc[target,cols],altered.loc[target,cols],equal_nan=True,rtol=1e-12,atol=1e-12)
        assert np.nanmax(np.abs(full.loc[~target,'peerContinuous']-altered.loc[~target,'peerContinuous']))>0
    size=pd.Series([100e9,400e9,400e9,400e9]);ret=pd.Series([0.,0.,.04,.04]);bm=pd.Series([0.,0.,.01,.01]);regions=pd.Series(['KR','KR','KR','US'])
    assert priority_score(size,ret,bm,regions).tolist()==[0.,50.,100.,50.]
    hp=health_score(pd.Series([100e9]),pd.Series([1e9]));assert hp.iloc[0]==100
    panel=pd.DataFrame({'symbol':['X']*4,'date':['2026-09-09','2026-09-10','2026-09-11','2026-09-14'],'technicalContinuous':[70,100,100,100],'priorityTwo':[50]*4,'healthCapLiquidityPlain':[100]*4,'marketSectorMapped':[100]*4,'eligible':[True]*4,'etfUnderlyingIndexClose':[100,110,0,110],'uMa60':[100]*4})
    rr=score_and_signals(panel);assert len(rr)==3 and rr.entrySignal.tolist()==[False,True,False] and not rr.exitSignal.any() and rr.dataErrorExitSignal.tolist()==[False,False,True]
    q=pd.read_csv(Path(a.environment_results)/'portfolio-summary.csv');selected=json.loads((Path(a.environment_results)/'decision.json').read_text())
    assert selected['priorityDenominator']==2 and selected['rotationPoints']==0 and selected['indexMembershipPoints']==0
    save_json(out/'verification.json',dict(prefixCausality=True,ownAndDuplicateFamilyExcluded=True,peerPerturbationActuallyChangesOtherFamilies=True,priorityTwoSlotValuesVerified=True,healthNoExcludedInputs=True,invalidIndexNotNormalExit=True,cutoffEnforced=True,selected=selected['selected'],passed=selected['passed']))
    print('Environment independence, historical-prefix causality and two-slot Priority verified.')
if __name__=='__main__':main()
