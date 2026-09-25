from __future__ import annotations
import argparse, os
from pathlib import Path
from urllib.parse import quote
import requests

BUCKET="cloudtrend-data"

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--remote",default="research/us/v0/sector/us_stock_sector_map_14_v1.csv")
    p.add_argument("--output",required=True)
    a=p.parse_args()
    url=os.environ["SUPABASE_URL"].rstrip("/")
    key=os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    uid=os.environ["SUPABASE_USER_ID"]
    obj=f"{uid}/{a.remote}"
    endpoint=f"{url}/storage/v1/object/authenticated/{quote(BUCKET,safe='')}/{quote(obj,safe='/=._-')}"
    r=requests.get(endpoint,headers={"Authorization":f"Bearer {key}","apikey":key},timeout=(20,300))
    r.raise_for_status()
    out=Path(a.output); out.parent.mkdir(parents=True,exist_ok=True); out.write_bytes(r.content)
    print({"downloaded":obj,"bytes":out.stat().st_size,"output":str(out)})

if __name__=="__main__":
    main()
