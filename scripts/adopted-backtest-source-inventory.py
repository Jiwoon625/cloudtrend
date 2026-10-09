"""Read existing private research inputs; never change CM inputs or disclose rows."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import tarfile
import tempfile
from urllib.parse import quote

import pyarrow.parquet as pq
import requests


def main():
    url = os.environ["SUPABASE_URL"].rstrip("/")
    uid = os.environ["SUPABASE_USER_ID"]
    if not re.fullmatch(r"https://[a-z0-9]+\.supabase\.co", url):
        raise ValueError("Unexpected storage service")
    if not re.fullmatch(r"[0-9a-f-]{36}", uid):
        raise ValueError("Invalid owner")
    session = requests.Session()
    session.headers.update({"apikey": os.environ["SUPABASE_SERVICE_ROLE_KEY"],
                            "Authorization": "Bearer " + os.environ["SUPABASE_SERVICE_ROLE_KEY"]})
    bucket = "cloudtrend-data"

    def get(key):
        if not key.startswith(uid + "/research/") or ".." in PurePosixPath(key).parts:
            raise ValueError("Source outside private owner research")
        response = session.get(url + "/storage/v1/object/authenticated/" + bucket + "/" + quote(key, safe="/._-="),
                               timeout=(20, 300), allow_redirects=False)
        if response.status_code != 200:
            raise RuntimeError(f"Private source read failed: HTTP {response.status_code}")
        return response.content

    response = session.get(url + "/storage/v1/bucket/" + bucket, timeout=30, allow_redirects=False)
    if response.status_code != 200 or response.json().get("public") is not False:
        raise RuntimeError("Private bucket verification failed")
    manifest_bytes = get(uid + "/research/cm/manifest.json")
    manifest = json.loads(manifest_bytes)
    outputs = manifest.get("outputs")
    if not isinstance(outputs, list):
        raise ValueError("Missing CM restored-source inventory")
    data_files = [item for item in outputs if item["relative_path"].endswith((".parquet", ".csv"))]
    selected = [item for item in data_files if any(
        target in item["relative_path"] for target in (
            "normalized_bars.parquet", "normalized_engine_input.parquet", "normalized_features_pre_gap.parquet",
            "normalized_features_post_gap.parquet", "cloudtrend_etf_research", "clean-input-panel.parquet",
            "/E/2026-09.parquet", "/K/2026-09.parquet", "/U/2026-09.parquet"))]
    sources = {item["storage_key"]: item for item in manifest.get("sources", [])}
    checked = []
    with tempfile.TemporaryDirectory(prefix="adopted-source-inventory-") as temp:
        for storage_key in sorted({item["storage_key"] for item in selected}):
            archive_record = sources.get(storage_key)
            if not archive_record:
                raise ValueError("Selected archive is not pinned by manifest")
            raw = get(storage_key)
            if len(raw) != archive_record["size"] or hashlib.sha256(raw).hexdigest() != archive_record["sha256"]:
                raise ValueError("Archive digest mismatch")
            archive_path = Path(temp) / "source.tar"
            archive_path.write_bytes(raw)
            del raw
            with tarfile.open(archive_path, "r:") as archive:
                for record in [item for item in selected if item["storage_key"] == storage_key]:
                    member = archive.getmember(record["relative_path"])
                    if not member.isfile() or member.size != record["size"]:
                        raise ValueError("Invalid selected data member")
                    target = Path(temp) / "selected.parquet"
                    digest = hashlib.sha256()
                    with archive.extractfile(member) as source, target.open("wb") as destination:
                        for chunk in iter(lambda: source.read(1024 * 1024), b""):
                            digest.update(chunk)
                            destination.write(chunk)
                    if digest.hexdigest() != record["sha256"]:
                        raise ValueError("Selected data digest mismatch")
                    parquet = pq.ParquetFile(target)
                    checked.append({"relative_path": record["relative_path"], "bytes": record["size"],
                                    "sha256": record["sha256"], "rows": parquet.metadata.num_rows,
                                    "columns": parquet.schema_arrow.names})
                    target.unlink()
            archive_path.unlink()
    report = {"version": "adopted-source-inventory-v1", "cmInputsModified": False,
              "manifestHash": hashlib.sha256(manifest_bytes).hexdigest(), "dataFiles": data_files,
              "checkedParquetSchemas": checked}
    run_id = os.environ.get("GITHUB_RUN_ID", "local")
    attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "1")
    key = f"{uid}/research/adopted-full-period/source-inventory/{run_id}-{attempt}.json"
    response = session.post(url + "/storage/v1/object/" + bucket + "/" + quote(key, safe="/._-"),
                            data=json.dumps(report).encode(), headers={"Content-Type": "application/json", "x-upsert": "false"},
                            timeout=(20, 90), allow_redirects=False)
    if response.status_code not in (200, 201):
        raise RuntimeError(f"Private inventory save failed: HTTP {response.status_code}")
    if json.loads(get(key)) != report:
        raise RuntimeError("Private inventory readback mismatch")
    # Schemas/counts only. No credentials, signed URLs, price rows, positions, or NAV.
    print(json.dumps({"status": "COMPLETE", "dataFileCount": len(data_files),
                      "dataGroups": sorted({str(PurePosixPath(item["relative_path"]).parent) for item in data_files}),
                      "checkedParquetSchemas": checked, "privateReportRun": run_id + "-" + attempt}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Network exceptions may contain URLs. Only a safe type reaches Actions logs.
        print("Source inventory failed:", type(error).__name__)
        raise SystemExit(1)
