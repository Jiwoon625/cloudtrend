from __future__ import annotations
import argparse, mimetypes, os
from pathlib import Path
from urllib.parse import quote
import requests

BUCKET="cloudtrend-data"

def main():
    p=argparse.ArgumentParser(); p.add_argument("--source",required=True); a=p.parse_args()
    src=Path(a.source)
    url=os.environ["SUPABASE_URL"].rstrip("/"); key=os.environ["SUPABASE_SERVICE_ROLE_KEY"]; uid=os.environ["SUPABASE_USER_ID"]
    run=os.environ.get("GITHUB_RUN_ID","local")
    for f in sorted(src.iterdir()):
        if not f.is_file(): continue
        obj=f"{uid}/results/us33-stage4/{run}/{f.name}"
        ep=f"{url}/storage/v1/object/{quote(BUCKET,safe='')}/{quote(obj,safe='/=._-')}"
        h={"Authorization":f"Bearer {key}","apikey":key,"x-upsert":"true","Content-Type":mimetypes.guess_type(f.name)[0] or "application/octet-stream"}
        with f.open("rb") as fh:
            r=requests.post(ep,headers=h,data=fh,timeout=(20,300)); r.raise_for_status()
        print("uploaded",obj)

if __name__=="__main__": main()
