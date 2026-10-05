"""Hash-pinned, data-only restoration of the 26 original CM input objects.

No caller-authored manifest, Drive access, code extraction, or unbounded in-memory
archive reads. The stage JSONs are the reviewed authoritative archive/member
index; their exact bytes are pinned before any entry can influence filesystem IO.
"""
from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
from pathlib import Path, PureWindowsPath
import re
import shutil
import stat
import tarfile
import tempfile
import uuid
import zipfile

BLOCK = 1024 * 1024
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
FROZEN_STAGES = (
    {"stage": "CloseadjInputsV2", "sha256": "cf9a7734c8411ec656575a3a5491c4b8a7d1741d650a0814211d339cb51e6096",
     "fingerprint": "c6983d4057d8b73175aa4e52dbf65eb2d4decbbddef96a1228aa6ba5faf9d885", "count": 389, "archives": 23},
    {"stage": "Stage2_reference_time", "sha256": "5ffb9c2c8c7ff280d68d4abaea26917287f813f7c191373c90211b99e1f53f73",
     "fingerprint": "bc6b8ab27125fccce810e1edc2558fce8455163d575722772483ed14855b67cf", "count": 12, "archives": 1},
)
EVIDENCE_NAME = "CM06_runtime_private_evidence_20261005.zip"
EVIDENCE_SHA256 = "b3b28b08ef4be32c07c1f50c3e37a35daa5ce3b656b5027931888fe2c891a100"
EVIDENCE_SIZE = 25691367
REFERENCE_ROOT = "outputs/colab_stage2_v1/reference_time/"
REFERENCE_PATHS = frozenset(REFERENCE_ROOT + p for p in (
    ".stage2_complete.json", "data/fx/ecb/usdkrw_release_proxy.csv",
    "data/fx/h10_all_publication_observations.csv", "data/reference_time/E_calendar.json",
    "data/reference_time/K_calendar.json", "data/reference_time/U_calendar.json",
    "data/reference_time/ecb_conservative_proxy_events.csv", "data/reference_time/h10_conservative_events.csv",
    "data/reference_time/h10_scheduled_events.csv", "data/reference_time/manifest.json",
    "data/us/spy_prepared_verified.parquet", "verification.json",
))


class IngestionError(RuntimeError):
    pass


class LocalConflict(IngestionError):
    pass


def _record(value):
    if (not isinstance(value, dict) or type(value.get("size")) is not int or value["size"] < 0 or
            not isinstance(value.get("sha256"), str) or SHA256.fullmatch(value["sha256"]) is None):
        raise IngestionError("Invalid size/SHA256 record")
    return {"size": value["size"], "sha256": value["sha256"]}


def safe(root, relative):
    if (not isinstance(relative, str) or not relative or "\\" in relative or
            PureWindowsPath(relative).drive or any(ord(c) < 32 or ord(c) == 127 for c in relative) or
            any(x in ("", ".", "..") for x in relative.split("/")) or Path(relative).is_absolute()):
        raise IngestionError("Unsafe relative path")
    root = Path(root)
    for p in (root, *root.parents):
        if p.is_symlink():
            raise IngestionError("Symlink root is not accepted")
    node = root
    for part in relative.split("/"):
        node /= part
        if node.is_symlink():
            raise IngestionError("Symlink input path is not accepted")
    return node


@contextlib.contextmanager
def parent_fd(path, create=False):
    """Descriptor-relative directory walk resists concurrent symlink swaps."""
    path = Path(path).absolute()
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parent.parts[1:]:
            if part in (".", ".."):
                raise IngestionError("Unsafe directory component")
            try:
                next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    raise
                try:
                    os.mkdir(part, mode=0o700, dir_fd=fd)
                except FileExistsError:
                    pass
                next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        yield fd, path.name
    finally:
        os.close(fd)


def stream_hashes(stream):
    digest = hashlib.sha256()
    size = 0
    for chunk in iter(lambda: stream.read(BLOCK), b""):
        digest.update(chunk)
        size += len(chunk)
    return {"size": size, "sha256": digest.hexdigest()}


def hashes(path):
    with parent_fd(path) as (fd, name):
        source = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        with os.fdopen(source, "rb") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise IngestionError("Only regular data files are accepted")
            return stream_hashes(stream)


def match_at(fd, name, record, label):
    try:
        source = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    except FileNotFoundError:
        return False
    except OSError:
        raise LocalConflict("Unsafe local file collision") from None
    with os.fdopen(source, "rb") as stream:
        mode = os.fstat(stream.fileno()).st_mode
        if not stat.S_ISREG(mode) or mode & 0o111 or stream_hashes(stream) != _record(record):
            raise LocalConflict("Existing data differs or is executable; preserved without overwriting")
    return True


def match(path, record):
    try:
        with parent_fd(path) as (fd, name):
            return match_at(fd, name, record, path)
    except FileNotFoundError:
        return False
    except OSError:
        raise LocalConflict("Unsafe local directory collision") from None


def install_stream(source, target, record):
    """Verify a streamed private copy before atomic, no-overwrite publication."""
    record = _record(record)
    with parent_fd(target, create=True) as (fd, name):
        if match_at(fd, name, record, target):
            return
        temporary = ".cm-new-" + uuid.uuid4().hex
        part = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        try:
            digest = hashlib.sha256()
            size = 0
            with os.fdopen(part, "wb") as out:
                for chunk in iter(lambda: source.read(BLOCK), b""):
                    size += len(chunk)
                    if size > record["size"]:
                        raise IngestionError("Data stream exceeds pinned size")
                    digest.update(chunk)
                    out.write(chunk)
                out.flush()
                os.fsync(out.fileno())
            if {"size": size, "sha256": digest.hexdigest()} != record:
                raise IngestionError("Data stream SHA256/size mismatch")
            try:
                os.link(temporary, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
            except FileExistsError:
                if not match_at(fd, name, record, target):
                    raise
            os.fsync(fd)
        finally:
            os.unlink(temporary, dir_fd=fd)


def install(source, target, record):
    with parent_fd(source) as (fd, name):
        source_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        with os.fdopen(source_fd, "rb") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise IngestionError("Source is not a regular file")
            install_stream(stream, target, record)


def _json(raw):
    def unique_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise IngestionError("Duplicate JSON key")
            result[key] = value
        return result
    try:
        return json.loads(raw, object_pairs_hook=unique_pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(IngestionError("Non-finite JSON number")))
    except (ValueError, UnicodeError):
        raise IngestionError("Invalid UTF-8 JSON input") from None


def allowed_paths(stage):
    if stage == "Stage2_reference_time":
        return REFERENCE_PATHS
    if stage != "CloseadjInputsV2":
        raise IngestionError("Unknown frozen input stage")
    prefix = "data/comparison_inputs_closeadj_v2/"
    expected = {prefix + "PREPARATION_RESULT.json"}
    for market, first in (("E", (2016, 8)), ("K", (2016, 8)), ("U", (2015, 1))):
        expected.add(prefix + market + "/manifest.json")
        year, month = first
        while (year, month) <= (2026, 9):
            expected.add(prefix + market + "/" + f"{year:04d}-{month:02d}.parquet")
            month += 1
            if month == 13:
                year, month = year + 1, 1
    return frozenset(expected)


def validate_stage(raw, expected):
    if hashlib.sha256(raw).hexdigest() != expected["sha256"]:
        raise IngestionError("Frozen stage JSON SHA256 mismatch")
    doc = _json(raw)
    if (not isinstance(doc, dict) or doc.get("schema_version") != 2 or
            type(doc.get("schema_version")) is not int or doc.get("archive_format") != "tar" or
            doc.get("stage") != expected["stage"] or doc.get("source_fingerprint") != expected["fingerprint"] or
            not isinstance(doc.get("outputs"), list) or len(doc["outputs"]) != expected["count"] or
            not isinstance(doc.get("archives"), list) or len(doc["archives"]) != expected["archives"]):
        raise IngestionError("Frozen stage schema/identity/count mismatch")
    records = {}
    for row in doc["outputs"]:
        record = _record(row)
        name = row.get("relative_path")
        safe("/unused", name)
        if name in records:
            raise IngestionError("Duplicate stage output")
        records[name] = record
    if set(records) != allowed_paths(expected["stage"]):
        raise IngestionError("Frozen stage output allowlist mismatch")
    seen = set()
    archive_hashes = set()
    archive_ids = set()
    for archive in doc["archives"]:
        record = _record(archive)
        if (record["size"] <= 0 or record["sha256"] in archive_hashes or
                not isinstance(archive.get("members"), list) or not archive["members"] or
                not isinstance(archive.get("drive_file_id"), str) or not archive["drive_file_id"] or
                archive["drive_file_id"] in archive_ids):
            raise IngestionError("Invalid/duplicate archive descriptor")
        archive_hashes.add(record["sha256"])
        archive_ids.add(archive["drive_file_id"])
        for name in archive["members"]:
            if not isinstance(name, str) or name not in records or name in seen:
                raise IngestionError("Duplicate/unlisted archive member")
            seen.add(name)
    if seen != set(records):
        raise IngestionError("Unassigned frozen stage output")
    return doc, records


def extract_archive(path, descriptor, records, destination):
    """Extract only manifest-listed regular, non-executable data files."""
    if hashes(path) != _record(descriptor):
        raise IngestionError("Archive SHA256/size mismatch")
    listed = set(descriptor["members"])
    if len(listed) != len(descriptor["members"]) or not listed <= records.keys():
        raise IngestionError("Invalid archive member set")
    destination = Path(destination)
    safe(destination, "probe")
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix=".cm-extract-", dir=destination.parent) as temporary:
        staging = Path(temporary)
        seen = set()
        staged = []
        try:
            with tarfile.open(path, "r:") as archive:
                for info in archive:
                    safe(destination, info.name)
                    if (not info.isfile() or info.issparse() or info.mode & 0o111 or
                            info.name not in listed or info.name in seen or info.size != records[info.name]["size"] or
                            Path(info.name).suffix not in {".json", ".jsonl", ".csv", ".parquet"}):
                        raise IngestionError("Unsafe/duplicate/unlisted TAR member")
                    seen.add(info.name)
                    target = staging / str(len(staged))
                    with archive.extractfile(info) as source:
                        install_stream(source, target, records[info.name])
                    staged.append((target, info.name))
            if seen != listed:
                raise IngestionError("TAR member set mismatch")
            for source, name in staged:
                install(source, safe(destination, name), records[name])
        except (tarfile.TarError, EOFError):
            raise IngestionError("Invalid checkpoint TAR") from None


def restore_archives(store, workdir):
    """Return a generated provenance manifest after all 401 files verify.

    The 26 original flat filenames remain unchanged under ``inputs/``. Inputs
    never supply Python/runtime code. This function does not upload anything.
    """
    root = Path(workdir)
    safe(root, "probe")
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    store.verify_private_bucket()
    stages = []
    sources = []
    outputs = {}
    for expected in FROZEN_STAGES:
        key = "inputs/cm06.batched.stage." + expected["stage"] + ".json"
        raw = store.get_object(key, max_bytes=2 * BLOCK)
        doc, records = validate_stage(raw, expected)
        if set(records) & outputs.keys():
            raise IngestionError("Cross-stage duplicate output")
        source = {"storage_key": store.object_key(key), "size": len(raw), "sha256": expected["sha256"], "kind": "stage_json"}
        sources.append(source)
        for archive in doc["archives"]:
            archive_key = "inputs/cm06.batched." + expected["stage"] + "." + archive["sha256"] + ".tar"
            sources.append({"storage_key": store.object_key(archive_key), **_record(archive), "kind": "tar_archive"})
            for name in archive["members"]:
                outputs[name] = {**records[name], "storage_key": store.object_key(archive_key), "stage": expected["stage"]}
        stages.append((expected, doc, records))
    if len(sources) != 26 or len(outputs) != 401:
        raise IngestionError("The frozen input contract requires 26 objects and 401 outputs")
    # Detect local collisions before transferring any large archive.
    existing = {name: match(safe(root, name), record) for name, record in outputs.items()}
    pending_bytes = sum(record["size"] for name, record in outputs.items() if not existing[name])
    # An incomplete TAR must stage every listed member, including members
    # already present in a reused workdir. Budget full selected-archive staging
    # plus missing-file publication, not merely twice the missing subset.
    staging_bytes = sum(records[name]["size"] for _, doc, records in stages
                        for archive in doc["archives"]
                        if any(not existing[name] for name in archive["members"])
                        for name in archive["members"])
    largest_archive = max(a["size"] for _, doc, _ in stages for a in doc["archives"])
    if shutil.disk_usage(root).free < staging_bytes + pending_bytes + largest_archive * 2 + 32 * BLOCK:
        raise IngestionError("Insufficient disk space for verified no-overwrite restore")
    with tempfile.TemporaryDirectory(prefix=".cm-inputs-", dir=root.parent) as temporary:
        staging = Path(temporary)
        prepared = staging / "prepared"
        prepared.mkdir(mode=0o700)
        for expected, doc, records in stages:
            for archive in doc["archives"]:
                if all(existing[name] for name in archive["members"]):
                    continue
                key = "inputs/cm06.batched." + expected["stage"] + "." + archive["sha256"] + ".tar"
                archive_path = staging / (archive["sha256"] + ".tar")
                store.download_object(key, archive_path, expected_size=archive["size"], expected_sha256=archive["sha256"])
                extract_archive(archive_path, archive, records, prepared)
                archive_path.unlink()
        # No runtime input appears before every archive/member has verified.
        for name, record in outputs.items():
            if not existing[name]:
                install(safe(prepared, name), safe(root, name), record)
    for name, record in outputs.items():
        if not match(safe(root, name), record):
            raise IngestionError("Restored input disappeared before final verification")
    return {"schema": "CMRESEARCHENGINE_INPUT_MANIFEST_V1", "bucket": store.bucket,
            "prefix": store.prefix, "input_object_count": 26, "restored_files": 401,
            "sources": sorted(sources, key=lambda row: row["storage_key"]),
            "outputs": [{"relative_path": name, **outputs[name]} for name in sorted(outputs)]}


def extract_verified_zip(path, destination, *, expected_sha256, expected_size):
    """Extract the pinned evidence format; an embedded manifest cannot add code."""
    if hashes(path) != {"size": expected_size, "sha256": expected_sha256}:
        raise IngestionError("Evidence ZIP SHA256/size mismatch")
    destination = Path(destination)
    safe(destination, "probe")
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        with zipfile.ZipFile(path) as archive:
            infos = archive.infolist()
            names = [info.filename for info in infos]
            if len(names) != len(set(names)) or "DATA_ONLY_MANIFEST.json" not in names:
                raise IngestionError("Duplicate or missing evidence ZIP manifest")
            manifest_info = archive.getinfo("DATA_ONLY_MANIFEST.json")
            if manifest_info.file_size > 2 * BLOCK:
                raise IngestionError("Evidence ZIP manifest exceeds size limit")
            manifest_raw = archive.read(manifest_info)
            manifest = _json(manifest_raw)
            if (not isinstance(manifest, dict) or manifest.get("schema") != "CM06_SUPABASE_RUNTIME_PRIVATE_EVIDENCE_V1" or
                    manifest.get("contains_code") is not False or manifest.get("contains_credentials") is not False or
                    not isinstance(manifest.get("files"), list) or len(manifest["files"]) != 35 or
                    manifest.get("reference_chunk_count") != 19 or manifest.get("evidence_parts_relative_path") != "reference_parts"):
                raise IngestionError("Evidence manifest identity/count mismatch")
            records = {}
            for row in manifest["files"]:
                record = _record(row)
                name = row.get("path")
                safe(destination, name)
                if name in records or Path(name).suffix not in {".json", ".jsonl"}:
                    raise IngestionError("Duplicate or executable evidence member")
                records[name] = record
            if set(names) != set(records) | {"DATA_ONLY_MANIFEST.json"}:
                raise IngestionError("Evidence ZIP contains unlisted or missing members")
            if sum(name.startswith("reference_parts/") for name in records) != 19:
                raise IngestionError("Evidence reference-part count mismatch")
            records["DATA_ONLY_MANIFEST.json"] = {"size": len(manifest_raw), "sha256": hashlib.sha256(manifest_raw).hexdigest()}
            for info in infos:
                mode = info.external_attr >> 16
                if (info.is_dir() or info.flag_bits & 1 or stat.S_ISLNK(mode) or mode & 0o111 or
                        (stat.S_IFMT(mode) and not stat.S_ISREG(mode)) or info.file_size != records[info.filename]["size"]):
                    raise IngestionError("Unsafe evidence ZIP member")
                match(safe(destination, info.filename), records[info.filename])
            required = sum(record["size"] for record in records.values()) * 2 + 32 * BLOCK
            if shutil.disk_usage(destination).free < required:
                raise IngestionError("Insufficient disk space for verified evidence restore")
            with tempfile.TemporaryDirectory(prefix=".cm-evidence-", dir=destination.parent) as temporary:
                staging = Path(temporary)
                for info in infos:
                    with archive.open(info) as source:
                        install_stream(source, safe(staging, info.filename), records[info.filename])
                for name, record in records.items():
                    install(safe(staging, name), safe(destination, name), record)
            return manifest
    except (zipfile.BadZipFile, EOFError):
        raise IngestionError("Invalid evidence ZIP") from None


def restore_evidence(store, destination):
    destination = Path(destination)
    safe(destination, "probe")
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    key = "evidence/" + EVIDENCE_NAME
    store.verify_private_bucket()
    with tempfile.TemporaryDirectory(prefix=".cm-evidence-download-", dir=destination.parent) as temporary:
        path = Path(temporary) / EVIDENCE_NAME
        store.download_object(key, path, expected_size=EVIDENCE_SIZE, expected_sha256=EVIDENCE_SHA256)
        manifest = extract_verified_zip(path, destination, expected_sha256=EVIDENCE_SHA256, expected_size=EVIDENCE_SIZE)
    return {"schema": "CMRESEARCHENGINE_EVIDENCE_MANIFEST_V1", "bucket": store.bucket,
            "storage_key": store.object_key(key), "size": EVIDENCE_SIZE, "sha256": EVIDENCE_SHA256,
            "reference_parts": "reference_parts", "files": manifest["files"]}
