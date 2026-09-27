"""Replay the frozen eight configurations with the unchanged Stage 4 engine.

This is a current-universe control, not the delisted-inclusive result. No
parameters are selected here. New-data terminal-price handling is validated
separately before comparing survivorship counterfactuals.
"""
from __future__ import annotations
import argparse,json,os
from pathlib import Path
import duckdb,pandas as pd
import research_us33_stage4_constraints_sizing as engine

def main():
    p=argparse.ArgumentParser()
    for key in ['panel','input-root','sector-map','output']:p.add_argument('--'+key,required=True)
    a=p.parse_args();out=Path(a.output);out.mkdir(parents=True,exist_ok=True)
    tmp=Path(os.environ.get('RUNNER_TEMP',str(out/'.tmp')))/'us33-survivorship-control';tmp.mkdir(parents=True,exist_ok=True)
    con=duckdb.connect(str(tmp/'control.duckdb'));con.execute("SET memory_limit='4GB'");con.execute('SET threads=2')
    prepared=tmp/'prepared'
    engine.prepare(con,Path(a.panel).resolve(),Path(a.input_root).resolve(),Path(a.sector_map).resolve(),prepared)
    configs=[]
    for style,exit_cut,arch,cap in [('AGGRESSIVE',.7,'M+B+T',2),('BALANCED',.5,'M+B+V',3)]:
        for n in [15,20]:
            for c in [cap,n]:
                # A cap equal to maximum portfolio size is exactly non-binding.
                configs.append(engine.Config(style,.8,exit_cut,arch,n,c,'EW','FROZEN_SURVIVOR_CONTROL'))
    states,result=engine.run(con,prepared,configs)
    result['sectorCapMode']=result.apply(lambda r:'NONE' if r.sector_cap==r.max_positions else 'ORIGINAL',axis=1)
    result.to_csv(out/'eight_configurations_legacy.csv',index=False)
    # Prior public workflow run 36202739436, frozen rules and sector-map v1.1.
    expected={('AGGRESSIVE',15):(.2819084606599318,.3365666021619196),('AGGRESSIVE',20):(.25183008000469154,.36187778723278696),
              ('BALANCED',15):(.21565326759703152,.2984420290784895),('BALANCED',20):(.23163004335521653,.40013976643725724)}
    checks=[]
    for row in result[result.sectorCapMode=='ORIGINAL'].itertuples():
        train,recent=expected[(row.label,row.max_positions)]
        checks.append(dict(style=row.label,n=row.max_positions,trainDifference=row.trainCAGR-train,reviewedDifference=row.testCAGR-recent))
    (out/'reproduction_checks.json').write_text(json.dumps(checks,indent=2))
    # One basis-point tolerance accommodates serialized source precision only.
    assert all(abs(r['trainDifference'])<.0001 and abs(r['reviewedDifference'])<.0001 for r in checks),checks
    for st in states.values():
        pd.DataFrame(st.daily).to_csv(out/f'{st.config.config_id}_daily.csv',index=False)
    (out/'research_grade.json').write_text(json.dumps(dict(researchGrade='CURRENT_UNIVERSE_CONTROL_POST_SELECTION_REVALIDATION',finalOosAllowed=False,
        reviewedPeriod='2023-2026 already used in strategy selection',sourceEngine='research_us33_stage4_constraints_sizing.py',sectorMap='v1.1 frozen'),indent=2))
    print(result[['label','max_positions','sectorCapMode','trainCAGR','testCAGR','testSharpe','testMDD']].to_string(index=False))
    con.close()
if __name__=='__main__':main()
