from __future__ import annotations

import argparse
import json
import mimetypes
import os
from pathlib import Path
from urllib.parse import quote

import requests

BUCKET = "cloudtrend-data"


def headers(key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}", "apikey": key}


def upload(url: str, key: str, object_path: str, source: Path) -> None:
    endpoint = (
        f"{url}/storage/v1/object/{quote(BUCKET, safe='')}/"
        f"{quote(object_path, safe='/=._-')}"
    )
    h = headers(key)
    h["x-upsert"] = "true"
    h["Content-Type"] = mimetypes.guess_type(source.name)[0] or "application/octet-stream"
    with source.open("rb") as f:
        response = requests.post(endpoint, headers=h, data=f, timeout=(20, 300))
    response.raise_for_status()


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--source", required=True)
    args = p.parse_args()

    source = Path(args.source).resolve()
    url = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    user_id = os.environ["SUPABASE_USER_ID"]
    run_id = os.environ.get("GITHUB_RUN_ID", "local")
    sha = os.environ.get("GITHUB_SHA", "unknown")

    prefix = f"{user_id}/results/us33-entry-exit/{run_id}"
    files = sorted(p for p in source.iterdir() if p.is_file())
    if not files:
        raise RuntimeError(f"no result files in {source}")

    for path in files:
        upload(url, key, f"{prefix}/{path.name}", path)
        print(f"uploaded {prefix}/{path.name}")

    pointer = source / "_latest_pointer.json"
    pointer.write_text(
        json.dumps(
            {
                "runId": run_id,
                "githubSha": sha,
                "resultPrefix": prefix,
                "files": [p.name for p in files],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    upload(
        url,
        key,
        f"{user_id}/results/us33-entry-exit/latest.json",
        pointer,
    )
    print("uploaded latest pointer")


if __name__ == "__main__":
    main()
