"""Colab entrypoint: Google authentication -> encrypted GitHub secret -> workflow dispatch.

No collection, source re-upload to Supabase or storage deletion is performed here.
"""
from __future__ import annotations
import base64
import json
import time
import urllib.error
import urllib.parse
import urllib.request

REPO = "Jiwoon625/cloudtrend"
WORKFLOW = "drive-screening.yml"


def github(token, path, data=None, method=None):
    request = urllib.request.Request(
        "https://api.github.com/repos/" + REPO + "/" + path,
        data=json.dumps(data).encode() if data is not None else None,
        method=method,
        headers={"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = response.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            raise RuntimeError("GITHUB_TOKEN에 Actions 실행 및 Actions secrets 쓰기 권한이 필요합니다. 토큰 권한을 확인해 주세요.") from None
        raise RuntimeError(f"GitHub 요청 실패 ({error.code}). PR 병합 및 workflow 설치 상태를 확인해 주세요.") from None


def launch(folder_id, run_id, mode="drive"):
    import re
    if not re.fullmatch(r"[A-Za-z0-9_-]{10,200}", folder_id) or not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", run_id) or mode not in ("drive", "supabase"):
        raise ValueError("실행 폴더·ID·보관 방식을 확인해 주세요.")
    from google.colab import auth, userdata
    import google.auth
    from google.auth.transport.requests import Request
    from nacl.public import PublicKey, SealedBox
    from nacl.encoding import Base64Encoder

    token = userdata.get("GITHUB_TOKEN")
    # Don't overwrite a shared short-lived credential while an existing runner is using it.
    for status in ("in_progress", "queued", "waiting", "pending", "requested"):
        runs = github(token, f"actions/workflows/{WORKFLOW}/runs?status={status}&per_page=1")
        if runs.get("workflow_runs"):
            raise RuntimeError("현재 스크리닝 실행기가 처리 중입니다. 기존 작업이 끝난 뒤 실행해 주세요.")
    auth.authenticate_user()
    credentials, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/drive"])
    credentials.refresh(Request())
    public = github(token, "actions/secrets/public-key")
    encrypted = SealedBox(PublicKey(public["key"].encode(), encoder=Base64Encoder)).encrypt(credentials.token.encode())
    github(token, "actions/secrets/GOOGLE_DRIVE_ACCESS_TOKEN",
           {"encrypted_value": base64.b64encode(encrypted).decode(), "key_id": public["key_id"]}, "PUT")
    start = time.time()
    github(token, f"actions/workflows/{WORKFLOW}/dispatches",
           {"ref": "main", "inputs": {"folder_id": folder_id, "collector_run_id": run_id, "source_storage": mode}}, "POST")
    print("스크리닝을 요청했습니다. 자료수집은 다시 하지 않습니다.")
    print("진행 확인: https://github.com/" + REPO + "/actions/workflows/" + WORKFLOW)
    # Print an observed run URL when available; do not block the notebook until completion.
    for _ in range(6):
        runs = github(token, f"actions/workflows/{WORKFLOW}/runs?event=workflow_dispatch&per_page=3")
        for run in runs.get("workflow_runs", []):
            from datetime import datetime
            if datetime.fromisoformat(run["created_at"].replace("Z", "+00:00")).timestamp() >= start - 2:
                print("실행 링크:", run["html_url"])
                return run["html_url"]
        time.sleep(2)
    return None
