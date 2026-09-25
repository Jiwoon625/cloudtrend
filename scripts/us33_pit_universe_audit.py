from __future__ import annotations
import io, json, time
from pathlib import Path
import pandas as pd
import requests
import yfinance as yf

BASE="https://www.alphavantage.co/query"
KNOWN=["TWTR","ATVI","VMW","FRC","SIVB"]

def fetch_listing(state):
    r=requests.get(BASE,params={"function":"LISTING_STATUS","state":state,"apikey":"demo"},timeout=60)
    r.raise_for_status()
    text=r.text
    if "Information" in text[:500] or "Thank you for using Alpha Vantage" in text[:500]:
        raise RuntimeError(text[:1000])
    df=pd.read_csv(io.StringIO(text))
    df.columns=[c.strip() for c in df.columns]
    return df

def yf_probe(symbol):
    out={"symbol":symbol}
    try:
        h=yf.Ticker(symbol).history(start="2016-01-01",end="2026-09-26",auto_adjust=False)
        out.update({
            "rows":int(len(h)),
            "minDate":str(h.index.min().date()) if len(h) else None,
            "maxDate":str(h.index.max().date()) if len(h) else None,
            "has2017":bool(len(h.loc["2017":"2017"])) if len(h) else False,
            "has2020":bool(len(h.loc["2020":"2020"])) if len(h) else False,
        })
    except Exception as e:
        out["error"]=repr(e)
    return out

def main():
    out=Path("analysis-runs/us33-pit-audit"); out.mkdir(parents=True,exist_ok=True)
    qa={"alphaVantage":{},"yfinanceProbe":[]}
    try:
        active=fetch_listing("active"); active.to_csv(out/"alpha_active_latest.csv",index=False)
        time.sleep(1)
        delisted=fetch_listing("delisted"); delisted.to_csv(out/"alpha_delisted_latest.csv",index=False)
        qa["alphaVantage"]={
            "activeRows":len(active),"delistedRows":len(delisted),
            "activeColumns":active.columns.tolist(),"delistedColumns":delisted.columns.tolist(),
        }
        for s in KNOWN:
            rows=delisted[delisted["symbol"].astype(str).str.upper()==s] if "symbol" in delisted.columns else pd.DataFrame()
            qa["alphaVantage"][f"known_{s}"]=rows.to_dict(orient="records")[:2]
        combined=pd.concat([active.assign(sourceState="active"),delisted.assign(sourceState="delisted")],ignore_index=True)
        combined.to_csv(out/"pit_universe_master_alpha.csv",index=False)
        # recent delisted stock sample for price recoverability
        sample=KNOWN[:]
        if "assetType" in delisted.columns:
            ds=delisted[delisted.assetType.astype(str).str.lower().eq("stock")].copy()
        else: ds=delisted.copy()
        if "delistingDate" in ds.columns:
            ds["delistingDateParsed"]=pd.to_datetime(ds.delistingDate,errors="coerce")
            ds=ds.sort_values("delistingDateParsed",ascending=False)
        for s in ds["symbol"].astype(str).head(15).tolist() if "symbol" in ds.columns else []:
            if s not in sample: sample.append(s)
        for s in sample[:20]:
            qa["yfinanceProbe"].append(yf_probe(s))
    except Exception as e:
        qa["alphaVantageError"]=repr(e)
    (out/"pit_audit.json").write_text(json.dumps(qa,ensure_ascii=False,indent=2,default=str),encoding="utf-8")
    print(json.dumps(qa,ensure_ascii=False,default=str))

if __name__=="__main__": main()
