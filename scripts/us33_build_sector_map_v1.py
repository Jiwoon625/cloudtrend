from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import re
import time
import threading
from pathlib import Path

import duckdb
import pandas as pd
import requests

SECTOR_NAME = {
    "SEMI": "반도체",
    "BATTERY": "2차전지·소재",
    "AUTO": "자동차·부품",
    "BIO": "제약·바이오",
    "IT_HW": "IT·전자부품",
    "SOFTWARE": "인터넷·소프트웨어",
    "FINANCE": "금융·지주",
    "SHIP_DEF": "조선·방산·기계",
    "CHEM_STEEL": "화학·철강·소재",
    "ENERGY": "에너지·유틸리티",
    "CONSUMER": "소비재·유통·식음료",
    "HEALTH_SVC": "화장품·의료기기",
    "TELCO_MEDIA": "통신·미디어·엔터",
    "CONSTRUCT": "건설·운송",
}
VALID = set(SECTOR_NAME)
SEC_UA = "CloudTrendResearch/1.0 contact: Jiwoon625@users.noreply.github.com"
_YAHOO_LOCAL = threading.local()


def yahoo_session():
    if not hasattr(_YAHOO_LOCAL, "session"):
        s = requests.Session()
        s.headers.update({"User-Agent": "Mozilla/5.0 (compatible; CloudTrendResearch/1.0)"})
        _YAHOO_LOCAL.session = s
    return _YAHOO_LOCAL.session


# Yahoo Finance industry -> CloudTrend 14-sector split.
# Order matters: more specific rules precede the broad Yahoo sector fallback.
INDUSTRY_RULES = [
    (r"semiconductor", "SEMI"),
    (r"battery|lithium|energy storage|electrical storage", "BATTERY"),
    (r"auto manufacturer|auto part|auto & truck dealership|automotive|recreational vehicle", "AUTO"),
    (r"biotechnology|drug manufacturer|pharmaceutical", "BIO"),
    (r"medical device|medical instrument|diagnostic|health information|medical care facilit|healthcare plan|medical distribution", "HEALTH_SVC"),
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
    "Technology": "IT_HW",
    "Healthcare": "BIO",
    "Financial Services": "FINANCE",
    "Real Estate": "FINANCE",
    "Industrials": "SHIP_DEF",
    "Basic Materials": "CHEM_STEEL",
    "Energy": "ENERGY",
    "Utilities": "ENERGY",
    "Consumer Cyclical": "CONSUMER",
    "Consumer Defensive": "CONSUMER",
    "Communication Services": "TELCO_MEDIA",
}

# Used only when Yahoo provides a name but sector/industry is missing or ambiguous.
NAME_RULES = [
    (r"SEMICONDUCT|MICROCHIP|CHIP TECHNOLOG|WAFER|FOUNDRY", "SEMI"),
    (r"BATTERY|LITHIUM|SOLID POWER|ENERGY STORAGE", "BATTERY"),
    (r"AUTOMOTIVE|MOTOR COMPANY|MOTORS INC|AUTO PART|TIRE", "AUTO"),
    (r"BIOTECH|BIOPHARMA|PHARMA|THERAPEUTIC|GENOMIC|VACCINE|DRUG", "BIO"),
    (r"MEDICAL|MEDTECH|DENTAL|DIAGNOSTIC|AESTHETIC|DERMA|BEAUTY HEALTH", "HEALTH_SVC"),
    (r"SOFTWARE|CLOUD|CYBER|DATA SYSTEM|DIGITAL PLATFORM|INTERNET|APPLICATION", "SOFTWARE"),
    (r"BANK|BANCORP|BANKSHARES|FINANCIAL|INSURANCE|CAPITAL MANAGEMENT|ASSET MANAGEMENT", "FINANCE"),
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
    sec = (sector or "").strip()
    ind = (industry or "").strip()
    name = (longname or "").upper()

    for pat, code in INDUSTRY_RULES:
        if re.search(pat, ind, re.I):
            return code, "YAHOO_INDUSTRY", 0.98, "A", pat

    for pat, code in NAME_RULES:
        if re.search(pat, name, re.I):
            return code, "YAHOO_NAME_OVERRIDE", 0.90, "B+", pat

    if sec in SECTOR_DEFAULT:
        return SECTOR_DEFAULT[sec], "YAHOO_SECTOR", 0.88, "B", sec

    return None, None, None, None, None


def classify_sic(sic, desc):
    try:
        n = int(str(sic).strip())
    except Exception:
        return None
    d = (desc or "").lower()

    if n == 3674 or "semiconductor" in d:
        return "SEMI"
    if n == 3691 or "storage batter" in d:
        return "BATTERY"
    if 3710 <= n <= 3716:
        return "AUTO"
    if 2830 <= n <= 2836 or "pharmaceutical" in d or "biological" in d:
        return "BIO"
    if 3840 <= n <= 3851 or 8000 <= n <= 8099:
        return "HEALTH_SVC"
    if 7370 <= n <= 7379:
        return "SOFTWARE"
    if 6000 <= n <= 6799:
        return "FINANCE"
    if 3720 <= n <= 3769 or 3500 <= n <= 3599:
        return "SHIP_DEF"
    if 1000 <= n <= 1299 or 2800 <= n <= 2899 or 3300 <= n <= 3499:
        return "CHEM_STEEL"
    if 1300 <= n <= 1399 or 4900 <= n <= 4999:
        return "ENERGY"
    if 4800 <= n <= 4899 or 7800 <= n <= 7999:
        return "TELCO_MEDIA"
    if 1500 <= n <= 1799 or 4000 <= n <= 4799:
        return "CONSTRUCT"
    if 3600 <= n <= 3699 or 3570 <= n <= 3579:
        return "IT_HW"
    if 2000 <= n <= 2399 or 5000 <= n <= 5999 or 7000 <= n <= 7299:
        return "CONSUMER"
    return None


def yahoo_one(symbol: str):
    ys = norm_yahoo_symbol(symbol)
    session = yahoo_session()
    err = None

    for attempt in range(3):
        try:
            r = session.get(
                "https://query1.finance.yahoo.com/v1/finance/search",
                params={"q": ys, "quotesCount": 5, "newsCount": 0},
                timeout=15,
            )
            r.raise_for_status()
            quotes = r.json().get("quotes", [])
            exact = [x for x in quotes if str(x.get("symbol", "")).upper() == ys]
            q = exact[0] if exact else (quotes[0] if quotes else None)
            if not q:
                raise RuntimeError("Yahoo Finance search returned no quote")
            return {
                "symbol": symbol,
                "yahooSymbol": ys,
                "yahooSector": q.get("sector"),
                "yahooIndustry": q.get("industry"),
                "yahooLongName": q.get("longname") or q.get("shortname"),
                "yahooQuoteType": q.get("quoteType"),
                "yahooExchange": q.get("exchDisp") or q.get("exchange"),
                "yahooError": None,
            }
        except Exception as e:
            err = repr(e)
            time.sleep(0.5 * (attempt + 1))

    return {
        "symbol": symbol,
        "yahooSymbol": ys,
        "yahooSector": None,
        "yahooIndustry": None,
        "yahooLongName": None,
        "yahooQuoteType": None,
        "yahooExchange": None,
        "yahooError": err,
    }


def try_sec_index():
    session = requests.Session()
    session.headers.update({
        "User-Agent": SEC_UA,
        "Accept-Encoding": "gzip, deflate",
    })
    try:
        r = session.get("https://www.sec.gov/files/company_tickers.json", timeout=30)
        r.raise_for_status()
        j = r.json()
        mapping = {
            str(v["ticker"]).upper().replace(".", "-"): int(v["cik_str"])
            for v in j.values()
        }
        return mapping, None
    except Exception as e:
        return {}, repr(e)


def sec_one(cik, session):
    try:
        r = session.get(
            f"https://data.sec.gov/submissions/CIK{int(cik):010d}.json",
            timeout=30,
        )
        r.raise_for_status()
        j = r.json()
        return j.get("sic"), j.get("sicDescription"), None
    except Exception as e:
        return None, None, repr(e)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--panel", required=True)
    p.add_argument("--fallback", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--workers", type=int, default=8)
    a = p.parse_args()

    out = Path(a.output).resolve()
    out.mkdir(parents=True, exist_ok=True)

    con = duckdb.connect()
    symbols = [
        r[0]
        for r in con.execute(
            "SELECT DISTINCT symbol FROM read_parquet(?) ORDER BY symbol",
            [str(Path(a.panel).resolve())],
        ).fetchall()
    ]
    if len(symbols) != 5032:
        raise RuntimeError(f"expected 5032 panel symbols, got {len(symbols)}")

    fb = pd.read_csv(a.fallback)
    fb = fb[fb.symbol.isin(symbols)].drop_duplicates("symbol").set_index("symbol")

    yahoo_rows = []
    with cf.ThreadPoolExecutor(max_workers=a.workers) as ex:
        futures = {ex.submit(yahoo_one, sym): sym for sym in symbols}
        for i, fut in enumerate(cf.as_completed(futures), 1):
            yahoo_rows.append(fut.result())
            if i % 250 == 0 or i == len(symbols):
                print(json.dumps({"yahooDone": i, "total": len(symbols)}))

    y = pd.DataFrame(yahoo_rows).sort_values("symbol")
    y.to_csv(out / "yahoo_sector_raw.csv", index=False)

    # SEC official SIC cross-check. GitHub-hosted IPs may be blocked; that is nonfatal.
    ticker_to_cik, sec_index_error = try_sec_index()
    sec_records = {}
    if ticker_to_cik:
        session = requests.Session()
        session.headers.update({
            "User-Agent": SEC_UA,
            "Accept-Encoding": "gzip, deflate",
        })
        targets = [sym for sym in symbols if norm_yahoo_symbol(sym) in ticker_to_cik]
        for i, sym in enumerate(targets, 1):
            cik = ticker_to_cik[norm_yahoo_symbol(sym)]
            sic, desc, err = sec_one(cik, session)
            sec_records[sym] = {
                "secCik": cik,
                "secSic": sic,
                "secSicDescription": desc,
                "secError": err,
            }
            if i % 5 == 0:
                time.sleep(0.65)
            if i % 500 == 0 or i == len(targets):
                print(json.dumps({"secDone": i, "total": len(targets)}))

    output_rows = []
    for r in y.to_dict(orient="records"):
        sym = r["symbol"]
        old = fb.loc[sym].to_dict() if sym in fb.index else {}

        yahoo_code, method, confidence, grade, matched = classify_yahoo(
            r.get("yahooSector"),
            r.get("yahooIndustry"),
            r.get("yahooLongName"),
        )

        sec = sec_records.get(sym, {})
        sec_code = classify_sic(
            sec.get("secSic"),
            sec.get("secSicDescription"),
        ) if sec else None

        agreement = (yahoo_code == sec_code) if yahoo_code and sec_code else None

        if yahoo_code:
            code = yahoo_code
            if agreement is True:
                method = "YAHOO_SEC_AGREE"
                confidence = 0.995
                grade = "A+"
            elif agreement is False:
                method = "YAHOO_SEC_CONFLICT"
                confidence = 0.90
                grade = "B+"
        elif sec_code:
            code = sec_code
            method = "SEC_SIC"
            confidence = 0.92
            grade = "A-"
            matched = str(sec.get("secSic"))
        else:
            code = old.get("sectorCode")
            method = "FALLBACK_V0_" + str(old.get("mapMethod", "UNKNOWN"))
            try:
                confidence = float(old.get("confidence", 0.55))
            except Exception:
                confidence = 0.55
            grade = str(old.get("confidenceGrade", "C"))
            matched = str(old.get("matchedRule", ""))

        if code not in VALID:
            raise RuntimeError(f"invalid mapping {sym} -> {code}")

        output_rows.append({
            "symbol": sym,
            "sectorCode": code,
            "sectorNameKo": SECTOR_NAME[code],
            "mapMethod": method,
            "confidence": confidence,
            "confidenceGrade": grade,
            "matchedRule": matched,
            "yahooSector": r.get("yahooSector"),
            "yahooIndustry": r.get("yahooIndustry"),
            "yahooLongName": r.get("yahooLongName"),
            "yahooQuoteType": r.get("yahooQuoteType"),
            "yahooExchange": r.get("yahooExchange"),
            "secCik": sec.get("secCik"),
            "secSic": sec.get("secSic"),
            "secSicDescription": sec.get("secSicDescription"),
            "sourceAgreement": agreement,
            "oldSectorCode": old.get("sectorCode"),
            "oldMapMethod": old.get("mapMethod"),
            "changedFromV0": bool(old.get("sectorCode") and old.get("sectorCode") != code),
            "mappingVersion": "us-sector-14-v1-yahoo-sec-20260926",
        })

    result = pd.DataFrame(output_rows).sort_values("symbol")

    if len(result) != 5032 or result.symbol.nunique() != 5032:
        raise RuntimeError("final map row/symbol QA failed")
    if result.sectorCode.nunique() != 14:
        raise RuntimeError(f"expected all 14 CloudTrend sectors, got {result.sectorCode.nunique()}")

    result.to_csv(out / "us_stock_sector_map_14_v1.csv", index=False)
    result[result.changedFromV0].to_csv(out / "sector_changes_vs_v0.csv", index=False)
    review = result[
        result.mapMethod.str.contains("CONFLICT|FALLBACK", regex=True, na=False)
        | (result.confidence < 0.85)
    ]
    review.to_csv(out / "manual_review_candidates.csv", index=False)

    qa = {
        "rows": int(len(result)),
        "uniqueSymbols": int(result.symbol.nunique()),
        "sectorCount": int(result.sectorCode.nunique()),
        "sectorCounts": result.sectorCode.value_counts().to_dict(),
        "methodCounts": result.mapMethod.value_counts().to_dict(),
        "confidenceGradeCounts": result.confidenceGrade.value_counts().to_dict(),
        "yahooSectorCoverage": int(result.yahooSector.notna().sum()),
        "yahooIndustryCoverage": int(result.yahooIndustry.notna().sum()),
        "yahooErrorCount": int(result.yahooSector.isna().sum()),
        "secIndexAvailable": bool(ticker_to_cik),
        "secIndexError": sec_index_error,
        "secSicCoverage": int(result.secSic.notna().sum()),
        "changedFromV0": int(result.changedFromV0.sum()),
        "fallbackCount": int(result.mapMethod.str.startswith("FALLBACK").sum()),
        "manualReviewCount": int(len(review)),
        "mappingVersion": "us-sector-14-v1-yahoo-sec-20260926",
        "sourceMethod": "Yahoo Finance search sector+industry; sample parity checked against yfinance 1.7.0; SEC SIC when accessible",
    }
    (out / "sector_map_qa.json").write_text(
        json.dumps(qa, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(qa, ensure_ascii=False))


if __name__ == "__main__":
    main()
