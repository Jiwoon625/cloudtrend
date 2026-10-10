#!/usr/bin/env python3
"""Private, run-scoped KR/ETF signal checkpoints and single-pass account replay.

Only this module's offline tests may supply fake HTTP or commands. No Actions
artifacts/cache, raw uploads, source/CM writes, or credentials in child processes.
A role is immutable across run attempts. A completion marker is written last and
is reusable only after scope, semantic proof, and EVERY recorded byte/hash pass.
"""
from __future__ import annotations

import argparse
import ast
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
_SPEC = importlib.util.spec_from_file_location("adopted_private_base", ROOT / "scripts/run-adopted-kr-etf-job.py")
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError("PRIVATE_JOB_HELPERS_UNAVAILABLE")
base = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(base)
_TRANSPORT_SPEC = importlib.util.spec_from_file_location("adopted_private_transport", ROOT / "scripts/adopted_private_transport.py")
if _TRANSPORT_SPEC is None or _TRANSPORT_SPEC.loader is None:
    raise RuntimeError("PRIVATE_TRANSPORT_UNAVAILABLE")
transport = importlib.util.module_from_spec(_TRANSPORT_SPEC)
_TRANSPORT_SPEC.loader.exec_module(transport)
JobError, require = base.JobError, base.require
REQUEST_VERSION = "adopted-resumable-request-v1"
PLAN_VERSION = "adopted-resumable-plan-v1"
COMPLETE_VERSION = "adopted-resumable-completion-v1"
CACHE_VERSION = "adopted-signal-cache-v1"
INDEX_VERSION = "adopted-signal-cache-index-v1"
REQUEST_FIELDS = {"version", "mode", "catalog_sha", "source_manifest_sha", "etf_start", "kr_start", "through", "chunk_sessions"}
OPTIONAL_REQUEST_FIELDS = {"resume_from"}
# This bounded recovery authorization identifies public run evidence only.
RESUME_FROM_PIN = {
    "runId": "37998687295",
    "codeCommit": "0439d13393c6015e93db54018ddebaba2eb10ac1",
    "planCompletionSha256": "50fdab59d0ac8363405107c143bbde32edb5515da49520ea49d674aa1b4f353c",
}
ORIGIN_FIELDS = {"runId", "codeCommit", "role", "completionSha256", "planSha256"}
CACHE_NAMES = {"signal-cache.jsonl.gz", "signal-cache.manifest.json", "quality.json"}
MAX_CHECKPOINT = 4 * base.CHUNK
MAX_OBJECT = 8 * 1024 * base.CHUNK
IDENTITY_FIELDS = {"version", "sourceHash", "calendarHash", "actualCalendarHash", "codeHash", "policyHash"}


def request_value(options):
    request = {field: getattr(options, field) for field in REQUEST_FIELDS}
    if hasattr(options, "resume_from"):
        request["resume_from"] = options.resume_from
    return request


def validate_resume_from(value):
    require(isinstance(value, dict) and set(value) == set(RESUME_FROM_PIN) and
            value == RESUME_FROM_PIN, "INVALID_RESUME_FROM_PIN")
    return value


def origin_scope_for(storage, options, role):
    """Expected historical evidence scope, never a fabricated execution environment."""
    origin = validate_resume_from(options.resume_from)
    return {"owner": storage.owner, "runId": origin["runId"], "role": valid_role(role),
            "codeCommit": origin["codeCommit"],
            "request": {field: getattr(options, field) for field in REQUEST_FIELDS}}


def validate_origin(origin, scope, *, plan_hash=None):
    require(isinstance(origin, dict) and set(origin) == ORIGIN_FIELDS, "INVALID_IMPORT_ORIGIN")
    request = scope.get("request", {})
    require("resume_from" in request, "UNAUTHORIZED_IMPORT_ORIGIN")
    pin = validate_resume_from(request["resume_from"])
    require(origin["runId"] == pin["runId"] and origin["codeCommit"] == pin["codeCommit"] and
            origin["runId"] != scope["runId"] and origin["role"] == scope["role"] and
            isinstance(origin["role"], str) and re.fullmatch(r"score-[0-9]{3}", origin["role"]),
            "IMPORT_ORIGIN_SCOPE_MISMATCH")
    for field in ("completionSha256", "planSha256"):
        base.check_hash(origin[field])
    require(plan_hash is None or origin["planSha256"] == plan_hash, "IMPORT_ORIGIN_PLAN_MISMATCH")
    return origin


def validate_options(options):
    request = request_value(options)
    if "resume_from" in request:
        validate_resume_from(request["resume_from"])
    require(request["version"] == REQUEST_VERSION and request["mode"] == "full", "INVALID_RESUMABLE_REQUEST")
    base.check_hash(request["catalog_sha"])
    base.check_hash(request["source_manifest_sha"])
    require(request["etf_start"] == "2017-01-11" and request["kr_start"] == "2017-08-21" and
            request["through"] == "2026-09-11", "RESUMABLE_PERIOD_NOT_APPROVED")
    require(type(request["chunk_sessions"]) is int and request["chunk_sessions"] == 120, "INVALID_CHUNK_SESSIONS")
    require(options.phase in {"plan", "score", "replay"}, "INVALID_RESUMABLE_PHASE")
    require((type(options.chunk_index) is int and 0 <= options.chunk_index < 1000) if options.phase == "score"
            else options.chunk_index is None, "INVALID_CHUNK_INDEX")
    require(options.market in {"kr", "etf"} if options.phase == "replay" else options.market is None,
            "INVALID_RESUMABLE_MARKET")


def authorize_trigger(options, environment):
    base.validated_code_commit(environment)
    require(environment.get("GITHUB_ACTIONS") == "true" and
            environment.get("GITHUB_WORKFLOW") == "KR ETF resumable final-strategy backtest" and
            environment.get("GITHUB_REF") == base.REQUEST_BRANCH, "EXPLICIT_RESUMABLE_JOB_REQUIRED")
    saved = base.read_local_json(options.request_file, 16384, "INVALID_REQUEST_FILE")
    require(REQUEST_FIELDS <= set(saved) <= REQUEST_FIELDS | OPTIONAL_REQUEST_FIELDS and saved == request_value(options), "REQUEST_OPTIONS_MISMATCH")
    event = base.read_local_json(environment.get("GITHUB_EVENT_PATH"), 10 * base.CHUNK, "INVALID_TRIGGER_EVENT")
    if environment.get("GITHUB_EVENT_NAME") == "workflow_dispatch":
        require(isinstance(event.get("inputs"), dict) and event["inputs"].get("mode") == "full", "EXPLICIT_FULL_DISPATCH_REQUIRED")
        return
    require(environment.get("GITHUB_EVENT_NAME") == "push", "EXPLICIT_RESUMABLE_JOB_REQUIRED")
    head = event.get("head_commit")
    message = head.get("message") if isinstance(head, dict) else None
    require(isinstance(message, str) and message.splitlines() and
            message.splitlines()[0] == "run(kr-etf-resumable): full", "PUSH_REQUEST_COMMIT_MISMATCH")


def valid_role(role):
    require(isinstance(role, str) and re.fullmatch(r"plan|score-[0-9]{3}|replay-(?:kr|etf)", role), "INVALID_CHECKPOINT_ROLE")
    return role


def role_for(options):
    return "score-%03d" % options.chunk_index if options.phase == "score" else (
        "replay-" + options.market if options.phase == "replay" else "plan")


def logical_path(relative):
    require(isinstance(relative, str), "INVALID_CHECKPOINT_PATH")
    if relative == "completion.json":
        return relative
    match = re.fullmatch(r"attempt-([1-9][0-9]{0,8})/(.+)", relative)
    return match.group(2) if match else relative


def valid_relative(role, relative, *, completion=True):
    valid_role(role)
    require(isinstance(relative, str), "INVALID_CHECKPOINT_PATH")
    relative = logical_path(relative)
    if completion and relative == "completion.json":
        return relative
    if role == "plan":
        ok = relative in {"plan.json", "parity.json"}
    elif role.startswith("score-"):
        ok = relative in CACHE_NAMES
    else:
        name = relative.removeprefix("result/")
        book = next((book for book in base.BOOK_NAMES if name.startswith(book + ".")), None)
        ok = relative == "run-manifest.json" or relative.startswith("result/") and (
            name in base.OUTPUT_NAMES or book and name[len(book) + 1:] in base.BOOK_SUFFIXES)
    require(ok, "INVALID_CHECKPOINT_PATH")
    return relative


def plain_hash(value):
    require(isinstance(value, str) and value.startswith("sha256:"), "INVALID_CACHE_HASH")
    base.check_hash(value[7:])
    return value[7:]


def stable_hash(value):
    return "sha256:" + hashlib.sha256(base.json_bytes(value)).hexdigest()


def parse_json(data, code):
    def unique(pairs):
        out = {}
        for key, value in pairs:
            require(key not in out, code)
            out[key] = value
        return out
    try:
        result = json.loads(data, object_pairs_hook=unique, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except JobError:
        raise
    except (ValueError, UnicodeDecodeError, TypeError, RecursionError):
        raise JobError(code) from None
    require(isinstance(result, dict), code)
    return result


def ordered_dates(dates):
    require(isinstance(dates, list) and 0 < len(dates) <= 20000 and
            all(base.summary_date(day) for day in dates) and dates == sorted(set(dates)), "INVALID_ACTUAL_CALENDAR")
    return dates


def measurements(value):
    require(isinstance(value, dict) and base.finite_number(value.get("elapsedSeconds")) and value["elapsedSeconds"] >= 0 and
            type(value.get("maxRssKiB")) is int and 0 < value["maxRssKiB"] <= 2**53-1, "INVALID_RESOURCE_MEASUREMENTS")
    return {key: value[key] for key in ("elapsedSeconds", "maxRssKiB")}


def scope_for(storage, options, environment, role=None):
    return {"owner": storage.owner, "runId": storage.run_id, "role": role or role_for(options),
            "codeCommit": base.validated_code_commit(environment), "request": request_value(options)}


def stage_metadata(completion, evidence, *, summary=None):
    """Only fixed labels, public pins, dates/counts and the existing metric whitelist."""
    scope, proof = completion["scope"], completion["proof"]
    role = valid_role(scope["role"])
    value = {"schema": COMPLETE_VERSION, "status": "COMPLETE", "role": role, "runId": scope["runId"],
             "codeCommit": scope["codeCommit"], "catalogSha256": scope["request"]["catalog_sha"],
             "sourceManifestSha256": scope["request"]["source_manifest_sha"],
             "completionSha256": evidence["sha256"], "files": len(completion["files"])}
    require(re.fullmatch(r"[1-9][0-9]*", value["runId"]), "INVALID_RUN_ID")
    require(isinstance(value["codeCommit"], str) and re.fullmatch(r"[0-9a-f]{40}", value["codeCommit"]), "INVALID_CODE_COMMIT")
    for key in ("catalogSha256", "sourceManifestSha256", "completionSha256"):
        base.check_hash(value[key])
    if role.startswith("score-"):
        require(type(proof.get("chunkIndex")) is int and proof["chunkIndex"] == int(role[6:]) and
                type(proof.get("sessions")) is int and 0 < proof["sessions"] <= 120 and
                base.summary_date(proof.get("first")) and base.summary_date(proof.get("last")) and
                proof["first"] <= proof["last"], "INVALID_STAGE_METADATA")
        value.update({key: proof[key] for key in ("chunkIndex", "first", "last", "sessions")})
    if summary is not None:
        require(role in {"replay-kr", "replay-etf"} and summary.get("market") == role[7:], "INVALID_STAGE_METADATA")
        base.safe_summary_metadata(summary)
        value["summary"] = summary
    encoded = base64.b64encode(base.json_bytes(value)).decode("ascii")
    require(len(encoded) <= base.MAX_METADATA_BYTES, "CHECKPOINT_METADATA_TOO_LARGE")
    return encoded


class ResumableStorage(base.PrivateStorage):
    def __init__(self, session, url, owner, secret, catalog_sha, run_id, role, attempt="1"):
        require(isinstance(run_id, str) and re.fullmatch(r"[1-9][0-9]*", run_id), "INVALID_RUN_ID")
        super().__init__(session, url, owner, secret, catalog_sha, run_id + "-1")
        self.run_id, self.role = run_id, valid_role(role)
        require(isinstance(attempt, str) and re.fullmatch(r"[1-9][0-9]{0,8}", attempt), "INVALID_RUN_ATTEMPT")
        self.attempt_prefix = "attempt-" + attempt + "/"
        self.root_prefix = owner + "/research/adopted-full-period/resumable/" + run_id + "/"
        self.run_prefix = self.root_prefix + role + "/"
        self.completion_hashes = {}

    def key(self, role, relative, *, write=False):
        valid_relative(role, relative)
        require(not write or role == self.role, "CHECKPOINT_WRITE_WRONG_ROLE")
        if relative != "completion.json":
            require(re.fullmatch(r"attempt-[1-9][0-9]{0,8}/.+", relative), "CHECKPOINT_ATTEMPT_REQUIRED")
            require(not write or relative.startswith(self.attempt_prefix), "CHECKPOINT_WRITE_WRONG_ATTEMPT")
        key = self.root_prefix + role + "/" + relative
        (self.output_keys if write else self.input_keys).add(key)
        return key

    def bounded(self, role, relative, *, optional=False, limit=MAX_CHECKPOINT):
        relative = relative if relative == "completion.json" else self.attempt_prefix + relative
        key = self.key(role, relative)
        with base.safe_response(self.session, "GET", self._url(key), headers=self.headers,
                                stream=True, timeout=(20, 300)) as response:
            if optional and base.confirmed_missing(response):
                return None
            require(response.status_code == 200, "CHECKPOINT_READ_FAILED")
            pieces, size = [], 0
            for piece in response.iter_content(base.CHUNK):
                size += len(piece)
                require(size <= limit, "CHECKPOINT_TOO_LARGE")
                pieces.append(piece)
        return b"".join(pieces)

    def put(self, relative, local, *, completion=None, summary=None):
        require(logical_path(relative) == relative, "INVALID_UPLOAD_RELATIVE_PATH")
        relative = relative if relative == "completion.json" else self.attempt_prefix + relative
        key = self.key(self.role, relative, write=True)
        require(Path(local).is_file() and not Path(local).is_symlink(), "INVALID_CHECKPOINT_LOCAL_FILE")
        evidence = base.digest_file(local)
        require((0 <= evidence["bytes"] if logical_path(relative).endswith(".trades.jsonl") else 0 < evidence["bytes"]) and
                evidence["bytes"] <= MAX_OBJECT, "INVALID_CHECKPOINT_SIZE")
        headers = {}
        if completion is not None:
            require(relative == "completion.json", "METADATA_ONLY_ON_COMPLETION")
            headers["x-metadata"] = stage_metadata(completion, evidence, summary=summary)
        self.verify_private_bucket(evidence["bytes"])
        with tempfile.TemporaryDirectory(prefix="adopted-checkpoint-readback-") as directory:
            readback = Path(directory) / "object"
            if self.download(key, readback, evidence, optional=True):
                return {"path": relative, **evidence}
            uncertain = False
            try:
                with Path(local).open("rb") as data:
                    with base.safe_response(self.session, "POST", self._url(key, write=True), headers={
                        **self.headers, "Content-Type": "application/octet-stream", "x-upsert": "false",
                        "Content-Length": str(evidence["bytes"]), **headers}, data=data, timeout=(20, 900)) as response:
                        require(response.status_code in (200, 201, 400, 409), "CHECKPOINT_CREATE_FAILED")
            except JobError as error:
                if str(error) != "NETWORK_OR_SESSION_ERROR":
                    raise
                uncertain = True
            exists = self.download(key, readback, evidence, optional=True)
            require(exists, "UNCERTAIN_CHECKPOINT_CREATE" if uncertain else "CHECKPOINT_READBACK_MISSING")
        return {"path": relative, **evidence}

    def read_completion(self, role, expected_scope, *, optional=False, expected_proof=None, expected_completion_sha=None):
        self.verify_private_bucket()
        payload = self.bounded(role, "completion.json", optional=optional)
        if payload is None:
            return None
        completion_sha = hashlib.sha256(payload).hexdigest()
        require(expected_completion_sha is None or completion_sha == expected_completion_sha,
                "ORIGIN_COMPLETION_HASH_MISMATCH")
        value = parse_json(payload, "INVALID_COMPLETION_JSON")
        require({"version", "status", "scope", "proof", "files"} <= set(value) <=
                {"version", "status", "scope", "proof", "files", "origin"} and value["version"] == COMPLETE_VERSION and
                value["status"] == "COMPLETE" and value["scope"] == expected_scope and isinstance(value["proof"], dict),
                "CHECKPOINT_SCOPE_MISMATCH")
        if "origin" in value:
            validate_origin(value["origin"], expected_scope)
        if role == "plan":
            proof = value["proof"]
            require(set(proof) == {"planSha256", "calendarHash", "parityStatus"} and proof["parityStatus"] == "PASS", "INVALID_PLAN_COMPLETION_PROOF")
            base.check_hash(proof["planSha256"])
            plain_hash(proof["calendarHash"])
        else:
            require(isinstance(expected_proof, dict) and value["proof"] == expected_proof, "CHECKPOINT_PROOF_MISMATCH")
        entries = value["files"]
        require(isinstance(entries, list) and 0 < len(entries) <= 64, "INVALID_COMPLETION_FILES")
        seen = set()
        for entry in entries:
            require(isinstance(entry, dict) and set(entry) == {"path", "bytes", "sha256"}, "INVALID_COMPLETION_FILE")
            require(isinstance(entry["path"], str) and re.fullmatch(r"attempt-[1-9][0-9]{0,8}/.+", entry["path"]), "CHECKPOINT_ATTEMPT_REQUIRED")
            relative = valid_relative(role, entry["path"], completion=False)
            require(relative not in seen, "DUPLICATE_COMPLETION_FILE")
            seen.add(relative)
            base.check_hash(entry["sha256"])
            require(type(entry["bytes"]) is int and
                    (0 <= entry["bytes"] if relative.endswith(".trades.jsonl") else 0 < entry["bytes"]) and
                    entry["bytes"] <= MAX_OBJECT, "INVALID_COMPLETION_BYTES")
        require(len({entry["path"].split("/", 1)[0] for entry in entries}) == 1, "MIXED_CHECKPOINT_ATTEMPTS")
        if role == "plan":
            require(seen == {"plan.json", "parity.json"}, "INCOMPLETE_CHECKPOINT")
            require(next(entry["sha256"] for entry in entries if logical_path(entry["path"]) == "plan.json") == value["proof"]["planSha256"], "INVALID_PLAN_COMPLETION_PROOF")
        elif role.startswith("score-"):
            require(seen == CACHE_NAMES, "INCOMPLETE_CHECKPOINT")
        else:
            require(seen == {"run-manifest.json"} | {"result/" + name for name in result_names(role[7:])}, "INCOMPLETE_CHECKPOINT")
        self.completion_hashes[role] = completion_sha
        return value

    def restore(self, role, expected_scope, directory, *, optional=False, expected_proof=None, expected_completion_sha=None):
        value = self.read_completion(role, expected_scope, optional=optional, expected_proof=expected_proof,
                                     expected_completion_sha=expected_completion_sha)
        if value is None:
            return None
        directory.mkdir(mode=0o700)
        for entry in value["files"]:
            target = directory / logical_path(entry["path"])
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            self.download(self.key(role, entry["path"]), target, entry)
        return value

    def complete(self, scope, proof, files, workspace, *, summary=None, origin=None):
        if origin is not None:
            validate_origin(origin, scope)
        entries = [self.put(relative, local) for relative, local in files]
        value = {"version": COMPLETE_VERSION, "status": "COMPLETE", "scope": scope, "proof": proof, "files": entries}
        if origin is not None:
            value["origin"] = origin
        path = Path(workspace) / "completion.json"
        base.local_json(path, value)
        self.put("completion.json", path, completion=value, summary=summary)
        return value


class ReadOnlyOriginStorage(ResumableStorage):
    """Historical checkpoints may only be read; all storage write entrypoints fail."""
    def key(self, role, relative, *, write=False):
        require(not write, "ORIGIN_STORAGE_READ_ONLY")
        return super().key(role, relative)

    def _url(self, key, *, write=False):
        require(not write, "ORIGIN_STORAGE_READ_ONLY")
        return super()._url(key)

    def put(self, *args, **kwargs):
        raise JobError("ORIGIN_STORAGE_READ_ONLY")

    def complete(self, *args, **kwargs):
        raise JobError("ORIGIN_STORAGE_READ_ONLY")

    def create_result(self, *args, **kwargs):
        raise JobError("ORIGIN_STORAGE_READ_ONLY")


def source_contract(storage, options, root):
    storage.verify_private_bucket()
    payload = storage.manifest()
    require(hashlib.sha256(payload).hexdigest() == options.source_manifest_sha, "SOURCE_MANIFEST_HASH_MISMATCH")
    manifest = parse_json(payload, "INVALID_SOURCE_MANIFEST_JSON")
    sources = base.validate_manifest(manifest, options.catalog_sha, storage.owner)
    require(len(sources) == 30 and len(manifest.get("extraFiles", [])) == 1, "PINNED_CATALOG_FILE_COUNT_MISMATCH")
    source_file = root / "source-manifest.json"
    with source_file.open("xb") as output:
        os.chmod(source_file, 0o600)
        output.write(payload)
    return manifest, sources, source_file


def prepare(storage, options, root, sources, source_file, environment, runner):
    raw = root / "raw"
    raw.mkdir(mode=0o700)
    storage.input_keys.update(item["storagePath"] for item in sources)
    for item in sources:
        target = raw / item["sourcePath"]
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        storage.download(item["storagePath"], target, item)
    prepared = root / "prepared"
    runner([sys.executable, str(ROOT / "scripts/prepare-adopted-kr-etf-inputs.py"),
            "--source-manifest", str(source_file), "--staged-root", str(raw),
            "--output", str(prepared), "--through", options.through], root / "prepare.log", environment)
    manifest = base.read_local_json(prepared / "manifest.json", 8 * base.CHUNK, "INVALID_PREPARED_MANIFEST")
    require(manifest.get("version") == "adopted-kr-etf-inputs-v1" and manifest.get("sourceFileCount") == 30 and
            manifest.get("allRawRowsRetained") is True and manifest.get("savedScoresReusedForSignals") is False and
            manifest.get("sourceCatalogSha256") == options.catalog_sha and
            manifest.get("sourceManifestFingerprint") == "sha256:" + options.source_manifest_sha,
            "PREPARED_SOURCE_CONTRACT_MISMATCH")
    ordered_dates(manifest.get("sessions"))
    measurements(manifest.get("preparationMetrics"))
    require(options.etf_start in manifest["sessions"] and options.kr_start in manifest["sessions"] and
            options.through in manifest["sessions"], "PERIOD_BOUNDARY_NOT_ACTUAL_SESSION")
    return prepared, manifest


def matrix_for(sessions, options):
    ordered_dates(sessions)
    require(options.etf_start in sessions and options.kr_start in sessions and options.through in sessions, "PERIOD_BOUNDARY_NOT_ACTUAL_SESSION")
    dates = [day for day in sessions if options.etf_start <= day <= options.through]
    chunks = [dates[i:i + options.chunk_sessions] for i in range(0, len(dates), options.chunk_sessions)]
    require(0 < len(chunks) <= 256, "INVALID_CHUNK_COUNT")
    return {"include": [{"chunkIndex": index, "first": chunk[0], "last": chunk[-1], "sessions": len(chunk)}
                        for index, chunk in enumerate(chunks)]}


def driver(prepared, target, market, first, last, *, smoke=False, scoring=False, index=None):
    command = [str(ROOT / "node_modules/.bin/vite-node"), "--config", "vitest.adopted-backtest.config.ts",
               "scripts/run-adopted-kr-etf-backtest.ts", "--", "--run-adopted-backtest", "--market", market,
               "--manifest", str(prepared / "manifest.json"), "--start", first, "--through", last, "--out", str(target)]
    if smoke:
        command += ["--smoke-sessions", "20"]
    if scoring:
        command += ["--scoring-only"]
    if index is not None:
        command += ["--cache-input", str(index)]
    return command


def verify_results(target, root, label, environment, runner):
    runner([sys.executable, str(ROOT / "scripts/verify-adopted-kr-etf-results.py"), "--results", str(target)],
           root / (label + "-verify.log"), environment)
    result = base.read_local_json(target / "verification.json", 65536, "INVALID_ARITHMETIC_VERIFICATION")
    require(result.get("status") == "PASS", "ARITHMETIC_VERIFICATION_FAILED")
    base.output_files(target)
    return result


def cache_manifest(directory, dates, expected_identity=None):
    path = directory / "signal-cache.manifest.json"
    value = base.read_local_json(path, MAX_CHECKPOINT, "INVALID_SIGNAL_CACHE_MANIFEST")
    require(set(value) == {"version", "identity", "identityHash", "selectionHash", "evaluationDates", "records", "data", "audit"} and
            value["version"] == CACHE_VERSION, "INVALID_SIGNAL_CACHE_MANIFEST")
    identity = value["identity"]
    require(isinstance(identity, dict) and set(identity) == IDENTITY_FIELDS and identity["version"] == CACHE_VERSION,
            "INVALID_SIGNAL_CACHE_IDENTITY")
    for key in IDENTITY_FIELDS - {"version"}:
        plain_hash(identity[key])
    require(expected_identity is None or identity == expected_identity, "SIGNAL_CACHE_IDENTITY_MISMATCH")
    require(value["identityHash"] == stable_hash(identity) and value["evaluationDates"] == dates and
            value["selectionHash"] == stable_hash({"identityHash": value["identityHash"], "evaluationDates": dates}) and
            type(value["records"]) is int and value["records"] == len(dates), "SIGNAL_CACHE_SELECTION_MISMATCH")
    data = value["data"]
    require(isinstance(data, dict) and set(data) == {"path", "bytes", "sha256"} and
            data["path"] == "signal-cache.jsonl.gz" and type(data["bytes"]) is int and 0 < data["bytes"] <= MAX_OBJECT,
            "INVALID_SIGNAL_CACHE_DATA")
    require(base.digest_file(directory / data["path"]) == {"bytes": data["bytes"], "sha256": plain_hash(data["sha256"])},
            "SIGNAL_CACHE_DATA_HASH_MISMATCH")
    audit = value["audit"]
    require(isinstance(audit, dict) and set(audit) == {"createdAt", "timestampRole"} and
            isinstance(audit["createdAt"], str) and re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", audit["createdAt"]) and
            audit["timestampRole"] == "GENERATION_TIME_ONLY_NOT_MARKET_EVIDENCE", "INVALID_CACHE_AUDIT")
    return value


def make_index(path, chunks):
    base.local_json(path, {"version": INDEX_VERSION, "chunks": [
        {"path": str(chunk / "signal-cache.manifest.json"), **{**base.digest_file(chunk / "signal-cache.manifest.json"),
         "sha256": "sha256:" + base.digest_file(chunk / "signal-cache.manifest.json")["sha256"]}} for chunk in chunks]})


def economic_files(directory):
    suffixes = {"daily-nav.jsonl", "trades.jsonl", "yearly-budgets.json", "accounting.json", "final-state.json", "contract.json"}
    return {item.name: item for item in base.output_files(directory) if item.name == "summary.json" or
            any(item.name == book + "." + suffix for book in base.BOOK_NAMES for suffix in suffixes)}


def economic_parity(left, right):
    first, second = economic_files(left), economic_files(right)
    require(first.keys() == second.keys() and len(first) >= 15, "PARITY_ECONOMIC_FILES_INCOMPLETE")
    for name in first:
        # Audit timestamps may occur inside contract/state, but are excluded only
        # if explicitly designated by a public schema. No broad field stripping.
        require(base.digest_file(first[name]) == base.digest_file(second[name]), "CACHE_ECONOMIC_PARITY_FAILED")
    return sorted(first)


def run_parity(prepared, prepared_manifest, options, root, environment, runner):
    dates = [day for day in prepared_manifest["sessions"] if options.kr_start <= day <= options.through][:20]
    require(len(dates) == 20, "INSUFFICIENT_PARITY_SESSIONS")
    chunks, identities = [], []
    for index, selected in enumerate((dates[:10], dates[10:])):
        target = root / ("parity-score-%d" % index)
        runner(driver(prepared, target, "kr-etf", selected[0], selected[-1], scoring=True),
               root / ("parity-score-%d.log" % index), environment)
        value = cache_manifest(target, selected, identities[0] if identities else None)
        identities.append(value["identity"])
        chunks.append(target)
    index_path = root / "parity-index.json"
    make_index(index_path, chunks)
    targets, quality = [], []
    for label, index in (("parity-monolithic", None), ("parity-cached", index_path)):
        target = root / label
        runner(driver(prepared, target, "kr-etf", dates[0], dates[-1], smoke=True, index=index), root / (label + ".log"), environment)
        verify_results(target, root, label, environment, runner)
        value = base.read_local_json(target / "quality.json", MAX_CHECKPOINT, "INVALID_PARITY_QUALITY")
        require(value.get("mode") == "SAMPLE_INCOMPLETE" and value.get("runStatus") == "FINISHED" and
                value.get("sessions") == 20, "INVALID_PARITY_SMOKE")
        quality.append(measurements(value))
        targets.append(target)
    names = economic_parity(*targets)
    return {"version": "adopted-cache-economic-parity-v1", "status": "PASS", "first": dates[0], "last": dates[-1],
            "sessions": 20, "chunkSessions": [10, 10], "independentVerifier": "PASS", "economicFiles": names,
            "measurements": quality, "fullSourceHistoryPreserved": True}, identities[0]


def validate_plan(plan, parity, options, scope):
    require(isinstance(plan, dict) and set(plan) == {"version", "scope", "sessions", "calendarHash", "matrix", "identity", "identityHash", "preparation", "paritySha256"} and
            plan["version"] == PLAN_VERSION and plan["scope"] == scope, "INVALID_PLAN_SCOPE")
    ordered_dates(plan["sessions"])
    require(plan["calendarHash"] == stable_hash(plan["sessions"]) and plan["matrix"] == matrix_for(plan["sessions"], options),
            "PLAN_CALENDAR_MISMATCH")
    require(isinstance(plan["identity"], dict) and set(plan["identity"]) == IDENTITY_FIELDS and
            plan["identity"]["version"] == CACHE_VERSION and plan["identityHash"] == stable_hash(plan["identity"]) and
            plan["identity"]["calendarHash"] == plan["calendarHash"], "PLAN_IDENTITY_MISMATCH")
    for key in IDENTITY_FIELDS - {"version"}:
        plain_hash(plan["identity"][key])
    measurements(plan["preparation"])
    dates = [day for day in plan["sessions"] if options.kr_start <= day <= options.through][:20]
    require(set(parity) == {"version", "status", "first", "last", "sessions", "chunkSessions", "independentVerifier", "economicFiles", "measurements", "fullSourceHistoryPreserved"} and
            parity["version"] == "adopted-cache-economic-parity-v1" and parity["status"] == "PASS" and
            parity["first"] == dates[0] and parity["last"] == dates[-1] and parity["sessions"] == 20 and
            parity["chunkSessions"] == [10, 10] and parity["independentVerifier"] == "PASS" and
            parity["fullSourceHistoryPreserved"] is True and isinstance(parity["economicFiles"], list) and
            len(parity["economicFiles"]) >= 15 and isinstance(parity["measurements"], list) and len(parity["measurements"]) == 2,
            "INVALID_PLAN_PARITY_PROOF")
    for measurement in parity["measurements"]:
        measurements(measurement)


def load_plan(storage, options, environment, root, *, optional=False):
    scope = scope_for(storage, options, environment, "plan")
    return load_scoped_plan(storage, options, scope, root / "restored-plan", optional=optional)


def load_scoped_plan(storage, options, scope, target, *, optional=False, expected_completion_sha=None):
    completion = storage.restore("plan", scope, target, optional=optional, expected_completion_sha=expected_completion_sha)
    if completion is None:
        return None
    plan = base.read_local_json(target / "plan.json", MAX_CHECKPOINT, "INVALID_PLAN")
    parity = base.read_local_json(target / "parity.json", MAX_CHECKPOINT, "INVALID_PARITY")
    validate_plan(plan, parity, options, scope)
    plan_hash = base.digest_file(target / "plan.json")["sha256"]
    require(plan["paritySha256"] == base.digest_file(target / "parity.json")["sha256"] and
            completion["proof"] == {"planSha256": plan_hash, "calendarHash": plan["calendarHash"], "parityStatus": "PASS"},
            "INVALID_PLAN_COMPLETION_PROOF")
    return plan, parity, plan_hash


def load_origin_plan(storage, options, root):
    pin = validate_resume_from(options.resume_from)
    return load_scoped_plan(storage, options, origin_scope_for(storage, options, "plan"), root / "origin-plan",
                            expected_completion_sha=pin["planCompletionSha256"])


def validate_origin_plan_match(plan, origin_plan):
    # The full historical request was checked by load_scoped_plan. These are the
    # actual fresh TS signal identity, full source calendar and exact chunk map.
    for field in ("sessions", "calendarHash", "matrix", "identity", "identityHash"):
        require(plan[field] == origin_plan[field], "ORIGIN_PLAN_SEMANTICS_MISMATCH")


def import_origin_score(storage, origin_storage, options, scope, root, plan, plan_hash, chunk, origin_loaded):
    origin_plan, _, origin_plan_hash = origin_loaded
    validate_origin_plan_match(plan, origin_plan)
    role = storage.role
    origin_scope = origin_scope_for(origin_storage, options, role)
    target = root / "origin-score"
    completion = origin_storage.restore(role, origin_scope, target, optional=True,
        expected_proof=score_proof(origin_plan, origin_plan_hash, chunk))
    if completion is None:
        return False
    # Reject transitive imports and validate every old file against both plans.
    require("origin" not in completion, "TRANSITIVE_ORIGIN_IMPORT_FORBIDDEN")
    validate_score_completion(completion, target, origin_plan, origin_plan_hash, chunk)
    proof = score_proof(plan, plan_hash, chunk)
    validate_score_completion({"proof": proof}, target, plan, plan_hash, chunk)
    receipt = {"runId": origin_scope["runId"], "codeCommit": origin_scope["codeCommit"], "role": role,
               "completionSha256": origin_storage.completion_hashes[role], "planSha256": origin_plan_hash}
    storage.complete(scope, proof, [(name, target / name) for name in
        ("signal-cache.jsonl.gz", "quality.json", "signal-cache.manifest.json")], root, origin=receipt)
    return True


def verify_import_origin(completion, origin_storage, options, scope, chunk, origin_loaded):
    """Bind a restored receipt to the exact original immutable completion.

    Current files were already restored byte-for-byte. Requiring identical old
    file evidence proves the original byte linkage without a second large copy.
    """
    if "origin" not in completion:
        return None
    origin_plan, _, origin_plan_hash = origin_loaded
    receipt = validate_origin(completion["origin"], scope, plan_hash=origin_plan_hash)
    original = origin_storage.read_completion(scope["role"], origin_scope_for(origin_storage, options, scope["role"]),
        expected_proof=score_proof(origin_plan, origin_plan_hash, chunk), expected_completion_sha=receipt["completionSha256"])
    require("origin" not in original, "TRANSITIVE_ORIGIN_IMPORT_FORBIDDEN")
    def evidence(value):
        return {logical_path(entry["path"]): {"bytes": entry["bytes"], "sha256": entry["sha256"]} for entry in value["files"]}
    require(evidence(original) == evidence(completion), "IMPORT_ORIGIN_FILE_MISMATCH")
    return receipt


def restore_score_chunks(storage, origin_storage, options, environment, root, plan, plan_hash, origin_loaded):
    cached, origins = [], []
    for chunk in plan["matrix"]["include"]:
        role = "score-%03d" % chunk["chunkIndex"]
        scope = scope_for(storage, options, environment, role)
        target = root / role
        value = storage.restore(role, scope, target, expected_proof=score_proof(plan, plan_hash, chunk))
        validate_score_completion(value, target, plan, plan_hash, chunk)
        receipt = verify_import_origin(value, origin_storage, options, scope, chunk, origin_loaded)
        if receipt is not None:
            origins.append(receipt)
        cached.append(target)
    return cached, origins


def score_proof(plan, plan_hash, chunk):
    dates = [day for day in plan["sessions"] if chunk["first"] <= day <= chunk["last"]]
    return {**chunk, "planSha256": plan_hash, "identityHash": plan["identityHash"],
            "selectionHash": stable_hash({"identityHash": plan["identityHash"], "evaluationDates": dates})}


def validate_score_completion(completion, target, plan, plan_hash, chunk):
    require(completion["proof"] == score_proof(plan, plan_hash, chunk), "INVALID_SCORE_COMPLETION_PROOF")
    dates = [day for day in plan["sessions"] if chunk["first"] <= day <= chunk["last"]]
    cache_manifest(target, dates, plan["identity"])
    quality = base.read_local_json(target / "quality.json", MAX_CHECKPOINT, "INVALID_SCORE_QUALITY")
    require(quality.get("runStatus") == "FINISHED" and quality.get("mode") == "SCORING_ONLY" and
            quality.get("scoringSessions") == chunk["sessions"], "INVALID_SCORE_QUALITY")
    passes = quality.get("portfolioExecutionPasses")
    require(isinstance(passes, dict) and set(passes) == {"ETF_V02", "KR_COMBINED_ADOPTED", "KOSPI_STANDALONE_DIAGNOSTIC", "KOSDAQ_STANDALONE_DIAGNOSTIC"} and all(type(n) is int and n == 0 for n in passes.values()),
            "SCORE_EXECUTED_PORTFOLIO")
    measurements(quality)


def recover_partial_score(storage, scope, root, plan, plan_hash, chunk):
    """The manifest is uploaded after data AND quality, before completion.

    It can be trusted only after bounded semantic identity/date checks and exact
    data readback. The actual TS cache reader still validates every record before
    a final portfolio pass. Arbitrary unknown remote keys are never requested.
    """
    payload = storage.bounded(storage.role, "signal-cache.manifest.json", optional=True)
    if payload is None:
        return False
    value = parse_json(payload, "INVALID_PARTIAL_CACHE_MANIFEST")
    dates = [day for day in plan["sessions"] if chunk["first"] <= day <= chunk["last"]]
    require(value.get("version") == CACHE_VERSION and value.get("identity") == plan["identity"] and
            value.get("identityHash") == plan["identityHash"] and value.get("evaluationDates") == dates and
            value.get("selectionHash") == score_proof(plan, plan_hash, chunk)["selectionHash"], "PARTIAL_CACHE_SCOPE_MISMATCH")
    data = value.get("data")
    require(isinstance(data, dict) and set(data) == {"path", "bytes", "sha256"} and
            data["path"] == "signal-cache.jsonl.gz" and type(data["bytes"]) is int and 0 < data["bytes"] <= MAX_OBJECT,
            "INVALID_PARTIAL_CACHE_DATA")
    evidence = {"bytes": data["bytes"], "sha256": plain_hash(data["sha256"])}
    target = root / "partial-score"
    target.mkdir(mode=0o700)
    with (target / "signal-cache.manifest.json").open("xb") as output:
        os.chmod(output.name, 0o600)
        output.write(payload)
    storage.download(storage.key(storage.role, storage.attempt_prefix + "signal-cache.jsonl.gz"), target / "signal-cache.jsonl.gz", evidence)
    quality = storage.bounded(storage.role, "quality.json")
    with (target / "quality.json").open("xb") as output:
        os.chmod(output.name, 0o600)
        output.write(quality)
    proof = score_proof(plan, plan_hash, chunk)
    validate_score_completion({"proof": proof}, target, plan, plan_hash, chunk)
    storage.complete(scope, proof, [(name, target / name) for name in
                     ("signal-cache.jsonl.gz", "quality.json", "signal-cache.manifest.json")], root)
    return True


def write_matrix(plan, environment):
    output = environment.get("GITHUB_OUTPUT")
    require(isinstance(output, str) and output, "GITHUB_OUTPUT_UNAVAILABLE")
    path = Path(output)
    require(not path.is_symlink(), "INVALID_GITHUB_OUTPUT")
    with path.open("a", encoding="utf-8") as stream:
        stream.write("matrix=" + base.json_bytes(plan["matrix"]).decode() + "\n")
        stream.write("chunk_count=" + str(len(plan["matrix"]["include"])) + "\n")


def result_books(market):
    return {"ETF_V02"} if market == "etf" else {"KR_COMBINED_ADOPTED", "KOSPI_STANDALONE_DIAGNOSTIC", "KOSDAQ_STANDALONE_DIAGNOSTIC"}


def result_names(market):
    suffixes = {"daily-nav.jsonl", "trades.jsonl", "yearly-budgets.json"} | (
        {"contract.json", "final-state.json"} if market == "etf" else {"evidence.json", "accounting.json"})
    return base.OUTPUT_NAMES | {book + "." + suffix for book in result_books(market) for suffix in suffixes}


def validate_replay_quality(quality, market):
    require(quality.get("runStatus") == "FINISHED" and quality.get("mode") == "SELECTED_RANGE_REPLAY", "RESULT_MODE_MISMATCH")
    require(type(quality.get("generatedScoringSessions")) is int and quality["generatedScoringSessions"] == 0 and
            isinstance(quality.get("signalCache"), dict) and quality["signalCache"].get("allIndexedRowsValidatedBeforeExecution") is True,
            "REPLAY_RECOMPUTED_SIGNALS")
    expected = {name: int(name in result_books(market)) for name in {"ETF_V02", "KR_COMBINED_ADOPTED", "KOSPI_STANDALONE_DIAGNOSTIC", "KOSDAQ_STANDALONE_DIAGNOSTIC"}}
    passes = quality.get("portfolioExecutionPasses")
    require(isinstance(passes, dict) and passes == expected and all(type(n) is int for n in passes.values()), "REPLAY_NOT_SINGLE_PASS")
    measurements(quality)
    return passes


def validate_verification(verification, summary, market):
    require(verification.get("schema") == "adopted-kr-etf-independent-verification-v1" and verification.get("status") == "PASS" and
            isinstance(verification.get("books"), dict) and set(verification["books"]) == result_books(market) and
            set(summary) == result_books(market), "INVALID_REPLAY_VERIFICATION")
    for book, evidence in verification["books"].items():
        require(isinstance(evidence, dict) and evidence.get("feesVerified") is True and evidence.get("navCashPlusMarksVerified") is True and
                evidence.get("annualBudgetsVerified") is True and evidence.get("metricsVerified") is (summary[book].get("status") == "COMPLETE") and
                type(evidence.get("dailyCashReconciled")) is int and evidence["dailyCashReconciled"] == summary[book].get("observations") and
                type(evidence.get("tradeRowsChecked")) is int and evidence["tradeRowsChecked"] >= 0,
                "INVALID_REPLAY_VERIFICATION_EVIDENCE")


def validate_restored_replay(completion, target, options, scope, plan, plan_hash, proof, *, origin_plan_hash=None, import_origins=()):
    require(completion["proof"] == proof, "INVALID_REPLAY_COMPLETION_PROOF")
    report = base.read_local_json(target / "run-manifest.json", MAX_CHECKPOINT, "INVALID_REPLAY_REPORT")
    require(report.get("codeCommit") == scope["codeCommit"] and report.get("sourceManifestSha256") == options.source_manifest_sha and
            report.get("catalogSha256") == options.catalog_sha and report.get("planSha256") == plan_hash and
            report.get("market") == options.market and report.get("mode") == "full" and report.get("status") == "COMPLETE" and
            report.get("start") == proof["start"] and report.get("through") == options.through and report.get("verifiedArithmetic") is True,
            "REPLAY_REPORT_SCOPE_MISMATCH")
    require((report.get("runId") == scope["runId"] if hasattr(options, "resume_from") or "runId" in report else True),
            "REPLAY_REPORT_SCOPE_MISMATCH")
    origins = report.get("importOrigins", [])
    require(isinstance(origins, list) and (not hasattr(options, "resume_from") or "importOrigins" in report),
            "INVALID_REPLAY_IMPORT_ORIGINS")
    roles = {"score-%03d" % chunk["chunkIndex"] for chunk in plan["matrix"]["include"]}
    seen = []
    for origin in origins:
        require(isinstance(origin, dict) and isinstance(origin.get("role"), str) and origin["role"] in roles,
                "INVALID_REPLAY_IMPORT_ORIGINS")
        validate_origin(origin, {**scope, "role": origin["role"]}, plan_hash=origin_plan_hash)
        seen.append(origin["role"])
    require(seen == sorted(set(seen)) and origins == list(import_origins), "INVALID_REPLAY_IMPORT_ORIGINS")
    require(report.get("outputs") == [entry for entry in completion["files"] if logical_path(entry["path"]) != "run-manifest.json"],
            "REPLAY_OUTPUT_MANIFEST_MISMATCH")
    require({file.name for file in base.output_files(target / "result")} == result_names(options.market), "INCOMPLETE_REPLAY_BOOK_FILES")
    summary = base.read_local_json(target / "result/summary.json", MAX_CHECKPOINT, "INVALID_RESULT_SUMMARY")
    verification = base.read_local_json(target / "result/verification.json", MAX_CHECKPOINT, "INVALID_ARITHMETIC_VERIFICATION")
    validate_verification(verification, summary, options.market)
    quality = base.read_local_json(target / "result/quality.json", MAX_CHECKPOINT, "INVALID_RESULT_QUALITY")
    require(validate_replay_quality(quality, options.market) == report.get("portfolioExecutionPasses"), "REPLAY_REPORT_QUALITY_MISMATCH")
    require(quality["signalCache"] == report.get("signalCache"), "REPLAY_REPORT_QUALITY_MISMATCH")
    require(report["closedTradeMetrics"]["books"] == {name: {key: evidence["closedTradeMetrics"].get(key) for key in base.TRADE_METRIC_FIELDS}
            for name, evidence in verification["books"].items()}, "REPLAY_REPORT_VERIFICATION_MISMATCH")
    base.build_summary_metadata(report, summary, base.digest_file(target / "run-manifest.json")["sha256"])


def result_report(options, scope, prepared_manifest, sources, plan_hash, parity, result, verification, outputs, *, import_origins=()):
    quality = base.read_local_json(result / "quality.json", MAX_CHECKPOINT, "INVALID_RESULT_QUALITY")
    passes = validate_replay_quality(quality, options.market)
    summary = base.read_local_json(result / "summary.json", MAX_CHECKPOINT, "INVALID_RESULT_SUMMARY")
    validate_verification(verification, summary, options.market)
    verified = verification.get("books")
    require(isinstance(verified, dict) and verified, "MISSING_CLOSED_TRADE_VERIFICATION")
    trade = {**base.TRADE_METRIC_CONTRACT, "books": {}}
    for book, value in verified.items():
        metrics = value.get("closedTradeMetrics") if isinstance(value, dict) else None
        require(book in base.BOOK_NAMES and isinstance(metrics, dict) and
                all(metrics.get(k) == expected for k, expected in base.TRADE_METRIC_CONTRACT.items()), "INVALID_TRADE_METRIC_CONTRACT")
        trade["books"][book] = {key: metrics.get(key) for key in base.TRADE_METRIC_FIELDS}
    readiness = quality.get("signalReadiness", {})
    checks = {"calendar": {"first": quality.get("sourceCalendarStart"), "last": quality.get("sourceCalendarEnd")},
              "featureLowerBounds": {market: quality.get("featureWarmupLowerBounds", {}).get(market) for market in ("KR", "ETF")},
              "signals": {market: {"scoreFirst": readiness.get("firstAnyValidScoreDate", {}).get(market),
                                     "entryFirst": readiness.get("firstEntryReadyDate", {}).get(market),
                                     "scoreCount": readiness.get("validScoreObservations", {}).get(market, 0),
                                     "entryCount": readiness.get("entryReadyObservations", {}).get(market, 0)} for market in ("KOSPI", "KOSDAQ", "ETF")},
              "accounts": {book: {"events": quality[book]["tradeCount"], "openCount": quality[book]["terminalOpenPositions"]}
                           for book in base.BOOK_NAMES if isinstance(quality.get(book), dict) and "tradeCount" in quality[book]}}
    return {"version": "adopted-private-resumable-backtest-job-v1", "status": "COMPLETE", "mode": "full", "market": options.market,
            "start": options.kr_start if options.market == "kr" else options.etf_start, "through": options.through,
            "runId": scope["runId"], "codeCommit": scope["codeCommit"], "catalogSha256": options.catalog_sha, "sourceManifestSha256": options.source_manifest_sha,
            "validatedCatalogFiles": 31, "validatedKrEtfCatalogFiles": 30, "downloadedKrEtfFiles": 30,
            "downloadedKrEtfBytes": sum(item["bytes"] for item in sources), "planSha256": plan_hash,
            "preparation": measurements(prepared_manifest["preparationMetrics"]), "extensionHashes": [], "extensionContinuity": None,
            "measurements": [parity["measurements"][0], measurements(quality)], "sourceCoverage": quality.get("sourceCoverage", {}),
            "verifiedArithmetic": True, "closedTradeMetrics": trade, "checks": checks,
            "accountRoles": {"KR_COMBINED_ADOPTED": "MAIN_COMBINED_ACCOUNT", "KOSPI_STANDALONE_DIAGNOSTIC": "STANDALONE_DIAGNOSTIC",
                             "KOSDAQ_STANDALONE_DIAGNOSTIC": "STANDALONE_DIAGNOSTIC", "ETF_V02": "STANDALONE_ETF_ACCOUNT"},
            "annualPolicy": {"KR": "Prior-year final-close NAV / 30 new-entry budget; held quantities are not rebalanced",
                             "ETF": "ANNUAL_NAV_VOLATILITY_SIGNAL_YEAR_V1"},
            "signalCache": quality["signalCache"], "portfolioExecutionPasses": passes, "outputs": outputs,
            "importOrigins": list(import_origins),
            "rawInputsUploaded": False, "logsUploaded": False, "cmAndOriginalSourcesUnmodified": True,
            "actionsArtifactsOrCacheUsed": False}


def execute(options, storage, workspace, environment, runner=base.run_command, *, origin_storage=None):
    validate_options(options)
    root = Path(workspace)
    require(root.is_dir() and not root.is_symlink() and not any(root.iterdir()), "PRIVATE_WORKSPACE_NOT_EMPTY")
    os.chmod(root, 0o700)
    scope = scope_for(storage, options, environment)
    resume = hasattr(options, "resume_from")
    require(not resume or isinstance(origin_storage, ReadOnlyOriginStorage), "ORIGIN_STORAGE_REQUIRED")
    require(not resume or scope["runId"] != options.resume_from["runId"], "RESUME_REQUIRES_NEW_RUN")
    _, sources, source_file = source_contract(storage, options, root)
    child_env = base.child_environment(environment)
    origin_loaded = load_origin_plan(origin_storage, options, root) if resume else None
    loaded = load_plan(storage, options, environment, root, optional=options.phase == "plan")
    if loaded is not None and origin_loaded is not None:
        validate_origin_plan_match(loaded[0], origin_loaded[0])
    if options.phase == "plan":
        if loaded is not None:
            write_matrix(loaded[0], environment)
            return {"status": "COMPLETE", "phase": "plan", "reused": True, "chunks": len(loaded[0]["matrix"]["include"])}
        prepared, manifest = prepare(storage, options, root, sources, source_file, child_env, runner)
        parity, identity = run_parity(prepared, manifest, options, root, child_env, runner)
        parity_path = root / "parity.json"
        base.local_json(parity_path, parity)
        plan = {"version": PLAN_VERSION, "scope": scope, "sessions": manifest["sessions"], "calendarHash": stable_hash(manifest["sessions"]),
                "matrix": matrix_for(manifest["sessions"], options), "identity": identity, "identityHash": stable_hash(identity),
                "preparation": measurements(manifest["preparationMetrics"]), "paritySha256": base.digest_file(parity_path)["sha256"]}
        validate_plan(plan, parity, options, scope)
        if origin_loaded is not None:
            validate_origin_plan_match(plan, origin_loaded[0])
        plan_path = root / "plan.json"
        base.local_json(plan_path, plan)
        storage.complete(scope, {"planSha256": base.digest_file(plan_path)["sha256"], "calendarHash": plan["calendarHash"], "parityStatus": "PASS"},
                         [("plan.json", plan_path), ("parity.json", parity_path)], root)
        write_matrix(plan, environment)
        return {"status": "COMPLETE", "phase": "plan", "reused": False, "chunks": len(plan["matrix"]["include"])}
    plan, parity, plan_hash = loaded
    restored = root / "restored-role"
    if options.phase == "score":
        chunks = plan["matrix"]["include"]
        require(options.chunk_index < len(chunks), "CHUNK_INDEX_OUTSIDE_PLAN")
        chunk = chunks[options.chunk_index]
        completion = storage.restore(storage.role, scope, restored, optional=True, expected_proof=score_proof(plan, plan_hash, chunk))
        if completion is not None:
            validate_score_completion(completion, restored, plan, plan_hash, chunk)
            verify_import_origin(completion, origin_storage, options, scope, chunk, origin_loaded)
            return {"status": "COMPLETE", "phase": "score", "chunkIndex": options.chunk_index, "reused": True}
        if origin_loaded is not None and import_origin_score(storage, origin_storage, options, scope, root, plan, plan_hash, chunk, origin_loaded):
            return {"status": "COMPLETE", "phase": "score", "chunkIndex": options.chunk_index, "reused": True, "imported": True}
        # A partial cross-run copy has no committed receipt. Never relabel its
        # bytes as newly computed if the historical completion disappears.
        if not resume and recover_partial_score(storage, scope, root, plan, plan_hash, chunk):
            return {"status": "COMPLETE", "phase": "score", "chunkIndex": options.chunk_index, "reused": True, "partialRecovered": True}
    else:
        cached, import_origins = restore_score_chunks(storage, origin_storage, options, environment, root, plan, plan_hash, origin_loaded)
        proof = {"planSha256": plan_hash, "market": options.market, "start": options.kr_start if options.market == "kr" else options.etf_start,
                 "through": options.through, "cacheChunks": len(plan["matrix"]["include"]), "verifiedArithmetic": True}
        completion = storage.restore(storage.role, scope, restored, optional=True, expected_proof=proof)
        if completion is not None:
            validate_restored_replay(completion, restored, options, scope, plan, plan_hash, proof, origin_plan_hash=origin_loaded[2] if origin_loaded else None, import_origins=import_origins)
            return {"status": "COMPLETE", "phase": "replay", "market": options.market, "reused": True}
    prepared, manifest = prepare(storage, options, root, sources, source_file, child_env, runner)
    require(manifest["sessions"] == plan["sessions"], "PREPARED_CALENDAR_CHANGED")
    if options.phase == "score":
        target = root / "score"
        runner(driver(prepared, target, "kr-etf", chunk["first"], chunk["last"], scoring=True), root / "score.log", child_env)
        require({item.name for item in target.iterdir()} == CACHE_NAMES | {"provenance.json", "summary.json", "report.md"}, "UNEXPECTED_SCORE_OUTPUT")
        proof = score_proof(plan, plan_hash, chunk)
        validate_score_completion({"proof": proof}, target, plan, plan_hash, chunk)
        storage.complete(scope, proof, [(name, target / name) for name in ("signal-cache.jsonl.gz", "quality.json", "signal-cache.manifest.json")], root)
        return {"status": "COMPLETE", "phase": "score", "chunkIndex": options.chunk_index, "reused": False}
    index_path = root / "cache-index.json"
    make_index(index_path, cached)
    result = root / "result"
    runner(driver(prepared, result, options.market, proof["start"], options.through, index=index_path), root / "replay.log", child_env)
    verification = verify_results(result, root, "result", child_env, runner)
    files = base.output_files(result)
    require({file.name for file in files} == result_names(options.market), "INCOMPLETE_REPLAY_BOOK_FILES")
    outputs = [{"path": storage.attempt_prefix + "result/" + path.name, **base.digest_file(path)} for path in files]
    report = result_report(options, scope, manifest, sources, plan_hash, parity, result, verification, outputs, import_origins=import_origins)
    report_path = root / "run-manifest.json"
    base.local_json(report_path, report)
    summary = base.read_local_json(result / "summary.json", MAX_CHECKPOINT, "INVALID_RESULT_SUMMARY")
    metadata = base.build_summary_metadata(report, summary, base.digest_file(report_path)["sha256"])
    storage.complete(scope, proof, [(logical_path(entry["path"]), root / logical_path(entry["path"])) for entry in outputs] + [("run-manifest.json", report_path)], root, summary=metadata)
    return {"status": "COMPLETE", "phase": "replay", "market": options.market, "reused": False}


def public_failure_code(code):
    # Uppercase syntax alone is not enough: a credential can have that shape.
    literals = set()
    for filename in (Path(__file__), Path(base.__file__)):
        tree = ast.parse(filename.read_text(encoding="utf-8"))
        literals.update(node.value for node in ast.walk(tree) if isinstance(node, ast.Constant) and
                        isinstance(node.value, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{1,150}", node.value))
    if code in literals:
        return True
    match = re.fullmatch(r"LOCAL_RESEARCH_PROCESS_FAILED_(PREPARE|VERIFY|REPLAY)_(.+)", code)
    if not match:
        return False
    detail = match.group(2)
    if detail in literals:
        return True
    location = re.fullmatch(r"SOURCE_(?:ASSERT|FRAME)_((?:src/lib|scripts)/[A-Za-z0-9_./-]+\.ts):([0-9]+)(?::[0-9]+)?", detail)
    if not location:
        return False
    candidate = ROOT / location.group(1)
    try:
        candidate.resolve(strict=True).relative_to(ROOT.resolve(strict=True))
        return candidate.is_file() and not candidate.is_symlink() and 0 < int(location.group(2)) <= len(candidate.read_text().splitlines())
    except (OSError, ValueError):
        return False


def run_github_job(options, *, environment=None, session_factory=None, command_runner=base.run_command, emit=print):
    environment = dict(os.environ if environment is None else environment)
    storage = origin_storage = None
    try:
        validate_options(options)
        authorize_trigger(options, environment)
        if session_factory is None:
            import requests
            session_factory = requests.Session
        storage = ResumableStorage(transport.PrivateBucketSession(session_factory), environment.get("SUPABASE_URL", ""), environment.get("SUPABASE_USER_ID", ""),
                                   environment.get("SUPABASE_SERVICE_ROLE_KEY", ""), options.catalog_sha,
                                   environment.get("GITHUB_RUN_ID", ""), role_for(options), environment.get("GITHUB_RUN_ATTEMPT", ""))
        if hasattr(options, "resume_from"):
            origin_storage = ReadOnlyOriginStorage(storage.session, base.EXPECTED_SUPABASE_URL, storage.owner,
                environment.get("SUPABASE_SERVICE_ROLE_KEY", ""), options.catalog_sha,
                options.resume_from["runId"], storage.role)
        with tempfile.TemporaryDirectory(prefix="adopted-resumable-", dir=environment.get("RUNNER_TEMP")) as workspace:
            result = execute(options, storage, workspace, environment, command_runner, origin_storage=origin_storage)
    except JobError as error:
        # Only our fixed codes or the original credential-free runner codes are public.
        code = str(error)
        if not public_failure_code(code):
            code = "JOB_FAILED_NO_PRIVATE_DETAILS_LOGGED"
        result = {"status": "STOPPED", "code": code}
    except Exception:
        result = {"status": "STOPPED", "code": "UNEXPECTED_JOB_ERROR_NO_DETAILS_LOGGED"}
    finally:
        if origin_storage is not None:
            origin_storage.headers.clear()
        if storage is not None:
            storage.close()
    emit(json.dumps(result, sort_keys=True))
    return result


def parse_options(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", dest="request_file", required=True)
    parser.add_argument("--phase", choices=["plan", "score", "replay"], required=True)
    parser.add_argument("--chunk-index", type=int)
    parser.add_argument("--market", choices=["kr", "etf"])
    options = parser.parse_args(argv)
    request = base.read_local_json(options.request_file, 16384, "INVALID_REQUEST_FILE")
    require(REQUEST_FIELDS <= set(request) <= REQUEST_FIELDS | OPTIONAL_REQUEST_FIELDS, "INVALID_REQUEST_FIELDS")
    for key, value in request.items():
        setattr(options, key, value)
    validate_options(options)
    return options


def main():
    try:
        options = parse_options()
    except JobError as error:
        print(json.dumps({"status": "STOPPED", "code": str(error)}, sort_keys=True))
        return 1
    return 0 if run_github_job(options)["status"] == "COMPLETE" else 1


if __name__ == "__main__":
    raise SystemExit(main())
