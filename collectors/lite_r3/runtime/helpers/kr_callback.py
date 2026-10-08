"""Bounded KR publish-success callback. No schedules, login, or credential creation.

Call only with the fresh return value of publish_to_supabase. The Drive claim
journal is at-most-once for one serialized notebook; GitHub workflow_dispatch
has no idempotency key, so uncertain sends are never automatically retried.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote
import hashlib
import json
import os
import re
import tempfile

KR_REPOSITORY = "Jiwoon625/cloudtrend"
KR_WORKFLOW = "cloudtrend-analysis.yml"
KR_REF = "main"
KR_CLAIM_DIRECTORY = str(globals()["KR_CLAIM_DIRECTORY"])
_SHA = re.compile(r"^sha256:[0-9a-f]{64}$")
_ACTIVE = {"queued", "in_progress", "waiting", "pending", "requested"}
_UNCERTAIN = {"DISPATCHING", "DISPATCH_UNCERTAIN"}
_NO_RETRY = _UNCERTAIN | {"REQUEST_ACCEPTED", "ALREADY_RUNNING", "ALREADY_COMPLETED"}


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _sha(value):
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def _check(condition, message):
    if not condition:
        raise ValueError(message)


def _utc_now():
    return datetime.now(timezone.utc).isoformat()


def _registry_identity(rows, user_id):
    _check(isinstance(rows, list) and 0 < len(rows) < 1000, "Incomplete source registry")
    seen, identity = set(), []
    for row in rows:
        sid = row.get("id")
        _check(isinstance(sid, str) and sid and sid not in seen, "Invalid source identity")
        _check(row.get("user_id") == user_id and row.get("status") == "active"
               and row.get("source_type") == "screening", "Wrong source registry scope")
        for field in ("file_hash", "data_hash", "schema_hash"):
            _check(isinstance(row.get(field), str) and _SHA.fullmatch(row[field]), "Invalid source hash")
        _check(isinstance(row.get("created_at"), str) and row["created_at"], "Missing source timing")
        _check(row.get("activated_at") is None or isinstance(row["activated_at"], str), "Invalid source timing")
        seen.add(sid)
        identity.append({"id": sid, "fileHash": row["file_hash"], "dataHash": row["data_hash"],
                         "schemaHash": row["schema_hash"], "activatedAt": row.get("activated_at"),
                         "createdAt": row["created_at"]})
    return sorted(identity, key=lambda r: r["id"])


def bind_kr_publication_receipt(receipt, final_registry, user_id):
    """Stamp only after the publisher's chunk/readback/legacy-sync checks pass."""
    identity = _registry_identity(final_registry, user_id)
    receipt.update(screeningReceiptVersion=1, publishedUserId=user_id, legacySynced=True,
                   publishedAt=_utc_now(), publishedRegistry=identity,
                   publishedRegistryFingerprint=_sha(_canonical(identity)),
                   publishedDataVersion=_sha("\n".join(sorted(r["dataHash"] for r in identity))))
    return receipt


def _receipt_binding(receipt, current_run_id, user_id):
    _check(isinstance(receipt, dict) and current_run_id and receipt.get("runId") == current_run_id,
           "Stale publication run")
    _check(receipt.get("status") == "PUBLISHED" and not receipt.get("failedStage")
           and not receipt.get("error"), "Publication is incomplete")
    _check(receipt.get("screeningReceiptVersion") == 1 and receipt.get("legacySynced") is True
           and receipt.get("publishedUserId") == user_id, "Unbound publication receipt")
    identity = receipt.get("publishedRegistry")
    _check(isinstance(identity, list) and identity, "Missing published registry")
    _check(receipt.get("publishedRegistryFingerprint") == _sha(_canonical(identity)), "Receipt fingerprint mismatch")
    _check(receipt.get("publishedDataVersion") == _sha("\n".join(sorted(r["dataHash"] for r in identity))),
           "Receipt data version mismatch")
    parts = receipt.get("parts")
    _check(isinstance(parts, list) and parts, "No verified publication parts")
    registry = {r["id"]: r["fileHash"] for r in identity}
    ids = []
    for part in parts:
        _check(part.get("verified") is True and registry.get(part.get("sourceId")) == part.get("fileHash"),
               "Unverified or missing publication part")
        ids.append(part["sourceId"])
    _check(len(ids) == len(set(ids)) and receipt.get("sourceIds") == ids
           and receipt.get("sourceId") == ids[-1], "Publication part list mismatch")
    return {key: receipt[key] for key in ("runId", "status", "parts", "sourceIds", "sourceId",
             "screeningReceiptVersion", "publishedUserId", "legacySynced", "publishedAt",
             "publishedRegistry", "publishedRegistryFingerprint", "publishedDataVersion")}


def _write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix="." + path.name, suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
        # A readback is required before any external POST. Drive durability and
        # cross-machine file locking are not a distributed transaction.
        _check(json.loads(path.read_text(encoding="utf-8")) == value, "Journal readback failed")
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


@contextmanager
def _claim_lock(path):
    # Colab/Linux only. Locks same-runtime repeated cells; never expire claims.
    import fcntl
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


class KrCallbackApi:
    """Uses only the notebook's existing Supabase and GitHub credentials."""
    def __init__(self, context, supabase_url, github_token, session=None):
        if session is None:
            import requests
            session = requests.Session()
        self.session = session
        self.context = context
        self.supabase_url = supabase_url.rstrip("/")
        self.github_token = github_token
        _check(self.supabase_url == EXPECTED_SUPABASE_URL.rstrip("/"), "Unexpected Supabase destination")

    def _get(self, url, *, github=False, params=None):
        if github:
            headers = {"Authorization": "Bearer " + self.github_token, "Accept": "application/vnd.github+json"}
        else:
            key = self.context["key"]
            headers = {"apikey": key, "Cache-Control": "no-cache"}
            if not key.startswith("sb_secret_"):
                headers["Authorization"] = "Bearer " + key
        response = self.session.get(url, headers=headers, params=params, timeout=(15, 60), allow_redirects=False)
        _check(response.status_code == 200, "Read-only callback preflight failed")
        return response.json()

    def registry(self):
        return self._get(self.supabase_url + "/rest/v1/analysis_source_files", params={
            "select": "id,user_id,source_type,status,file_hash,data_hash,schema_hash,activated_at,created_at",
            "user_id": "eq." + self.context["uid"], "source_type": "eq.screening", "status": "eq.active",
            "order": "activated_at.desc,created_at.desc", "limit": "1000"})

    def matching_runs(self, data_version):
        rows = self._get(self.supabase_url + "/rest/v1/analysis_runs", params={
            "select": "id,user_id,kind,status,data_version,created_at,completed_at",
            "user_id": "eq." + self.context["uid"], "kind": "eq.SCREENING", "data_version": "eq." + data_version,
            "status": "in.(RUNNING,COMPLETED)", "order": "created_at.desc", "limit": "1000"})
        _check(isinstance(rows, list) and len(rows) < 1000, "Incomplete analysis run list")
        return rows

    def active_workflows(self):
        url = f"https://api.github.com/repos/{KR_REPOSITORY}/actions/workflows/{KR_WORKFLOW}/runs"
        active = []
        # Query each active status rather than assume recent-history pagination
        # includes every long-running workflow. Include issue-comment runs too.
        for status in sorted(_ACTIVE):
            result = self._get(url, github=True, params={"status": status, "per_page": 100})
            _check(isinstance(result, dict) and isinstance(result.get("workflow_runs"), list), "Invalid workflow list")
            for run in result["workflow_runs"]:
                if run.get("status") in _ACTIVE and run.get("event") != "pull_request":
                    active.append({"id": run["id"], "status": run["status"]})
            _check(result.get("total_count", 0) <= 100, "Incomplete active workflow list")
        return active

    def dispatch(self):
        # requests has no POST retry adapter here. Never log response bodies or
        # request objects: either can contain credentials or private metadata.
        response = self.session.post(
            f"https://api.github.com/repos/{KR_REPOSITORY}/actions/workflows/{quote(KR_WORKFLOW)}/dispatches",
            headers={"Authorization": "Bearer " + self.github_token, "Accept": "application/vnd.github+json"},
            json={"ref": KR_REF, "inputs": {"force": "false"}}, timeout=(15, 60), allow_redirects=False)
        return response.status_code


def request_kr_screening_after_publish(*, receipt, current_run_id, context, receipt_path,
                                       github_token, supabase_url, claim_directory=KR_CLAIM_DIRECTORY, api=None):
    """Return request status. Never change a successful publication into failure.

    The caller supplies the fresh publisher result, not a reloaded old receipt.
    Accepted means GitHub accepted the request; it does not mean screening ran.
    """
    result = {"status": "NOT_REQUESTED", "screeningTriggered": False, "runId": current_run_id}
    try:
        binding = _receipt_binding(receipt, current_run_id, context["uid"])
        persisted = json.loads(Path(receipt_path).read_text(encoding="utf-8"))
        _check(_receipt_binding(persisted, current_run_id, context["uid"]) == binding,
               "Persisted receipt does not match this publication")
    except Exception:
        return dict(result, status="BLOCKED_INVALID_RECEIPT")

    def report(status, **details):
        outcome = dict(result, status=status, **details)
        # Only nonsecret allowlisted result metadata is written.
        receipt["screeningRequest"] = outcome
        receipt["screeningTriggered"] = bool(outcome.get("screeningTriggered"))
        try:
            latest = json.loads(Path(receipt_path).read_text(encoding="utf-8"))
            _check(_receipt_binding(latest, current_run_id, context["uid"]) == binding, "Receipt replaced concurrently")
            latest.update(screeningRequest=outcome, screeningTriggered=receipt["screeningTriggered"])
            _write_json(receipt_path, latest)
        except Exception:
            outcome["receiptUpdateVerified"] = False
        return outcome

    if not isinstance(github_token, str) or not github_token.strip():
        return report("SKIPPED_MISSING_GITHUB_TOKEN")
    identity = receipt["publishedRegistry"]
    fingerprint = receipt["publishedRegistryFingerprint"]
    data_version = receipt["publishedDataVersion"]
    key = _sha(_canonical({"userId": context["uid"], "repository": KR_REPOSITORY,
                           "workflow": KR_WORKFLOW, "ref": KR_REF, "fingerprint": fingerprint}))[7:]
    path = Path(claim_directory) / (key + ".json")
    result["requestKey"] = key
    try:
        api = api or KrCallbackApi(context, supabase_url, github_token)
        with _claim_lock(path.with_suffix(".lock")):
            _check(_registry_identity(api.registry(), context["uid"]) == identity, "Registry changed after publication")
            runs = api.matching_runs(data_version)
            exact = [r for r in runs if r.get("user_id") == context["uid"] and r.get("kind") == "SCREENING"
                     and r.get("data_version") == data_version and r.get("status") in {"RUNNING", "COMPLETED"}]
            # A completed logical-source run is reuse evidence; this says nothing
            # about downstream portfolio/Shadow readiness.
            existing = next((r for r in exact if r["status"] == "COMPLETED"), None) or next(iter(exact), None)
            claim = json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
            if claim is not None:
                _check(claim.get("requestKey") == key and claim.get("sourceFingerprint") == fingerprint,
                       "Invalid callback journal")
            if existing:
                status = "ALREADY_COMPLETED" if existing["status"] == "COMPLETED" else "ALREADY_RUNNING"
                new_claim = {"requestKey": key, "sourceFingerprint": fingerprint, "dataVersion": data_version,
                             "status": status, "analysisRunId": existing["id"], "updatedAt": _utc_now()}
                _write_json(path, new_claim)
                return report(status, analysisRunId=existing["id"])
            if claim and claim.get("status") in _NO_RETRY:
                status = "PENDING_RECONCILIATION" if claim["status"] in _UNCERTAIN else "ALREADY_REQUESTED"
                return report(status, originalRequestStatus=claim["status"],
                              screeningTriggered=claim["status"] == "REQUEST_ACCEPTED")
            if claim:
                _check(claim.get("status") == "REJECTED", "Unknown callback journal state")
            active = api.active_workflows()
            if active:
                # No source key in existing Actions inputs. Never call an
                # unrelated active run a matching-source successful request.
                return report("DEFERRED_ACTIVE_WORKFLOW", activeWorkflowIds=[r["id"] for r in active])
            _check(_registry_identity(api.registry(), context["uid"]) == identity, "Registry changed before dispatch")
            # Persist intent BEFORE the only mutating request. If the runtime
            # stops at any point after this write, retry must reconcile first.
            claim = {"requestKey": key, "sourceFingerprint": fingerprint, "dataVersion": data_version,
                     "status": "DISPATCHING", "runId": current_run_id, "updatedAt": _utc_now()}
            _write_json(path, claim)
            try:
                http_status = api.dispatch()
            except Exception:
                http_status = None
            if http_status == 204:
                claim.update(status="REQUEST_ACCEPTED", updatedAt=_utc_now())
            elif http_status in {400, 401, 403, 404, 409, 422, 429}:
                claim.update(status="REJECTED", httpStatus=http_status, updatedAt=_utc_now())
            else:
                claim.update(status="DISPATCH_UNCERTAIN", updatedAt=_utc_now())
            try:
                _write_json(path, claim)
            except Exception:
                return report("PENDING_RECONCILIATION", screeningTriggered=http_status == 204,
                              requestAccepted=http_status == 204)
            return report(claim["status"], screeningTriggered=http_status == 204,
                          **({"httpStatus": http_status} if claim["status"] == "REJECTED" else {}))
    except Exception:
        # Suppress untrusted network exception text, credentials, and URLs.
        return report("BLOCKED_PREFLIGHT_OR_JOURNAL")


def patch_kr_publisher_source(source):
    """Pure patch generator. Does not edit a notebook or run its publisher."""
    changes = [
        ("id,user_id,original_filename,min_date,max_date,schema_hash,file_hash,file_size_bytes,storage_bucket,storage_path,status,activated_at,created_at",
         "id,user_id,source_type,original_filename,min_date,max_date,schema_hash,file_hash,data_hash,file_size_bytes,storage_bucket,storage_path,status,activated_at,created_at"),
        ("        require(source_fingerprint(source_registry(ctx))==source_fingerprint(active),'통합 중 다른 실행이 원천 목록을 변경했습니다.')",
         "        final_registry=source_registry(ctx)\n        require(source_fingerprint(final_registry)==source_fingerprint(active),'통합 중 다른 실행이 원천 목록을 변경했습니다.')"),
        ("        save('PUBLISHED')", "        bind_kr_publication_receipt(receipt, final_registry, ctx['uid'])\n        save('PUBLISHED')"),
        ("        print('CloudTrend 스크리닝은 직접 시작하세요.')", "        print('업로드 영수증 검증 완료. 이어서 한국 스크리닝 자동 요청 상태를 확인합니다.')"),
    ]
    for old, new in changes:
        _check(source.count(old) == 1, "Reviewed KR publisher patch anchor changed")
        source = source.replace(old, new, 1)
    compile(source, "kr_publisher_callback_patched.py", "exec")
    return source


def install_kr_publish_screening_callback(namespace):
    """Install once after the existing publisher/schema/progress installers.

    Wrapping the publisher handles both the ordinary cell and explicit saved
    manifest retry. A raised publish failure cannot reach this callback.
    """
    original = namespace["publish_to_supabase"]
    if getattr(original, "_kr_screening_callback_v1", False):
        return
    labels = {
        "REQUEST_ACCEPTED": "GitHub 한국 스크리닝 요청 접수. 엔진 완료는 아직 확인되지 않았습니다.",
        "ALREADY_REQUESTED": "같은 원천의 기존 요청이 있어 추가 요청을 생략했습니다.",
        "ALREADY_RUNNING": "같은 원천의 스크리닝이 실행 중입니다.",
        "ALREADY_COMPLETED": "같은 논리 원천의 스크리닝 완료 기록이 있어 추가 요청을 생략했습니다.",
        "SKIPPED_MISSING_GITHUB_TOKEN": "업로드 완료. 기존 GITHUB_TOKEN이 없어 스크리닝 요청을 생략했습니다.",
        "DEFERRED_ACTIVE_WORKFLOW": "업로드 완료. 진행 중인 한국 워크플로가 있어 자동 요청을 보류했습니다.",
        "DISPATCH_UNCERTAIN": "업로드 완료. 스크리닝 요청 응답이 불확실해 자동 재요청을 차단했습니다.",
        "PENDING_RECONCILIATION": "업로드 완료. 기존 요청 여부를 확인하기 전에는 자동 재요청하지 않습니다.",
        "REJECTED": "업로드 완료. GitHub가 스크리닝 요청을 거절했습니다. 요청 영수증의 HTTP 상태를 확인하세요.",
    }

    def publish_and_request(context, manifest_path, run_id):
        namespace["_KR_SCREENING_REQUEST"] = None
        receipt = original(context, manifest_path, run_id)
        outcome = request_kr_screening_after_publish(
            receipt=receipt, current_run_id=run_id, context=context,
            receipt_path=Path(manifest_path).parent / "publish_receipt.json",
            github_token=namespace.get("GITHUB_TOKEN"), supabase_url=namespace["SUPABASE_URL"],
            claim_directory=namespace.get("KR_SCREENING_CLAIM_DIRECTORY", KR_CLAIM_DIRECTORY))
        namespace["_KR_SCREENING_REQUEST"] = outcome
        print(labels.get(outcome["status"], "업로드 완료. 한국 스크리닝 자동 요청의 사전 검증이 통과하지 못했습니다."))
        return receipt

    publish_and_request._kr_screening_callback_v1 = True
    namespace["publish_to_supabase"] = publish_and_request
