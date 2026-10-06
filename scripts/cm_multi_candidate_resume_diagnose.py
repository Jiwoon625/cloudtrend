#!/usr/bin/env python3
"""Read-only resume/step diagnosis for selected CM candidates.

Restores verified private inputs, loads each candidate's latest checkpoint, then
steps in memory only. No checkpoint/result writes and no private row values are
printed.
"""
from __future__ import annotations
import argparse, json, sys, tempfile, traceback
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"research/cmresearchengine"))

from cmresearchengine import runtime
from cmresearchengine.storage import SupabaseCMStore
from cmresearchengine.ingest import restore_archives, restore_evidence
from cmresearchengine.prepared import PreparedResearch, configuration
from cmresearchengine.plan import manifest, candidates
from cm06_fresh_host_v1 import digest
from cm06_fresh_journal_v1 import CandidateJournal

def candidate_by_exact_id(candidate_id):
    for stage in ("base","fine","split25","split10","references"):
        for c in candidates(stage):
            if c.candidate_id == candidate_id:
                return c
    raise KeyError(candidate_id)

def diagnose_one(store, config, plan_hash, candidate_id, step_limit):
    candidate=candidate_by_exact_id(candidate_id)
    prepared=PreparedResearch(config,candidate)
    identity=prepared.identity
    ident=digest(identity)
    journal=CandidateJournal(
        store.scoped_checkpoints(plan_hash,candidate_id),
        "first_"+ident,"complete_"+ident,identity)
    out={"candidate_id":candidate_id,"identity_digest":ident}
    try:
        completed=journal.completed()
        out["completed"]="present" if completed is not None else "none"
    except Exception as exc:
        out.update(status="DIAG_ERROR",step="completed",error_type=type(exc).__name__)
        return out
    try:
        runner=prepared.factory()
        journal.load(runner)
        out.update(load_status="ok",journal_sequence=journal.sequence,
                   start_processed_events=getattr(runner,"_resume_events",None))
    except Exception as exc:
        frames=traceback.extract_tb(exc.__traceback__)
        out.update(status="DIAG_ERROR",step="load",error_type=type(exc).__name__,
                   frames=[{"file":Path(f.filename).name,"function":f.name,"line":f.lineno}
                           for f in frames[-8:]])
        return out
    steps=0
    try:
        while steps < step_limit and runner.step():
            steps += 1
    except Exception as exc:
        frames=traceback.extract_tb(exc.__traceback__)
        out.update(status="STEP_EXCEPTION_REPRODUCED",error_type=type(exc).__name__,
                   steps_after_resume=steps,
                   processed_events_at_error=getattr(runner,"_resume_events",None),
                   frames=[{"file":Path(f.filename).name,"function":f.name,"line":f.lineno}
                           for f in frames[-10:]])
        return out
    out.update(status="NO_EXCEPTION_WITHIN_LIMIT",steps_tested=steps,
               processed_events_after=getattr(runner,"_resume_events",None),
               finished=bool(getattr(runner,"_resume_finished",False)))
    return out

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--candidates",default="S03,S04")
    ap.add_argument("--step-limit",type=int,default=2500)
    args=ap.parse_args()
    ids=[x.strip() for x in args.candidates.split(",") if x.strip()]
    store=SupabaseCMStore.from_env();plan_hash=manifest()["definition_sha256"]
    with tempfile.TemporaryDirectory(prefix="cm-multi-diagnose-") as td:
        work=Path(td)
        restore_archives(store,work)
        restore_evidence(store,runtime.VENDOR)
        config=configuration(work,runtime.VENDOR,work/"state")
        for cid in ids:
            print(json.dumps(diagnose_one(store,config,plan_hash,cid,args.step_limit),
                             sort_keys=True),flush=True)
    return 0

if __name__=="__main__":
    raise SystemExit(main())
