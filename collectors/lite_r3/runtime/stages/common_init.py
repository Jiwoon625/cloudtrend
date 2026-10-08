#@title 2. 공통 Colab 초기화 — 설치 · Drive · IP · Secrets (한 번만)

import os
import sys
import json
import time
import math
import glob
import hashlib
import threading
import getpass
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np
import pandas as pd
import requests
from tqdm.auto import tqdm

IN_COLAB = "google.colab" in sys.modules
if not IN_COLAB:
    raise RuntimeError("이 노트북은 Google Colab 전용입니다.")

from google.colab import drive, userdata

if not Path("/content/drive/MyDrive").exists():
    drive.mount("/content/drive", force_remount=False)
else:
    print("Google Drive: 이미 마운트되어 있습니다.")

def get_public_ip():
    endpoints = ["https://api.ipify.org", "https://checkip.amazonaws.com"]
    errors = []
    for endpoint in endpoints:
        try:
            response = requests.get(endpoint, timeout=10)
            response.raise_for_status()
            ip = response.text.strip()
            if ip:
                return ip
        except Exception as error:
            errors.append(f"{endpoint}: {error}")
    raise RuntimeError("외부 IP 확인 실패\n" + "\n".join(errors))

if RUN_KR_MARKET or RUN_US_MARKET:
    COLAB_PUBLIC_IP = get_public_ip()
    print("현재 실행환경의 외부 IP:", COLAB_PUBLIC_IP)
    print("이 IP가 Toss Open API 허용 IP에 등록되어 있어야 합니다.")
else:
    COLAB_PUBLIC_IP = None
    print("미국 저장자료 확인: Toss 수집/IP 확인 생략")

def _read_colab_secret(*names):
    for name in names:
        try:
            value = userdata.get(name)
        except Exception:
            value = None
        if value is not None and str(value).strip():
            return str(value).strip()
    return None

def resolve_credential(canonical, aliases=(), label=None, hidden=False, required=True):
    """환경변수 → Colab Secrets → 직접입력 순서로 인증값을 확보합니다."""
    candidates = (canonical, *aliases)
    value = None
    for name in candidates:
        current = os.environ.get(name)
        if current and str(current).strip():
            value = str(current).strip()
            break
    if value is None:
        value = _read_colab_secret(*candidates)
    if value is None and required:
        prompt = (label or canonical) + ": "
        value = getpass.getpass(prompt) if hidden else input(prompt)
        value = str(value).strip()
    if required and not value:
        raise EnvironmentError(f"{label or canonical} 값이 비어 있습니다.")
    if value:
        os.environ[canonical] = value
        for alias in aliases:
            os.environ.setdefault(alias, value)
    return value

if RUN_KR_MARKET or RUN_US_MARKET:
    TOSS_CLIENT_ID = resolve_credential("TOSS_CLIENT_ID", aliases=("TOSS_CLIENT_ID_T",), label="Toss Client ID")
    TOSS_CLIENT_SECRET = resolve_credential("TOSS_CLIENT_SECRET", aliases=("TOSS_CLIENT_SECRET_T",), label="Toss Client Secret", hidden=True)
else:
    TOSS_CLIENT_ID = globals().get("TOSS_CLIENT_ID", "")
    TOSS_CLIENT_SECRET = globals().get("TOSS_CLIENT_SECRET", "")
CLIENT_ID = TOSS_CLIENT_ID
CLIENT_SECRET = TOSS_CLIENT_SECRET

if RUN_KR_MARKET:
    resolve_credential("KRX_OPENAPI_KEY", label="KRX Open API Key", hidden=True)

SUPABASE_URL = str(globals()["SUPABASE_URL"]).rstrip("/")
EXPECTED_SUPABASE_URL = str(globals()["EXPECTED_SUPABASE_URL"]).rstrip("/")
if SUPABASE_URL != EXPECTED_SUPABASE_URL:
    raise RuntimeError("Supabase destination differs from notebook configuration")
SUPABASE_SERVICE_ROLE_KEY = resolve_credential("SUPABASE_SERVICE_ROLE_KEY", label="Supabase Service Role Key", hidden=True)

SUPABASE_USER_ID = globals().get("SUPABASE_USER_ID") or resolve_credential("SUPABASE_USER_ID", label="Supabase User ID", required=False)
if (RUN_KR_MARKET or RUN_US_MARKET) and not SUPABASE_USER_ID:
    owners_response = requests.get(
        SUPABASE_URL + "/rest/v1/analysis_source_files",
        headers={"apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": "Bearer " + SUPABASE_SERVICE_ROLE_KEY},
        params={"select":"user_id","status":"eq.active","limit":"1000"},
        timeout=30,
    )
    owners_response.raise_for_status()
    owner_rows = owners_response.json()
    owners = {row["user_id"] for row in owner_rows}
    if len(owners) != 1 or len(owner_rows) >= 1000:
        raise RuntimeError("SUPABASE_USER_ID를 Colab Secrets에 등록하세요. owner가 모호합니다.")
    SUPABASE_USER_ID = owners.pop()
    os.environ["SUPABASE_USER_ID"] = SUPABASE_USER_ID

GITHUB_TOKEN = resolve_credential("GITHUB_TOKEN", label="GitHub Token", hidden=True, required=False)

print("공통 초기화 완료")
print({
    "TOSS_CLIENT_ID": bool(TOSS_CLIENT_ID),
    "TOSS_CLIENT_SECRET": bool(TOSS_CLIENT_SECRET),
    "KRX_OPENAPI_KEY": bool(os.environ.get("KRX_OPENAPI_KEY")) if RUN_KR_MARKET else "SKIP",
    "SUPABASE_SERVICE_ROLE_KEY": bool(SUPABASE_SERVICE_ROLE_KEY),
    "SUPABASE_USER_ID": bool(SUPABASE_USER_ID) if RUN_US_MARKET else "SKIP",
    "GITHUB_TOKEN": bool(GITHUB_TOKEN),
})
