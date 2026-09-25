from __future__ import annotations

import argparse, json, os
from pathlib import Path
import duckdb
import pandas as pd

import research_us33_stage4_constraints_sizing as s4

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--panel",required=True); p.add_argument("--input-root",required=True)
    p.add_argument("--sector-map",required=True); p.add_argument("--output",required=True)
    p.add_argument("--memory-limit",default="4GB")
    a=p.parse_args()
    out=Path(a.output).resolve(); out.mkdir(parents=True,exist_ok=True)
    tmp=Path(os.environ.get("RUNNER_TEMP",str(out/".tmp")))/"us33-stage4b"; tmp.mkdir(parents=True,exist_ok=True)
    con=duckdb.connect(str(tmp/"stage4b.duckdb")); con.execute(f"SET memory_limit='{a.memory_limit}'"); con.execute("SET threads=1"); con.execute("SET preserve_insertion_order=false")
    prepared=tmp/"prepared"; s4.prepare(con,Path(a.panel).resolve(),Path(a.input_root).resolve(),Path(a.sector_map).resolve(),prepared)

    configs=[]
    for label,v in s4.ARCH.items():
        for n in s4.HOLDINGS:
            for sc in s4.SECTOR_CAPS:
                for sz in s4.SIZINGS:
                    configs.append(s4.Config(label,v["entry"],v["exit"],v["architecture"],n,sc,sz,"ALL_SIZING"))
    states,res=s4.run(con,prepared,configs)
    res.to_csv(out/"all_constraints_all_sizing.csv",index=False)

    # pairwise VOL - EW deltas for each exact portfolio constraint
    piv=res.pivot_table(index=["label","max_positions","sector_cap"],columns="sizing",
        values=["trainCAGR","trainSharpe","trainMDD","testCAGR","testSharpe","testMDD","testExcessCAGR","fullCAGR","fullSharpe","fullMDD"])
    piv.columns=["__".join(x) for x in piv.columns]
    piv=piv.reset_index()
    for metric in ["trainCAGR","trainSharpe","testCAGR","testSharpe","testExcessCAGR","fullCAGR","fullSharpe"]:
        piv[f"{metric}__VOL_MINUS_EW"]=piv[f"{metric}__VOL60_T15"]-piv[f"{metric}__EW"]
    # MDD improvement: positive means less negative / better
    for metric in ["trainMDD","testMDD","fullMDD"]:
        piv[f"{metric}__VOL_MINUS_EW"]=piv[f"{metric}__VOL60_T15"]-piv[f"{metric}__EW"]
    piv.to_csv(out/"vol60_vs_ew_pairwise.csv",index=False)

    summary={}
    for label in s4.ARCH:
        z=piv[piv.label==label]
        summary[label]={
          "pairs":len(z),
          "volBetterTrainSharpe":int((z["trainSharpe__VOL_MINUS_EW"]>0).sum()),
          "volBetterTestSharpe":int((z["testSharpe__VOL_MINUS_EW"]>0).sum()),
          "volBetterTestCAGR":int((z["testCAGR__VOL_MINUS_EW"]>0).sum()),
          "volBetterTestMDD":int((z["testMDD__VOL_MINUS_EW"]>0).sum()),
          "medianTestCAGRDelta":float(z["testCAGR__VOL_MINUS_EW"].median()),
          "medianTestSharpeDelta":float(z["testSharpe__VOL_MINUS_EW"].median()),
          "medianTestMDDDelta":float(z["testMDD__VOL_MINUS_EW"].median()),
        }
    # Stable-region view: no re-selection claim, just diagnostic where both train and test positive vs SPY.
    res["trainExcessApprox"]=res.trainCAGR-0.105 # only screening proxy, not used for selection
    stable=res[(res.testExcessCAGR>0)&(res.testSharpe>0.65)].sort_values(["label","testSharpe","testCAGR"],ascending=[True,False,False])
    stable.to_csv(out/"stable_holdout_region.csv",index=False)
    (out/"sizing_summary.json").write_text(json.dumps({
      "study":"US3.3 Stage4b all-constraint sizing sensitivity",
      "summary":summary,
      "interpretationRule":"Prefer EW unless VOL60_T15 shows repeatable improvement across multiple constraints, not a single-cell win.",
      "researchGrade":"SURVIVOR_ONLY_POST_SELECTION_HOLDOUT",
      "finalOosAllowed":False
    },ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps(summary,ensure_ascii=False))

if __name__=="__main__": main()
