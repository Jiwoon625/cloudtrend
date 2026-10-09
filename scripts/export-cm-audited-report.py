"""Private aggregate reporting after the unchanged CM accounting audit passes.

This file deliberately lives outside the engine source-hash roots. It never
changes research inputs, calculation identity, checkpoints or original results.
Only allowlisted aggregate fields enter a new create-only private report object
and its bounded user_metadata. No raw result or metric is printed to Actions.
"""
from __future__ import annotations

import base64
import csv
import hashlib
import io
import json
import math
import os
from decimal import Decimal
from pathlib import Path
import re

PLAN = "ce6be8c497e45fa22a41d3a7b924913a23b18588fd05efd33ee14eb961ec7c2c"
SCHEMA = "CM_PRIVATE_AUDITED_AGGREGATE_V1"
MAX_METADATA_BYTES = 8192
METRICS = ("cagr", "mdd", "cumulative_return", "annualized_volatility", "sharpe",
           "sortino", "worst_rolling_3m", "worst_rolling_6m", "worst_rolling_12m")
REPORT_FIELDS = {"schema", "status", "plan_sha256", "candidate_id", "identity", "result_zip_sha256",
                 "summary_sha256", "audit", "start", "end", "one_way_fee", "annualization_days",
                 "nav_observations", "performance_observations", "metrics", "yearly_returns",
                 "proxy_exit_count", "unresolved_rights_encounter_count", "historical_pit_certified",
                 "actual_historical_execution_certified", "full_tax_supported"}


class ReportError(RuntimeError):
    """Use fixed messages only: external data must never enter public errors."""


def require(value, code):
    if not value:
        raise ReportError(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode()


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def hash_value(value):
    require(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value), "INVALID_HASH")
    return value


def number(value, *, optional=False):
    if optional and value is None:
        return None
    require(type(value) in (int, float) and math.isfinite(value), "INVALID_AGGREGATE_NUMBER")
    return value


def count(value):
    require(type(value) is int and 0 <= value <= 2**53 - 1, "INVALID_AGGREGATE_COUNT")
    return value


def github_context(environ):
    require(environ.get("GITHUB_ACTIONS") == "true", "EXPLICIT_ACTIONS_AUDIT_REQUIRED")
    require(environ.get("GITHUB_WORKFLOW", "").startswith("CMresearchengine ") and
            environ.get("GITHUB_WORKFLOW", "").endswith("private final audit"), "WRONG_AUDIT_WORKFLOW")
    require(environ.get("GITHUB_EVENT_NAME") == "push", "EXPLICIT_AUDIT_PUSH_REQUIRED")
    run_id, attempt, commit = (environ.get(k, "") for k in
                               ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_SHA"))
    require(re.fullmatch(r"[1-9][0-9]*", run_id) and re.fullmatch(r"[1-9][0-9]*", attempt), "INVALID_AUDIT_RUN")
    require(re.fullmatch(r"[0-9a-f]{40}", commit), "INVALID_AUDIT_COMMIT")
    return {"run_id": run_id, "attempt": int(attempt), "commit": commit}


def prepare_report(store, candidate, identity, audit_context, approved):
    """Re-read authenticated immutable result bytes; never recompute a strategy."""
    import pandas as pd
    from cmresearchengine.runner import read_result
    from cm06.metrics import performance_metrics
    from cm06_fresh_host_v1 import digest

    hash_value(identity)
    require(candidate in approved, "CANDIDATE_NOT_IN_APPROVED_300")
    require(re.fullmatch(r"[A-Za-z0-9_]{1,120}", candidate), "INVALID_CANDIDATE")
    source = f"results/{PLAN}/{candidate}/{identity}/"
    completion_raw = store.get_object(source + "completion.json", max_bytes=1000000)
    summary_raw = store.get_object(source + "summary.json", max_bytes=1000000)
    checkpoint = store.scoped_checkpoints(PLAN, candidate)
    require(checkpoint.get_bytes("complete_" + identity) == completion_raw, "COMPLETION_MARKER_MISMATCH")
    completion = json.loads(completion_raw)
    require(completion.get("schema") == "CM06_FRESH_COMPLETED_V1" and
            digest(completion["identity"]) == identity, "COMPLETION_IDENTITY_MISMATCH")
    require(completion["identity"]["candidate"]["candidate_id"] == candidate and
            completion["identity"]["plan_sha256"] == PLAN, "CANDIDATE_IDENTITY_MISMATCH")
    files = read_result(completion, checkpoint)
    require(files["summary.json"] == summary_raw, "SUMMARY_BYTES_MISMATCH")
    manifest = json.loads(files["file_manifest.json"])["files"]
    require(set(manifest) == set(files) - {"file_manifest.json"}, "FILE_SET_MISMATCH")
    for name, record in manifest.items():
        require(len(files[name]) == record["size"] and sha256(files[name]) == record["sha256"], "FILE_HASH_MISMATCH")
    summary = json.loads(summary_raw)
    require(summary.get("schema") == "CM_RESEARCH_RESULT_V1" and summary.get("candidate_id") == candidate,
            "SUMMARY_IDENTITY_MISMATCH")
    require(summary.get("evaluation_start") == "2017-08-21" and summary.get("evaluation_end") == "2026-09-11",
            "EVALUATION_PERIOD_CHANGED")
    require(summary.get("historical_pit_certified") is False and
            summary.get("actual_historical_execution_certified") is False and
            summary.get("full_tax_supported") is False, "RESEARCH_LIMITATIONS_CHANGED")
    require(summary.get("ordinary_and_proxy_sales_share_one_way_fee") == "0.0015", "COST_CONTRACT_CHANGED")
    performance = summary["performance"]
    require(performance.get("supported") is True and performance.get("status") == "ok", "UNSUPPORTED_PERFORMANCE")
    nav = pd.read_csv(io.BytesIO(files["nav.csv"]))
    series = pd.Series(nav["gross_nav_krw"].astype(float).to_numpy(), index=pd.to_datetime(nav["at"], utc=True))
    start = pd.Timestamp(performance["start_at"])
    require(start.tzinfo is not None and start <= series.index[0] and start.date().isoformat() == "2017-08-21",
            "INVALID_INITIAL_BASELINE_TIME")
    require(summary["execution_contract"]["initial_capital_krw"] == 100000000, "INITIAL_CAPITAL_CHANGED")
    if start < series.index[0]:
        series = pd.concat([pd.Series([100000000.0], index=pd.DatetimeIndex([start])), series])
    recomputed = performance_metrics(series)
    require(recomputed.get("supported") is True, "INVALID_REPORT_NAV")
    metrics = {}
    for field in METRICS:
        value = number(performance.get(field), optional=field not in ("cagr", "mdd", "cumulative_return"))
        observed = recomputed.get(field)
        require((value is None and observed is None) or
                (value is not None and observed is not None and math.isclose(value, observed, rel_tol=1e-10, abs_tol=1e-12)),
                "PERFORMANCE_RECONCILIATION_FAILED")
        metrics[field] = value
    require(-1 < metrics["mdd"] <= 0 and metrics["cumulative_return"] > -1, "INVALID_RETURN_DOMAIN")
    require(performance["observations"] == len(series), "OBSERVATION_COUNT_MISMATCH")
    years = []
    require(len(performance["yearly_returns"]) <= 10, "UNEXPECTED_YEAR_COUNT")
    for row, recomputed_row in zip(performance["yearly_returns"], recomputed["yearly_returns"], strict=True):
        require(row["year"] == recomputed_row["year"] and
                math.isclose(number(row["return"]), recomputed_row["return"], rel_tol=1e-10, abs_tol=1e-12), "YEARLY_RETURN_MISMATCH")
        require(type(row["partial_start"]) is bool and type(row["partial_end"]) is bool, "INVALID_YEAR_FLAGS")
        years.append({k: row[k] for k in ("year", "return", "partial_start", "partial_end")})
    return {"schema": SCHEMA, "status": "PRIVATE_AUDIT_VERIFIED", "plan_sha256": PLAN,
            "candidate_id": candidate, "identity": identity,
            "result_zip_sha256": hash_value(completion["outputs_sha256"]),
            "summary_sha256": sha256(summary_raw), "audit": audit_context,
            "start": "2017-08-21", "end": "2026-09-11", "one_way_fee": "0.0015",
            "annualization_days": 365.2425, "nav_observations": count(len(nav)),
            "performance_observations": count(len(series)), "metrics": metrics, "yearly_returns": years,
            "proxy_exit_count": count(summary["proxy_exit_count"]),
            "unresolved_rights_encounter_count": count(summary["unresolved_rights_encounter_count"]),
            "historical_pit_certified": False, "actual_historical_execution_certified": False,
            "full_tax_supported": False}


def audit_cash_only(candidate, identity, *, store=None):
    """Narrow historical pure-cash audit; zero executions are required, not invented."""
    from cmresearchengine.storage import SupabaseCMStore
    from cmresearchengine.runner import read_result
    require(candidate == "Q_K000_E000_U000_C100", "PURE_CASH_CANDIDATE_ONLY")
    hash_value(identity)
    store = SupabaseCMStore.from_env() if store is None else store
    require(store.verify_private_bucket()["public"] is False, "PRIVATE_BUCKET_REQUIRED")
    prefix = f"results/{PLAN}/{candidate}/{identity}/"
    completion_raw = store.get_object(prefix + "completion.json", max_bytes=1000000)
    summary_raw = store.get_object(prefix + "summary.json", max_bytes=1000000)
    checkpoint = store.scoped_checkpoints(PLAN, candidate)
    require(checkpoint.get_bytes("complete_" + identity) == completion_raw, "COMPLETION_MARKER_MISMATCH")
    completion = json.loads(completion_raw)
    require(sha256(canonical(completion["identity"])) == identity and
            completion["identity"]["candidate"]["candidate_id"] == candidate and
            completion["identity"]["candidate"]["initial_weights"] == {"K": 0, "E": 0, "U": 0, "C": 1},
            "PURE_CASH_IDENTITY_MISMATCH")
    files = read_result(completion, checkpoint)
    require(files["summary.json"] == summary_raw, "SUMMARY_BYTES_MISMATCH")
    manifest = json.loads(files["file_manifest.json"])["files"]
    require(set(manifest) == set(files) - {"file_manifest.json"}, "FILE_SET_MISMATCH")
    for name, record in manifest.items():
        require(len(files[name]) == record["size"] and sha256(files[name]) == record["sha256"], "FILE_HASH_MISMATCH")
    rows = lambda filename: list(csv.DictReader(io.StringIO(files[filename].decode("utf-8-sig"))))
    nav, events, proxies = rows("nav.csv"), rows("events.csv"), rows("retrospective_exit_proxy_audit.csv")
    summary = json.loads(summary_raw)
    require(bool(nav) and not any(row.get("kind") in {"BUY", "SELL"} for row in events) and not proxies,
            "PURE_CASH_EXECUTION_FOUND")
    require(summary["proxy_exit_count"] == summary["unresolved_rights_encounter_count"] == 0,
            "PURE_CASH_RIGHTS_FOUND")
    for row in nav:
        require(Decimal(row["gross_nav_krw"]) == Decimal(row["cash_krw"]) == Decimal("100000000") and
                Decimal(row["receivable_krw"]) == Decimal(row["market_value_krw"]) == 0,
                "PURE_CASH_NAV_CHANGED")
    require(Decimal(str(summary["final_snapshot"]["bridge_residual_krw"])) == 0, "PURE_CASH_BRIDGE_FAILED")
    for field in ("cagr", "mdd", "cumulative_return", "annualized_volatility"):
        require(number(summary["performance"][field]) == 0, "PURE_CASH_PERFORMANCE_CHANGED")
    print(json.dumps({"status": candidate + "_PRIVATE_AUDIT_VERIFIED", "trade_fee_checks": 0,
                      "cash_settlement_checks": 0, "proxy_exit_checks": 0, "nav_rows_checked": len(nav),
                      "file_manifest_checked": len(manifest), "pure_cash_contract_verified": True,
                      "result_zip_sha256": completion["outputs_sha256"], "private_storage": True}, sort_keys=True))


def publish_report(store, report):
    from cmresearchengine.storage import _DuplicateObject, ImmutableConflict
    require(set(report) == REPORT_FIELDS and set(report["metrics"]) == set(METRICS), "UNEXPECTED_METADATA_FIELDS")
    require(report["schema"] == SCHEMA and report["status"] == "PRIVATE_AUDIT_VERIFIED" and
            report["plan_sha256"] == PLAN, "INVALID_REPORT_IDENTITY")
    for field in ("identity", "result_zip_sha256", "summary_sha256"):
        hash_value(report[field])
    require(isinstance(report["candidate_id"], str) and re.fullmatch(r"[A-Za-z0-9_]{1,120}", report["candidate_id"]),
            "INVALID_CANDIDATE")
    require(set(report["audit"]) == {"run_id", "attempt", "commit"}, "INVALID_AUDIT_FIELDS")
    require(isinstance(report["audit"]["run_id"], str) and re.fullmatch(r"[1-9][0-9]*", report["audit"]["run_id"]) and
            type(report["audit"]["attempt"]) is int and report["audit"]["attempt"] > 0 and
            isinstance(report["audit"]["commit"], str) and re.fullmatch(r"[0-9a-f]{40}", report["audit"]["commit"]),
            "INVALID_AUDIT_FIELDS")
    require(report["start"] == "2017-08-21" and report["end"] == "2026-09-11" and
            report["one_way_fee"] == "0.0015" and report["annualization_days"] == 365.2425,
            "INVALID_REPORT_CONTRACT")
    for field in ("historical_pit_certified", "actual_historical_execution_certified", "full_tax_supported"):
        require(report[field] is False, "INVALID_REPORT_LIMITATION")
    for field in ("nav_observations", "performance_observations", "proxy_exit_count", "unresolved_rights_encounter_count"):
        count(report[field])
    for field, value in report["metrics"].items():
        number(value, optional=field not in ("cagr", "mdd", "cumulative_return"))
    require(isinstance(report["yearly_returns"], list) and 1 <= len(report["yearly_returns"]) <= 10,
            "INVALID_YEARLY_METADATA")
    for row in report["yearly_returns"]:
        require(set(row) == {"year", "return", "partial_start", "partial_end"} and
                type(row["year"]) is int and 2017 <= row["year"] <= 2026 and
                type(row["partial_start"]) is bool and type(row["partial_end"]) is bool,
                "INVALID_YEARLY_METADATA")
        number(row["return"])
    raw = canonical(report)
    report_hash = sha256(raw)
    metadata = {**report, "report_sha256": report_hash}
    header = base64.b64encode(canonical(metadata)).decode("ascii")
    require(len(raw) <= MAX_METADATA_BYTES and len(header) <= MAX_METADATA_BYTES, "AGGREGATE_METADATA_TOO_LARGE")
    # This new namespace is outside original result/identity and checkpoint paths.
    target = f"results/reports/audited/{PLAN}/{report['candidate_id']}/{report['identity']}/{report_hash}.json"
    require(store.verify_private_bucket()["public"] is False, "PRIVATE_BUCKET_REQUIRED")
    try:
        existing = store.get_object(target, max_bytes=len(raw))
    except FileNotFoundError:
        existing = None
    if existing is not None:
        if existing != raw:
            raise ImmutableConflict("Report bytes differ; no overwrite performed")
        return report_hash
    try:
        store._request("POST", store._object_route(target), lambda response: store._bounded(response, 65536),
                       data=raw, headers={"Content-Type": "application/octet-stream", "x-upsert": "false",
                                          "x-metadata": header})
    except _DuplicateObject:
        pass
    require(store.get_object(target, max_bytes=len(raw)) == raw, "PRIVATE_REPORT_READBACK_MISMATCH")
    return report_hash


def export_reports(targets, *, accounting_audit_passed, environ=None, store=None, approved_path=None):
    """Called once only after all unchanged audit(candidate, identity) calls pass."""
    require(accounting_audit_passed is True, "ACCOUNTING_AUDIT_REQUIRED")
    context = github_context(os.environ if environ is None else environ)
    require(isinstance(targets, list) and 1 <= len(targets) <= 52 and
            len({row[0] for row in targets}) == len(targets), "INVALID_REPORT_TARGETS")
    from cmresearchengine.storage import SupabaseCMStore
    if store is None:
        store = SupabaseCMStore.from_env()
    if approved_path is None:
        approved_path = Path("research/cmresearchengine/REPRESENTATIVE_300_APPROVED.json")
    approved = json.loads(Path(approved_path).read_text())
    require(approved.get("schema") == "CM_REPRESENTATIVE_300_APPROVED_V1" and
            approved.get("plan_sha256") == PLAN and approved.get("total") == 300 and
            len(approved.get("candidates", [])) == 300, "APPROVED_MANIFEST_CHANGED")
    candidates = {row["id"] for row in approved["candidates"]}
    require(len(candidates) == 300, "DUPLICATE_APPROVED_CANDIDATE")
    # Complete every local validation before writing any report.
    reports = [prepare_report(store, candidate, identity, context, candidates) for candidate, identity in targets]
    for report in reports:
        publish_report(store, report)
    print(json.dumps({"status": "PRIVATE_AGGREGATE_REPORTS_VERIFIED", "count": len(reports), "private_storage": True}, sort_keys=True))


def export_reports_safely(*args, **kwargs):
    try:
        export_reports(*args, **kwargs)
    except Exception:
        # Suppress raw values, external response text and traceback locals.
        print('{"status":"PRIVATE_AGGREGATE_REPORT_BLOCKED"}')
        raise SystemExit(1) from None
