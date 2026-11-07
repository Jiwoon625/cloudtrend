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
import stat
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import uuid

MAX_FILE = 45 * 1024 * 1024
MAX_ARCHIVE = 80 * 1024 * 1024
MAX_EXPANDED = 256 * 1024 * 1024
ID = re.compile(r"^[A-Za-z0-9_-]{10,200}$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
V7_BASELINE_SHA = "d0cb8477ca6f94a5ebbcbd8e79928635222e46f20e116fafb902c7763e0bfe92"
MAX_MANIFEST = 1024 * 1024
MAX_HEAD = 8 * 1024 * 1024
MAX_PARENT_SOURCES = 64
MAX_PARENT_BYTES = 512 * 1024 * 1024
MAX_DELTA_EXPANDED = 128 * 1024 * 1024


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



def flat_csv_name(name):
    require(isinstance(name, str) and name.endswith(".csv") and
            PurePosixPath(name).name == name and "\\" not in name and "\0" not in name,
            "Delta must contain flat CSV only")
    return name


def v7_manifest(raw_manifest):
    """Read the original collector proof without adding or rewriting a CSV inventory."""
    require(len(raw_manifest) <= MAX_MANIFEST, "Run manifest exceeds size limit")
    m = json.loads(raw_manifest)
    require(isinstance(m, dict) and m.get("version") == "drive-history-collector-v7.0-preview" and
            m.get("complete") is True, "Run incomplete or unsupported")
    require(m.get("history_backend") == "drive" and m.get("baselineSha256") == V7_BASELINE_SHA and
            m.get("parentManifestSha256") == V7_BASELINE_SHA, "Unsupported history parent")
    require(m.get("missingSymbols") == [] and m.get("missingIndexSymbols") == [] and
            m.get("missingSymbolCount") == 0 and m.get("correctionCount") == 0,
            "Unresolved coverage/corrections")
    files = m.get("files")
    require(isinstance(files, list) and len(files) == 1 and isinstance(files[0], dict) and
            files[0].get("name") == "delta.zip", "Expected one delta package")
    descriptor = files[0]
    require(isinstance(descriptor.get("sha256"), str) and
            SHA256.fullmatch(descriptor["sha256"].removeprefix("sha256:")) and
            type(descriptor.get("bytes")) is int and 0 < descriptor["bytes"] <= MAX_ARCHIVE,
            "Invalid delta archive descriptor")
    entries = m.get("deltaMembers")
    require(isinstance(entries, list) and 0 < len(entries) <= 2000, "No/too many delta parts")
    seen = set()
    for entry in entries:
        require(isinstance(entry, dict), "Invalid delta member descriptor")
        name = flat_csv_name(entry.get("name"))
        require(name not in seen, "Duplicate delta part")
        seen.add(name)
        require(isinstance(entry.get("sha256"), str) and
                SHA256.fullmatch(entry["sha256"].removeprefix("sha256:")) and
                type(entry.get("bytes")) is int and 0 < entry["bytes"] <= MAX_FILE,
                "Invalid delta member hash/size")
    require(sum(entry["bytes"] for entry in entries) <= MAX_DELTA_EXPANDED,
            "Delta expansion limit exceeded")
    return m


def inspect_v7_archive(data, raw_manifest):
    m = v7_manifest(raw_manifest)
    descriptor = m["files"][0]
    require(len(data) == descriptor["bytes"] and
            hashlib.sha256(data).hexdigest() == descriptor["sha256"].removeprefix("sha256:"),
            "Delta archive hash/size mismatch")
    expected = {entry["name"]: entry for entry in m["deltaMembers"]}
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        infos = z.infolist()
        names = [info.filename for info in infos]
        require(len(names) == len(set(names)) and set(names) == set(expected),
                "Delta package inventory mismatch")
        require(sum(info.file_size for info in infos) <= MAX_DELTA_EXPANDED,
                "Delta expansion limit exceeded")
        by_name = {info.filename: info for info in infos}
        parts = []
        # Manifest order is authoritative even if ZIP member order is different.
        for name, entry in expected.items():
            info = by_name[name]
            flat_csv_name(info.filename)
            require(not stat.S_ISLNK(info.external_attr >> 16) and not info.is_dir() and
                    info.file_size == entry["bytes"] and info.file_size <= MAX_FILE,
                    "Unsafe delta member")
            raw = z.read(info)  # ZIP CRC is checked before SHA256.
            digest = hashlib.sha256(raw).hexdigest()
            require(len(raw) == entry["bytes"] and digest == entry["sha256"].removeprefix("sha256:"),
                    "Delta CSV hash/size mismatch")
            parts.append({"name": name, "bytes": raw, "sha256": digest})
    return m, raw_manifest, parts


def validate_group_manifest(manifest, run_id=None):
    identifier = manifest.get("runId")
    require(isinstance(identifier, str) and re.fullmatch(r"[A-Za-z0-9_-]{8,128}", identifier) and
            (run_id is None or identifier == run_id), "Invalid/mismatched collector run ID")
    date = manifest.get("actualLatestPriceDate")
    require(isinstance(date, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", date) and
            date == manifest.get("cutoffDateInclusive"), "Invalid collector session")
    require(manifest.get("mode") == "SCREENING" and
            manifest.get("krxPublicationEvidence", {}).get("phase") in ("PRELIMINARY", "FINAL"),
            "Missing publication evidence")
    return date


def write_prepared_group(output, raw_manifest, parts, *, run_id, archive_id, archive_sha,
                         mode="drive", layout=None):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    (output / "collector-manifest.json").write_bytes(raw_manifest)
    for part in parts:
        flat_csv_name(part["name"])
        (output / part["name"]).write_bytes(part["bytes"])
    spec = {"version": "drive-screening-input-v1", "runId": run_id, "mode": mode,
            "archiveFileId": archive_id, "archiveSha256": archive_sha,
            "manifestSha256": hashlib.sha256(raw_manifest).hexdigest(),
            "parts": [{"path": part["name"], "sha256": part["sha256"]} for part in parts]}
    if layout:
        spec["layout"] = layout
    return spec


def read_published_head():
    """The sole Supabase read is a bounded, cache-busted result metadata object."""
    base = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    owner = os.environ.get("SUPABASE_USER_ID", "")
    require(base.startswith("https://") and re.fullmatch(r"[a-f0-9-]{36}", owner) and key,
            "Missing server publication configuration")
    request = urllib.request.Request(
        base + "/storage/v1/object/cloudtrend-data/" + owner +
        "/results/drive-screening/input-head/latest.json?cacheNonce=" + str(uuid.uuid4()),
        headers={"Authorization": "Bearer " + key, "apikey": key, "cache-control": "no-cache"})
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            raw = response.read(MAX_HEAD + 1)
        require(len(raw) <= MAX_HEAD, "Drive history metadata exceeds limit")
        head = json.loads(raw)
        require(isinstance(head, dict), "Invalid Drive history checkpoint")
        return head
    except urllib.error.HTTPError as error:
        try:
            missing = json.loads(error.read(MAX_HEAD + 1))
        except (ValueError, TypeError):
            missing = {}
        if error.code == 404 or (error.code == 400 and isinstance(missing, dict) and
                str(missing.get("error", "")).lower() in ("not_found", "object not found")):
            return None
        raise RuntimeError(f"Drive history checkpoint read failed ({error.code})") from None


def prepare_published_parents(drive, output, as_of_date):
    """Retain ordered published legacy Drive groups without source writes."""
    head = read_published_head()
    prepared = {"parents": [], "expectedHeadHash": hashlib.sha256(json.dumps(
        head, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        if head is not None else None}
    if head is None:
        return prepared
    require(head.get("version") == "drive-input-head-v1", "Unknown Drive history checkpoint")
    evidence = head.get("drivePublication", {})
    require(isinstance(evidence, dict) and evidence.get("version") == "drive-result-publication-v1" and
            isinstance(evidence.get("asOfDate"), str) and
            re.fullmatch(r"\d{4}-\d{2}-\d{2}", evidence["asOfDate"]) and
            evidence["asOfDate"] <= as_of_date, "Selected run is older than published Drive history")
    entries = evidence.get("sources")
    require(isinstance(entries, list) and 0 < len(entries) <= MAX_PARENT_SOURCES,
            "Invalid Drive history source count")
    groups, archives, source_ids = [], set(), set()
    for entry in entries:
        require(isinstance(entry, dict), "Invalid historical source")
        archive_id = entry.get("archiveFileId", "")
        require(isinstance(archive_id, str) and ID.fullmatch(archive_id), "Invalid historical Drive archive ID")
        require(isinstance(entry.get("archiveSha256"), str) and SHA256.fullmatch(entry["archiveSha256"]),
                "Invalid historical Drive archive hash")
        require(entry.get("layout") is None, "Unsupported historical Drive layout")
        record = entry.get("record", {})
        require(isinstance(record, dict), "Invalid historical source record")
        source_id = record.get("id")
        if source_id is not None:
            require(isinstance(source_id, str) and source_id not in source_ids,
                    "Duplicate historical source ID")
            source_ids.add(source_id)
        if not groups or groups[-1][0]["archiveFileId"] != archive_id:
            require(archive_id not in archives, "Interleaved historical Drive archive groups")
            groups.append([])
            archives.add(archive_id)
        groups[-1].append(entry)
    compressed = expanded = 0
    for entries in groups:
        entry = entries[0]
        archive_id, archive_sha = entry["archiveFileId"], entry["archiveSha256"]
        proofs = []
        for source in entries:
            require(source["archiveSha256"] == archive_sha,
                    "Conflicting historical archive descriptors")
            proof = source["record"].get("validation_result", {}).get("krPublication")
            require(isinstance(proof, dict) and isinstance(proof.get("requestId"), str) and
                    isinstance(proof.get("manifestSha256"), str) and
                    re.fullmatch(r"sha256:[a-f0-9]{64}", proof["manifestSha256"]),
                    "Invalid historical publication proof")
            proofs.append(proof)
        publication = proofs[0]
        require(all(p["requestId"] == publication["requestId"] and
                    p["manifestSha256"] == publication["manifestSha256"] for p in proofs),
                "Conflicting historical manifest proofs")
        data = drive.download(archive_id)
        compressed += len(data)
        require(len(data) <= MAX_ARCHIVE and compressed <= MAX_PARENT_BYTES,
                "Historical Drive archive byte limit exceeded")
        require(hashlib.sha256(data).hexdigest() == archive_sha, "Historical Drive archive hash mismatch")
        manifest, raw_manifest, parts = inspect_archive(data, publication["requestId"])
        require("sha256:" + hashlib.sha256(raw_manifest).hexdigest() == publication["manifestSha256"],
                "Historical manifest mismatch")
        require(validate_group_manifest(manifest, publication["requestId"]) <= as_of_date,
                "Historical manifest is newer than selected run")
        require(all("manifestText" not in p or p["manifestText"].encode("utf-8") == raw_manifest
                    for p in proofs), "Conflicting historical manifest text")
        expanded += sum(len(part["bytes"]) for part in parts)
        require(expanded <= MAX_PARENT_BYTES, "Historical Drive expansion limit exceeded")
        names = [source.get("csvFile") for source in entries]
        # Legacy metadata without per-part descriptors retains the archive manifest order.
        if any(name is not None for name in names):
            require(all(isinstance(name, str) for name in names) and len(set(names)) == len(names) and
                    set(names) == {part["name"] for part in parts},
                    "Historical CSV inventory mismatch")
            by_name = {part["name"]: part for part in parts}
            parts = [by_name[name] for name in names]
            for source, part in zip(entries, parts):
                record = source["record"]
                require(record.get("file_hash") == "sha256:" + part["sha256"] and
                        record.get("file_size_bytes") == len(part["bytes"]) and
                        record.get("storage_bucket") == "google-drive" and
                        record.get("storage_path") == f"drive://{archive_id}/kr-outputs/{part['name']}",
                        "Historical CSV source binding mismatch")
        directory = "parent-" + str(len(prepared["parents"])).zfill(3)
        parent = Path(output) / directory
        spec = write_prepared_group(parent, raw_manifest, parts, run_id=publication["requestId"],
                                    archive_id=archive_id, archive_sha=archive_sha)
        (parent / "input.json").write_text(json.dumps(spec, ensure_ascii=False, indent=2))
        prepared["parents"].append(directory)
    return prepared


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
        prepared.update(prepare_published_parents(drive, output, manifest["actualLatestPriceDate"]))
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
