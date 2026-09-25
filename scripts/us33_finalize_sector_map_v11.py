from __future__ import annotations

import argparse
import json
from pathlib import Path
import pandas as pd

SECTOR_NAME = {
    "SEMI":"반도체","BATTERY":"2차전지·소재","AUTO":"자동차·부품","BIO":"제약·바이오",
    "IT_HW":"IT·전자부품","SOFTWARE":"인터넷·소프트웨어","FINANCE":"금융·지주",
    "SHIP_DEF":"조선·방산·기계","CHEM_STEEL":"화학·철강·소재","ENERGY":"에너지·유틸리티",
    "CONSUMER":"소비재·유통·식음료","HEALTH_SVC":"화장품·의료기기",
    "TELCO_MEDIA":"통신·미디어·엔터","CONSTRUCT":"건설·운송",
}
VALID=set(SECTOR_NAME)

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--yahoo-map",required=True)
    p.add_argument("--curated-v0",required=True)
    p.add_argument("--output",required=True)
    a=p.parse_args()

    out=Path(a.output); out.mkdir(parents=True,exist_ok=True)
    y=pd.read_csv(a.yahoo_map)
    old=pd.read_csv(a.curated_v0)
    old=old.drop_duplicates("symbol").set_index("symbol")

    rows=[]
    for rec in y.to_dict(orient="records"):
        sym=rec["symbol"]
        o=old.loc[sym].to_dict() if sym in old.index else {}

        # CloudTrend is a 14-sector thematic system, not a pure GICS replica.
        # Keep reviewed/explicit mappings before translating broad Yahoo industries.
        if o.get("mapMethod")=="EXPLICIT" and o.get("sectorCode") in VALID:
            rec["sectorCode"]=o["sectorCode"]
            rec["sectorNameKo"]=SECTOR_NAME[o["sectorCode"]]
            rec["mapMethod"]="CURATED_EXPLICIT"
            rec["confidence"]=0.995
            rec["confidenceGrade"]="A+"
            rec["matchedRule"]="prior_cloudtrend_explicit"
        elif (
            o.get("sectorCode")=="BATTERY"
            and o.get("mapMethod")=="RULE"
            and str(o.get("matchedRule")) in {"BATTERY","LITHIUM"}
        ):
            # GICS/Yahoo has no standalone battery sector; retain transparent
            # high-specificity battery/lithium theme rules for the CloudTrend taxonomy.
            rec["sectorCode"]="BATTERY"
            rec["sectorNameKo"]=SECTOR_NAME["BATTERY"]
            rec["mapMethod"]="CURATED_THEME_RULE"
            rec["confidence"]=0.97
            rec["confidenceGrade"]="A"
            rec["matchedRule"]=str(o.get("matchedRule"))

        rec["oldSectorCode"]=o.get("sectorCode")
        rec["oldMapMethod"]=o.get("mapMethod")
        rec["changedFromV0"]=bool(o.get("sectorCode") and o.get("sectorCode")!=rec["sectorCode"])
        rec["mappingVersion"]="us-sector-14-v1.1-yahoo-sec-curated-20260926"
        rows.append(rec)

    result=pd.DataFrame(rows).sort_values("symbol")
    if len(result)!=5032 or result.symbol.nunique()!=5032:
        raise RuntimeError("row/symbol QA failed")
    if result.sectorCode.nunique()!=14 or not set(result.sectorCode).issubset(VALID):
        raise RuntimeError("14-sector QA failed")

    result.to_csv(out/"us_stock_sector_map_14_v1.csv",index=False)
    result[result.changedFromV0].to_csv(out/"sector_changes_vs_v0.csv",index=False)
    review=result[
        result.mapMethod.str.contains("CONFLICT|FALLBACK",regex=True,na=False)
        | (pd.to_numeric(result.confidence,errors="coerce")<0.85)
    ]
    review.to_csv(out/"manual_review_candidates.csv",index=False)

    qa={
        "rows":int(len(result)),
        "uniqueSymbols":int(result.symbol.nunique()),
        "sectorCount":int(result.sectorCode.nunique()),
        "sectorCounts":result.sectorCode.value_counts().to_dict(),
        "methodCounts":result.mapMethod.value_counts().to_dict(),
        "confidenceGradeCounts":result.confidenceGrade.value_counts().to_dict(),
        "yahooSectorCoverage":int(result.yahooSector.notna().sum()) if "yahooSector" in result else None,
        "yahooIndustryCoverage":int(result.yahooIndustry.notna().sum()) if "yahooIndustry" in result else None,
        "secSicCoverage":int(result.secSic.notna().sum()) if "secSic" in result else None,
        "changedFromV0":int(result.changedFromV0.sum()),
        "fallbackCount":int(result.mapMethod.str.startswith("FALLBACK").sum()),
        "manualReviewCount":int(len(review)),
        "curatedExplicitCount":int((result.mapMethod=="CURATED_EXPLICIT").sum()),
        "curatedBatteryRuleCount":int((result.mapMethod=="CURATED_THEME_RULE").sum()),
        "mappingVersion":"us-sector-14-v1.1-yahoo-sec-curated-20260926",
        "methodology":"CloudTrend curated explicit/theme overrides -> Yahoo Finance industry/sector -> SEC SIC when available -> v0 fallback",
    }
    (out/"sector_map_qa.json").write_text(json.dumps(qa,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps(qa,ensure_ascii=False))

if __name__=="__main__":
    main()
