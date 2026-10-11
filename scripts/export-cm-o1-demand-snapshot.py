"""Read pinned CM results/calendars; publish only a private O1 target summary.

No strategy execution, source restoration, credential change, or raw log export.
The as-of policy evaluation is explicitly distinct from an executed month review.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import runpy
import tarfile

import pandas as pd

PLAN = "ce6be8c497e45fa22a41d3a7b924913a23b18588fd05efd33ee14eb961ec7c2c"
SCHEMA = "CM_O1_PRIVATE_DEMAND_SNAPSHOT_V1"
SOURCES = {
    "O1": ("39ecd66d6c80546b404c1ed77503c3dc33abf4817549fa9d4e9e4e5682f124b5", "73470903434fa0263ff3b9fc0f0f1e7f38f115fdd9c641f9c32e0c979aac2710"),
    "REF_K": ("8f401d3a503d062a3f7cf9039724bdf4d7a30cb6567f9299e4de01208fdc39cb", "23b5f42bc225a22b59b5b486d341459a0711f457fd481e873d39648ea23c1569"),
    "REF_E": ("1e831f27951622f1f91495fc603f7791842de82ddcc9f23bc6cdb9bfb56b000a", "7b38bf7ef329ba3b90c783899d376ab77e66f2f9930476e2994e61459a4f35a2"),
    "REF_U": ("ad1eefe33e36ddbe043e357356aed6c2651577a72d4c414eae6ffcb10f0c9330", "c5649bbd2bb8f7fd39f8804fe57e596dfa037c153c769ad44600311f132d7110"),
}
MAX_BYTES = 8192
SCOPE = "Historical research targets only; no current signal or actual holdings inference"
POLICY_CONTRACT = "First eligible record per engine/demand_id; positive amount in each market's last20 open sessions; any-demand O1 equal split; cap60%; excess central cash"
HISTORY_SCHEMA = "CM_O1_PRIVATE_MONTHLY_ZERO_SUMMARY_V1"
HISTORY_SCOPE = "All recorded historical month reviews; BUY means positive executed fill events in the same last20 market-session window, not the target signal"


class SnapshotError(RuntimeError):
    """Only fixed codes are safe to expose in a public Actions job."""


def require(condition, code):
    if not condition:
        raise SnapshotError(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def verified_result(store, candidate):
    from cmresearchengine import runtime
    from cmresearchengine.runner import read_result
    identity, expected_zip = SOURCES[candidate]
    source = f"results/{PLAN}/{candidate}/{identity}/"
    completion_raw = store.get_object(source + "completion.json", max_bytes=1000000)
    summary_raw = store.get_object(source + "summary.json", max_bytes=1000000)
    checkpoint = store.scoped_checkpoints(PLAN, candidate)
    require(checkpoint.get_bytes("complete_" + identity) == completion_raw, "COMPLETION_MARKER_MISMATCH")
    completion = json.loads(completion_raw)
    require(completion.get("schema") == "CM06_FRESH_COMPLETED_V1" and
            sha(canonical(completion["identity"])) == identity, "COMPLETION_IDENTITY_MISMATCH")
    descriptor = completion["identity"]
    require(descriptor["candidate"]["candidate_id"] == candidate and descriptor["plan_sha256"] == PLAN,
            "SOURCE_CANDIDATE_MISMATCH")
    require(descriptor["code_hashes"] == runtime.code_hashes(), "FROZEN_ENGINE_CODE_CHANGED")
    require(completion["outputs_sha256"] == expected_zip, "PINNED_ZIP_MISMATCH")
    files = read_result(completion, checkpoint)
    require(files["summary.json"] == summary_raw, "SUMMARY_BYTES_MISMATCH")
    manifest = json.loads(files["file_manifest.json"])["files"]
    require(set(manifest) == set(files) - {"file_manifest.json"}, "FILE_SET_MISMATCH")
    for name, record in manifest.items():
        require(len(files[name]) == record["size"] and sha(files[name]) == record["sha256"], "FILE_HASH_MISMATCH")
    summary = json.loads(summary_raw)
    require(summary["candidate_id"] == candidate and summary["evaluation_start"] == "2017-08-21" and
            summary["evaluation_end"] == "2026-09-11", "PERIOD_OR_CANDIDATE_CHANGED")
    require(summary["execution_contract"] == descriptor["execution"], "EXECUTION_CONTRACT_MISMATCH")
    require(summary["ordinary_and_proxy_sales_share_one_way_fee"] == "0.0015", "COST_CONTRACT_CHANGED")
    if candidate.startswith("REF_"):
        require(summary["execution_contract"]["cash_movement"] == "NONE", "REFERENCE_FEEDBACK_FOUND")
    return files


def verified_calendars(store):
    from cmresearchengine.ingest import FROZEN_STAGES, REFERENCE_ROOT, validate_stage
    expected = next(x for x in FROZEN_STAGES if x["stage"] == "Stage2_reference_time")
    raw = store.get_object("inputs/cm06.batched.stage.Stage2_reference_time.json", max_bytes=2 * 1024 * 1024)
    doc, records = validate_stage(raw, expected)
    require(len(doc["archives"]) == 1, "REFERENCE_ARCHIVE_COUNT_CHANGED")
    record = doc["archives"][0]
    require(record["size"] <= 16 * 1024 * 1024, "REFERENCE_ARCHIVE_TOO_LARGE")
    key = "inputs/cm06.batched.Stage2_reference_time." + record["sha256"] + ".tar"
    archive_raw = store.get_object(key, max_bytes=record["size"])
    require(len(archive_raw) == record["size"] and sha(archive_raw) == record["sha256"], "REFERENCE_ARCHIVE_HASH_MISMATCH")
    calendars, hashes = {}, {}
    with tarfile.open(fileobj=io.BytesIO(archive_raw), mode="r:") as archive:
        names = archive.getnames()
        require(len(names) == len(set(names)), "DUPLICATE_REFERENCE_MEMBER")
        for engine in "KEU":
            name = REFERENCE_ROOT + f"data/reference_time/{engine}_calendar.json"
            member = archive.getmember(name)
            require(member.isfile() and member.size == records[name]["size"], "INVALID_CALENDAR_MEMBER")
            data = archive.extractfile(member).read()
            require(sha(data) == records[name]["sha256"], "CALENDAR_HASH_MISMATCH")
            rows = json.loads(data)
            require(isinstance(rows, list) and rows, "INVALID_CALENDAR")
            times = pd.DatetimeIndex(pd.to_datetime([x["open_at"] for x in rows], utc=True))
            require(not times.has_duplicates and times.is_monotonic_increasing, "INVALID_CALENDAR_ORDER")
            calendars[engine] = rows
            hashes[engine] = sha(data)
    return calendars, {"stage_sha256": expected["sha256"], "archive_sha256": record["sha256"], "calendars_sha256": hashes}


def clean_weights(value):
    require(set(value) == set("KEUC"), "TARGET_KEYS_CHANGED")
    result = {k: float(value[k]) for k in "KEUC"}
    require(all(math.isfinite(v) and 0 <= v <= 1 for v in result.values()) and
            math.isclose(sum(result.values()), 1, abs_tol=1e-10), "INVALID_TARGET_WEIGHTS")
    require(all(result[e] <= 0.60 + 1e-12 for e in "KEU"), "TARGET_CAP_EXCEEDED")
    return result


def equal_weights(left, right):
    return all(math.isclose(left[k], right[k], rel_tol=1e-10, abs_tol=1e-12) for k in "KEUC")


def evaluate(cutoff, references, calendars):
    from cm06.policies import policy_target
    sessions = {e: [x["open_at"] for x in calendars[e]] for e in "KEU"}
    result = policy_target("O1", references["nav"], cutoff, demand_events=references["demands"],
                           reference_capital=references["capital"], engine_sessions=sessions)
    diagnostics = result.diagnostics
    require(diagnostics["status"] == "ok" and diagnostics["fallback"] is False, "O1_DERIVATION_FALLBACK")
    counts = diagnostics["demand_unique_positive_counts"]
    require(set(counts) == set("KEU") and all(type(n) is int and n >= 0 for n in counts.values()), "INVALID_DEMAND_COUNTS")
    window = {}
    for e in "KEU":
        rows = [x for x in calendars[e] if pd.Timestamp(x["open_at"]) <= cutoff][-20:]
        require(len(rows) == 20, "MISSING_SESSION_WINDOW")
        require(all(pd.Timestamp(x["close_available_at"]) <= cutoff for x in rows), "SELECTED_SESSION_NOT_CLOSED")
        window[e] = {"count": 20, "first": rows[0]["session_date"], "last": rows[-1]["session_date"]}
    return {"cutoff": cutoff.isoformat(), "session_windows": window,
            "unique_positive_demand_counts": counts, "active_engines": [e for e in "KEU" if counts[e] > 0],
            "weights": clean_weights(result.weights), "fallback": False}


def derive_snapshot(o1_files, reference_files, calendars, calendar_sources, context):
    from cmresearchengine.runner import build_references
    references = build_references(reference_files)
    nav = pd.read_csv(io.BytesIO(o1_files["nav.csv"]))
    dates = pd.DatetimeIndex(pd.to_datetime(nav["at"], utc=True))
    require(len(nav) > 0 and dates.is_monotonic_increasing and not dates.has_duplicates, "INVALID_O1_NAV_GRID")
    cutoff = dates[-1]
    require(cutoff.date().isoformat() == "2026-09-11" and
            all(pd.Timestamp(references["nav"][e].index[-1]) == cutoff for e in "KEU"), "LAST_CUTOFF_CHANGED")
    reviews = json.loads(o1_files["reviews.json"])
    require(isinstance(reviews, list) and reviews, "NO_MONTHLY_REVIEW")
    times = pd.DatetimeIndex([pd.Timestamp(x["at"]) for x in reviews])
    require(times.is_monotonic_increasing and not times.has_duplicates and times[-1] <= cutoff,
            "INVALID_MONTHLY_REVIEW_ORDER")
    actual = reviews[-1]
    require(all(x["policy"]["policy_id"] == "O1" for x in reviews), "MONTHLY_POLICY_CHANGED")
    valid_reviews = [x for x in reviews if x["policy"]["status"] == "ok" and x["policy"]["fallback"] is False]
    require(valid_reviews, "NO_VALID_MONTHLY_REVIEW")
    valid = valid_reviews[-1]
    monthly = evaluate(pd.Timestamp(valid["at"]), references, calendars)
    valid_recorded = clean_weights(valid["movement"]["targets"])
    recorded = clean_weights(actual["movement"]["targets"])
    last_nav_target = clean_weights({e: nav.iloc[-1]["target_" + e] for e in "KEUC"})
    require(equal_weights(monthly["weights"], valid_recorded) and equal_weights(recorded, last_nav_target),
            "MONTHLY_TARGET_RECONCILIATION_FAILED")
    require(monthly["unique_positive_demand_counts"] == valid["policy"]["demand_unique_positive_counts"],
            "MONTHLY_DEMAND_RECONCILIATION_FAILED")
    if actual is not valid:
        require(actual["policy"]["fallback"] is True and equal_weights(recorded, valid_recorded),
                "LAST_FALLBACK_TARGET_NOT_RETAINED")
    monthly.update({"month": valid["month"], "recorded_target_verified": True})
    effective = {"cutoff": times[-1].isoformat(), "month": actual["month"], "weights": recorded,
                 "fallback": actual["policy"]["fallback"], "last_nav_target_verified": True,
                 "same_as_last_valid_review": actual is valid}
    virtual = evaluate(cutoff, references, calendars)
    virtual["is_executed_monthly_review"] = False
    require(times[-1] < cutoff, "ASOF_AND_MONTHLY_CUTOFF_NOT_DISTINCT")
    return {"schema": SCHEMA, "status": "PRIVATE_O1_DEMAND_SNAPSHOT_VERIFIED", "plan_sha256": PLAN,
            "candidate_id": "O1", "identity": SOURCES["O1"][0], "audit": context,
            "source_results": {k: {"identity": v[0], "zip_sha256": v[1]} for k, v in SOURCES.items()},
            "calendar_sources": calendar_sources, "virtual_asof": virtual,
            "actual_last_monthly": effective, "last_valid_monthly_calculation": monthly,
            "scope": SCOPE, "policy_contract": POLICY_CONTRACT}


def validate_report(report):
    require(set(report) == {"schema", "status", "plan_sha256", "candidate_id", "identity", "audit", "source_results",
                            "calendar_sources", "virtual_asof", "actual_last_monthly", "last_valid_monthly_calculation",
                            "scope", "policy_contract"}, "REPORT_FIELDS_CHANGED")
    require(report["schema"] == SCHEMA and report["status"] == "PRIVATE_O1_DEMAND_SNAPSHOT_VERIFIED" and
            report["plan_sha256"] == PLAN and report["candidate_id"] == "O1" and report["identity"] == SOURCES["O1"][0] and
            report["scope"] == SCOPE and report["policy_contract"] == POLICY_CONTRACT, "REPORT_IDENTITY_CHANGED")
    require(report["source_results"] == {k: {"identity": v[0], "zip_sha256": v[1]} for k, v in SOURCES.items()},
            "REPORT_SOURCE_PINS_CHANGED")
    audit = report["audit"]
    require(set(audit) == {"run_id", "attempt", "commit"} and isinstance(audit["run_id"], str) and
            re.fullmatch(r"[1-9][0-9]*", audit["run_id"]) and type(audit["attempt"]) is int and audit["attempt"] > 0 and
            isinstance(audit["commit"], str) and re.fullmatch(r"[0-9a-f]{40}", audit["commit"]), "INVALID_AUDIT_CONTEXT")
    source = report["calendar_sources"]
    require(set(source) == {"stage_sha256", "archive_sha256", "calendars_sha256"} and
            source["stage_sha256"] == "5ffb9c2c8c7ff280d68d4abaea26917287f813f7c191373c90211b99e1f53f73" and
            source["archive_sha256"] == "1272caccc39531d4db2bc958570775bc6a002778c923d9e15e3b4adbb35a6c8a" and
            set(source["calendars_sha256"]) == set("KEU") and
            all(isinstance(v, str) and re.fullmatch(r"[0-9a-f]{64}", v) for v in source["calendars_sha256"].values()),
            "INVALID_CALENDAR_SOURCE_FIELDS")

    def timestamp(value):
        require(isinstance(value, str) and re.fullmatch(r"202[0-6]-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.]\d+)?[+]00:00", value),
                "INVALID_SUMMARY_TIMESTAMP")
        return pd.Timestamp(value)

    def weights(value):
        require(all(type(x) is float for x in value.values()), "INVALID_WEIGHT_TYPE")
        clean_weights(value)

    for field, extra in (("virtual_asof", {"is_executed_monthly_review"}),
                         ("last_valid_monthly_calculation", {"month", "recorded_target_verified"})):
        value = report[field]
        require(set(value) == {"cutoff", "session_windows", "unique_positive_demand_counts", "active_engines", "weights", "fallback"} | extra,
                "INVALID_DERIVED_FIELDS")
        cutoff = timestamp(value["cutoff"])
        require(value["fallback"] is False and set(value["session_windows"]) == set("KEU") and
                set(value["unique_positive_demand_counts"]) == set("KEU"), "INVALID_DERIVED_CONTRACT")
        for engine, window in value["session_windows"].items():
            require(set(window) == {"count", "first", "last"} and type(window["count"]) is int and window["count"] == 20,
                    "INVALID_WINDOW_FIELDS")
            require(all(isinstance(window[k], str) and re.fullmatch(r"202[0-6]-[0-9]{2}-[0-9]{2}", window[k]) for k in ("first", "last")) and
                    window["first"] <= window["last"] <= cutoff.date().isoformat(), "INVALID_WINDOW_DATES")
            n = value["unique_positive_demand_counts"][engine]
            require(type(n) is int and 0 <= n <= 10000000, "INVALID_SUMMARY_COUNT")
        require(value["active_engines"] == [e for e in "KEU" if value["unique_positive_demand_counts"][e] > 0],
                "ACTIVE_ENGINES_MISMATCH")
        weights(value["weights"])
        if field == "virtual_asof":
            require(value["is_executed_monthly_review"] is False and cutoff.date().isoformat() == "2026-09-11", "INVALID_VIRTUAL_CUTOFF")
        else:
            require(value["recorded_target_verified"] is True and isinstance(value["month"], str) and
                    re.fullmatch(r"202[0-6]-[0-9]{2}", value["month"]), "INVALID_VALID_MONTHLY_FIELDS")
    actual = report["actual_last_monthly"]
    require(set(actual) == {"cutoff", "month", "weights", "fallback", "last_nav_target_verified", "same_as_last_valid_review"} and
            isinstance(actual["month"], str) and re.fullmatch(r"202[0-6]-[0-9]{2}", actual["month"]) and
            type(actual["fallback"]) is bool and type(actual["same_as_last_valid_review"]) is bool and
            actual["last_nav_target_verified"] is True, "INVALID_ACTUAL_MONTHLY_FIELDS")
    weights(actual["weights"])
    require(timestamp(report["last_valid_monthly_calculation"]["cutoff"]) <= timestamp(actual["cutoff"]) <
            timestamp(report["virtual_asof"]["cutoff"]), "INVALID_REVIEW_TIMELINE")


def derive_monthly_history(o1_files, reference_files, calendars, calendar_sources, context):
    from cmresearchengine.runner import build_references
    from cm06.policies import policy_target
    references = build_references(reference_files)
    reviews = json.loads(o1_files["reviews.json"])
    require(isinstance(reviews, list) and reviews, "NO_MONTHLY_REVIEW")
    times = pd.DatetimeIndex([pd.Timestamp(row["at"]) for row in reviews])
    require(times.is_monotonic_increasing and not times.has_duplicates, "INVALID_MONTHLY_REVIEW_ORDER")
    require(len({row["month"] for row in reviews}) == len(reviews), "DUPLICATE_MONTHLY_REVIEW")
    sessions = {e: [row["open_at"] for row in calendars[e]] for e in "KEU"}

    def buys(files):
        events = pd.read_csv(io.BytesIO(files["events.csv"]))
        require({"at", "kind", "sleeve", "quantity", "id"}.issubset(events.columns), "BUY_EVENT_COLUMNS_MISSING")
        selected = events.loc[events["kind"].eq("BUY")].copy()
        require(not selected["id"].isna().any() and not selected["id"].duplicated().any(), "DUPLICATE_BUY_EVENT")
        require(selected["sleeve"].isin(list("KEU")).all(), "UNKNOWN_BUY_SLEEVE")
        quantity = pd.to_numeric(selected["quantity"], errors="raise")
        require((quantity > 0).all(), "NONPOSITIVE_BUY_FILL")
        selected["at"] = pd.to_datetime(selected["at"], utc=True)
        return selected

    o1_buys = buys(o1_files)
    ref_buys = {e: buys(reference_files[e]) for e in "KEU"}
    keys = ("zero_target_reviews", "zero_demand_valid_reviews", "zero_o1_buys_valid_reviews",
            "zero_ref_buys_valid_reviews", "nonzero_target_zero_o1_buys_valid_reviews",
            "positive_demand_zero_ref_buys_valid_reviews")
    stats = {e: {**dict.fromkeys(keys, 0), "zero_target_examples": [], "nonzero_target_zero_o1_buys_examples": []}
             for e in "KEU"}
    previous = {"K": 1/3, "E": 1/3, "U": 1/3, "C": 0.}
    valid_count = fallback_count = 0
    for review, cutoff in zip(reviews, times):
        recorded = clean_weights(review["movement"]["targets"])
        policy = review["policy"]
        require(policy["policy_id"] == "O1", "MONTHLY_POLICY_CHANGED")
        expected = policy_target("O1", references["nav"], cutoff, previous,
            demand_events=references["demands"], reference_capital=references["capital"], engine_sessions=sessions)
        require(equal_weights(recorded, clean_weights(expected.weights)) and
                policy["fallback"] == expected.diagnostics["fallback"], "HISTORICAL_TARGET_RECONCILIATION_FAILED")
        for e in "KEU":
            stats[e]["zero_target_reviews"] += int(recorded[e] == 0)
        if policy["fallback"]:
            fallback_count += 1
            require(equal_weights(recorded, previous), "HISTORICAL_FALLBACK_TARGET_CHANGED")
            previous = recorded
            continue
        valid_count += 1
        derived = evaluate(cutoff, references, calendars)
        counts = derived["unique_positive_demand_counts"]
        require(policy["status"] == "ok" and counts == policy["demand_unique_positive_counts"],
                "HISTORICAL_DEMAND_RECONCILIATION_FAILED")
        for e in "KEU":
            require((recorded[e] == 0) == (counts[e] == 0), "ZERO_TARGET_DEMAND_MISMATCH")
            window = [row for row in calendars[e] if pd.Timestamp(row["open_at"]) <= cutoff][-20:]
            first = pd.Timestamp(window[0]["open_at"])
            def count_fills(frame):
                return int((frame["sleeve"].eq(e) & frame["at"].ge(first) & frame["at"].le(cutoff)).sum())
            own_count, ref_count = count_fills(o1_buys), count_fills(ref_buys[e])
            stat = stats[e]
            stat["zero_demand_valid_reviews"] += int(counts[e] == 0)
            stat["zero_o1_buys_valid_reviews"] += int(own_count == 0)
            stat["zero_ref_buys_valid_reviews"] += int(ref_count == 0)
            stat["nonzero_target_zero_o1_buys_valid_reviews"] += int(recorded[e] > 0 and own_count == 0)
            stat["positive_demand_zero_ref_buys_valid_reviews"] += int(counts[e] > 0 and ref_count == 0)
            example = {"month": review["month"], "window_first": window[0]["session_date"],
                       "window_last": window[-1]["session_date"], "demands": counts[e],
                       "target": recorded[e], "o1_buys": own_count, "ref_buys": ref_count}
            if recorded[e] == 0 and len(stat["zero_target_examples"]) < 3:
                stat["zero_target_examples"].append(example)
            if recorded[e] > 0 and own_count == 0 and len(stat["nonzero_target_zero_o1_buys_examples"]) < 2:
                stat["nonzero_target_zero_o1_buys_examples"].append(example)
        previous = recorded
    return {"schema": HISTORY_SCHEMA, "status": "PRIVATE_O1_MONTHLY_ZERO_SUMMARY_VERIFIED",
            "plan_sha256": PLAN, "candidate_id": "O1", "identity": SOURCES["O1"][0], "audit": context,
            "source_results": {k: {"identity": v[0], "zip_sha256": v[1]} for k, v in SOURCES.items()},
            "review_count": len(reviews), "valid_review_count": valid_count, "fallback_review_count": fallback_count,
            "first_review_month": reviews[0]["month"], "last_review_month": reviews[-1]["month"],
            "markets": stats, "all_valid_targets_reconciled": True, "scope": HISTORY_SCOPE}


def validate_history_report(report):
    require(set(report) == {"schema", "status", "plan_sha256", "candidate_id", "identity", "audit", "source_results",
            "review_count", "valid_review_count", "fallback_review_count", "first_review_month", "last_review_month",
            "markets", "all_valid_targets_reconciled", "scope"}, "HISTORY_FIELDS_CHANGED")
    require(report["schema"] == HISTORY_SCHEMA and report["status"] == "PRIVATE_O1_MONTHLY_ZERO_SUMMARY_VERIFIED" and
            report["plan_sha256"] == PLAN and report["candidate_id"] == "O1" and report["identity"] == SOURCES["O1"][0] and
            report["all_valid_targets_reconciled"] is True and report["scope"] == HISTORY_SCOPE, "HISTORY_IDENTITY_CHANGED")
    require(report["source_results"] == {k: {"identity": v[0], "zip_sha256": v[1]} for k, v in SOURCES.items()},
            "HISTORY_SOURCE_PINS_CHANGED")
    audit = report["audit"]
    require(set(audit) == {"run_id", "attempt", "commit"} and isinstance(audit["run_id"], str) and
            re.fullmatch(r"[1-9][0-9]*", audit["run_id"]) and type(audit["attempt"]) is int and audit["attempt"] > 0 and
            isinstance(audit["commit"], str) and re.fullmatch(r"[0-9a-f]{40}", audit["commit"]), "INVALID_AUDIT_CONTEXT")
    total = report["review_count"]
    require(type(total) is int and 0 < total < 200 and
            all(type(report[k]) is int and 0 <= report[k] <= total for k in ("valid_review_count", "fallback_review_count")) and
            total == report["valid_review_count"] + report["fallback_review_count"], "INVALID_HISTORY_COUNTS")
    def month(value):
        return isinstance(value, str) and re.fullmatch(r"20(?:1[7-9]|2[0-6])-(?:0[1-9]|1[0-2])", value)
    require(month(report["first_review_month"]) and month(report["last_review_month"]) and
            report["first_review_month"] <= report["last_review_month"], "INVALID_HISTORY_MONTHS")
    require(set(report["markets"]) == set("KEU"), "INVALID_HISTORY_MARKETS")
    count_keys = {"zero_target_reviews", "zero_demand_valid_reviews", "zero_o1_buys_valid_reviews",
                  "zero_ref_buys_valid_reviews", "nonzero_target_zero_o1_buys_valid_reviews",
                  "positive_demand_zero_ref_buys_valid_reviews"}
    for stat in report["markets"].values():
        require(set(stat) == count_keys | {"zero_target_examples", "nonzero_target_zero_o1_buys_examples"} and
                all(type(stat[k]) is int and 0 <= stat[k] <= total for k in count_keys), "INVALID_HISTORY_STAT_FIELDS")
        for field, limit in (("zero_target_examples", 3), ("nonzero_target_zero_o1_buys_examples", 2)):
            examples = stat[field]
            require(isinstance(examples, list) and len(examples) <= limit, "INVALID_HISTORY_EXAMPLE_COUNT")
            for example in examples:
                require(set(example) == {"month", "window_first", "window_last", "demands", "target", "o1_buys", "ref_buys"} and
                        month(example["month"]) and report["first_review_month"] <= example["month"] <= report["last_review_month"],
                        "INVALID_HISTORY_EXAMPLE_FIELDS")
                require(all(type(example[k]) is int and 0 <= example[k] < 10000000 for k in ("demands", "o1_buys", "ref_buys")) and
                        type(example["target"]) is float and math.isfinite(example["target"]) and 0 <= example["target"] <= .6,
                        "INVALID_HISTORY_EXAMPLE_VALUES")
                require(all(isinstance(example[k], str) and re.fullmatch(r"20(?:1[7-9]|2[0-6])-[0-9]{2}-[0-9]{2}", example[k])
                            for k in ("window_first", "window_last")) and example["window_first"] <= example["window_last"],
                        "INVALID_HISTORY_WINDOW")
                require((example["target"] == 0 and example["demands"] == 0) if field == "zero_target_examples" else
                        (example["target"] > 0 and example["demands"] > 0 and example["o1_buys"] == 0), "INVALID_HISTORY_EXAMPLE_MEANING")


def publish(store, report):
    from cmresearchengine.storage import _DuplicateObject, ImmutableConflict
    if report.get("schema") == HISTORY_SCHEMA:
        validate_history_report(report)
    else:
        validate_report(report)
    raw = canonical(report)
    digest = sha(raw)
    metadata = {**report, "report_sha256": digest}
    header = base64.b64encode(canonical(metadata)).decode("ascii")
    require(len(raw) <= MAX_BYTES and len(header) <= MAX_BYTES, "PRIVATE_SUMMARY_TOO_LARGE")
    require(store.verify_private_bucket()["public"] is False, "PRIVATE_BUCKET_REQUIRED")
    target = f"results/reports/o1-demand-snapshot/{PLAN}/O1/{report['identity']}/{digest}.json"
    try:
        existing = store.get_object(target, max_bytes=len(raw))
    except FileNotFoundError:
        existing = None
    if existing is not None:
        if existing != raw:
            raise ImmutableConflict("Private report conflict")
        return digest
    try:
        store._request("POST", store._object_route(target), lambda response: store._bounded(response, 65536),
                       data=raw, headers={"Content-Type": "application/octet-stream", "x-upsert": "false", "x-metadata": header})
    except _DuplicateObject:
        pass
    require(store.get_object(target, max_bytes=len(raw)) == raw, "PRIVATE_REPORT_READBACK_MISMATCH")
    return digest


def export_snapshot(*, accounting_audit_passed, store=None, environ=None):
    require(accounting_audit_passed is True, "ACCOUNTING_AUDIT_REQUIRED")
    from cmresearchengine.storage import SupabaseCMStore
    helper = runpy.run_path(str(Path(__file__).with_name("export-cm-audited-report.py")))
    context = helper["github_context"](os.environ if environ is None else environ)
    store = SupabaseCMStore.from_env() if store is None else store
    require(store.verify_private_bucket()["public"] is False, "PRIVATE_BUCKET_REQUIRED")
    files = {candidate: verified_result(store, candidate) for candidate in SOURCES}
    calendars, calendar_sources = verified_calendars(store)
    report = derive_snapshot(files["O1"], {e: files["REF_" + e] for e in "KEU"}, calendars, calendar_sources, context)
    publish(store, report)
    history = derive_monthly_history(files["O1"], {e: files["REF_" + e] for e in "KEU"}, calendars, calendar_sources, context)
    publish(store, history)
    print('{"status":"PRIVATE_O1_DEMAND_SNAPSHOT_VERIFIED","private_storage":true}')
    print('{"status":"PRIVATE_O1_MONTHLY_ZERO_SUMMARY_VERIFIED","private_storage":true}')


def export_snapshot_safely(**kwargs):
    try:
        export_snapshot(**kwargs)
    except Exception:
        print('{"status":"PRIVATE_O1_DEMAND_SNAPSHOT_BLOCKED"}')
        raise SystemExit(1) from None
