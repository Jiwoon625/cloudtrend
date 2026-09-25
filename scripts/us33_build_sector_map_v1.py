from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import math
import os
import re
import threading
import time
from pathlib import Path
from urllib.parse import quote

import duckdb
import pandas as pd
import requests
import yfinance as yf

SECTOR_NAME = {
    "SEMI":"반도체","BATTERY":"2차전지·소재","AUTO":"자동차·부품","BIO":"제약·바이오",
    "IT_HW":"IT·전자부품","SOFTWARE":"인터넷·소프트웨어","FINANCE":"금융·지주",
    "SHIP_DEF":"조선·방산·기계","CHEM_STEEL":"화학·철강·소재","ENERGY":"에너지·유틸리티",
    "CONSUMER":"소비재·유통·식음료","HEALTH_SVC":"화장품·의료기기",
    "TELCO_MEDIA":"통신·미디어·엔터","CONSTRUCT":"건설·운송",
}
VALID=set(SECTOR_NAME)
SEC_UA="CloudTrendResearch/1.0 contact: Jiwoon625@users.noreply.github.com"

INDUSTRY_RULES = [
    (r"semiconductor", "SEMI"),
    (r"battery|lithium|energy storage|electrical storage", "BATTERY"),
    (r"auto manufacturer|auto part|auto & truck dealership|automotive", "AUTO"),
    (r"biotechnology|drug manufacturer|pharmaceutical", "BIO"),
    (r"medical device|medical instrument|diagnostic|health information|medical care facilit|healthcare plan", "HEALTH_SVC"),
    (r"software|information technology service|internet content|computer system|data processing", "SOFTWARE"),
    (r"bank|credit service|insurance|capital market|asset management|financial data|mortgage finance|real estate|reit", "FINANCE"),
    (r"aerospace|defense|specialty industrial machinery|farm & heavy construction machinery|tools & accessories|electrical equipment|metal fabrication|industrial distribution", "SHIP_DEF"),
    (r"chemical|steel|aluminum|copper|gold|silver|precious metal|mining|building material|paper|specialty chemical", "CHEM_STEEL"),
    (r"oil & gas|thermal coal|uranium|solar|renewable|utilit", "ENERGY"),
    (r"telecom|entertainment|broadcast|advertising|publishing|gaming|multimedia", "TELCO_MEDIA"),
    (r"airline|airport|railroad|trucking|marine shipping|integrated freight|infrastructure operation|engineering & construction|transport", "CONSTRUCT"),
    (r"consumer electronics|computer hardware|electronic component|communication equipment|scientific & technical instrument", "IT_HW"),
    (r"restaurant|retail|apparel|footwear|food|beverage|tobacco|travel|lodging|resort|leisure|packaged foods|household|personal product", "CONSUMER"),
]
SECTOR_DEFAULT = {
    "Technology":"IT_HW",
    "Healthcare":"BIO",
    "Financial Services":"FINANCE",
    "Real Estate":"FINANCE",
    "Industrials":"SHIP_DEF",
    "Basic Materials":"CHEM_STEEL",
    "Energy":"ENERGY",
    "Utilities":"ENERGY",
    "Consumer Cyclical":"CONSUMER",
    "Consumer Defensive":"CONSUMER",
    "Communication Services":"TELCO_MEDIA",
}

NAME_RULES = [
    (r"SEMICONDUCT|MICROCHIP|CHIP TECHNOLOG|WAFER|FOUNDRY", "SEMI"),
    (r"BATTERY|LITHIUM|SOLID POWER|ENERGY STORAGE", "BATTERY"),
    (r"AUTOMOTIVE|MOTOR COMPANY|MOTORS INC|AUTO PART|TIRE", "AUTO"),
    (r"BIOTECH|BIOPHARMA|PHARMA|THERAPEUTIC|GENOMIC|VACCINE|DRUG", "BIO"),
    (r"MEDICAL|MEDTECH|DENTAL|DIAGNOSTIC|AESTHETIC|DERMA|BEAUTY HEALTH", "HEALTH_SVC"),
    (r"SOFTWARE|CLOUD|CYBER|DATA SYSTEM|DIGITAL PLATFORM|INTERNET|APPLICATION", "SOFTWARE"),
    (r"BANK|BANCORP|BANKSHARES|FINANCIAL|INSURANCE|CAPITAL MANAGEMENT|ASSET MANAGEMENT|HOLDINGS.*REIT", "FINANCE"),
    (r"AEROSPACE|DEFENSE|ROBOT|MACHINERY|INDUSTRIAL GROUP|ELECTRIC.*EQUIPMENT", "SHIP_DEF"),
    (r"MINING|MINERALS|GOLD|SILVER|COPPER|STEEL|CHEMICAL|MATERIALS|ALUMINUM", "CHEM_STEEL"),
    (r"ENERGY|PETROLEUM|OIL|GAS|URANIUM|SOLAR|WIND|POWER CORP|UTILITY", "ENERGY"),
    (r"TELECOM|MEDIA|ENTERTAINMENT|BROADCAST|GAMING|STUDIO|MUSIC", "TELCO_MEDIA"),
    (r"SHIPPING|LOGISTICS|TRANSPORT|AIRLINES|AIRWAYS|RAIL|FREIGHT|CONSTRUCTION|INFRASTRUCTURE", "CONSTRUCT"),
    (r"ELECTRONIC|HARDWARE|DISPLAY|NETWORK|COMMUNICATIONS EQUIPMENT|TECHNOLOGIES", "IT_HW"),
    (r"FOODS|FOOD|BEVERAGE|RETAIL|APPAREL|RESTAURANT|HOTEL|RESORT|TRAVEL|LEISURE|CONSUMER|BRANDS", "CONSUMER"),
]

def norm_yahoo_symbol(s: str) -> str:
    return str(s).strip().upper().replace(".", "-")

def classify_yahoo(sector, industry, longname):
    sec=(sector or "").strip()
    ind=(industry or "").strip()
    name=(longname or "").upper()
    text=ind.lower()
    for pat,code in INDUSTRY_RULES:
        if re.search(pat,text,re.I):
            return code,"YF_INDUSTRY",0.98,"A",pat
    for pat,code in NAME_RULES:
        if re.search(pat,name,re.I):
            return code,"YF_NAME_OVERRIDE",0.90,"B+",pat
    if sec in SECTOR_DEFAULT:
        return SECTOR_DEFAULT[sec],"YF_SECTOR",0.88,"B",sec
    return None,None,None,None,None

def classify_sic(sic, desc):
    try: n=int(str(sic).strip())
    except: return None
    d=(desc or "").lower()
    if n==3674 or "semiconductor" in d: return "SEMI"
    if n in {3691} or "storage batter" in d: return "BATTERY"
    if 3710<=n<=3716: return "AUTO"
    if 2830<=n<=2836 or "pharmaceutical" in d or "biological" in d: return "BIO"
    if 3840<=n<=3851 or 8000<=n<=8099: return "HEALTH_SVC"
    if 7370<=n<=7379: return "SOFTWARE"
    if 6000<=n<=6799: return "FINANCE"
    if 3720<=n<=3769 or 3500<=n<=3599: return "SHIP_DEF"
    if 1000<=n<=1299 or 2800<=n<=2899 or 3300<=n<=3499: return "CHEM_STEEL"
    if 1300<=n<=1399 or 4900<=n<=4999: return "ENERGY"
    if 4800<=n<=4899 or 7800<=n<=7999: return "TELCO_MEDIA"
    if 1500<=n<=1799 or 4000<=n<=4799: return "CONSTRUCT"
    if 3600<=n<=3699 or 3570<=n<=3579: return "IT_HW"
    if 2000<=n<=2399 or 5000<=n<=5999 or 7000<=n<=7299: return "CONSUMER"
    return None

def yahoo_one(symbol):
    ys=norm_yahoo_symbol(symbol)
    err=None
    for attempt in range(3):
        try:
            info=yf.Ticker(ys).get_info()
            return {
                "symbol":symbol,"yahooSymbol":ys,
                "yfSector":info.get("sector"),"yfIndustry":info.get("industry"),
                "yfSectorKey":info.get("sectorKey"),"yfIndustryKey":info.get("industryKey"),
                "yfLongName":info.get("longName") or info.get("shortName"),
                "yfQuoteType":info.get("quoteType"),"yfError":None,
            }
        except Exception as e:
            err=repr(e)
            time.sleep(0.8*(attempt+1))
    return {"symbol":symbol,"yahooSymbol":ys,"yfSector":None,"yfIndustry":None,
            "yfSectorKey":None,"yfIndustryKey":None,"yfLongName":None,"yfQuoteType":None,"yfError":err}

def try_sec_index():
    s=requests.Session()
    s.headers.update({"User-Agent":SEC_UA,"Accept-Encoding":"gzip, deflate","Host":"www.sec.gov"})
    try:
        r=s.get("https://www.sec.gov/files/company_tickers.json",timeout=30)
        r.raise_for_status()
        j=r.json()
        return {str(v["ticker"]).upper().replace(".","-"):int(v["cik_str"]) for v in j.values()}, None
    except Exception as e:
        return {},repr(e)

def sec_one(ticker,cik,session):
    try:
        u=f"https://data.sec.gov/submissions/CIK{int(cik):010d}.json"
        r=session.get(u,timeout=30); r.raise_for_status()
        j=r.json()
        return j.get("sic"),j.get("sicDescription"),None
    except Exception as e:
        return None,None,repr(e)

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--panel",required=True)
    ap.add_argument("--fallback",required=True)
    ap.add_argument("--output",required=True)
    ap.add_argument("--workers",type=int,default=6)
    a=ap.parse_args()

    out=Path(a.output); out.mkdir(parents=True,exist_ok=True)
    con=duckdb.connect()
    symbols=[r[0] for r in con.execute("select distinct symbol from read_parquet(?) order by symbol",[str(Path(a.panel).resolve())]).fetchall()]
    fb=pd.read_csv(a.fallback)
    fb=fb[fb.symbol.isin(symbols)].drop_duplicates("symbol").set_index("symbol")
    if len(symbols)!=5032:
        raise RuntimeError(f"expected 5032 panel symbols, got {len(symbols)}")

    rows=[]
    lock=threading.Lock()
    with cf.ThreadPoolExecutor(max_workers=a.workers) as ex:
        futs={ex.submit(yahoo_one,s):s for s in symbols}
        for i,f in enumerate(cf.as_completed(futs),1):
            rec=f.result()
            rows.append(rec)
            if i%250==0:
                print(json.dumps({"yahooDone":i,"total":len(symbols)}))
    y=pd.DataFrame(rows).sort_values("symbol")

    # SEC is an official cross-check/fallback when the host allows access.
    t2c,sec_index_error=try_sec_index()
    sec_session=requests.Session()
    sec_session.headers.update({"User-Agent":SEC_UA,"Accept-Encoding":"gzip, deflate"})
    sec_records={}
    if t2c:
        targets=[s for s in symbols if norm_yahoo_symbol(s) in t2c]
        for i,sym in enumerate(targets,1):
            cik=t2c[norm_yahoo_symbol(sym)]
            sic,desc,err=sec_one(sym,cik,sec_session)
            sec_records[sym]={"secCik":cik,"secSic":sic,"secSicDescription":desc,"secError":err}
            if i%5==0: time.sleep(0.65)  # stay below SEC fair-access threshold
            if i%500==0: print(json.dumps({"secDone":i,"total":len(targets)}))

    outrows=[]
    for r in y.to_dict(orient="records"):
        sym=r["symbol"]
        old=fb.loc[sym].to_dict() if sym in fb.index else {}
        yf_code,method,conf,grade,rule=classify_yahoo(r.get("yfSector"),r.get("yfIndustry"),r.get("yfLongName"))
        sec=sec_records.get(sym,{})
        sec_code=classify_sic(sec.get("secSic"),sec.get("secSicDescription")) if sec else None
        agreement=(yf_code==sec_code) if yf_code and sec_code else None

        if yf_code:
            code=yf_code
            if agreement is True:
                method="YF+SEC_AGREE"; conf=0.995; grade="A+"
            elif agreement is False:
                method="YF_SEC_CONFLICT"; conf=0.90; grade="B+"
        elif sec_code:
            code=sec_code; method="SEC_SIC"; conf=0.92; grade="A-"; rule=str(sec.get("secSic"))
        else:
            code=old.get("sectorCode")
            method="FALLBACK_V0_"+str(old.get("mapMethod","UNKNOWN"))
            conf=float(old.get("confidence",0.55)) if pd.notna(old.get("confidence")) else 0.55
            grade=str(old.get("confidenceGrade","C"))
            rule=str(old.get("matchedRule",""))

        if code not in VALID:
            raise RuntimeError(f"invalid mapping {sym} -> {code}")

        outrows.append({
            "symbol":sym,
            "sectorCode":code,
            "sectorNameKo":SECTOR_NAME[code],
            "mapMethod":method,
            "confidence":conf,
            "confidenceGrade":grade,
            "matchedRule":rule,
            "yfSector":r.get("yfSector"),
            "yfIndustry":r.get("yfIndustry"),
            "yfLongName":r.get("yfLongName"),
            "yfQuoteType":r.get("yfQuoteType"),
            "secCik":sec.get("secCik"),
            "secSic":sec.get("secSic"),
            "secSicDescription":sec.get("secSicDescription"),
            "sourceAgreement":agreement,
            "oldSectorCode":old.get("sectorCode"),
            "changedFromV0":bool(old.get("sectorCode") and old.get("sectorCode")!=code),
            "mappingVersion":"us-sector-14-v1-yahoo-sec-20260926",
        })

    res=pd.DataFrame(outrows).sort_values("symbol")
    res.to_csv(out/"us_stock_sector_map_14_v1.csv",index=False)
    res[res.changedFromV0].to_csv(out/"sector_changes_vs_v0.csv",index=False)
    res[(res.mapMethod.str.contains("CONFLICT|FALLBACK",regex=True,na=False))].to_csv(out/"manual_review_candidates.csv",index=False)

    qa={
        "rows":len(res),"uniqueSymbols":int(res.symbol.nunique()),"sectorCount":int(res.sectorCode.nunique()),
        "sectorCounts":res.sectorCode.value_counts().to_dict(),
        "methodCounts":res.mapMethod.value_counts().to_dict(),
        "confidenceCounts":res.confidenceGrade.value_counts().to_dict(),
        "yahooSectorCoverage":int(res.yfSector.notna().sum()),
        "yahooIndustryCoverage":int(res.yfIndustry.notna().sum()),
        "secIndexAvailable":bool(t2c),"secIndexError":sec_index_error,
        "secSicCoverage":int(res.secSic.notna().sum()),
        "changedFromV0":int(res.changedFromV0.sum()),
        "fallbackCount":int(res.mapMethod.str.startswith("FALLBACK").sum()),
        "mappingVersion":"us-sector-14-v1-yahoo-sec-20260926",
        "yfinanceVersion":getattr(yf,"__version__",None),
    }
    (out/"sector_map_qa.json").write_text(json.dumps(qa,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps(qa,ensure_ascii=False))

if __name__=="__main__":
    main()
