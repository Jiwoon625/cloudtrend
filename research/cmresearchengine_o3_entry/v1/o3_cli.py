"""One bounded O3 segment. It never submits or restarts any workflow."""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import sys

from o3_manifest import canonical, digest, manifest, verify_frozen_checkout


def emit(status, **fields):
    print(json.dumps({"status": status, **fields}, sort_keys=True), flush=True)


def request(path):
    value = json.loads(Path(path).read_text())
    if (set(value) != {"schema", "request_id", "mode", "candidate_id", "max_seconds"} or
            value["schema"] != "CM_O3_ENTRY_MANUAL_REQUEST_V1" or value["candidate_id"] != "O3" or
            value["mode"] not in ("preflight", "run") or
            not isinstance(value["request_id"], str) or not re.fullmatch(r"o3-entry-manual-[A-Za-z0-9_-]{1,80}", value["request_id"]) or
            type(value["max_seconds"]) is not int or not 60 <= value["max_seconds"] <= 3000):
        raise ValueError("Invalid bounded O3 request")
    return value


def publish_result(store, plan_hash, prepared, receipt, scoped):
    from cmresearchengine.runner import read_result
    base = f"results/{plan_hash}/O3/"
    writes = {base + "attempts/" + digest(receipt) + ".json": canonical(receipt)}
    if receipt["status"] == "COMPLETED_VERIFIED":
        files = read_result(receipt["completion"], scoped)
        prefix = base + digest(prepared.identity) + "/"
        writes[prefix + "summary.json"] = files["summary.json"]
        # Completion is the last result-index object; the journal was verified first.
        writes[prefix + "completion.json"] = canonical(receipt["completion"])
    for key, raw in writes.items():
        store.put_object(key, raw)
        if store.get_object(key, max_bytes=len(raw)) != raw:
            raise ValueError("O3 immutable result readback mismatch")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request-file", required=True)
    parser.add_argument("--work", required=True)
    args = parser.parse_args(argv)
    spec = request(args.request_file)
    plan = manifest()
    if (plan["contract"]["execution_status"] != "APPROVED_MANUAL_ENTRY_EXTENSION" or
            plan["contract"]["boundary_approval_status"] != "APPROVED_DEFINITION"):
        raise ValueError("O3 definition is still a local proposal")
    verify_frozen_checkout()
    from cmresearchengine import runtime
    from cmresearchengine.ingest import restore_archives, restore_evidence
    from cmresearchengine.storage import SupabaseCMStore
    from cmresearchengine.prepared import PreparedResearch, configuration
    from cmresearchengine.runner import run_strategy
    from cm06.registry import candidate_by_id
    from o3_prepared import PreparedO3
    from o3_audit import verify_and_publish
    store = SupabaseCMStore.from_env()
    if store.verify_private_bucket()["public"] is not False:
        raise ValueError("Private bucket required")
    work = Path(args.work).resolve()
    work.mkdir(parents=True, exist_ok=True)
    restore_archives(store, work)
    restore_evidence(store, runtime.VENDOR)
    prototype = PreparedResearch(configuration(work, runtime.VENDOR, work / "state"), candidate_by_id("S05"))
    if prototype.admitted_event_count != 27:
        raise ValueError("Known event profile changed")
    prepared = PreparedO3.from_prototype(prototype)
    emit("O3_PREFLIGHT_VERIFIED", plan_sha256=plan["definition_sha256"], known_events=27)
    if spec["mode"] == "preflight":
        return 0
    stop = [False]
    signal.signal(signal.SIGTERM, lambda *_: stop.__setitem__(0, True))
    signal.signal(signal.SIGINT, lambda *_: stop.__setitem__(0, True))
    plan_hash = plan["definition_sha256"]
    raw_plan = canonical(plan)
    key = "results/plans/" + plan_hash + ".json"
    store.put_object(key, raw_plan)
    if store.get_object(key, max_bytes=len(raw_plan)) != raw_plan:
        raise ValueError("O3 plan readback mismatch")
    scoped = store.scoped_checkpoints(plan_hash, "O3")
    receipt = run_strategy(prepared, scoped, max_seconds=spec["max_seconds"], stop_requested=lambda: stop[0])
    publish_result(store, plan_hash, prepared, receipt, scoped)
    emit(receipt["status"], candidate_id="O3", checkpoint_sequence=receipt.get("checkpoint_sequence"),
         processed_events=receipt.get("processed_events"))
    if receipt["status"] == "COMPLETED_VERIFIED":
        emit(**verify_and_publish(store, digest(prepared.identity), os.environ))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        # Data, object names, and credentials never enter a public traceback.
        emit("O3_SEGMENT_ERROR", error_type=type(error).__name__)
        sys.exit(2)

