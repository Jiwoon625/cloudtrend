#!/usr/bin/env python3
"""Read-only diagnostic: restore latest S05 checkpoint and step until next exception.

No checkpoint/result writes. Public output is sanitized: no symbols, holdings,
prices, credentials, storage paths, or raw exception values are printed.
"""
from __future__ import annotations
import hashlib,json,sys,tempfile,traceback
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"research/cmresearchengine"))

from cmresearchengine import runtime
from cmresearchengine.storage import SupabaseCMStore
from cmresearchengine.ingest import restore_archives, restore_evidence
from cmresearchengine.prepared import PreparedResearch, configuration
from cmresearchengine.plan import manifest
from cm06.registry import candidate_by_id
from cm06_fresh_host_v1 import digest
from cm06_fresh_journal_v1 import CandidateJournal

SAFE_KEYS={"K","E","U","C","OPEN","CLOSE","REVIEW","SNAPSHOT","FX","CORPORATE_ACTION"}

def main():
    store=SupabaseCMStore.from_env(); plan_hash=manifest()["definition_sha256"]
    with tempfile.TemporaryDirectory(prefix="cm-step-diagnose-") as td:
        work=Path(td)
        restore_archives(store,work); restore_evidence(store,runtime.VENDOR)
        prepared=PreparedResearch(configuration(work,runtime.VENDOR,work/"state"),candidate_by_id("S05"))
        identity=prepared.identity; ident=digest(identity)
        journal=CandidateJournal(store.scoped_checkpoints(plan_hash,"S05"),
            "first_"+ident,"complete_"+ident,identity)
        runner=prepared.factory(); journal.load(runner)
        start=getattr(runner,"_resume_events",0)
        steps=0
        try:
            while steps < 1500 and runner.step():
                steps += 1
        except Exception as exc:
            frames=traceback.extract_tb(exc.__traceback__)
            safe_frames=[{"file":Path(f.filename).name,"function":f.name,"line":f.lineno} for f in frames[-8:]]
            arg=exc.args[0] if exc.args else None
            safe_arg=arg if isinstance(arg,str) and arg in SAFE_KEYS else None
            print(json.dumps({
                "status":"STEP_EXCEPTION_REPRODUCED",
                "error_type":type(exc).__name__,
                "safe_key":safe_arg,
                "error_arg_type":type(arg).__name__ if arg is not None else None,
                "start_processed_events":start,
                "steps_after_resume":steps,
                "processed_events_at_error":getattr(runner,"_resume_events",None),
                "frames":safe_frames,
            },sort_keys=True))
            return 0
        print(json.dumps({
            "status":"NO_EXCEPTION_WITHIN_LIMIT",
            "start_processed_events":start,
            "steps_tested":steps,
            "processed_events_after":getattr(runner,"_resume_events",None),
        },sort_keys=True))
        return 0

if __name__=="__main__":
    raise SystemExit(main())
