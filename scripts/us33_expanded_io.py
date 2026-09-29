from __future__ import annotations

import argparse
import json
import mimetypes
import os
from pathlib import Path
from urllib.parse import quote

import requests

BUCKET = "cloudtrend-data"
USER = "bdfc8818-33a7-4030-9dbd-ecad39f223ac"
PRICE_PREFIX = f"{USER}/research/us/expanded"
REFERENCE_PREFIX = f"{USER}/research/us/Expended/Reference"
STANDARD_REFERENCE_PREFIX = f"{USER}/research/us/expanded/reference"

INPUTS = [
    *[(f"{PRICE_PREFIX}/prices/year={y}/data_0.parquet", f"prices/year={y}/data_0.parquet") for y in range(2015, 2027)],
    (f"{PRICE_PREFIX}/benchmark/spy.parquet", "benchmark/spy.parquet"),
    (f"{PRICE_PREFIX}/manifest.json", "manifest.json"),
    (f"{REFERENCE_PREFIX}/tickers.csv", "reference/tickers.csv"),
    (f"{REFERENCE_PREFIX}/actions.csv", "reference/actions.csv"),
    (f"{STANDARD_REFERENCE_PREFIX}/sector_map_extended.csv", "reference/sector_map_extended.csv"),
    (f"{STANDARD_REFERENCE_PREFIX}/verified_event_overrides.csv", "reference/verified_event_overrides.csv"),
]


def env() -> tuple[str, str]:
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")
    return url, key


def headers(key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}", "apikey": key}


def endpoint(url: str, path: str) -> str:
    return f"{url}/storage/v1/object/authenticated/{quote(BUCKET, safe='')}/{quote(path, safe='/=._-')}"


def download(url: str, key: str, remote: str, local: Path) -> None:
    local.parent.mkdir(parents=True, exist_ok=True)
    if local.exists() and local.stat().st_size > 0:
        print(f"cache hit: {local}")
        return
    with requests.get(endpoint(url, remote), headers=headers(key), stream=True, timeout=(20, 300)) as r:
        if r.status_code == 404:
            raise RuntimeError(f"required Supabase object missing: {remote}")
        r.raise_for_status()
        tmp = local.with_suffix(local.suffix + ".tmp")
        with tmp.open("wb") as f:
            for chunk in r.iter_content(1024 * 1024):
                if chunk:
                    f.write(chunk)
        tmp.replace(local)
    print(f"downloaded: {remote} -> {local} ({local.stat().st_size} bytes)")


def upload(url: str, key: str, remote: str, local: Path) -> None:
    h = headers(key)
    h["x-upsert"] = "true"
    h["Content-Type"] = mimetypes.guess_type(local.name)[0] or "application/octet-stream"
    e = f"{url}/storage/v1/object/{quote(BUCKET, safe='')}/{quote(remote, safe='/=._-')}"
    with local.open("rb") as f:
        r = requests.post(e, headers=h, data=f, timeout=(20, 300))
    r.raise_for_status()
    print(f"uploaded: {remote}")


def cmd_download(root: Path) -> None:
    url, key = env()
    for remote, rel in INPUTS:
        download(url, key, remote, root / rel)


def cmd_upload_results(source: Path) -> None:
    url, key = env()
    run_id = os.environ.get("GITHUB_RUN_ID", "local")
    sha = os.environ.get("GITHUB_SHA", "unknown")
    prefix = f"{USER}/results/us33-expanded-mbtv/{run_id}"
    files = sorted(p for p in source.iterdir() if p.is_file() and p.suffix in {".csv", ".json"})
    if not files:
        raise RuntimeError(f"no result files in {source}")
    for p in files:
        upload(url, key, f"{prefix}/{p.name}", p)
    latest = source / "latest.json"
    latest.write_text(json.dumps({
        "runId": run_id,
        "githubSha": sha,
        "resultPrefix": prefix,
        "files": [p.name for p in files],
    }, indent=2), encoding="utf-8")
    upload(url, key, f"{USER}/results/us33-expanded-mbtv/latest.json", latest)


def main() -> None:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("download")
    d.add_argument("--root", required=True)
    u = sub.add_parser("upload-results")
    u.add_argument("--source", required=True)
    a = p.parse_args()
    if a.cmd == "download":
        cmd_download(Path(a.root).resolve())
    else:
        cmd_upload_results(Path(a.source).resolve())


if __name__ == "__main__":
    main()
