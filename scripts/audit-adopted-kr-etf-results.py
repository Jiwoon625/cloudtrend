#!/usr/bin/env python3
"""Audit pinned COMPLETE research results; never read inputs or execute signals/accounts.

All source files are hash checked in private temporary storage, then the existing
independent Decimal verifier runs again without credentials. Only exact-whitelist
annual aggregates are written, create-only, to a separate private audit prefix.
No original result is changed; no raw data/logs enter artifacts, cache, or stdout.
The checked-in request template is deliberately non-executable until filled.
"""
from __future__ import annotations

import argparse
import ast
import base64
from decimal import Decimal
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
_SPEC = importlib.util.spec_from_file_location("adopted_audit_core", ROOT / "scripts/run-adopted-kr-etf-resumable-job.py")
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError("AUDIT_HELPERS_UNAVAILABLE")
core = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(core)
base, require, JobError = core.base, core.require, core.JobError
_VERIFIER_SPEC = importlib.util.spec_from_file_location("adopted_audit_arithmetic", ROOT / "scripts/verify-adopted-kr-etf-results.py")
if _VERIFIER_SPEC is None or _VERIFIER_SPEC.loader is None:
    raise RuntimeError("AUDIT_VERIFIER_UNAVAILABLE")
verifier = importlib.util.module_from_spec(_VERIFIER_SPEC)
_VERIFIER_SPEC.loader.exec_module(verifier)

SOURCE_RUN_ID = "38016639367"
SOURCE_COMMIT = "38da620ced597eaae4e07b54f36a2173c70d9640"
SOURCE_REQUEST = {
    "version": "adopted-resumable-request-v1", "mode": "full",
    "catalog_sha": "78e59c019a579b704a40c1d9a6a5de414dfaad8e71da1312f583327c2306ca89",
    "source_manifest_sha": "0a87b02838ea0cd2c084c98c82cdc9f798beb6d10d3c6e563b55595577e2daf6",
    "etf_start": "2017-01-11", "kr_start": "2017-08-21", "through": "2026-09-11", "chunk_sessions": 120,
    "resume_from": {"runId": "37998687295", "codeCommit": "0439d13393c6015e93db54018ddebaba2eb10ac1",
                    "planCompletionSha256": "50fdab59d0ac8363405107c143bbde32edb5515da49520ea49d674aa1b4f353c"},
}
REQUEST_VERSION = "adopted-result-audit-request-v1"
SUMMARY_VERSION = "adopted-result-annual-audit-v1"
COMPLETION_VERSION = "adopted-result-audit-completion-v1"
WORKFLOW = "KR ETF private annual result audit"
COMMIT_MARKER = "run(kr-etf-audit): annual-results"
REQUEST_FIELDS = {"version", "sourceRunId", "sourceCommit", "sourceRequest", "sourceCompletionSha256"}
ROLES = {"replay-kr", "replay-etf"}
BOOKS = core.result_books("kr") | core.result_books("etf")
MAX_SOURCE_TOTAL = 2 * 1024 * base.CHUNK
MAX_JSON = 4 * base.CHUNK
MAX_AGGREGATE = 8192
FORMULA = "CLOSED_ROUND_TRIP_NET_RETURN_V1"
NAV_FORMULA = "YEAR_END_NAV_OVER_PRIOR_YEAR_END_NAV_MINUS_ONE_V1"
MDD_FORMULA = "ANNUAL_NAV_DRAWDOWN_RESET_AT_OPENING_BASE_V1"
PROVENANCE_FIELDS = {"sourceRunId", "sourceCommit", "sourceCompletionSha256", "catalogSha256", "sourceManifestSha256",
                     "auditRunId", "auditRunAttempt", "auditCommit", "auditWorkflow"}
SUMMARY_FIELDS = {"schema", "status", "book", "start", "through", "provenance", "verifiedArithmetic",
                  "navReturnDefinition", "mddDefinition", "tradeDefinition", "unit", "annualPortfolio", "annualClosedTrades"}
PORTFOLIO_FIELDS = {"year", "startDate", "endDate", "periodType", "openingBase", "observations", "netReturn", "mdd"}
CLOSED_FIELDS = {"exitYear", "closedTradeCount", "proxyClosedTradeCount", "meanNetReturn", "medianNetReturn"}


def validate_request(value):
    require(isinstance(value, dict) and set(value) == REQUEST_FIELDS and value["version"] == REQUEST_VERSION,
            "INVALID_AUDIT_REQUEST")
    require(value["sourceRunId"] == SOURCE_RUN_ID and value["sourceCommit"] == SOURCE_COMMIT and
            base.json_bytes(value["sourceRequest"]) == base.json_bytes(SOURCE_REQUEST), "SOURCE_PIN_MISMATCH")
    hashes = value["sourceCompletionSha256"]
    require(isinstance(hashes, dict) and set(hashes) == ROLES, "COMPLETION_PINS_REQUIRED")
    for completion_hash in hashes.values():
        base.check_hash(completion_hash)
        require(completion_hash != "0" * 64, "COMPLETION_PIN_PLACEHOLDER")
    require(len(set(hashes.values())) == 2, "COMPLETION_PINS_MUST_DIFFER")
    return value


def authorization(request_file, environment):
    commit = base.validated_code_commit(environment)
    require(environment.get("GITHUB_ACTIONS") == "true" and environment.get("GITHUB_WORKFLOW") == WORKFLOW and
            environment.get("GITHUB_REF") == base.REQUEST_BRANCH and environment.get("GITHUB_EVENT_NAME") == "push",
            "EXPLICIT_AUDIT_COMMIT_REQUIRED")
    require(commit != SOURCE_COMMIT, "AUDIT_COMMIT_MUST_BE_NEW")
    for key in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"):
        require(isinstance(environment.get(key), str) and re.fullmatch(r"[1-9][0-9]{0,19}", environment[key]), "INVALID_AUDIT_RUN")
    require(environment["GITHUB_RUN_ID"] != SOURCE_RUN_ID, "AUDIT_RUN_MUST_BE_NEW")
    event = base.read_local_json(environment.get("GITHUB_EVENT_PATH"), 10 * base.CHUNK, "INVALID_AUDIT_EVENT")
    head = event.get("head_commit")
    require(isinstance(head, dict) and head.get("id") == commit and event.get("after") == commit and
            event.get("ref") == base.REQUEST_BRANCH and isinstance(head.get("message"), str) and
            head["message"].splitlines() and head["message"].splitlines()[0] == COMMIT_MARKER,
            "AUDIT_COMMIT_MARKER_MISMATCH")
    request = validate_request(base.read_local_json(request_file, 16384, "INVALID_AUDIT_REQUEST"))
    # A filled request must identify exactly the source contract shipped with it.
    saved = base.read_local_json(ROOT / ".github/kr-etf-resumable-request.json", 16384, "SOURCE_REQUEST_UNAVAILABLE")
    require(base.json_bytes(saved) == base.json_bytes(request["sourceRequest"]), "CHECKED_IN_SOURCE_REQUEST_MISMATCH")
    return request


def source_scope(owner, role, request):
    return {"owner": owner, "runId": request["sourceRunId"], "role": role,
            "codeCommit": request["sourceCommit"], "request": request["sourceRequest"]}


class ReadOnlyResultStorage(core.ReadOnlyOriginStorage):
    """No source manifest, input, plan, signal checkpoint, or write capability."""
    def __init__(self, session, environment, request, role):
        require(role in ROLES, "INVALID_AUDIT_SOURCE_ROLE")
        super().__init__(session, environment.get("SUPABASE_URL", ""), environment.get("SUPABASE_USER_ID", ""),
                         environment.get("SUPABASE_SERVICE_ROLE_KEY", ""), request["sourceRequest"]["catalog_sha"],
                         request["sourceRunId"], role)
        self.input_keys.clear()

    def key(self, role, relative, *, write=False):
        require(role == self.role and role in ROLES, "AUDIT_SOURCE_SCOPE_ONLY")
        return super().key(role, relative, write=write)

    def _url(self, key, *, write=False):
        require(not write and key.startswith(self.run_prefix), "AUDIT_SOURCE_SCOPE_ONLY")
        return super()._url(key, write=False)

    def manifest(self):
        raise JobError("AUDIT_SOURCE_INPUTS_FORBIDDEN")

    def verified_september_extension(self, *args, **kwargs):
        raise JobError("AUDIT_SOURCE_INPUTS_FORBIDDEN")

    def download_observed(self, *args, **kwargs):
        raise JobError("AUDIT_SOURCE_INPUTS_FORBIDDEN")


def restore_source(storage, request, root):
    role = storage.role
    storage.verify_private_bucket()
    payload = storage.bounded(role, "completion.json")
    require(hashlib.sha256(payload).hexdigest() == request["sourceCompletionSha256"][role], "SOURCE_COMPLETION_HASH_MISMATCH")
    value = core.parse_json(payload, "INVALID_SOURCE_COMPLETION")
    require(set(value) == {"version", "status", "scope", "proof", "files"} and value.get("status") == "COMPLETE" and
            value.get("version") == core.COMPLETE_VERSION and value.get("scope") == source_scope(storage.owner, role, request),
            "SOURCE_COMPLETION_SCOPE_MISMATCH")
    proof, market = value["proof"], role[7:]
    require(isinstance(proof, dict) and set(proof) == {"planSha256", "market", "start", "through", "cacheChunks", "verifiedArithmetic"} and
            proof["market"] == market and proof["start"] == SOURCE_REQUEST[market + "_start"] and
            proof["through"] == SOURCE_REQUEST["through"] and type(proof["cacheChunks"]) is int and
            proof["cacheChunks"] == 20 and proof["verifiedArithmetic"] is True, "INVALID_SOURCE_COMPLETION_PROOF")
    base.check_hash(proof["planSha256"])
    entries = value.get("files")
    require(isinstance(entries, list) and 0 < len(entries) <= 64 and all(isinstance(e, dict) and
            type(e.get("bytes")) is int and 0 <= e["bytes"] <= MAX_SOURCE_TOTAL for e in entries) and
            sum(e["bytes"] for e in entries) <= MAX_SOURCE_TOTAL, "AUDIT_SOURCE_TOO_LARGE")
    # Core restore rechecks completion scope/hash, exact file set, path safety,
    # one attempt, and then checks every file's byte count and SHA-256.
    restored = storage.restore(role, source_scope(storage.owner, role, request), root,
                               expected_proof=proof, expected_completion_sha=request["sourceCompletionSha256"][role])
    require(restored == value, "SOURCE_COMPLETION_CHANGED")
    return restored


def read_result_json(path, code):
    require(path.is_file() and not path.is_symlink() and 0 < path.stat().st_size <= MAX_JSON, code)
    return core.parse_json(path.read_bytes(), code)


def validate_source_results(completion, root, request, role):
    market = role[7:]
    read = lambda name: read_result_json(root / name, "INVALID_SOURCE_RESULT_JSON")
    report, summary, original_verification = read("run-manifest.json"), read("result/summary.json"), read("result/verification.json")
    proof = completion["proof"]
    require(report.get("version") == "adopted-private-resumable-backtest-job-v1" and report.get("status") == "COMPLETE" and
            report.get("mode") == "full" and report.get("market") == market and report.get("runId") == request["sourceRunId"] and
            report.get("codeCommit") == request["sourceCommit"] and report.get("catalogSha256") == SOURCE_REQUEST["catalog_sha"] and
            report.get("sourceManifestSha256") == SOURCE_REQUEST["source_manifest_sha"] and report.get("planSha256") == proof["planSha256"] and
            report.get("start") == proof["start"] and report.get("through") == proof["through"] and report.get("verifiedArithmetic") is True,
            "SOURCE_REPORT_SCOPE_MISMATCH")
    require(report.get("outputs") == [entry for entry in completion["files"] if core.logical_path(entry["path"]) != "run-manifest.json"],
            "SOURCE_OUTPUT_MANIFEST_MISMATCH")
    require(set(summary) == core.result_books(market), "SOURCE_BOOK_SET_MISMATCH")
    for stats in summary.values():
        require(isinstance(stats, dict) and stats.get("status") == "COMPLETE" and stats.get("startDate") == proof["start"] and
                stats.get("endDate") == proof["through"] and stats.get("missingValuationCount") == 0 and
                stats.get("staleValuationCount") == 0, "INCOMPLETE_SOURCE_BOOK")
    core.validate_verification(original_verification, summary, market)
    quality = read("result/quality.json")
    require(core.validate_replay_quality(quality, market) == report.get("portfolioExecutionPasses") and
            quality["signalCache"] == report.get("signalCache"), "SOURCE_QUALITY_REPORT_MISMATCH")
    require(report.get("closedTradeMetrics", {}).get("books") == {
        name: {key: evidence["closedTradeMetrics"].get(key) for key in base.TRADE_METRIC_FIELDS}
        for name, evidence in original_verification["books"].items()}, "SOURCE_TRADE_REPORT_MISMATCH")
    base.build_summary_metadata(report, summary, base.digest_file(root / "run-manifest.json")["sha256"])
    origins = report.get("importOrigins")
    require(isinstance(origins, list) and len(origins) == 17, "SOURCE_IMPORT_PROVENANCE_MISMATCH")
    seen, origin_plans = [], set()
    for origin in origins:
        require(isinstance(origin, dict) and isinstance(origin.get("role"), str), "SOURCE_IMPORT_PROVENANCE_MISMATCH")
        core.validate_origin(origin, {**completion["scope"], "role": origin["role"]})
        require(0 <= int(origin["role"][6:]) < proof["cacheChunks"], "SOURCE_IMPORT_PROVENANCE_MISMATCH")
        seen.append(origin["role"])
        origin_plans.add(origin["planSha256"])
    require(seen == sorted(set(seen)) and len(origin_plans) == 1, "SOURCE_IMPORT_PROVENANCE_MISMATCH")
    return summary, original_verification


def rerun_arithmetic(source_root, target, summary, original, market, environment, runner):
    target.mkdir(mode=0o700)
    # Preserve every downloaded source byte. The verifier writes a new receipt
    # beside private copies and is the ONLY executable this audit invokes.
    needed = {"summary.json"} | {book + "." + suffix for book in summary for suffix in (
        ("daily-nav.jsonl", "trades.jsonl", "yearly-budgets.json") if book == "ETF_V02" else
        ("daily-nav.jsonl", "trades.jsonl", "yearly-budgets.json", "accounting.json", "evidence.json"))}
    for name in sorted(needed):
        shutil.copyfile(source_root / "result" / name, target / name)
        os.chmod(target / name, 0o600)
    runner([sys.executable, str(ROOT / "scripts/verify-adopted-kr-etf-results.py"), "--results", str(target)],
           target.parent / (market + "-arithmetic.log"), base.child_environment(environment))
    verified = read_result_json(target / "verification.json", "INVALID_FRESH_VERIFICATION")
    core.validate_verification(verified, summary, market)
    require(verified == original, "FRESH_ARITHMETIC_RECEIPT_MISMATCH")
    for book, evidence in verified["books"].items():
        metrics = evidence.get("closedTradeMetrics")
        require(isinstance(metrics, dict) and metrics.get("status") == "VERIFIED" and
                all(metrics.get(key) == value for key, value in base.TRADE_METRIC_CONTRACT.items()), "INVALID_FRESH_CLOSED_TRADES")
        # Formula implementation is shared only with the independent verifier,
        # never with the strategy or cached portfolio executor.
        require(metrics == verifier.closed_trade_metrics(book, verifier.read_lines(target / (book + ".trades.jsonl"))),
                "CLOSED_TRADE_REDUCTION_MISMATCH")
    return verified


def period_type(year, start, through):
    first = year == int(start[:4]) and start > "%04d-01-01" % year
    last = year == int(through[:4]) and through < "%04d-12-31" % year
    return ("PARTIAL_FIRST_AND_LAST_YEAR" if first and last else "PARTIAL_FIRST_YEAR" if first else
            "PARTIAL_LAST_YEAR" if last else "FULL_YEAR")


def annual_portfolio(rows, start, through):
    require(isinstance(rows, list) and len(rows) > 1 and base.summary_date(start) and base.summary_date(through), "INVALID_ANNUAL_NAV")
    require(rows[0].get("date") == start and rows[-1].get("date") == through, "ANNUAL_NAV_BOUNDARY_MISMATCH")
    groups, previous = {}, None
    for row in rows:
        day = row.get("date")
        require(base.summary_date(day) and start <= day <= through and (previous is None or previous < day) and
                row.get("valuationStatus") == "COMPLETE", "INVALID_ANNUAL_NAV_ROW")
        try:
            nav = Decimal(str(row.get("nav")))
        except Exception:
            raise JobError("INVALID_ANNUAL_NAV_VALUE") from None
        require(nav.is_finite() and nav >= 0, "INVALID_ANNUAL_NAV_VALUE")
        groups.setdefault(int(day[:4]), []).append((day, nav))
        previous = day
    require(list(groups) == list(range(int(start[:4]), int(through[:4]) + 1)), "ANNUAL_NAV_YEAR_GAP")
    opening, result = verifier.INITIAL, []
    for index, (year, values) in enumerate(groups.items()):
        require(opening > 0, "ANNUAL_NAV_ZERO_OPENING_BASE")
        peak, mdd = opening, Decimal(0)
        for _, nav in values:
            peak = max(peak, nav)
            mdd = min(mdd, nav / peak - 1)
        final = values[-1][1]
        result.append({"year": year, "startDate": values[0][0], "endDate": values[-1][0],
                       "periodType": period_type(year, start, through),
                       "openingBase": "INITIAL_HYPOTHETICAL_CAPITAL" if index == 0 else "PREVIOUS_YEAR_FINAL_NAV",
                       "observations": len(values), "netReturn": float(final / opening - 1), "mdd": float(mdd)})
        opening = final
    return result


def provenance(request, role, environment):
    return {"sourceRunId": request["sourceRunId"], "sourceCommit": request["sourceCommit"],
            "sourceCompletionSha256": request["sourceCompletionSha256"][role],
            "catalogSha256": SOURCE_REQUEST["catalog_sha"], "sourceManifestSha256": SOURCE_REQUEST["source_manifest_sha"],
            "auditRunId": environment["GITHUB_RUN_ID"], "auditRunAttempt": environment["GITHUB_RUN_ATTEMPT"],
            "auditCommit": base.validated_code_commit(environment), "auditWorkflow": WORKFLOW}


def build_aggregate(book, rows, metrics, request, environment):
    role = "replay-etf" if book == "ETF_V02" else "replay-kr"
    start, through = SOURCE_REQUEST[role[7:] + "_start"], SOURCE_REQUEST["through"]
    annual = annual_portfolio(rows, start, through)
    require(metrics.get("definition") == FORMULA and metrics.get("status") == "VERIFIED", "ARITHMETIC_NOT_VERIFIED")
    yearly = metrics.get("byFinalExitYear")
    require(isinstance(yearly, list) and all(isinstance(item, dict) and set(item) == CLOSED_FIELDS for item in yearly), "INVALID_CLOSED_YEAR_FIELDS")
    index = {item["exitYear"]: item for item in yearly}
    years = [item["year"] for item in annual]
    require(len(index) == len(yearly) and set(index) <= set(years), "INVALID_CLOSED_YEAR_GROUPING")
    require(sum(item["closedTradeCount"] for item in yearly) == metrics["closedTradeCount"] and
            sum(item["proxyClosedTradeCount"] for item in yearly) == metrics["proxyClosedTradeCount"], "CLOSED_YEAR_COUNT_MISMATCH")
    closed = [dict(index.get(year, {"exitYear": year, "closedTradeCount": 0, "proxyClosedTradeCount": 0,
                                   "meanNetReturn": None, "medianNetReturn": None})) for year in years]
    value = {"schema": SUMMARY_VERSION, "status": "COMPLETE", "book": book, "start": start, "through": through,
             "provenance": provenance(request, role, environment), "verifiedArithmetic": True,
             "navReturnDefinition": NAV_FORMULA, "mddDefinition": MDD_FORMULA,
             "tradeDefinition": FORMULA, "unit": "RATIO", "annualPortfolio": annual, "annualClosedTrades": closed}
    safe_aggregate(value)
    return value


def safe_provenance(value):
    require(isinstance(value, dict) and set(value) == PROVENANCE_FIELDS and value["sourceRunId"] == SOURCE_RUN_ID and
            value["sourceCommit"] == SOURCE_COMMIT and value["catalogSha256"] == SOURCE_REQUEST["catalog_sha"] and
            value["sourceManifestSha256"] == SOURCE_REQUEST["source_manifest_sha"] and value["auditWorkflow"] == WORKFLOW,
            "INVALID_AUDIT_PROVENANCE")
    base.check_hash(value["sourceCompletionSha256"])
    require(value["sourceCompletionSha256"] != "0" * 64, "INVALID_AUDIT_PROVENANCE")
    base.validated_code_commit({"GITHUB_SHA": value["auditCommit"]})
    for key in ("auditRunId", "auditRunAttempt"):
        require(isinstance(value[key], str) and re.fullmatch(r"[1-9][0-9]{0,19}", value[key]), "INVALID_AUDIT_PROVENANCE")
    require(value["auditRunId"] != SOURCE_RUN_ID and value["auditCommit"] != SOURCE_COMMIT, "AUDIT_PROVENANCE_RELABELED")


def safe_aggregate(value):
    """Exact nested field/domain allowlist: never serializes arbitrary source fields."""
    require(isinstance(value, dict) and set(value) == SUMMARY_FIELDS and value["schema"] == SUMMARY_VERSION and
            value["status"] == "COMPLETE" and value["book"] in BOOKS and value["verifiedArithmetic"] is True and
            value["navReturnDefinition"] == NAV_FORMULA and value["mddDefinition"] == MDD_FORMULA and
            value["tradeDefinition"] == FORMULA and value["unit"] == "RATIO", "INVALID_AGGREGATE_FIELDS")
    start = SOURCE_REQUEST["etf_start" if value["book"] == "ETF_V02" else "kr_start"]
    require(value["start"] == start and value["through"] == SOURCE_REQUEST["through"], "INVALID_AGGREGATE_PERIOD")
    safe_provenance(value["provenance"])
    years = list(range(int(start[:4]), int(value["through"][:4]) + 1))
    annual, trades = value["annualPortfolio"], value["annualClosedTrades"]
    require(isinstance(annual, list) and isinstance(trades, list) and len(annual) == len(trades) == len(years), "INVALID_AGGREGATE_YEARS")
    previous = None
    for index, (year, item, closed) in enumerate(zip(years, annual, trades)):
        require(isinstance(item, dict) and set(item) == PORTFOLIO_FIELDS and type(item["year"]) is int and item["year"] == year and
                item["periodType"] == period_type(year, start, value["through"]) and item["openingBase"] == (
                    "INITIAL_HYPOTHETICAL_CAPITAL" if index == 0 else "PREVIOUS_YEAR_FINAL_NAV"), "INVALID_ANNUAL_FIELDS")
        require(all(base.summary_date(item[k]) and int(item[k][:4]) == year for k in ("startDate", "endDate")) and
                start <= item["startDate"] <= item["endDate"] <= value["through"] and
                (previous is None or previous < item["startDate"]), "INVALID_ANNUAL_DATES")
        previous = item["endDate"]
        require(type(item["observations"]) is int and 1 <= item["observations"] <= 366 and
                base.finite_number(item["netReturn"]) and item["netReturn"] >= -1 and
                base.finite_number(item["mdd"]) and -1 <= item["mdd"] <= 0, "INVALID_ANNUAL_METRICS")
        require(isinstance(closed, dict) and set(closed) == CLOSED_FIELDS and type(closed["exitYear"]) is int and
                closed["exitYear"] == year, "INVALID_CLOSED_YEAR_FIELDS")
        require(all(type(closed[k]) is int and 0 <= closed[k] <= 2**53-1 for k in ("closedTradeCount", "proxyClosedTradeCount")) and
                closed["proxyClosedTradeCount"] <= closed["closedTradeCount"], "INVALID_CLOSED_YEAR_COUNTS")
        for key in ("meanNetReturn", "medianNetReturn"):
            require((base.finite_number(closed[key]) and closed[key] >= -1) if closed["closedTradeCount"] else closed[key] is None,
                    "INVALID_CLOSED_YEAR_METRICS")
    require(annual[0]["startDate"] == start and annual[-1]["endDate"] == value["through"], "INVALID_ANNUAL_COVERAGE")
    encoded = base64.b64encode(base.json_bytes(value)).decode("ascii")
    require(len(encoded) <= MAX_AGGREGATE, "AGGREGATE_METADATA_TOO_LARGE")
    return encoded


def safe_completion(value):
    require(isinstance(value, dict) and set(value) == {"schema", "status", "auditRunId", "auditRunAttempt", "auditCommit",
            "auditWorkflow", "sourceRunId", "sourceCommit", "sourceCompletionSha256", "verifiedArithmetic", "files"} and
            value["schema"] == COMPLETION_VERSION and value["status"] == "COMPLETE" and value["verifiedArithmetic"] is True and
            value["sourceRunId"] == SOURCE_RUN_ID and value["sourceCommit"] == SOURCE_COMMIT and value["auditWorkflow"] == WORKFLOW,
            "INVALID_AUDIT_COMPLETION")
    validate_request({"version": REQUEST_VERSION, "sourceRunId": value["sourceRunId"], "sourceCommit": value["sourceCommit"],
                      "sourceRequest": SOURCE_REQUEST, "sourceCompletionSha256": value["sourceCompletionSha256"]})
    for role in ROLES:
        safe_provenance({key: value[key] for key in ("sourceRunId", "sourceCommit", "auditRunId", "auditRunAttempt", "auditCommit", "auditWorkflow")} |
                        {"sourceCompletionSha256": value["sourceCompletionSha256"][role], "catalogSha256": SOURCE_REQUEST["catalog_sha"],
                         "sourceManifestSha256": SOURCE_REQUEST["source_manifest_sha"]})
    entries = value["files"]
    require(isinstance(entries, list) and len(entries) == len(BOOKS) and all(isinstance(e, dict) and
            set(e) == {"path", "bytes", "sha256"} for e in entries) and {e["path"] for e in entries} == {b + ".json" for b in BOOKS},
            "INVALID_AUDIT_COMPLETION_FILES")
    for entry in entries:
        require(type(entry["bytes"]) is int and 0 < entry["bytes"] <= MAX_AGGREGATE, "INVALID_AUDIT_COMPLETION_BYTES")
        base.check_hash(entry["sha256"])
    encoded = base64.b64encode(base.json_bytes(value)).decode("ascii")
    require(len(encoded) <= MAX_AGGREGATE, "AGGREGATE_METADATA_TOO_LARGE")
    return encoded


class AggregateStorage(base.PrivateStorage):
    def __init__(self, session, environment, request):
        super().__init__(session, environment.get("SUPABASE_URL", ""), environment.get("SUPABASE_USER_ID", ""),
                         environment.get("SUPABASE_SERVICE_ROLE_KEY", ""), SOURCE_REQUEST["catalog_sha"],
                         environment["GITHUB_RUN_ID"] + "-" + environment["GITHUB_RUN_ATTEMPT"])
        self.run_prefix = self.owner + "/research/adopted-full-period/result-audits/" + environment["GITHUB_RUN_ID"] + "/attempt-" + environment["GITHUB_RUN_ATTEMPT"] + "/"
        self.input_keys.clear()
        self.environment = {key: environment[key] for key in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_SHA")}
        self.request = validate_request(request)
        self.receipts = {}

    def _url(self, key, *, write=False):
        require(key.startswith(self.run_prefix), "AUDIT_OUTPUT_SCOPE_ONLY")
        return super()._url(key, write=write)

    def manifest(self):
        raise JobError("AUDIT_SOURCE_INPUTS_FORBIDDEN")

    def create_result(self, *args, **kwargs):
        raise JobError("AUDIT_AGGREGATES_ONLY")

    def put(self, name, value, workspace):
        require(name in {book + ".json" for book in BOOKS} | {"completion.json"}, "INVALID_AUDIT_OUTPUT_NAME")
        metadata = safe_completion(value) if name == "completion.json" else safe_aggregate(value)
        prov = value if name == "completion.json" else value["provenance"]
        require(prov["auditRunId"] == self.environment["GITHUB_RUN_ID"] and prov["auditRunAttempt"] == self.environment["GITHUB_RUN_ATTEMPT"] and
                prov["auditCommit"] == self.environment["GITHUB_SHA"], "AUDIT_OUTPUT_PROVENANCE_MISMATCH")
        if name == "completion.json":
            require(value["sourceCompletionSha256"] == self.request["sourceCompletionSha256"], "AUDIT_OUTPUT_SOURCE_PIN_MISMATCH")
            require(value["files"] == [self.receipts[b + ".json"] for b in sorted(BOOKS) if b + ".json" in self.receipts] and
                    len(self.receipts) == len(BOOKS), "AUDIT_COMPLETION_MUST_BE_LAST")
        else:
            require(name == value["book"] + ".json", "AUDIT_BOOK_PATH_MISMATCH")
            role = "replay-etf" if value["book"] == "ETF_V02" else "replay-kr"
            require(prov["sourceCompletionSha256"] == self.request["sourceCompletionSha256"][role], "AUDIT_OUTPUT_SOURCE_PIN_MISMATCH")
        path = Path(workspace) / name
        base.local_json(path, value)
        evidence, key = base.digest_file(path), self.run_prefix + name
        self.output_keys.add(key)
        self.verify_private_bucket(evidence["bytes"])
        with tempfile.TemporaryDirectory(prefix="adopted-audit-readback-") as directory:
            readback = Path(directory) / "object"
            if not self.download(key, readback, evidence, optional=True):
                uncertain = False
                try:
                    with path.open("rb") as data:
                        with base.safe_response(self.session, "POST", self._url(key, write=True), headers={
                            **self.headers, "x-upsert": "false", "Content-Type": "application/octet-stream", "x-metadata": metadata,
                            "Content-Length": str(evidence["bytes"])}, data=data, timeout=(20, 300)) as response:
                            require(response.status_code in (200, 201, 400, 409), "AUDIT_CREATE_FAILED")
                except JobError as error:
                    if str(error) != "NETWORK_OR_SESSION_ERROR":
                        raise
                    uncertain = True
                require(self.download(key, readback, evidence, optional=True),
                        "UNCERTAIN_AUDIT_CREATE" if uncertain else "AUDIT_READBACK_MISSING")
        receipt = {"path": name, **evidence}
        if name != "completion.json":
            self.receipts[name] = receipt
        return receipt


def execute(request, output, sources, workspace, environment, runner):
    root = Path(workspace)
    os.chmod(root, 0o700)
    aggregates, plan_hashes = {}, set()
    for role in sorted(ROLES):
        restored = root / role
        completion = restore_source(sources[role], request, restored)
        plan_hashes.add(completion["proof"]["planSha256"])
        summary, original = validate_source_results(completion, restored, request, role)
        verified = rerun_arithmetic(restored, root / (role + "-arithmetic"), summary, original, role[7:], environment, runner)
        for book in sorted(summary):
            rows = verifier.read_lines(restored / "result" / (book + ".daily-nav.jsonl"))
            aggregates[book] = build_aggregate(book, rows, verified["books"][book]["closedTradeMetrics"], request, environment)
    require(len(plan_hashes) == 1 and set(aggregates) == BOOKS, "SOURCE_RESULTS_PLAN_MISMATCH")
    # Do not publish even one aggregate until BOTH result sets pass all checks.
    entries = [output.put(book + ".json", aggregates[book], root) for book in sorted(BOOKS)]
    completion = {"schema": COMPLETION_VERSION, "status": "COMPLETE", "auditRunId": environment["GITHUB_RUN_ID"],
                  "auditRunAttempt": environment["GITHUB_RUN_ATTEMPT"], "auditCommit": base.validated_code_commit(environment),
                  "auditWorkflow": WORKFLOW, "sourceRunId": request["sourceRunId"], "sourceCommit": request["sourceCommit"],
                  "sourceCompletionSha256": request["sourceCompletionSha256"], "verifiedArithmetic": True, "files": entries}
    output.put("completion.json", completion, root)
    return {"status": "COMPLETE", "phase": "ANNUAL_RESULT_AUDIT", "books": len(BOOKS), "verifiedArithmetic": True}


def public_failure_code(code):
    # A runtime exception, source value, URL, owner ID, or credential can never be
    # made public just because it looks like an uppercase error code.
    literals = set()
    for filename in (Path(__file__), Path(base.__file__), Path(core.__file__)):
        literals.update(node.value for node in ast.walk(ast.parse(filename.read_text())) if isinstance(node, ast.Constant) and
                        isinstance(node.value, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{1,150}", node.value))
    return code if code in literals else "AUDIT_FAILED_NO_PRIVATE_DETAILS_LOGGED"


def run_github_job(request_file, *, environment=None, session_factory=None, runner=base.run_command, emit=print):
    environment = dict(os.environ if environment is None else environment)
    session, output, sources = None, None, {}
    try:
        request = authorization(request_file, environment)
        session = core.transport.PrivateBucketSession(session_factory)
        output = AggregateStorage(session, environment, request)
        sources = {role: ReadOnlyResultStorage(session, environment, request, role) for role in ROLES}
        with tempfile.TemporaryDirectory(prefix="adopted-result-audit-", dir=environment.get("RUNNER_TEMP")) as root:
            result = execute(request, output, sources, root, environment, runner)
    except JobError as error:
        result = {"status": "STOPPED", "code": public_failure_code(str(error))}
    except Exception:
        result = {"status": "STOPPED", "code": "AUDIT_FAILED_NO_PRIVATE_DETAILS_LOGGED"}
    finally:
        for storage in list(sources.values()) + ([output] if output is not None else []):
            storage.headers.clear()
        if session is not None:
            try:
                session.close()
            except Exception:
                result = {"status": "STOPPED", "code": "AUDIT_TRANSPORT_CLOSE_FAILED"}
    emit(json.dumps(result, sort_keys=True))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", required=True)
    args = parser.parse_args()
    return 0 if run_github_job(args.request)["status"] == "COMPLETE" else 1


if __name__ == "__main__":
    sys.exit(main())
