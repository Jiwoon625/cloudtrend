"""Drive transport for the separate screening executor; never loads collector code/pickle."""
from __future__ import annotations
import argparse
import csv
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import uuid

MAX_FILE = 45 * 1024 * 1024
MAX_ARCHIVE = 80 * 1024 * 1024
MAX_EXPANDED = 256 * 1024 * 1024
ID = re.compile(r"^[A-Za-z0-9_-]{10,200}$")


def require(ok, message):
    if not ok:
        raise ValueError(message)


def get_token():
    # The Colab launcher refreshes this short-lived secret on every execution.
    credentials = os.environ.get("GOOGLE_DRIVE_CREDENTIALS_JSON")
    if credentials:
        c = json.loads(credentials)
        require(c.get("type") == "authorized_user", "Use authorized_user Google OAuth credentials")
        body = urllib.parse.urlencode({"client_id": c["client_id"], "client_secret": c["client_secret"],
                                      "refresh_token": c["refresh_token"], "grant_type": "refresh_token"}).encode()
        request = urllib.request.Request("https://oauth2.googleapis.com/token", data=body)
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)["access_token"]
    token = os.environ.get("GOOGLE_DRIVE_ACCESS_TOKEN", "")
    require(token, "Google 인증이 없습니다. Colab 실행기를 실행해 주세요.")
    return token


class Drive:
    def __init__(self, token):
        self.token = token

    def call(self, path, *, query=None, data=None, method=None, content_type=None, upload=False, limit=MAX_ARCHIVE):
        base = "https://www.googleapis.com/" + ("upload/drive/v3/" if upload else "drive/v3/")
        url = base + path + ("?" + urllib.parse.urlencode(query) if query else "")
        headers = {"Authorization": "Bearer " + self.token}
        if content_type:
            headers["Content-Type"] = content_type
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                result = response.read(limit + 1)
                require(len(result) <= limit, "Drive response exceeds size limit")
                return result
        except urllib.error.HTTPError as error:
            body = ""
            try:
                body = error.read().decode("utf-8", errors="replace")
            except Exception:
                pass
            raise RuntimeError(f"Drive 요청 실패 ({error.code}): {body}") from None

    def children(self, folder_id):
        require(ID.fullmatch(folder_id), "Invalid Drive folder ID")
        found, token = [], None
        while True:
            query = {"q": f"'{folder_id}' in parents and trashed=false", "pageSize": 100,
                     "fields": "files(id,name,mimeType,md5Checksum),nextPageToken", "supportsAllDrives": "true",
                     "includeItemsFromAllDrives": "true"}
            if token:
                query["pageToken"] = token
            page = json.loads(self.call("files", query=query))
            found.extend(page.get("files", []))
            token = page.get("nextPageToken")
            if not token:
                return found

    def download(self, file_id):
        require(ID.fullmatch(file_id), "Invalid Drive file ID")
        return self.call("files/" + file_id, query={"alt": "media", "supportsAllDrives": "true"})

    def upload(self, parent, name, data, mime="application/octet-stream"):
        require(ID.fullmatch(parent), "Invalid Drive folder ID")
        boundary = "cloudtrend_" + hashlib.sha256(data).hexdigest()
        meta = json.dumps({"name": name, "parents": [parent]}, ensure_ascii=False).encode()
        body = (f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n".encode() + meta +
                f"\r\n--{boundary}\r\nContent-Type: {mime}\r\n\r\n".encode() + data +
                f"\r\n--{boundary}--\r\n".encode())
        return json.loads(self.call("files", query={"uploadType": "multipart", "fields": "id,name,webViewLink", "supportsAllDrives": "true"},
                                    data=body, content_type=f"multipart/related; boundary={boundary}", upload=True))


def archive_files(data):
    """Reject traversal, duplicate names, symlinks and bombs; don't execute/unpickle anything."""
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        infos = z.infolist()
        require(len(infos) <= 500, "Too many files in kr-outputs archive")
        require(sum(i.file_size for i in infos) <= MAX_EXPANDED, "ZIP expanded size exceeds limit")
        names, result = set(), {}
        for info in infos:
            p = PurePosixPath(info.filename)
            require(not p.is_absolute() and ".." not in p.parts and "\\" not in info.filename, "Unsafe ZIP path")
            require(info.filename not in names, "Duplicate ZIP path")
            require((info.external_attr >> 16) & 0o170000 != 0o120000, "ZIP symlink is not allowed")
            names.add(info.filename)
            if not info.is_dir():
                require(info.file_size <= MAX_FILE, "ZIP member exceeds 45 MB")
                result[info.filename] = z.read(info)  # zipfile checks CRC
        return result


def inspect_archive(data, run_id):
    files = archive_files(data)
    manifests = [(name, value) for name, value in files.items()
                 if PurePosixPath(name).name.startswith("collection_manifest") and name.endswith(".json")]
    require(len(manifests) == 1, "Expected exactly one collection manifest")
    manifest_name, manifest_bytes = manifests[0]
    m = json.loads(manifest_bytes)
    require(m.get("runId") == run_id, "Run ID differs from collector manifest")
    require(m.get("mode") == "SCREENING" and m.get("complete") is True, "Collection is incomplete")
    require(m.get("missingSymbolCount") == 0 and m.get("missingSymbols") == [] and m.get("missingIndexSymbols") == [], "Collection has missing symbols/indexes")
    date = m.get("actualLatestPriceDate")
    require(isinstance(date, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", date) and date == m.get("cutoffDateInclusive"), "Invalid collector session")
    phase = m.get("krxPublicationEvidence", {}).get("phase")
    require(phase in ("PRELIMINARY", "FINAL"), "Missing publication evidence")
    entries = m.get("csv")
    require(isinstance(entries, list) and 0 < len(entries) <= 50, "No manifest-bound input CSV")
    parts, keys, symbols, indices = [], set(), set(), set()
    directory = PurePosixPath(manifest_name).parent
    for entry in entries:
        name = entry["file"]
        require(PurePosixPath(name).name == name and name.endswith(".csv"), "Invalid CSV name")
        raw = files.get(str(directory / name))
        require(raw is not None, "Manifest input CSV is missing")
        digest = hashlib.sha256(raw).hexdigest()
        require(entry["sha256"].removeprefix("sha256:") == digest and entry["bytes"] == len(raw), "Input CSV hash/size mismatch")
        latest = ""
        for row in csv.DictReader(io.StringIO(raw.decode("utf-8-sig"))):
            require(row["date"] <= date, "Input includes a future session")
            key = (row["symbol"], row["date"])
            require(key not in keys, "Duplicate symbol/session across input parts")
            keys.add(key)
            latest = max(latest, row["date"])
            if row["date"] == date and float(row.get("close") or 0) > 0:
                if row.get("securityType", row.get("type")) in ("STOCK", "ETF"):
                    symbols.add(row["symbol"])
                else:
                    indices.add(row["symbol"])
        require(latest == date, "CSV part does not reach manifest session")
        parts.append({"name": name, "bytes": raw, "sha256": digest})
    require(len(keys) == m.get("rowCount"), "Manifest row count mismatch")
    expected = set(m.get("requestedSymbols", []))
    require(expected and symbols == expected, "Latest-session price coverage differs from manifest universe")
    require({"KOSPI", "KOSDAQ"} <= indices, "Latest-session market indexes are missing")
    return m, manifest_bytes, parts


def prepare(drive, folder, run_id, output, mode):
    children = drive.children(folder)
    archives = [f for f in children if f["name"] == "kr-outputs.zip"]
    require(len(archives) == 1, "Expected one kr-outputs.zip in the selected run folder")
    archive = drive.download(archives[0]["id"])
    manifest, raw_manifest, parts = inspect_archive(archive, run_id)
    output.mkdir(parents=True, exist_ok=True)
    (output / "collector-manifest.json").write_bytes(raw_manifest)
    descriptors = []
    for part in parts:
        (output / part["name"]).write_bytes(part["bytes"])
        descriptor = {"path": part["name"], "sha256": part["sha256"]}
        descriptor["driveSource"] = {"archiveFileId": archives[0]["id"], "folderId": folder,
                                     "member": "kr-outputs/" + part["name"]}
        descriptors.append(descriptor)
    prepared = {"version": "drive-screening-input-v1", "runId": run_id, "mode": mode, "folderId": folder,
                "archiveFileId": archives[0]["id"], "archiveSha256": hashlib.sha256(archive).hexdigest(),
                "manifestSha256": hashlib.sha256(raw_manifest).hexdigest(), "parts": descriptors}
    if mode == "publish":
        prepared["parents"] = []
        base = os.environ.get("SUPABASE_URL", "").rstrip("/")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
        owner = os.environ.get("SUPABASE_USER_ID", "")
        require(base.startswith("https://") and re.fullmatch(r"[a-f0-9-]{36}", owner) and key, "Missing server publication configuration")
        request = urllib.request.Request(base + "/storage/v1/object/cloudtrend-data/" + owner + "/results/drive-screening/input-head/latest.json?cacheNonce=" + str(uuid.uuid4()),
            headers={"Authorization":"Bearer "+key,"apikey":key,"cache-control":"no-cache"})
        try:
            with urllib.request.urlopen(request,timeout=90) as response:
                raw = response.read(8*1024*1024+1)
            require(len(raw)<=8*1024*1024,"Drive history metadata exceeds limit")
            head = json.loads(raw)
        except urllib.error.HTTPError as error:
            try: missing = json.loads(error.read())
            except Exception: missing = {}
            if error.code == 404 or (error.code == 400 and str(missing.get("error", "")).lower() in ("not_found", "object not found")):
                head = None
            else: raise RuntimeError(f"Drive history checkpoint read failed ({error.code})") from None
        prepared["expectedHeadHash"] = hashlib.sha256(json.dumps(head,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()).hexdigest() if head else None
        if head:
            require(head.get("version")=="drive-input-head-v1", "Unknown Drive history checkpoint")
            evidence = head.get("drivePublication", {})
            require(evidence.get("version")=="drive-result-publication-v1" and evidence.get("asOfDate", "")<=manifest["actualLatestPriceDate"], "Selected run is older than published Drive history")
            entries=evidence.get("sources")
            require(isinstance(entries,list) and 0<len(entries)<=64,"Invalid Drive history source count")
            seen=set()
            for entry in entries:
                archive_id=entry.get("archiveFileId", "")
                require(ID.fullmatch(archive_id),"Invalid historical Drive archive ID")
                if archive_id in seen: continue
                seen.add(archive_id)
                data=drive.download(archive_id)
                require(hashlib.sha256(data).hexdigest()==entry.get("archiveSha256"),"Historical Drive archive hash mismatch")
                publication=entry["record"]["validation_result"]["krPublication"]
                old_manifest, old_raw, old_parts=inspect_archive(data,publication["requestId"])
                require("sha256:"+hashlib.sha256(old_raw).hexdigest()==publication["manifestSha256"],"Historical manifest mismatch")
                directory="parent-"+str(len(prepared["parents"])).zfill(3)
                parent=output/directory;parent.mkdir(exist_ok=True)
                (parent/"collector-manifest.json").write_bytes(old_raw)
                for part in old_parts:(parent/part["name"]).write_bytes(part["bytes"])
                old_spec={"version":"drive-screening-input-v1","runId":publication["requestId"],"mode":"drive",
                    "archiveFileId":archive_id,"archiveSha256":entry["archiveSha256"],
                    "manifestSha256":hashlib.sha256(old_raw).hexdigest(),
                    "parts":[{"path":part["name"],"sha256":part["sha256"]} for part in old_parts]}
                (parent/"input.json").write_text(json.dumps(old_spec,ensure_ascii=False,indent=2))
                prepared["parents"].append(directory)
    (output / "input.json").write_text(json.dumps(prepared, ensure_ascii=False, indent=2))
    return {"runId": run_id, "phase": manifest["krxPublicationEvidence"]["phase"], "symbols": len(manifest["requestedSymbols"]), "parts": len(parts)}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("action", choices=["prepare", "save"])
    p.add_argument("--folder", required=True)
    p.add_argument("--run-id", required=True)
    p.add_argument("--directory", default="drive-screening")
    p.add_argument("--mode", choices=["drive", "supabase", "publish"], default="drive")
    args = p.parse_args()
    require(ID.fullmatch(args.folder), "Invalid folder ID")
    require(re.fullmatch(r"[A-Za-z0-9_-]{8,128}", args.run_id), "Invalid run ID")
    token = get_token()
    # Export refreshed access token for Node without writing it into run artifacts.
    if os.environ.get("GITHUB_ENV"):
        require("\n" not in token and "\r" not in token, "Invalid access token")
        print("::add-mask::" + token)
        with open(os.environ["GITHUB_ENV"], "a") as f:
            f.write("GOOGLE_DRIVE_ACCESS_TOKEN=" + token + "\n")
    drive, output = Drive(token), Path(args.directory)
    if args.action == "prepare":
        print(json.dumps(prepare(drive, args.folder, args.run_id, output, args.mode), ensure_ascii=False))
    else:
        # Keep logs, source bytes and credentials out of the result bundle.
        paths = [p for p in output.rglob("*.json") if p.name in ("execution-receipt.json", "screening-summary.json", "screening-bundle.json")]
        require(paths, "No execution result was produced")
        bundle = io.BytesIO()
        with zipfile.ZipFile(bundle, "w", compression=zipfile.ZIP_DEFLATED) as z:
            for path in paths:
                z.write(path, str(path.relative_to(output)))
                if path.name == "screening-bundle.json":
                    bundle_json = json.loads(path.read_text())
                    rows = bundle_json.get("result", {}).get("rows", [])
                    sheet = io.StringIO()
                    writer = csv.writer(sheet)
                    writer.writerow(["기준일", "종목코드", "종목명", "시장", "유형", "종가", "총점", "기술점수", "등급", "판정"])
                    for row in rows:
                        instrument = row.get("instrument", {})
                        writer.writerow([bundle_json["data"]["asOfDate"], instrument.get("symbol"), instrument.get("name"),
                                         instrument.get("market"), instrument.get("instrumentType"), row.get("snapshot", {}).get("close"),
                                         row.get("totalScoreNormalized"), row.get("technical", {}).get("points"),
                                         row.get("grade"), row.get("actionLabelText")])
                    z.writestr(str(path.relative_to(output).with_name("screening-rows.csv")), sheet.getvalue().encode("utf-8-sig"))
        attempt = os.environ.get("GITHUB_RUN_ID", "local") + "-" + os.environ.get("GITHUB_RUN_ATTEMPT", "1")
        saved = drive.upload(args.folder, f"screening-results-{args.run_id}-{attempt}.zip", bundle.getvalue(), "application/zip")
        require(hashlib.sha256(drive.download(saved["id"])).digest() == hashlib.sha256(bundle.getvalue()).digest(), "Result readback mismatch")
        print(json.dumps({"resultFileId": saved["id"], "verified": True}))


if __name__ == "__main__":
    main()
