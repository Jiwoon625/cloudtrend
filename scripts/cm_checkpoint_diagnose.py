#!/usr/bin/env python3
"""Read-only integrity diagnosis for CMresearchengine checkpoint chains.

This script is intentionally outside research/cmresearchengine/{vendor,cmresearchengine}
so adding it does not change the strategy resume identity.
"""
from __future__ import annotations
import argparse, hashlib, json, os, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "research/cmresearchengine"))

from cmresearchengine.storage import SupabaseCMStore

HEX64 = re.compile(r"[0-9a-f]{64}\Z")
COMP = re.compile(r"[A-Za-z0-9_-]{1,200}\Z")
SCHEMA = "CM06_FRESH_COMMIT_CHAIN_V1"

def sha(b): return hashlib.sha256(b).hexdigest()

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--plan-hash",required=True)
    p.add_argument("--candidate",required=True)
    p.add_argument("--first-id",required=True)
    args=p.parse_args()
    if not HEX64.fullmatch(args.plan_hash): raise SystemExit("invalid plan hash")
    if not COMP.fullmatch(args.candidate) or not COMP.fullmatch(args.first_id): raise SystemExit("invalid component")

    root=SupabaseCMStore.from_env()
    store=root.scoped_checkpoints(args.plan_hash,args.candidate)
    next_id=args.first_id
    seen=set(); prev=None; expected_identity=None; seq=0
    summary=[]
    while True:
        if next_id in seen:
            print(json.dumps({"status":"CORRUPT","kind":"cycle","sequence":seq+1},sort_keys=True)); return 2
        seen.add(next_id)
        try:
            raw=store.get_bytes(next_id)
        except FileNotFoundError:
            print(json.dumps({"status":"CHAIN_END","verified_sequences":seq,"next_missing":True,
                              "last":summary[-1] if summary else None},sort_keys=True)); return 0
        try: doc=json.loads(raw)
        except Exception:
            print(json.dumps({"status":"CORRUPT","kind":"manifest_unreadable","sequence":seq+1},sort_keys=True)); return 2
        sequence=seq+1
        if doc.get("schema") != SCHEMA:
            print(json.dumps({"status":"CORRUPT","kind":"schema","sequence":sequence},sort_keys=True)); return 2
        identity=doc.get("identity")
        identity_sha=sha(json.dumps(identity,sort_keys=True,separators=(",",":"),ensure_ascii=False,allow_nan=False).encode())
        if expected_identity is None: expected_identity=identity
        elif identity != expected_identity:
            print(json.dumps({"status":"CORRUPT","kind":"identity_changed","sequence":sequence},sort_keys=True)); return 2
        if doc.get("sequence") != sequence:
            print(json.dumps({"status":"CORRUPT","kind":"sequence","sequence":sequence,
                              "observed":doc.get("sequence")},sort_keys=True)); return 2
        if doc.get("previous_sha256") != prev:
            print(json.dumps({"status":"CORRUPT","kind":"previous_sha","sequence":sequence},sort_keys=True)); return 2
        state_id=doc.get("state_id")
        try: state=store.get_bytes(state_id)
        except FileNotFoundError:
            print(json.dumps({"status":"CORRUPT","kind":"state_missing","sequence":sequence},sort_keys=True)); return 2
        expected_size=doc.get("state_size"); expected_sha=doc.get("state_sha256")
        if len(state) != expected_size:
            print(json.dumps({"status":"CORRUPT","kind":"state_size","sequence":sequence,
                              "expected":expected_size,"observed":len(state)},sort_keys=True)); return 2
        actual_sha=sha(state)
        if actual_sha != expected_sha:
            print(json.dumps({"status":"CORRUPT","kind":"state_sha","sequence":sequence},sort_keys=True)); return 2
        summary.append({"sequence":sequence,"processed_events":doc.get("processed_events"),
                        "finished":doc.get("finished"),"state_size":len(state),
                        "identity_sha256":identity_sha})
        prev=sha(raw); seq=sequence
        next_id=doc.get("next_commit_id")
        if not isinstance(next_id,str) or not COMP.fullmatch(next_id):
            print(json.dumps({"status":"CORRUPT","kind":"next_id","sequence":sequence},sort_keys=True)); return 2

if __name__=="__main__":
    raise SystemExit(main())
