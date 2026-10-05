#!/usr/bin/env python3
"""Deep read-only resume diagnosis using the exact CMresearchengine preparation path."""
from __future__ import annotations
import hashlib, json, sys, tempfile
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

def main():
    store=SupabaseCMStore.from_env()
    plan_hash=manifest()["definition_sha256"]
    with tempfile.TemporaryDirectory(prefix="cm-resume-diagnose-") as td:
        work=Path(td)
        source_manifest=restore_archives(store,work)
        restore_evidence(store,runtime.VENDOR)
        config=configuration(work,runtime.VENDOR,work/"state")
        prepared=PreparedResearch(config,candidate_by_id("S05"))
        identity=prepared.identity
        identity_digest=digest(identity)
        scoped=store.scoped_checkpoints(plan_hash,"S05")
        journal=CandidateJournal(scoped,"first_"+identity_digest,"complete_"+identity_digest,identity)
        out={"status":"DEEP_DIAGNOSE","identity_digest":identity_digest,
             "source_manifest_sha256":hashlib.sha256(json.dumps(source_manifest,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()).hexdigest()}
        try:
            completed=journal.completed()
            out["completed_call"]="none" if completed is None else "present"
        except Exception as exc:
            out.update(step="completed",error_type=type(exc).__name__,error=str(exc))
            print(json.dumps(out,sort_keys=True));return 2
        try:
            runner=prepared.factory()
            journal.load(runner)
            out.update(step="load",journal_sequence=journal.sequence,
                       processed_events=getattr(runner,"_resume_events",None),
                       load_status="ok")
        except Exception as exc:
            out.update(step="load",error_type=type(exc).__name__,error=str(exc),
                       journal_sequence=getattr(journal,"sequence",None))
            print(json.dumps(out,sort_keys=True));return 2
        print(json.dumps(out,sort_keys=True));return 0

if __name__=="__main__":
    raise SystemExit(main())
