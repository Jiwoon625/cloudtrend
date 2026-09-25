from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from urllib.parse import quote

import pandas as pd
import requests

BUCKET = "cloudtrend-data"
USER_PREFIX = "bdfc8818-33a7-4030-9dbd-ecad39f223ac/research/us/v0"

CANDIDATES = [
    "universe/us_stock_master_current_v01.parquet",
    "universe/us_stock_universe_screening_v01.parquet",
    "us_stock_master_current_v01.parquet",
    "us_stock_universe_screening_v01.parquet",
]

def env():
    url = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return url, key

def headers(key):
    return {"Authorization": f"Bearer {key}", "apikey": key}

def download(url, key, rel, dst):
    endpoint = f"{url}/storage/v1/object/authenticated/{quote(BUCKET, safe='')}/{quote(USER_PREFIX + '/' + rel, safe='/=._-')}"
    r = requests.get(endpoint, headers=headers(key), timeout=(20, 300))
    if r.status_code == 404:
        return False
    r.raise_for_status()
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(r.content)
    return True

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--output", required=True)
    a=p.parse_args()
    out=Path(a.output); out.mkdir(parents=True, exist_ok=True)
    url,key=env()
    rows=[]
    for rel in CANDIDATES:
        dst=out/Path(rel).name
        ok=download(url,key,rel,dst)
        rows.append({"path": rel, "found": ok, "size": dst.stat().st_size if ok else None})
        if ok:
            df=pd.read_parquet(dst)
            summary={
                "path":rel,
                "shape":list(df.shape),
                "columns":df.columns.tolist(),
                "dtypes":{c:str(t) for c,t in df.dtypes.items()},
                "sample":df.head(10).astype(object).where(pd.notna(df.head(10)), None).to_dict(orient="records"),
                "distinct_examples":{}
            }
            for c in df.columns:
                lc=c.lower()
                if any(k in lc for k in ["sector","industry","category","type","market","asset","security","name"]):
                    vals=df[c].dropna().astype(str).drop_duplicates().head(30).tolist()
                    summary["distinct_examples"][c]=vals
            (out/(dst.stem+"_schema.json")).write_text(json.dumps(summary,ensure_ascii=False,indent=2,default=str),encoding="utf-8")
    (out/"probe_summary.json").write_text(json.dumps(rows,indent=2),encoding="utf-8")
    print(json.dumps(rows))

if __name__=="__main__":
    main()
