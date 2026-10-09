#!/usr/bin/env python3
"""Private GitHub KR/ETF/US research I/O. No input, CM, registry, or production writes.

Requires already-configured Actions secrets. Execution needs workflow_dispatch or
an explicit, matching request commit on the fixed research branch. Tests inject
fake HTTP and subprocesses and never contact Storage. Raw and
prepared inputs and subprocess logs remain in a private temporary local directory,
never Actions artifacts/cache. Only allowlisted generated results are uploaded to
the new owner research run prefix, create-only, then byte/hash-read back.
"""
from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
from datetime import date
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
EXPECTED_SUPABASE_URL = "https://ahbvrtugugwnbrfnbxzp.supabase.co"
BUCKET = "cloudtrend-data"
CHUNK = 1024 * 1024
MAX_MANIFEST_BYTES = 4 * CHUNK
SOURCE_VERSION = "adopted-full-period-source-transfer-v1"
REQUEST_BRANCH = "refs/heads/feat/kr-etf-final-history"
REQUEST_FIELDS = {"mode", "market", "catalog_sha", "source_manifest_sha", "start", "through", "smoke_sessions"}
OUTPUT_NAMES = {"summary.json", "quality.json", "provenance.json", "report.md", "verification.json"}
OPTIONAL_OUTPUT_NAMES = {"input-provenance.json"}
BOOK_NAMES = {"KR_COMBINED_ADOPTED", "KOSPI_STANDALONE_DIAGNOSTIC", "KOSDAQ_STANDALONE_DIAGNOSTIC", "ETF_V02", "US_A0"}
BOOK_SUFFIXES = {"daily-nav.jsonl", "trades.jsonl", "yearly-budgets.json", "evidence.json", "contract.json", "final-state.json", "accounting.json"}
SUMMARY_FIELDS = {"schema", "status", "mode", "market", "start", "through", "codeCommit", "catalogSha256",
                  "books", "measurements", "preparation", "resultManifestSha256", "sourceCoverage", "verifiedArithmetic", "checks"}
BOOK_SUMMARY_FIELDS = {"status", "startDate", "endDate", "observations", "cagr", "mdd", "cumulativeReturn",
                       "missingValuationCount", "staleValuationCount", "annualization"}
MAX_METADATA_BYTES = 8 * 1024


class JobError(RuntimeError):
    """Only fixed credential-free codes cross the public Actions-log boundary."""


def require(condition, code):
    if not condition:
        raise JobError(code)


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def digest_file(path):
    digest, size = hashlib.sha256(), 0
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(CHUNK), b""):
            digest.update(chunk)
            size += len(chunk)
    return {"bytes": size, "sha256": digest.hexdigest()}


def check_hash(value):
    require(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value), "INVALID_SHA256")


def summary_date(value):
    if not isinstance(value, str):
        return False
    try:
        return date.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


def finite_number(value):
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def safe_symbol_audit_metadata(metadata):
    require(isinstance(metadata, dict) and set(metadata) == {"schema", "status", "sourceFileCount", "invalidClasses", "invalidRows", "examples", "resultManifestSha256"}, "INVALID_SYMBOL_AUDIT")
    require(metadata["schema"] == "adopted-kr-etf-symbol-audit-v1" and metadata["status"] == "INPUT_CLASSIFICATION_ONLY", "INVALID_SYMBOL_AUDIT")
    check_hash(metadata["resultManifestSha256"])
    require(type(metadata["sourceFileCount"]) is int and 0 < metadata["sourceFileCount"] <= 256, "INVALID_SYMBOL_AUDIT")
    require(all(type(metadata[k]) is int and 0 <= metadata[k] <= 2**53-1 for k in ("invalidClasses", "invalidRows")), "INVALID_SYMBOL_AUDIT_COUNTS")
    require(isinstance(metadata["examples"], list) and len(metadata["examples"]) <= 8, "INVALID_SYMBOL_AUDIT_EXAMPLES")
    for item in metadata["examples"]:
        require(isinstance(item, dict) and set(item) == {"rawSymbol", "normalizedSymbol", "market", "type", "rows", "sourceOrders"}, "INVALID_SYMBOL_AUDIT")
        require(all(isinstance(item[k], str) and len(item[k]) <= 128 for k in ("rawSymbol", "normalizedSymbol", "market", "type")), "INVALID_SYMBOL_AUDIT_LABEL")
        require(type(item["rows"]) is int and 0 < item["rows"] <= 2**53-1 and isinstance(item["sourceOrders"], list) and
                all(type(n) is int and 1 <= n <= metadata["sourceFileCount"] for n in item["sourceOrders"]), "INVALID_SYMBOL_AUDIT")
    header = base64.b64encode(json_bytes(metadata)).decode("ascii")
    require(len(header) <= MAX_METADATA_BYTES, "SYMBOL_AUDIT_TOO_LARGE")
    return header


def safe_summary_metadata(metadata):
    """Validate both shape and scalar domains; never serialize arbitrary source values."""
    require(isinstance(metadata, dict) and set(metadata) == SUMMARY_FIELDS, "INVALID_RESULT_METADATA_FIELDS")
    require(metadata["schema"] == "adopted-backtest-summary-v1" and metadata["status"] == "COMPLETE",
            "INVALID_RESULT_METADATA_STATUS")
    require(metadata["mode"] in ("smoke", "full") and metadata["market"] in ("kr", "etf", "kr-etf", "us"),
            "INVALID_RESULT_METADATA_MODE")
    require(summary_date(metadata["start"]) and summary_date(metadata["through"]) and
            metadata["start"] <= metadata["through"], "INVALID_RESULT_METADATA_DATES")
    validated_code_commit({"GITHUB_SHA": metadata["codeCommit"]})
    check_hash(metadata["catalogSha256"])
    check_hash(metadata["resultManifestSha256"])
    expected = {"US_A0"} if metadata["market"] == "us" else (
        {"ETF_V02"} if metadata["market"] == "etf" else
        {"KR_COMBINED_ADOPTED", "KOSPI_STANDALONE_DIAGNOSTIC", "KOSDAQ_STANDALONE_DIAGNOSTIC"} |
        ({"ETF_V02"} if metadata["market"] == "kr-etf" else set()))
    books = metadata["books"]
    require(isinstance(books, dict) and set(books) == expected, "INVALID_RESULT_METADATA_BOOKS")
    for book in books.values():
        require(isinstance(book, dict) and set(book) == BOOK_SUMMARY_FIELDS, "INVALID_RESULT_METADATA_BOOK_FIELDS")
        require(book["status"] in ("COMPLETE", "INCOMPLETE", "SAMPLE_INCOMPLETE") and
                book["annualization"] == "ACTUAL_DAYS_365_2425", "INVALID_RESULT_METADATA_BOOK_STATUS")
        require(book["startDate"] == metadata["start"] and
                (book["endDate"] is None or summary_date(book["endDate"]) and
                 metadata["start"] <= book["endDate"] <= metadata["through"]), "INVALID_RESULT_METADATA_BOOK_DATES")
        for field in ["observations", "missingValuationCount", "staleValuationCount"]:
            require(type(book[field]) is int and 0 <= book[field] <= 2 ** 53 - 1, "INVALID_RESULT_METADATA_COUNTS")
        require(book["missingValuationCount"] <= book["observations"] and
                book["staleValuationCount"] <= book["observations"], "INVALID_RESULT_METADATA_COUNTS")
        for field in ["cagr", "mdd", "cumulativeReturn"]:
            value = book[field]
            require(value is None or finite_number(value), "INVALID_RESULT_METADATA_METRIC")
        if metadata["mode"] == "smoke":
            require(book["status"] == "SAMPLE_INCOMPLETE" and all(book[field] is None for field in
                    ["cagr", "mdd", "cumulativeReturn"]), "SMOKE_METADATA_CANNOT_CLAIM_PERFORMANCE")
    require(metadata["verifiedArithmetic"] is True, "ARITHMETIC_NOT_VERIFIED")
    coverage = metadata["sourceCoverage"]
    require(isinstance(coverage, dict) and set(coverage) <= {"KOSPI", "KOSDAQ", "ETF"}, "INVALID_SOURCE_COVERAGE")
    for item in coverage.values():
        require(isinstance(item, dict) and set(item) == {"symbols", "rows", "firstDate", "lastDate"}, "INVALID_SOURCE_COVERAGE")
        require(all(type(item[k]) is int and 0 <= item[k] <= 2**53-1 for k in ("symbols", "rows")), "INVALID_SOURCE_COVERAGE")
        require(all(item[k] is None or summary_date(item[k]) for k in ("firstDate", "lastDate")), "INVALID_SOURCE_COVERAGE")
    checks = metadata["checks"]
    require(isinstance(checks, dict) and set(checks) == {"calendar", "signals", "accounts", "featureLowerBounds"}, "INVALID_CHECKS")
    require(isinstance(checks["calendar"], dict) and set(checks["calendar"]) == {"first", "last"} and
            all(value is None or summary_date(value) for value in checks["calendar"].values()), "INVALID_CHECKS_CALENDAR")
    bounds = checks["featureLowerBounds"]
    require(isinstance(bounds, dict) and set(bounds) == {"KR", "ETF"} and all(value is None or summary_date(value) for value in bounds.values()), "INVALID_CHECKS_FEATURE_BOUNDS")
    signals = checks["signals"]
    require(isinstance(signals, dict) and set(signals) <= {"KOSPI", "KOSDAQ", "ETF"}, "INVALID_CHECKS_SIGNALS")
    for value in signals.values():
        require(isinstance(value, dict) and set(value) == {"scoreFirst", "entryFirst", "scoreCount", "entryCount"}, "INVALID_CHECKS_SIGNALS")
        require(all(value[k] is None or summary_date(value[k]) for k in ("scoreFirst", "entryFirst")), "INVALID_CHECKS_SIGNALS")
        require(all(type(value[k]) is int and 0 <= value[k] <= 2**53-1 for k in ("scoreCount", "entryCount")), "INVALID_CHECKS_SIGNALS")
    accounts = checks["accounts"]
    require(isinstance(accounts, dict) and set(accounts) <= expected, "INVALID_CHECKS_ACCOUNTS")
    for value in accounts.values():
        require(isinstance(value, dict) and set(value) == {"events", "openCount"} and
                all(type(count) is int and 0 <= count <= 2**53-1 for count in value.values()), "INVALID_CHECKS_ACCOUNTS")
    preparation = metadata["preparation"]
    require(isinstance(preparation, dict) and set(preparation) == {"elapsedSeconds", "maxRssKiB"} and
            finite_number(preparation["elapsedSeconds"]) and preparation["elapsedSeconds"] >= 0 and
            type(preparation["maxRssKiB"]) is int and preparation["maxRssKiB"] > 0,
            "INVALID_PREPARATION_MEASUREMENTS")
    measurements = metadata["measurements"]
    require(isinstance(measurements, list) and len(measurements) == (2 if metadata["mode"] == "full" else 1),
            "INVALID_RESULT_METADATA_MEASUREMENTS")
    for item in measurements:
        require(isinstance(item, dict) and set(item) == {"elapsedSeconds", "maxRssKiB"}, "INVALID_RESULT_METADATA_MEASUREMENTS")
        require(finite_number(item["elapsedSeconds"]) and item["elapsedSeconds"] >= 0 and
                type(item["maxRssKiB"]) is int and 0 < item["maxRssKiB"] <= 2 ** 53 - 1,
                "INVALID_RESULT_METADATA_MEASUREMENTS")
    payload = json_bytes(metadata)
    header = base64.b64encode(payload).decode("ascii")
    require(len(payload) <= MAX_METADATA_BYTES and len(header) <= MAX_METADATA_BYTES, "RESULT_METADATA_TOO_LARGE")
    return header


def build_summary_metadata(report, summary, manifest_hash):
    require(isinstance(summary, dict) and all(isinstance(value, dict) for value in summary.values()), "INVALID_RESULT_SUMMARY")
    metadata = {"schema": "adopted-backtest-summary-v1",
                **{field: report[field] for field in ["status", "mode", "market", "start", "through", "codeCommit", "catalogSha256"]},
                "preparation": report["preparation"], "checks": report["checks"],
                "sourceCoverage": report.get("sourceCoverage", {}), "verifiedArithmetic": report["verifiedArithmetic"],
                "books": {book: {field: values.get(field) for field in BOOK_SUMMARY_FIELDS} for book, values in summary.items()},
                "measurements": [{field: item[field] for field in ["elapsedSeconds", "maxRssKiB"]} for item in report["measurements"]],
                "resultManifestSha256": manifest_hash}
    safe_summary_metadata(metadata)
    return metadata


def validate_options(options):
    check_hash(options.catalog_sha)
    check_hash(options.source_manifest_sha)
    require(isinstance(options.mode, str) and options.mode in {"smoke", "full", "symbols"} and
            isinstance(options.market, str) and options.market in {"kr", "etf", "kr-etf", "us"}, "INVALID_MODE_OR_MARKET")
    require(type(options.smoke_sessions) is int and 20 <= options.smoke_sessions <= 60, "INVALID_SMOKE_SESSIONS")
    try:
        start, through = date.fromisoformat(options.start), date.fromisoformat(options.through)
    except (ValueError, TypeError):
        raise JobError("INVALID_SELECTED_DATES") from None
    require(start.isoformat() == options.start and through.isoformat() == options.through and start <= through, "INVALID_SELECTED_DATES")


def read_local_json(file, limit, code):
    try:
        path = Path(file)
        require(path.is_file() and not path.is_symlink() and path.stat().st_size <= limit, code)
        data = json.loads(path.read_bytes())
    except JobError:
        raise
    except (OSError, ValueError, TypeError, UnicodeDecodeError):
        raise JobError(code) from None
    require(isinstance(data, dict), code)
    return data


def authorize_github_trigger(options, environment):
    validated_code_commit(environment)
    require(environment.get("GITHUB_ACTIONS") == "true" and
            environment.get("GITHUB_WORKFLOW") == "KR ETF final-strategy backtest", "EXPLICIT_GITHUB_JOB_REQUIRED")
    if environment.get("GITHUB_EVENT_NAME") == "workflow_dispatch":
        return
    require(environment.get("GITHUB_EVENT_NAME") == "push" and
            environment.get("GITHUB_REF") == REQUEST_BRANCH and
            isinstance(getattr(options, "request_file", None), str), "EXPLICIT_GITHUB_JOB_REQUIRED")
    # Re-read rather than trusting only a marker from argument parsing. A push
    # must have an explicit JSON request whose mode matches both CLI and commit.
    request = read_local_json(options.request_file, 16 * 1024, "INVALID_REQUEST_FILE")
    require(set(request) == REQUEST_FIELDS and all(
        request[field] == getattr(options, field) for field in REQUEST_FIELDS), "REQUEST_OPTIONS_MISMATCH")
    event = read_local_json(environment.get("GITHUB_EVENT_PATH"), 10 * CHUNK, "INVALID_PUSH_EVENT")
    head = event.get("head_commit")
    message = head.get("message") if isinstance(head, dict) else None
    require(isinstance(message, str) and message.splitlines() and
            message.splitlines()[0] == "run(kr-etf-backtest): " + options.mode, "PUSH_REQUEST_COMMIT_MISMATCH")


def validated_code_commit(environment):
    commit = environment.get("GITHUB_SHA")
    require(isinstance(commit, str) and re.fullmatch(r"[0-9a-f]{40}", commit), "INVALID_CODE_COMMIT")
    return commit


def validate_owner(owner):
    require(isinstance(owner, str) and re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", owner), "INVALID_STORAGE_OWNER")


def input_prefix(owner):
    validate_owner(owner)
    return owner + "/research/adopted-full-period/inputs/"


def validate_manifest(manifest, catalog_sha, owner):
    check_hash(catalog_sha)
    require(isinstance(manifest, dict) and manifest.get("version") == SOURCE_VERSION, "INVALID_SOURCE_MANIFEST")
    require(manifest.get("bucket") == BUCKET and manifest.get("owner") == owner and
            manifest.get("catalogSha256") == catalog_sha, "SOURCE_MANIFEST_SCOPE_MISMATCH")
    files = manifest.get("orderedFiles")
    require(isinstance(files, list) and 0 < len(files) <= 256, "INVALID_SOURCE_FILE_LIST")
    catalog, paths, keys = [], set(), set()
    total = 0
    for order, item in enumerate(files, 1):
        require(isinstance(item, dict) and type(item.get("order")) is int and item["order"] == order,
                "SOURCE_ORDER_MISMATCH")
        relative = item.get("sourcePath")
        require(isinstance(relative, str) and re.fullmatch(r"(?:stock_history|sources)/[A-Za-z0-9_.-]+\.parquet", relative),
                "INVALID_SOURCE_PATH")
        expected_group = "STOCK_KR" if relative.startswith("stock_history/") else "ETF"
        require(item.get("sourceGroup") == expected_group, "SOURCE_GROUP_MISMATCH")
        check_hash(item.get("sha256"))
        require(type(item.get("bytes")) is int and 0 < item["bytes"] <= 256 * CHUNK, "INVALID_SOURCE_BYTES")
        file_id = item.get("driveFileId")
        require(isinstance(file_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{20,100}", file_id), "INVALID_CATALOG_SOURCE_ID")
        key = input_prefix(owner) + item["sha256"] + "/" + relative
        require(item.get("storagePath") == key, "SOURCE_STORAGE_PATH_MISMATCH")
        require(relative not in paths and key not in keys, "DUPLICATE_SOURCE_PATH")
        paths.add(relative)
        keys.add(key)
        total += item["bytes"]
        catalog.append({"fileId": file_id, "path": relative, "bytes": item["bytes"], "sha256": item["sha256"]})
    # The private transfer can also pin US metadata. It participates in catalog
    # integrity in original order, but must not enter the KR staging/parser path.
    extras = manifest.get("extraFiles", [])
    require(isinstance(extras, list) and len(extras) <= 32, "INVALID_EXTRA_FILE_LIST")
    for item in extras:
        require(isinstance(item, dict) and "order" not in item and item.get("sourceGroup") == "US_METADATA", "INVALID_EXTRA_SOURCE_GROUP")
        relative = item.get("sourcePath")
        require(isinstance(relative, str) and re.fullmatch(r"metadata/[A-Za-z0-9_.-]+\.parquet", relative), "INVALID_EXTRA_SOURCE_PATH")
        check_hash(item.get("sha256"))
        require(type(item.get("bytes")) is int and 0 < item["bytes"] <= 256 * CHUNK, "INVALID_SOURCE_BYTES")
        file_id = item.get("driveFileId")
        require(isinstance(file_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{20,100}", file_id), "INVALID_CATALOG_SOURCE_ID")
        key = input_prefix(owner) + item["sha256"] + "/" + relative
        require(item.get("storagePath") == key and relative not in paths and key not in keys, "INVALID_EXTRA_SOURCE_KEY")
        paths.add(relative)
        keys.add(key)
        total += item["bytes"]
        catalog.append({"fileId": file_id, "path": relative, "bytes": item["bytes"], "sha256": item["sha256"]})
    require(total <= 8 * 1024 * CHUNK, "SOURCE_TOTAL_TOO_LARGE")
    require(hashlib.sha256(json_bytes(catalog)).hexdigest() == catalog_sha, "CATALOG_HASH_MISMATCH")
    return files


@contextmanager
def safe_response(session, method, url, **kwargs):
    response = None
    try:
        response = session.request(method, url, allow_redirects=False, **kwargs)
        yield response
    except JobError:
        raise
    except Exception:
        raise JobError("NETWORK_OR_SESSION_ERROR") from None
    finally:
        if response is not None:
            response.close()


def response_json(response):
    try:
        result = response.json()
    except Exception:
        raise JobError("INVALID_SERVICE_METADATA") from None
    require(isinstance(result, dict), "INVALID_SERVICE_METADATA")
    return result


def confirmed_missing(response):
    if response.status_code not in (400, 404):
        return False
    data = response_json(response)
    return data.get("code") == "NoSuchKey" or (
        str(data.get("statusCode")) == "404" and data.get("message") == "Object not found")


class PrivateStorage:
    def __init__(self, session, url, owner, secret, catalog_sha, run_id):
        require(url == EXPECTED_SUPABASE_URL, "UNEXPECTED_STORAGE_PROJECT")
        validate_owner(owner)
        require(isinstance(secret, str) and bool(secret.strip()), "EXISTING_SECRET_UNAVAILABLE")
        check_hash(catalog_sha)
        require(isinstance(run_id, str) and re.fullmatch(r"[1-9][0-9]*-[1-9][0-9]*", run_id), "INVALID_RUN_ID")
        self.session = session
        self.owner = owner
        self.headers = {"apikey": secret, "Authorization": "Bearer " + secret}
        self.manifest_key = input_prefix(owner) + catalog_sha + "/source-manifest.json"
        self.run_prefix = owner + "/research/adopted-full-period/runs/" + run_id + "/"
        self.input_keys = {self.manifest_key}
        self.output_keys = set()

    def verify_private_bucket(self, size=0):
        with safe_response(self.session, "GET", EXPECTED_SUPABASE_URL + "/storage/v1/bucket/" + BUCKET,
                           headers=self.headers, timeout=(20, 60)) as response:
            require(response.status_code == 200, "BUCKET_METADATA_UNAVAILABLE")
            bucket = response_json(response)
        require(bucket.get("id") == BUCKET and bucket.get("public") is False, "BUCKET_NOT_PRIVATE")
        limit = bucket.get("file_size_limit")
        require(limit is None or type(limit) is int and limit >= size, "BUCKET_FILE_LIMIT_UNVERIFIED")
        allowed = bucket.get("allowed_mime_types")
        require(not allowed or isinstance(allowed, list) and any(
            mime in allowed for mime in ["application/octet-stream", "application/*", "*/*"]), "BUCKET_RESULT_MIME_RESTRICTED")

    def _url(self, key, *, write=False):
        require(key in (self.output_keys if write else self.input_keys | self.output_keys), "STORAGE_PATH_OUTSIDE_JOB")
        suffix = "/object/" if write else "/object/authenticated/"
        return EXPECTED_SUPABASE_URL + "/storage/v1" + suffix + BUCKET + "/" + quote(key, safe="/._-")

    def manifest(self):
        with safe_response(self.session, "GET", self._url(self.manifest_key), headers=self.headers,
                           stream=True, timeout=(20, 300)) as response:
            require(response.status_code == 200, "SOURCE_MANIFEST_UNAVAILABLE")
            chunks, size = [], 0
            for chunk in response.iter_content(CHUNK):
                size += len(chunk)
                require(size <= MAX_MANIFEST_BYTES, "SOURCE_MANIFEST_TOO_LARGE")
                chunks.append(chunk)
        return b"".join(chunks)

    def download(self, key, target, evidence, *, optional=False):
        with safe_response(self.session, "GET", self._url(key), headers=self.headers,
                           stream=True, timeout=(20, 300)) as response:
            if optional and confirmed_missing(response):
                return False
            require(response.status_code == 200, "PRIVATE_OBJECT_READ_FAILED")
            digest, size = hashlib.sha256(), 0
            try:
                with Path(target).open("xb") as output:
                    os.chmod(target, 0o600)
                    for chunk in response.iter_content(CHUNK):
                        size += len(chunk)
                        require(size <= evidence["bytes"], "PRIVATE_OBJECT_SIZE_MISMATCH")
                        digest.update(chunk)
                        output.write(chunk)
                require(size == evidence["bytes"] and digest.hexdigest() == evidence["sha256"], "PRIVATE_OBJECT_HASH_MISMATCH")
            except BaseException:
                Path(target).unlink(missing_ok=True)
                raise
        return True

    def create_result(self, relative, local, *, metadata=None):
        require(re.fullmatch(r"(?:result|preflight-smoke)/[A-Za-z0-9_.-]+|run-manifest\.json", relative), "INVALID_RESULT_PATH")
        key = self.run_prefix + relative
        self.output_keys.add(key)
        evidence = digest_file(local)
        metadata_headers = {}
        if metadata is not None:
            require(relative == "run-manifest.json", "METADATA_ONLY_ALLOWED_ON_RUN_MANIFEST")
            metadata_headers["x-metadata"] = (safe_symbol_audit_metadata(metadata) if metadata.get("schema") == "adopted-kr-etf-symbol-audit-v1" else safe_summary_metadata(metadata))
            require(metadata["resultManifestSha256"] == evidence["sha256"], "RESULT_METADATA_HASH_MISMATCH")
        self.verify_private_bucket(evidence["bytes"])
        # Existing objects are never overwritten. A same-attempt retry may verify identical bytes.
        with tempfile.TemporaryDirectory(prefix="adopted-readback-") as directory:
            readback = Path(directory) / "object"
            if self.download(key, readback, evidence, optional=True):
                return {"path": relative, **evidence, "alreadyVerified": True}
            uncertain = False
            try:
                with Path(local).open("rb") as data:
                    with safe_response(self.session, "POST", self._url(key, write=True), headers={
                        **self.headers, "x-upsert": "false", "Content-Type": "application/octet-stream",
                        **metadata_headers,
                        "Content-Length": str(evidence["bytes"])}, data=data, timeout=(20, 900)) as response:
                        require(response.status_code in (200, 201, 400, 409), "RESULT_CREATE_FAILED")
            except JobError as error:
                if str(error) != "NETWORK_OR_SESSION_ERROR":
                    raise
                uncertain = True
            exists = self.download(key, readback, evidence, optional=True)
            require(exists, "UNCERTAIN_RESULT_CREATE" if uncertain else "RESULT_READBACK_MISSING")
        return {"path": relative, **evidence, "alreadyVerified": False}

    def download_observed(self, key, target, expected_bytes):
        """Originals without a supplied hash retain that weaker evidence explicitly."""
        require(type(expected_bytes) is int and 0 < expected_bytes <= 8 * 1024 * CHUNK, "INVALID_OBSERVED_SOURCE_BYTES")
        with safe_response(self.session, "GET", self._url(key), headers=self.headers,
                           stream=True, timeout=(20, 300)) as response:
            require(response.status_code == 200, "PRIVATE_OBJECT_READ_FAILED")
            digest, size = hashlib.sha256(), 0
            try:
                with Path(target).open("xb") as output:
                    os.chmod(target, 0o600)
                    for chunk in response.iter_content(CHUNK):
                        size += len(chunk)
                        require(size <= expected_bytes, "PRIVATE_OBJECT_SIZE_MISMATCH")
                        digest.update(chunk)
                        output.write(chunk)
                require(size == expected_bytes, "PRIVATE_OBJECT_SIZE_MISMATCH")
            except BaseException:
                Path(target).unlink(missing_ok=True)
                raise
        return {"bytes": size, "sha256": digest.hexdigest(), "hashStatus": "OBSERVED_AT_DOWNLOAD_NOT_PREPINNED"}

    def close(self):
        self.headers.clear()
        self.session.close()


def local_json(path, value):
    with Path(path).open("xb") as output:
        os.chmod(path, 0o600)
        output.write(json_bytes(value))


def child_environment(environment):
    # Neither the parser nor the strategy subprocess can inherit Storage/GitHub credentials.
    allowed = {"PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ", "NODE_OPTIONS"}
    return {key: value for key, value in environment.items() if key in allowed}


def run_command(command, log, environment):
    with Path(log).open("xb") as output:
        os.chmod(log, 0o600)
        result = subprocess.run(command, cwd=ROOT, env=child_environment(environment),
                                stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT, check=False)
    if result.returncode != 0:
        stage = "PREPARE" if "--output" in command else "VERIFY" if "--results" in command else "REPLAY"
        with Path(log).open("rb") as stream:
            stream.seek(max(0, Path(log).stat().st_size - 32768))
            tail = stream.read().decode("utf-8", errors="replace")
        known = [
            ("Cannot create a string longer", "STRING_LIMIT"),
            ("Invalid string length", "STRING_LIMIT"),
            ("heap out of memory", "HEAP_LIMIT"),
            ("Reached heap limit", "HEAP_LIMIT"),
            ("Legacy number needs more than eight decimal places", "PRICE_PRECISION"),
            ("Source byte count mismatch", "INPUT_SIZE"),
            ("Source SHA-256 mismatch", "INPUT_HASH"),
            ("outside the declared market calendar", "CALENDAR_OBSERVATION"),
            ("differ from canonical KOSPI session evidence", "CALENDAR_MISMATCH"),
            ("boundaries must be covered", "PERIOD_BOUNDARY"),
            ("Unsupported lossless CSV type", "SOURCE_SCHEMA"),
            ("Canonical source requires", "SOURCE_COLUMNS"),
            ("symbols must", "SYMBOL_SCHEMA"),
            ("symbol/date/version", "SIGNAL_IDENTITY"),
            ("Annual ETF asset base requires", "ANNUAL_NAV_UNAVAILABLE"),
            ("Negative cash or cash reconciliation mismatch", "CASH_RECONCILIATION"),
            ("integer sizing mismatch", "INTEGER_SIZING"),
            ("Performance metric mismatch", "METRIC_RECONCILIATION"),
        ]
        code = next((code for text, code in known if text in tail), None)
        if code is None:
            # Only literal assertion text from this public source tree may identify
            # a failure. Never print the private message or interpolation values.
            assertions = []
            for folder in (ROOT / "src/lib", ROOT / "scripts"):
                for file in folder.rglob("*.ts"):
                    if ".test." in file.name:
                        continue
                    source = file.read_text(encoding="utf-8")
                    for match in re.finditer(r'throw new Error\(\s*["\x27`]([^"\x27`\n$]{16,})', source):
                        literal = match.group(1)
                        if literal in tail:
                            relative = file.relative_to(ROOT).as_posix()
                            line = source.count("\n", 0, match.start()) + 1
                            assertions.append((len(literal), relative, line))
            if assertions:
                _, relative, line = max(assertions)
                code = "SOURCE_ASSERT_" + relative + ":" + str(line)
            else:
                frames = re.findall(r'RESEARCH_FAILURE_FRAME ((?:src/lib|scripts)/[A-Za-z0-9_./-]+\.ts:[0-9]+:[0-9]+)', tail)
                if frames:
                    code = "SOURCE_FRAME_" + frames[0]
                else:
                    code = "PROCESS_KILLED" if result.returncode in (-9, 137) else "UNCLASSIFIED"
        raise JobError("LOCAL_RESEARCH_PROCESS_FAILED_" + stage + "_" + code)
    print(json.dumps({"phase": "PREPARE_COMPLETE" if "--output" in command else "VERIFY_COMPLETE" if "--results" in command else "REPLAY_COMPLETE"}), flush=True)


def output_files(directory):
    require(directory.is_dir() and not directory.is_symlink(), "RESULT_DIRECTORY_UNAVAILABLE")
    files = []
    for item in sorted(directory.iterdir()):
        require(item.is_file() and not item.is_symlink(), "UNEXPECTED_RESULT_FILE")
        book = next((book for book in BOOK_NAMES if item.name.startswith(book + ".")), None)
        require(item.name in OUTPUT_NAMES | OPTIONAL_OUTPUT_NAMES or book and item.name[len(book) + 1:] in BOOK_SUFFIXES, "UNEXPECTED_RESULT_FILE")
        files.append(item)
    require(OUTPUT_NAMES <= {item.name for item in files}, "INCOMPLETE_RESULT_FILES")
    return files


def load_us_input_hook():
    specification = importlib.util.spec_from_file_location("adopted_us_private_inputs", ROOT / "scripts/adopted-us-private-inputs.py")
    require(specification is not None and specification.loader is not None, "US_PRIVATE_INPUT_HOOK_UNAVAILABLE")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module.stage_us_private_inputs


def verified_hook_path(value, root):
    require(isinstance(value, (str, Path)), "INVALID_US_HOOK_PATH")
    file = Path(value)
    require(file.is_file() and not file.is_symlink(), "INVALID_US_HOOK_PATH")
    try:
        relative = file.absolute().relative_to(root.absolute())
        require(".." not in relative.parts, "US_HOOK_PATH_OUTSIDE_PRIVATE_STAGE")
        file.resolve(strict=True).relative_to(root.resolve(strict=True))
    except (ValueError, OSError):
        raise JobError("US_HOOK_PATH_OUTSIDE_PRIVATE_STAGE") from None
    current = root
    for piece in relative.parts:
        current = current / piece
        require(not current.is_symlink(), "INVALID_US_HOOK_PATH")
    return str(file.resolve(strict=True))


def execute_job(options, storage, workspace, environment, command_runner=run_command, us_input_hook=None):
    """Injected storage/runner make this entire workflow testable without auth/network."""
    validate_options(options)
    code_commit = validated_code_commit(environment)
    environment = child_environment(environment)
    root = Path(workspace)
    require(root.is_dir() and not root.is_symlink() and not any(root.iterdir()), "PRIVATE_WORKSPACE_NOT_EMPTY")
    os.chmod(root, 0o700)
    storage.verify_private_bucket()
    payload = storage.manifest()
    require(hashlib.sha256(payload).hexdigest() == options.source_manifest_sha, "SOURCE_MANIFEST_HASH_MISMATCH")
    try:
        manifest = json.loads(payload)
    except (ValueError, UnicodeDecodeError):
        raise JobError("INVALID_SOURCE_MANIFEST_JSON") from None
    sources = validate_manifest(manifest, options.catalog_sha, storage.owner)
    source_manifest = root / "source-manifest.json"
    with source_manifest.open("xb") as output:
        output.write(payload)
    os.chmod(source_manifest, 0o600)
    prepared = root / "prepared"
    input_provenance = None
    if options.market == "us":
        staged = root / "us-inputs"
        hook = us_input_hook or load_us_input_hook()
        try:
            inputs = hook(storage, storage.owner, manifest, staged)
        except Exception as error:
            if type(error).__name__ == "UsInputError" and re.fullmatch(r"[A-Z][A-Z0-9_]{1,95}", str(error)):
                raise JobError("US_INPUTS_" + str(error)) from None
            raise
        require(isinstance(inputs, dict) and isinstance(inputs.get("canonical"), list) and inputs["canonical"] and
                isinstance(inputs.get("provenance"), dict), "INVALID_US_INPUT_HOOK_RESULT")
        canonical = [verified_hook_path(file, staged) for file in inputs["canonical"]]
        require(len(set(canonical)) == len(canonical), "DUPLICATE_US_CANONICAL_PATH")
        command = [sys.executable, str(ROOT / "scripts/prepare-adopted-us-backtest.py"),
                   "--canonical", *canonical, "--benchmark", verified_hook_path(inputs.get("benchmark"), staged),
                   "--master", verified_hook_path(inputs.get("master"), staged), "--output", str(prepared),
                   "--start", options.start, "--through", options.through]
        if inputs.get("sectorMap") is not None:
            command += ["--sector-map", verified_hook_path(inputs["sectorMap"], staged)]
        input_provenance = inputs["provenance"]
    else:
        staged = root / "raw"
        staged.mkdir(mode=0o700)
        storage.input_keys.update(item["storagePath"] for item in sources)
        for item in sources:
            target = staged / item["sourcePath"]
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            storage.download(item["storagePath"], target, item)
        command = [sys.executable, str(ROOT / "scripts/prepare-adopted-kr-etf-inputs.py"),
                   "--source-manifest", str(source_manifest), "--staged-root", str(staged),
                   "--output", str(prepared), "--through", options.through]
        if options.mode == "symbols":
            profile_path = root / "run-manifest.json"
            command[command.index("--output")+1] = str(profile_path)
            command += ["--inspect-symbols-only"]
            command_runner(command, root / "symbol-audit.log", environment)
            profile = read_local_json(profile_path, CHUNK, "INVALID_SYMBOL_AUDIT_FILE")
            metadata = {"schema": profile["schema"], "status": profile["status"], "sourceFileCount": profile["sourceFileCount"],
                        "invalidClasses": len(profile["invalid"]), "invalidRows": sum(item["rows"] for item in profile["invalid"]),
                        "examples": profile["invalid"][:8], "resultManifestSha256": digest_file(profile_path)["sha256"]}
            storage.create_result("run-manifest.json", profile_path, metadata=metadata)
            return {"status": "INPUT_CLASSIFICATION_ONLY", "mode": "symbols", "invalidClasses": len(profile["invalid"])}
    command_runner(command, root / "prepare.log", environment)
    prepared_manifest = read_local_json(prepared / "manifest.json", 8 * CHUNK, "INVALID_PREPARED_MANIFEST")
    preparation = prepared_manifest.get("preparationMetrics")
    require(isinstance(preparation, dict) and set(preparation) == {"elapsedSeconds", "maxRssKiB"} and
            finite_number(preparation["elapsedSeconds"]) and preparation["elapsedSeconds"] >= 0 and
            type(preparation["maxRssKiB"]) is int and preparation["maxRssKiB"] > 0,
            "INVALID_PREPARATION_MEASUREMENTS")
    runs = []
    def replay(label, smoke):
        target = root / label
        command = [str(ROOT / "node_modules/.bin/vite-node"), "--config", "vitest.adopted-backtest.config.ts",
                   "scripts/run-adopted-kr-etf-backtest.ts", "--", "--run-adopted-backtest",
                   "--market", options.market, "--manifest", str(prepared / "manifest.json"),
                   "--start", options.start, "--through", options.through, "--out", str(target)]
        if smoke:
            command += ["--smoke-sessions", str(options.smoke_sessions)]
        before = time.monotonic()
        command_runner(command, root / (label + ".log"), environment)
        if input_provenance is not None:
            local_json(target / "input-provenance.json", input_provenance)
        command_runner([sys.executable, str(ROOT / "scripts/verify-adopted-kr-etf-results.py"), "--results", str(target)],
                       root / (label + "-verification.log"), environment)
        verification = read_local_json(target / "verification.json", 65536, "INVALID_ARITHMETIC_VERIFICATION")
        require(verification.get("status") == "PASS", "ARITHMETIC_VERIFICATION_FAILED")
        files = output_files(target)
        try:
            quality = json.loads((target / "quality.json").read_bytes())
        except (ValueError, UnicodeDecodeError):
            raise JobError("INVALID_RESULT_QUALITY") from None
        require(quality.get("runStatus") == "FINISHED" and quality.get("mode") == (
            "SAMPLE_INCOMPLETE" if smoke else "SELECTED_RANGE_REPLAY"), "RESULT_MODE_MISMATCH")
        require(type(quality.get("maxRssKiB")) in (int, float) and quality["maxRssKiB"] > 0 and
                type(quality.get("elapsedSeconds")) in (int, float) and quality["elapsedSeconds"] >= 0,
                "RESULT_RESOURCE_MEASUREMENTS_MISSING")
        if smoke:
            require(quality.get("sessions") == options.smoke_sessions, "SMOKE_SESSION_COUNT_MISMATCH")
        runs.append({"directory": target, "files": files, "mode": "smoke" if smoke else "full",
                     "elapsedSeconds": time.monotonic() - before,
                     "runnerElapsedSeconds": quality["elapsedSeconds"], "maxRssKiB": quality["maxRssKiB"]})
    # The actual source/universe is loaded for this smoke, including genuine history.
    # A failed smoke never advances to full; no synthetic resource estimate is substituted.
    if options.mode == "full":
        replay("preflight-smoke", True)
    replay("result", options.mode == "smoke")
    outputs = []
    for run in runs:
        for file in run["files"]:
            outputs.append(storage.create_result(run["directory"].name + "/" + file.name, file))
    result_quality = read_local_json(root / "result" / "quality.json", 4*CHUNK, "INVALID_RESULT_QUALITY")
    readiness = result_quality.get("signalReadiness", {})
    checks = {
        "calendar": {"first": result_quality.get("sourceCalendarStart"), "last": result_quality.get("sourceCalendarEnd")},
        "featureLowerBounds": {market: result_quality.get("featureWarmupLowerBounds", {}).get(market) for market in ("KR", "ETF")},
        "signals": {market: {
            "scoreFirst": readiness.get("firstAnyValidScoreDate", {}).get(market),
            "entryFirst": readiness.get("firstEntryReadyDate", {}).get(market),
            "scoreCount": readiness.get("validScoreObservations", {}).get(market, 0),
            "entryCount": readiness.get("entryReadyObservations", {}).get(market, 0),
        } for market in ("KOSPI", "KOSDAQ", "ETF")},
        "accounts": {book: {"events": result_quality[book]["tradeCount"], "openCount": result_quality[book]["terminalOpenPositions"]}
                     for book in BOOK_NAMES if isinstance(result_quality.get(book), dict) and "tradeCount" in result_quality[book]},
    }
    report = {"version": "adopted-private-backtest-job-v1", "status": "COMPLETE", "mode": options.mode,
              "codeCommit": code_commit,
              "market": options.market, "start": options.start, "through": options.through,
              "catalogSha256": options.catalog_sha, "sourceManifestSha256": hashlib.sha256(payload).hexdigest(),
              "validatedKrEtfCatalogFiles": len(sources),
              "downloadedKrEtfFiles": len(sources) if options.market != "us" else 0,
              "downloadedKrEtfBytes": sum(item["bytes"] for item in sources) if options.market != "us" else 0,
              "usInputProvenance": input_provenance,
              "preparation": preparation,
              "verifiedArithmetic": True, "checks": checks,
              "sourceCoverage": result_quality.get("sourceCoverage", {}),
              "measurements": [{key: value for key, value in run.items() if key not in ("directory", "files")} for run in runs],
              "outputs": outputs, "rawInputsUploaded": False, "logsUploaded": False,
              "cmAndOriginalSourcesUnmodified": True, "actionsArtifactsOrCacheUsed": False}
    report_path = root / "run-manifest.json"
    local_json(report_path, report)
    try:
        summary = json.loads((root / "result" / "summary.json").read_bytes())
    except (ValueError, UnicodeDecodeError):
        raise JobError("INVALID_RESULT_SUMMARY") from None
    metadata = build_summary_metadata(report, summary, digest_file(report_path)["sha256"])
    storage.create_result("run-manifest.json", report_path, metadata=metadata)  # Completion marker is always last.
    return {"status": "COMPLETE", "mode": options.mode, "market": options.market, "outputFiles": len(outputs)}


def run_github_job(options, *, environment=None, session_factory=None, command_runner=run_command, us_input_hook=None, emit=print):
    environment = dict(os.environ if environment is None else environment)
    storage = None
    try:
        validate_options(options)
        authorize_github_trigger(options, environment)
        run_id = environment.get("GITHUB_RUN_ID", "") + "-" + environment.get("GITHUB_RUN_ATTEMPT", "")
        if session_factory is None:
            import requests
            session_factory = requests.Session
        storage = PrivateStorage(session_factory(), environment.get("SUPABASE_URL", ""),
                                 environment.get("SUPABASE_USER_ID", ""), environment.get("SUPABASE_SERVICE_ROLE_KEY", ""),
                                 options.catalog_sha, run_id)
        with tempfile.TemporaryDirectory(prefix="adopted-private-job-", dir=environment.get("RUNNER_TEMP")) as workspace:
            result = execute_job(options, storage, workspace, environment, command_runner, us_input_hook)
        result["privateRun"] = run_id
    except JobError as error:
        result = {"status": "STOPPED", "code": str(error)}
    except Exception:
        result = {"status": "STOPPED", "code": "UNEXPECTED_JOB_ERROR_NO_DETAILS_LOGGED"}
    finally:
        if storage is not None:
            storage.close()
    emit(json.dumps(result, sort_keys=True))
    return result


def parse_options(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", dest="request_file", help="Local JSON containing seven explicit research selection fields")
    parser.add_argument("--catalog-sha")
    parser.add_argument("--source-manifest-sha")
    parser.add_argument("--mode", choices=["smoke", "full", "symbols"])
    parser.add_argument("--market", choices=["kr", "etf", "kr-etf", "us"])
    parser.add_argument("--start")
    parser.add_argument("--through")
    parser.add_argument("--smoke-sessions", type=int)
    options = parser.parse_args(argv)
    if options.request_file is not None:
        require(all(getattr(options, field) is None for field in REQUEST_FIELDS), "REQUEST_CANNOT_MIX_SELECTION_FLAGS")
        request = read_local_json(options.request_file, 16 * 1024, "INVALID_REQUEST_FILE")
        require(set(request) == REQUEST_FIELDS, "INVALID_REQUEST_FIELDS")
        for field, value in request.items():
            setattr(options, field, value)
    elif options.smoke_sessions is None:
        options.smoke_sessions = 20
    validate_options(options)
    return options


def main():
    try:
        options = parse_options()
        require(options.market in ("kr", "etf", "kr-etf"), "ONLY_KR_ETF_REPLAY_ALLOWED")
    except JobError as error:
        print(json.dumps({"status": "STOPPED", "code": str(error)}, sort_keys=True))
        return 1
    result = run_github_job(options)
    return 0 if result["status"] in ("COMPLETE", "INPUT_CLASSIFICATION_ONLY") else 1


if __name__ == "__main__":
    raise SystemExit(main())
