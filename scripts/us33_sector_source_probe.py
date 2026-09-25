from __future__ import annotations
import json, time
from pathlib import Path
import requests
import yfinance as yf

TICKERS=["AAPL","NVDA","TSLA","JPM","XOM","LLY","UNH","CAT","NEE","NFLX","AMZN","MU","F","NUE","LMT","PLTR","COIN","ZIM"]
UA="CloudTrendResearch/1.0 contact: Jiwoon625@users.noreply.github.com"

def norm_sec_ticker(s):
    return str(s).upper().replace(".","-").replace("/","-")

def main():
    out=Path("analysis-runs/us33-sector-source-probe"); out.mkdir(parents=True,exist_ok=True)
    rows=[]
    for t in TICKERS:
        rec={"symbol":t}
        try:
            info=yf.Ticker(t).get_info()
            rec["yf"]={k:info.get(k) for k in ["symbol","shortName","longName","quoteType","sector","sectorKey","industry","industryKey"]}
        except Exception as e:
            rec["yf_error"]=repr(e)
        rows.append(rec)

    s=requests.Session(); s.headers.update({"User-Agent":UA,"Accept-Encoding":"gzip, deflate"})
    t2c={}
    try:
        idx=s.get("https://www.sec.gov/files/company_tickers.json",timeout=30)
        idx.raise_for_status()
        data=idx.json()
        t2c={norm_sec_ticker(v["ticker"]):int(v["cik_str"]) for v in data.values()}
    except Exception as e:
        for rec in rows:
            rec["sec_index_error"]=repr(e)
    if t2c:
        for rec in rows:
            cik=t2c.get(norm_sec_ticker(rec["symbol"]))
            rec["sec_cik"]=cik
            if not cik: continue
            try:
                u=f"https://data.sec.gov/submissions/CIK{cik:010d}.json"
                r=s.get(u,timeout=30); r.raise_for_status()
                j=r.json()
                rec["sec"]={k:j.get(k) for k in ["name","sic","sicDescription","tickers","exchanges","entityType"]}
                time.sleep(0.15)
            except Exception as e:
                rec["sec_error"]=repr(e)
    (out/"probe.json").write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps(rows,ensure_ascii=False))

if __name__=="__main__":
    main()
