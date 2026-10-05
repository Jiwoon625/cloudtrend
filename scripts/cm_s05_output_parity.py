#!/usr/bin/env python3
"""Read-only parity check between baseline and optimized S05 completed outputs.

Prints only aggregate metrics, hashes and per-file equality. Never prints
holdings, symbols, orders, credentials or raw private rows.
"""
from __future__ import annotations
import hashlib, io, json, zipfile
from cmresearchengine.storage import SupabaseCMStore

PLAN="ce6be8c497e45fa22a41d3a7b924913a23b18588fd05efd33ee14eb961ec7c2c"
CANDIDATE="S05"
BASE="39b9c2183ef161c086c5fa9391cc0d04c45d1f5faefae0eb70124ff27e2245bf"
FAST="f8901f9644e83afa0901d740c7852b6b546ecfe911ff27a3e96998319f16eed2"

def load_completed(store, identity_digest):
    marker_id="complete_"+identity_digest
    marker_raw=store.get_bytes(marker_id)
    marker=json.loads(marker_raw)
    output=store.get_bytes(marker["outputs_id"])
    if len(output)!=marker["outputs_size"] or hashlib.sha256(output).hexdigest()!=marker["outputs_sha256"]:
        raise RuntimeError("completed output integrity mismatch")
    with zipfile.ZipFile(io.BytesIO(output)) as z:
        files={name:z.read(name) for name in z.namelist()}
    return marker,output,files

def safe_summary(files):
    s=json.loads(files["summary.json"])
    p=s.get("performance",{})
    fs=s.get("final_snapshot",{})
    return {
        "processed_events":s.get("processed_events"),
        "proxy_exit_count":s.get("proxy_exit_count"),
        "unresolved_rights_encounter_count":s.get("unresolved_rights_encounter_count"),
        "total_return":p.get("total_return"),
        "cagr":p.get("cagr"),
        "mdd":p.get("mdd"),
        "sharpe":p.get("sharpe"),
        "final_gross_nav_krw":fs.get("gross_nav_krw"),
    }

def main():
    store=SupabaseCMStore.from_env().scoped_checkpoints(PLAN,CANDIDATE)
    bm,bout,bfiles=load_completed(store,BASE)
    fm,fout,ffiles=load_completed(store,FAST)
    names=sorted(set(bfiles)|set(ffiles))
    parity={name:(name in bfiles and name in ffiles and bfiles[name]==ffiles[name]) for name in names}
    bsum=safe_summary(bfiles);fsum=safe_summary(ffiles)
    out={
        "status":"S05_OUTPUT_PARITY",
        "baseline_output_sha256":hashlib.sha256(bout).hexdigest(),
        "optimized_output_sha256":hashlib.sha256(fout).hexdigest(),
        "output_zip_equal":bout==fout,
        "all_files_equal":all(parity.values()),
        "file_count":len(names),
        "file_parity":parity,
        "summary_equal":bsum==fsum,
        "baseline_summary":bsum,
        "optimized_summary":fsum,
    }
    print(json.dumps(out,sort_keys=True,default=str))
    return 0 if out["all_files_equal"] and out["summary_equal"] else 2

if __name__=="__main__":
    raise SystemExit(main())
