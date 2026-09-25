from __future__ import annotations

import argparse
import mimetypes
import os
from pathlib import Path
from urllib.parse import quote

import requests

BUCKET = "cloudtrend-data"
USER_PREFIX = "bdfc8818-33a7-4030-9dbd-ecad39f223ac/research/us/v0"
INPUTS = [
    *[(f"canonical/year={year}/us_stock_daily.parquet", f"canonical/year={year}/us_stock_daily.parquet") for year in range(2016, 2027)],
    ("benchmark/us_benchmarks_adjusted.parquet", "benchmark/us_benchmarks_adjusted.parquet"),
    ("manifest_us1_price_backfill.json", "manifest_us1_price_backfill.json"),
    ("manifest_us2.json", "manifest_us2.json"),
    ("manifest_us2_1.json", "manifest_us2_1.json"),
    ("results/long_horizon_feature_review.csv", "results/long_horizon_feature_review.csv"),
    ("results/turnover_summary.csv", "results/turnover_summary.csv"),
    ("results/feature_redundancy_pairs.csv", "results/feature_redundancy_pairs.csv"),
    ("results/feature_direction.csv", "results/feature_direction.csv"),
    ("results/rank_ic_120_252_yearly.csv", "results/rank_ic_120_252_yearly.csv"),
]


def env() -> tuple[str, str]:
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")
    return url, key


def headers(key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}", "apikey": key}


def download_object(url: str, key: str, object_path: str, destination: Path) -> None:
    endpoint = f"{url}/storage/v1/object/authenticated/{quote(BUCKET, safe='')}/{quote(object_path, safe='/=._-')}"
    destination.parent.mkdir(parents=True, exist_ok=True)
    with requests.get(endpoint, headers=headers(key), stream=True, timeout=(20, 300)) as response:
        response.raise_for_status()
        tmp = destination.with_suffix(destination.suffix + ".tmp")
        with tmp.open("wb") as f:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    f.write(chunk)
        tmp.replace(destination)


def upload_object(url: str, key: str, object_path: str, source: Path) -> None:
    endpoint = f"{url}/storage/v1/object/{quote(BUCKET, safe='')}/{quote(object_path, safe='/=._-')}"
    content_type = mimetypes.guess_type(source.name)[0] or "application/octet-stream"
    h = headers(key)
    h["x-upsert"] = "true"
    h["Content-Type"] = content_type
    with source.open("rb") as f:
        response = requests.post(endpoint, headers=h, data=f, timeout=(20, 300))
    response.raise_for_status()


def cmd_download(root: Path) -> None:
    url, key = env()
    for remote_rel, local_rel in INPUTS:
        object_path = f"{USER_PREFIX}/{remote_rel}"
        destination = root / local_rel
        if destination.exists() and destination.stat().st_size > 0:
            print(f"cache hit: {local_rel} ({destination.stat().st_size} bytes)")
            continue
        download_object(url, key, object_path, destination)
        print(f"downloaded: {local_rel} ({destination.stat().st_size} bytes)")


def cmd_upload_results(source: Path) -> None:
    url, key = env()
    run_id = os.environ.get("GITHUB_RUN_ID", "local")
    sha = os.environ.get("GITHUB_SHA", "unknown")
    prefix = f"bdfc8818-33a7-4030-9dbd-ecad39f223ac/results/us3-score-candidates/{run_id}"
    files = [p for p in source.iterdir() if p.is_file() and p.suffix in {".csv", ".json"}]
    if not files:
        raise RuntimeError(f"no result files found in {source}")
    for p in sorted(files):
        upload_object(url, key, f"{prefix}/{p.name}", p)
        print(f"uploaded: {prefix}/{p.name}")
    latest = source / "latest.json"
    latest.write_text(
        __import__("json").dumps(
            {"runId": run_id, "githubSha": sha, "resultPrefix": prefix, "files": [p.name for p in sorted(files)]},
            indent=2,
        ),
        encoding="utf-8",
    )
    upload_object(
        url,
        key,
        "bdfc8818-33a7-4030-9dbd-ecad39f223ac/results/us3-score-candidates/latest.json",
        latest,
    )
    print("uploaded latest pointer")


def main() -> None:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="command", required=True)
    d = sub.add_parser("download")
    d.add_argument("--root", required=True)
    u = sub.add_parser("upload-results")
    u.add_argument("--source", required=True)
    args = p.parse_args()
    if args.command == "download":
        cmd_download(Path(args.root).resolve())
    else:
        cmd_upload_results(Path(args.source).resolve())


if __name__ == "__main__":
    main()
