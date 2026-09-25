from __future__ import annotations

import argparse, json, os
from pathlib import Path
import duckdb
import pandas as pd

import research_us33_stage4_constraints_sizing as s4

HOLDINGS=[15,20,25,30]
CONFIGS={
  "AGGRESSIVE":{"entry":0.80,"exit":0.70,"architecture":"M+B+T","sector_cap":2},
  "BALANCED":{"entry":0.80,"exit":0.50,"architecture":"M+B+V","sector_cap":3},
}

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--panel",required=True); p.add_argument("--input-root",required=True)
    p.add_argument("--sector-map",required=True); p.add_argument("--output",required=True)
    p.add_argument("--memory-limit",default="4GB")
    a=p.parse_args()
    out=Path(a.output).resolve(); out.mkdir(parents=True,exist_ok=True)
    tmp=Path(os.environ.get("RUNNER_TEMP",str(out/".tmp")))/"us33-holdings-expansion"; tmp.mkdir(parents=True,exist_ok=True)
    con=duckdb.connect(str(tmp/"study.duckdb")); con.execute(f"SET memory_limit='{a.memory_limit}'"); con.execute("SET threads=1"); con.execute("SET preserve_insertion_order=false")
    prepared=tmp/"prepared"; s4.prepare(con,Path(a.panel).resolve(),Path(a.input_root).resolve(),Path(a.sector_map).resolve(),prepared)

    cfgs=[]
    for label,v in CONFIGS.items():
        for n in HOLDINGS:
            cfgs.append(s4.Config(label,v["entry"],v["exit"],v["architecture"],n,v["sector_cap"],"EW","HOLDINGS_EXPANSION"))
    states,res=s4.run(con,prepared,cfgs)
    res=res.sort_values(["label","max_positions"])
    res.to_csv(out/"holdings_15_20_25_30.csv",index=False)

    summary={}
    for label in CONFIGS:
        z=res[res.label==label].copy()
        base=z[z.max_positions==15].iloc[0]
        rows=[]
        for _,r in z.iterrows():
            rows.append({
              "holdings":int(r.max_positions),
              "trainCAGR":float(r.trainCAGR),"trainSharpe":float(r.trainSharpe),"trainMDD":float(r.trainMDD),
              "testCAGR":float(r.testCAGR),"testSharpe":float(r.testSharpe),"testMDD":float(r.testMDD),
              "testExcessCAGR":float(r.testExcessCAGR),"testAnnualTurnover":float(r.testAnnualTurnover),
              "fullCAGR":float(r.fullCAGR),"fullSharpe":float(r.fullSharpe),"fullMDD":float(r.fullMDD),
              "deltaTestCAGRvs15":float(r.testCAGR-base.testCAGR),
              "deltaTestSharpevs15":float(r.testSharpe-base.testSharpe),
              "deltaTestMDDvs15":float(r.testMDD-base.testMDD),
            })
        summary[label]=rows

    (out/"holdings_summary.json").write_text(json.dumps({
      "study":"US-3.3 holdings expansion 15/20/25/30",
      "fixedRules":{
        "AGGRESSIVE":"E80-X70 M+B+T sectorCap2 EW",
        "BALANCED":"E80-X50 M+B+V sectorCap3 EW"
      },
      "trainWindow":"2017-2022",
      "holdoutWindow":"2023-2026",
      "results":summary,
      "researchGrade":"SURVIVOR_ONLY_POST_SELECTION_HOLDOUT",
      "finalOosAllowed":False
    },ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps(summary,ensure_ascii=False))

if __name__=="__main__": main()
