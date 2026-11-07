"""Colab entrypoint: Google authentication -> encrypted GitHub secret -> workflow dispatch. v1.1 result-only publication.

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


def launch(folder_id, run_id, mode="publish", wait=True, prepare_charts=True):
    import re
    if not re.fullmatch(r"[A-Za-z0-9_-]{10,200}", folder_id) or not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", run_id) or mode not in ("drive", "supabase", "publish"):
        raise ValueError("실행 폴더·ID·보관 방식을 확인해 주세요.")
    from google.colab import auth, userdata
    import google.auth
    from google.auth.transport.requests import Request
    from nacl.public import PublicKey, SealedBox
    from nacl.encoding import Base64Encoder

    token = userdata.get("GITHUB_TOKEN")
    # Don't overwrite a shared short-lived credential while an existing runner is using it.
    for status in ("in_progress", "queued", "waiting", "pending", "requested"):
        runs = github(token, f"actions/workflows/{WORKFLOW}/runs?status={status}&event=workflow_dispatch&per_page=1")
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
           {"ref": "main", "inputs": {"folder_id": folder_id, "collector_run_id": run_id, "source_storage": mode, "prepare_charts":str(bool(prepare_charts)).lower()}}, "POST")
    print("스크리닝 후 홈페이지 게시를 요청했습니다. 원천 CSV는 업로드하지 않습니다." if mode=="publish" else "스크리닝을 요청했습니다. 자료수집은 다시 하지 않습니다.")
    print("진행 확인: https://github.com/" + REPO + "/actions/workflows/" + WORKFLOW)
    # Print an observed run URL when available; do not block the notebook until completion.
    for _ in range(6):
        runs = github(token, f"actions/workflows/{WORKFLOW}/runs?event=workflow_dispatch&per_page=3")
        for run in runs.get("workflow_runs", []):
            from datetime import datetime
            if datetime.fromisoformat(run["created_at"].replace("Z", "+00:00")).timestamp() >= start - 2:
                print("실행 링크:", run["html_url"])
                if wait:
                    monitor_publication(token,run["id"],mode)
                return run["html_url"]
        time.sleep(2)
    return None


def monitor_publication(token, run_id, mode="publish"):
    """Distinguish calculation, homepage publication and the final Drive save."""
    deadline=time.monotonic()+60*60
    observed=None
    posted=False
    while time.monotonic()<deadline:
        run=github(token,f"actions/runs/{run_id}")
        jobs=github(token,f"actions/runs/{run_id}/jobs").get("jobs",[])
        steps=[s for j in jobs if j["name"]=="screening" for s in j.get("steps",[])]
        stage=next((s["name"] for s in steps if s["status"]=="in_progress"),run["status"])
        if stage!=observed:
            labels={"Run npm ci":"실행 환경 준비", "Prepare pinned private inputs and preserve baseline identity":"입력 검증", "Build current signal configuration":"운영 규칙 준비", "Run existing engine on completed input":"스크리닝 계산·홈페이지 게시", "Save execution results and receipt to the selected Drive run":"Drive 결과 보관", "Prepare recent result charts":"최근 120일 차트 준비", "Summarize execution":"완료 확인", "queued":"실행 대기", "in_progress":"준비 중", "completed":"마무리"}
            print("진행:",labels.get(stage,"실행 준비·확인 중"))
            observed=stage
        calculated=next((s for s in steps if s["name"]=="Run existing engine on completed input"),None)
        if mode=="publish" and calculated and calculated.get("conclusion")=="success" and not posted:
            print("홈페이지 게시와 읽기 검증이 끝났습니다: https://cloudtrend.vercel.app")
            print("Drive 결과 보관을 마무리하고 있습니다. 잠정 자료는 잠정 표시를 유지합니다.")
            posted=True
        if run["status"]=="completed":
            if run.get("conclusion")!="success":
                message="홈페이지 게시 후 차트·Drive 보관/마무리 단계가 실패했습니다. 실행 링크에서 확인해 주세요." if posted else "실행이 완료되지 않았습니다. 실행 링크의 실패 단계를 확인해 주세요."
                raise RuntimeError(message)
            if mode=="publish" and not posted:
                raise RuntimeError("작업은 종료됐지만 홈페이지 게시 단계를 확인하지 못했습니다. 실행 링크를 확인해 주세요.")
            print("완료: 홈페이지 게시 및 Drive 결과 보관" if mode=="publish" else "완료: Drive 결과 보관")
            return run
        time.sleep(15)
    print("확인이 오래 걸려 대기를 종료합니다. GitHub 작업은 계속 진행될 수 있으니 실행 링크를 확인해 주세요.")
    return None
