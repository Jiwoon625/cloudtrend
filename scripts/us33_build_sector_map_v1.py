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
    headers={"User-Agent":"Mozilla/5.0 (compatible; CloudTrendResearch/1.0)"}
    for attempt in range(3):
        try:
            r=requests.get(
                "https://query1.finance.yahoo.com/v1/finance/search",
                params={"q":ys,"quotesCount":5,"newsCount":0},
                headers=headers,timeout=15,
            )
            r.raise_for_status()
            quotes=r.json().get("quotes",[])
            q=next((x for x in quotes if str(x.get("symbol","")).upper()==ys), quotes[0] if quotes else {})
            if not q:
                raise RuntimeError("Yahoo search returned no quote")
            return {
                "symbol":symbol,"yahooSymbol":ys,
                "yfSector":q.get("sector"),"yfIndustry":q.get("industry"),
                "yfSectorKey":q.get("sectorKey"),"yfIndustryKey":q.get("industryKey"),
                "yfLongName":q.get("longname") or q.get("shortname"),
                "yfQuoteType":q.get("quoteType"),"yfError":None,
            }
        except Exception as e:
            err=repr(e)
            time.sleep(0.5*(attempt+1))
    return {"symbol":symbol,"yahooSymbol":ys,"yfSector":None,"yfIndustry":None,
            "yfSectorKey":None,"yfIndustryKey":None,"yfLongName":None,"yfQuoteType":None,"yfError":err}

