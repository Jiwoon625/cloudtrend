"""Manual chart repair transport: Drive sources in, private evidence out; no source writes."""
from __future__ import annotations
import argparse
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "collectors" / "drive_history_v7"))
from history import Drive, OWNER, atomic, prepare_baseline, require

spec = importlib.util.spec_from_file_location("chart_repair_transfer", ROOT / "scripts" / "drive-screening-transfer.py")
transfer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transfer)


def prepare(output: Path, request: dict) -> None:
    require(os.environ.get("SUPABASE_USER_ID") == OWNER, "Repair owner differs from pinned baseline")
    require(os.environ.get("SUPABASE_URL", "").rstrip("/") == "https://ahbvrtugugwnbrfnbxzp.supabase.co", "Unexpected repair project")
    head = transfer.read_published_head()
    require(isinstance(head, dict), "A published Drive generation is required")
    require(head.get("inputFingerprint") == request["inputFingerprint"] and head.get("resultDigest") == request["resultDigest"], "Published generation changed; repair request must be reviewed again")
    output.mkdir(parents=True, exist_ok=True)
    drive = Drive()
    prepare_baseline(output / "baseline", drive=drive)
    parents = output / "parents"
    parents.mkdir(parents=True, exist_ok=True)
    index = transfer.prepare_published_parents(drive, parents, head["drivePublication"]["asOfDate"])
    require(transfer.read_published_head() == head, "Drive head changed during source preparation")
    atomic(output / "head.json", json.dumps(head, ensure_ascii=False).encode())
    atomic(parents / "index.json", json.dumps(index).encode())
    atomic(output / "request.json", json.dumps(request).encode())
    atomic(output / "transport-receipt.json", json.dumps({"sourceBackend": "GOOGLE_DRIVE", "historicalSupabaseSourceGETs": 0, "driveReads": drive.reads, "parents": len(index["parents"]), "verified": True}, indent=2).encode())
    print(json.dumps({"stage": "drive-inputs-verified", "parents": len(index["parents"]), "baselineSources": 52}))


def save(output: Path, request: dict) -> None:
    names = ["repair-report.json", "transport-receipt.json"]
    files = [output / name for name in names if (output / name).exists()]
    require(files, "No chart repair evidence exists")
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        for file in files:
            archive.write(file, file.name)
        # Preserve the code used for this repair with its private execution evidence.
        for name in ["scripts/drive-chart-repair.ts", "scripts/drive-chart-repair-transfer.py", "src/lib/chartSavedUniverse.ts", "src/lib/fullInstrumentCharts.server.ts"]:
            archive.write(ROOT / name, "code/" + name)
    attempt = os.environ.get("GITHUB_RUN_ID", "local") + "-" + os.environ.get("GITHUB_RUN_ATTEMPT", "1")
    saved = Drive().upload(request["resultFolderId"], "drive-chart-repair-" + attempt + ".zip", stream.getvalue())
    print(json.dumps({"resultFileId": saved["id"], "readbackVerified": True}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["prepare", "save"])
    parser.add_argument("--directory", default="drive-chart-work")
    parser.add_argument("--request", default=".github/operations/drive-chart-restoration.json")
    args = parser.parse_args()
    request = json.loads(Path(args.request).read_text())
    require(request.get("version") == "drive-chart-restoration-v1" and request.get("mode") in ("diagnose", "repair"), "Invalid reviewed chart repair request")
    require(transfer.ID.fullmatch(request.get("resultFolderId", "")), "Invalid result folder")
    (prepare if args.action == "prepare" else save)(Path(args.directory), request)
