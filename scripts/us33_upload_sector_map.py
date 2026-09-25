from __future__ import annotations
import argparse, mimetypes, os
from pathlib import Path
from urllib.parse import quote
import requests

BUCKET="cloudtrend-data"

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--source",required=True)
    p.add_argument("--prefix",default="research/us/v0/sector")
    a=p.parse_args()
    url=os.environ["SUPABASE_URL"].rstrip("/")
    key=os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    uid=os.environ["SUPABASE_USER_ID"]
    src=Path(a.source)
    files=[x for x in src.iterdir() if x.is_file() and x.suffix in {".csv",".json"}]
    for f in files:
        obj=f"{uid}/{a.prefix}/{f.name}"
        endpoint=f"{url}/storage/v1/object/{quote(BUCKET,safe='')}/{quote(obj,safe='/=._-')}"
        h={"Authorization":f"Bearer {key}","apikey":key,"x-upsert":"true",
           "Content-Type":mimetypes.guess_type(f.name)[0] or "application/octet-stream"}
        with f.open("rb") as fh:
            r=requests.post(endpoint,headers=h,data=fh,timeout=(20,300))
        r.raise_for_status()
        print(f"uploaded {obj}")

if __name__=="__main__":
    main()
