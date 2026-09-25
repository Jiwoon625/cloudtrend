from __future__ import annotations

import argparse
import mimetypes
import os
from pathlib import Path
from urllib.parse import quote

import requests

BUCKET = "cloudtrend-data"
PREFIX = "bdfc8818-33a7-4030-9dbd-ecad39f223ac/results/us31-diversity-architecture"


def env() -> tuple[str, str]:
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")
    return url, key


def headers(key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}", "apikey": key}


def upload(url: str, key: str, object_path: str, source: Path) -> None:
    endpoint = f"{url}/storage/v1/object/{quote(BUCKET, safe='')}/{quote(object_path, safe='/=._-')}"
    h = headers(key)
    h["x-upsert"] = "true"
    h["Content-Type"] = mimetypes.guess_type(source.name)[0] or "application/octet-stream"
    with source.open("rb") as f:
        r = requests.post(endpoint, headers=h, data=f, timeout=(20, 300))
    r.raise_for_status()


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--source", required=True)
    args = p.parse_args()

    source = Path(args.source).resolve()
    url, key = env()
    run_id = os.environ.get("GITHUB_RUN_ID", "local")
    sha = os.environ.get("GITHUB_SHA", "unknown")
    run_prefix = f"{PREFIX}/{run_id}"

    files = sorted(p for p in source.iterdir() if p.is_file() and p.suffix in {".csv",".json"})
    if not files:
        raise RuntimeError(f"no result files in {source}")

    for f in files:
        upload(url, key, f"{run_prefix}/{f.name}", f)
        print(f"uploaded: {run_prefix}/{f.name}")

    latest = source / "latest.json"
    latest.write_text(
        __import__("json").dumps(
            {"runId": run_id, "githubSha": sha, "resultPrefix": run_prefix, "files": [f.name for f in files]},
            indent=2,
        ),
        encoding="utf-8",
    )
    upload(url, key, f"{PREFIX}/latest.json", latest)
    print("uploaded latest pointer")


if __name__ == "__main__":
    main()
