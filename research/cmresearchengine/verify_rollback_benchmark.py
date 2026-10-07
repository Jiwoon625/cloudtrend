"""Verify bounded rollback benchmark receipts and private completion parity."""
import argparse
import hashlib
import json
from pathlib import Path

BASELINE = {
    "S01": "9034d6987a157ebd169705096ad89f32",
    "S02": "01bb60ba34bf34106fe1a11cd3d80f2f",
    "S03": "3cd8ecb1f1283ddfd45265a6342e72c1",
    "S04": "4928a85513a68dfdef800b93851136f9",
}


def verify_receipts(text):
    records = []
    for line in text.splitlines():
        if not line.startswith("{"):
            continue
        records.append(json.loads(line))
    statuses = {"COMPLETED_VERIFIED", "PAUSED_VERIFIED", "WORKER_EXCEPTION",
                "WORKER_SUBMIT_EXCEPTION", "NOT_STARTED_DEADLINE",
                "NOT_STARTED_STOP_REQUESTED"}
    receipts = [row for row in records if row.get("status") in statuses]
    if sorted(row.get("candidate_id", "") for row in receipts) != sorted(BASELINE):
        raise ValueError("Exactly one terminal receipt for each S01-S04 is required")
    if any(row["status"] not in {"COMPLETED_VERIFIED", "PAUSED_VERIFIED"} for row in receipts):
        raise ValueError("Candidate exception or not-started receipt")
    batches = [row for row in records if row.get("status") == "BATCH_VERIFIED"]
    if len(batches) != 1:
        raise ValueError("Exactly one BATCH_VERIFIED receipt required")
    batch = batches[0]
    completed = sum(row["status"] == "COMPLETED_VERIFIED" for row in receipts)
    expected = {"selected_count": 4, "terminal_receipts_collected": 4,
                "worker_exceptions": 0, "not_started": 0, "parallel_workers": 2,
                "completed_in_selected_batch": completed,
                "remaining_in_selected_batch": 4-completed, "hybrid_2x2": True}
    if any(batch.get(key) != value for key, value in expected.items()):
        raise ValueError("Batch and candidate receipt counts disagree")
    groups = [row for row in records if row.get("status") == "HYBRID_US_ANALYSIS_GROUP_VERIFIED"]
    if sorted(row.get("group_index", -1) for row in groups) != [0, 1]:
        raise ValueError("Both hybrid group statistics are required")
    totals = [row for row in records if row.get("status") == "HYBRID_US_ANALYSIS_VERIFIED"]
    if len(totals) != 1 or totals[0].get("groups") != 2:
        raise ValueError("Combined hybrid statistics are required")
    for key in ("hits", "misses", "row_checks"):
        if totals[0].get(key) != sum(group.get(key, 0) for group in groups):
            raise ValueError("Combined hybrid statistics disagree")
    if totals[0].get("max_cached_rows") != max(group.get("max_cached_rows", 0) for group in groups):
        raise ValueError("Combined cache peak disagrees")
    return completed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--log", required=True)
    parser.add_argument("--work", required=True)
    args = parser.parse_args()
    completed = verify_receipts(Path(args.log).read_text())
    if completed != 4:
        print(json.dumps({"status": "ROLLBACK_GATE_PAUSED", "completed": completed,
                          "terminal_receipts": 4, "safe_same_head_resume": True}), flush=True)
        return 0

    # Credentials are used only by the existing private, scope-restricted store.
    from cmresearchengine import runtime
    from cmresearchengine.cli import HYBRID_SHARED_US_ANALYSIS
    from cmresearchengine.prepared import PreparedResearch, configuration
    from cmresearchengine.plan import manifest
    from cmresearchengine.storage import SupabaseCMStore
    from cmresearchengine.runner import read_result
    from cm06.registry import candidate_by_id
    from cm06_fresh_host_v1 import canonical, digest
    from cm06_fresh_journal_v1 import CandidateJournal

    work = Path(args.work)
    config = configuration(work, runtime.VENDOR, work / "state")
    prototype = PreparedResearch(config, candidate_by_id("S05"),
                                 execution_optimization=HYBRID_SHARED_US_ANALYSIS)
    store = SupabaseCMStore.from_env()
    plan_hash = manifest()["definition_sha256"]
    for candidate_id, expected_etag in BASELINE.items():
        prepared = prototype.clone(candidate_by_id(candidate_id), None)
        identity_digest = digest(prepared.identity)
        scoped = store.scoped_checkpoints(plan_hash, candidate_id)
        journal = CandidateJournal(scoped, "first_"+identity_digest,
                                   "complete_"+identity_digest, prepared.identity)
        completion = journal.completed()
        if not completion:
            raise ValueError("Missing durable completion marker")
        files = read_result(completion, scoped)
        summary = files["summary.json"]
        if hashlib.md5(summary).hexdigest() != expected_etag:
            raise ValueError("Economic summary byte parity mismatch: "+candidate_id)
        key = "results/"+plan_hash+"/"+candidate_id+"/"+identity_digest
        if store.get_object(key+"/summary.json") != summary:
            raise ValueError("Published summary differs from verified output")
        if store.get_object(key+"/completion.json") != canonical(completion):
            raise ValueError("Published and durable completion markers differ")
        print(json.dumps({"status": "ROLLBACK_ECONOMIC_PARITY_VERIFIED",
                          "candidate_id": candidate_id,
                          "summary_etag": expected_etag,
                          "output_sha256_verified": True,
                          "completion_marker_verified": True}), flush=True)
    print(json.dumps({"status": "ROLLBACK_GATE_COMPLETED_VERIFIED",
                      "completed": 4, "summary_parity": 4, "completion_integrity": 4,
                      "throughput_adoption_requires_cumulative_wall_comparison": True}), flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        # Do not publish private response bodies, state, paths or credentials.
        print(json.dumps({"status": "ROLLBACK_GATE_BLOCKED",
                          "error_type": type(exc).__name__}), flush=True)
        raise SystemExit(2)
