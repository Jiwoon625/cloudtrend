"""Create-only, verified blob storage for resumable CM06 checkpoints.

No authentication, permission changes, remote update/delete, name-based lookup,
or automatic recovery with a different ID occurs here. Construct DriveBlobStore
with an already-authorized Google Drive v3 service. The caller must persist IDs
before use and publish its commit manifest only after put_bytes returns.

Drive's official fixed-ID contract (checked 2026-10-04):
https://developers.google.com/workspace/drive/api/guides/create-file#generate-ids
https://developers.google.com/workspace/drive/api/reference/rest/v3/files/generateIds
Generate IDs with files.generateIds, supply body.id to files.create. A retry
after creation returns 409; read back that same ID and compare before accepting.
Google Workspace conversion, shortcuts, and shared-drive destinations are not
supported. Only ordinary binary blobs in the explicitly authorized folder are.

DirectoryStore uses a private POSIX directory and a single metadata+data envelope
per ID. It writes and fsyncs an exclusive temporary file, hard-links it to the
fixed ID without replacement, then fsyncs the directory and reads it back. A
crash before publication leaves at most an unreferenced temporary file; after
publication a retry must use exactly the same ID and bytes. There is no latest
pointer. Local storage is a test/offline backend, not a durable remote backup.

Checksums detect corruption, not malicious writers able to alter both metadata
and content. Drive sharing is verified before and after transfer, but Drive has
no transaction to lock out a concurrent owner changing ACLs during a transfer.
The caller must upload only its safe checkpoint state, never credentials or raw
source data; this bytes-level store cannot classify arbitrary content.
"""

from __future__ import annotations

import errno
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import struct
from typing import Any, Callable
import uuid


AUTHORIZED_FOLDER_ID = "1a6Dw2vw57OtgfrL4Js1NbLHGf7HT8maf"
_FOLDER_MIME = "application/vnd.google-apps.folder"
_FIELDS = (
    "id,name,mimeType,parents,trashed,size,md5Checksum,sha256Checksum,"
    "version,modifiedTime,driveId,capabilities(canDownload,canAddChildren)"
)
_MAGIC = b"CM06BLOB\x01"
_HEADER_LIMIT = 65536
_DEFAULT_LIMIT = 512 * 1024 * 1024
FaultHook = Callable[[str, str], None]


class StoreError(RuntimeError):
    """Storage could not establish a verified result."""


class VerificationError(StoreError):
    """Content, metadata, destination, or privacy validation failed."""


class ConcurrentCommit(StoreError):
    """A fixed ID is already occupied by different content or identity."""


class CommitUncertain(StoreError):
    """Creation outcome is unknown; retain and retry ONLY the same fixed ID."""


def _id(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", value):
        raise ValueError("Blob ID must be 1-200 ASCII letters, digits, '_' or '-'")
    return value


def _name(value: str) -> str:
    if (not isinstance(value, str) or not value.strip() or value in (".", "..")
            or len(value.encode("utf-8")) > 1024 or "/" in value or "\\" in value
            or any(ord(c) < 32 or ord(c) == 127 for c in value)):
        raise ValueError("Blob name must be a nonempty filename, not a path")
    return value


def _mime(value: str) -> str:
    if (not isinstance(value, str)
            or not re.fullmatch(r"[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+", value)
            or value.lower().startswith("application/vnd.google-apps.")):
        raise ValueError("Expected an ordinary blob MIME type, without conversion")
    return value


def _hashes(data: bytes) -> dict[str, Any]:
    return {"size": len(data), "sha256": hashlib.sha256(data).hexdigest(),
            "md5Checksum": hashlib.md5(data, usedforsecurity=False).hexdigest()}


def _status(exc: BaseException) -> int | None:
    status = getattr(getattr(exc, "resp", None), "status", None)
    try:
        return int(status) if status is not None else None
    except (ValueError, TypeError):
        return None


def _execute(request: Any) -> Any:
    # Explicitly disable client retries; retry/reconciliation must keep the ID.
    return request.execute(num_retries=0)


def _same(expected: bytes, name: str, mime_type: str,
          observed: bytes, meta: dict[str, Any]) -> None:
    # Drive may classify an application/octet-stream upload by its actual
    # content (observed live: a canonical .json descriptor becomes
    # application/json). MIME classification is not a conflicting commit when
    # the exact requested bytes and filename are unchanged. Metadata validation
    # still rejects native Workspace/shortcut MIME and verifies parent/ACL/hash.
    # Explicit typed uploads remain strict; only generic binary input permits
    # only the known JSON/gzip/ZIP raw-blob classifications used by this
    # checkpoint protocol. Unknown classifications still fail closed.
    matches_bytes = observed == expected
    matches_name = meta["name"] == name
    observed_mime = _mime(meta["mimeType"])
    normalized = set()
    if mime_type == "application/octet-stream":
        if name.endswith(".json"):
            normalized = {"application/json"}
        elif name.endswith(".json.gz"):
            normalized = {"application/gzip", "application/x-gzip"}
        elif name.endswith(".zip"):
            normalized = {"application/zip", "application/x-zip-compressed"}
    matches_mime = observed_mime == mime_type or observed_mime in normalized
    if not (matches_bytes and matches_name and matches_mime):
        raise ConcurrentCommit("Fixed blob ID differs: " + json.dumps({
            "bytes_match": matches_bytes, "name_match": matches_name,
            "requested_mime": mime_type, "observed_mime": observed_mime,
            "expected_sha256": hashlib.sha256(expected).hexdigest(),
            "observed_sha256": hashlib.sha256(observed).hexdigest()}, sort_keys=True))


def _receipt(data: bytes, meta: dict[str, Any], reused: bool) -> dict[str, Any]:
    return {"file_id": meta["id"], "id": meta["id"], "name": meta["name"],
            **_hashes(data), "reused": reused, "metadata": dict(meta)}


class _StoreBase:
    def __init__(self, *, fault: FaultHook | None = None,
                 max_blob_bytes: int = _DEFAULT_LIMIT) -> None:
        if type(max_blob_bytes) is not int or max_blob_bytes <= 0:
            raise ValueError("max_blob_bytes must be a positive integer")
        self._fault_hook = fault
        self.max_blob_bytes = max_blob_bytes

    def _fault(self, stage: str, file_id: str) -> None:
        if self._fault_hook is not None:
            self._fault_hook(stage, file_id)

    def _input(self, file_id: str, name: str, data: bytes, mime_type: str) -> None:
        _id(file_id)
        _name(name)
        _mime(mime_type)
        if type(data) is not bytes:
            raise TypeError("Blob data must be immutable bytes")
        if len(data) > self.max_blob_bytes:
            raise ValueError("Blob exceeds configured size limit")

    def _validate_meta(self, meta: Any, file_id: str, parent: str) -> dict[str, Any]:
        if not isinstance(meta, dict) or meta.get("id") != file_id:
            raise VerificationError("Blob metadata has an unexpected ID")
        if meta.get("parents") != [parent] or meta.get("trashed") is not False:
            raise VerificationError("Blob is trashed or outside the exact checkpoint folder")
        try:
            _name(meta["name"])
            _mime(meta["mimeType"])
            raw_size = meta["size"]
            if type(raw_size) not in (int, str) or not re.fullmatch(r"[0-9]+", str(raw_size)):
                raise ValueError("invalid size")
            size = int(raw_size)
            if size > self.max_blob_bytes:
                raise ValueError("size exceeds limit")
            md5 = meta["md5Checksum"]
            if not isinstance(md5, str) or not re.fullmatch(r"[0-9a-fA-F]{32}", md5):
                raise ValueError("missing checksum")
            sha = meta.get("sha256Checksum")
            if sha is not None and (not isinstance(sha, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", sha)):
                raise ValueError("invalid sha256")
        except (KeyError, TypeError, ValueError) as exc:
            raise VerificationError("Blob metadata is incomplete or invalid") from exc
        result = dict(meta)
        result["size"] = size
        result["md5Checksum"] = md5.lower()
        if sha is not None:
            result["sha256Checksum"] = sha.lower()
        return result

    def _check_bytes(self, data: bytes, meta: dict[str, Any]) -> None:
        if type(data) is not bytes:
            raise VerificationError("Download did not return bytes")
        hashes = _hashes(data)
        if (hashes["size"] != meta["size"]
                or hashes["md5Checksum"] != meta["md5Checksum"]
                or (meta.get("sha256Checksum") is not None
                    and hashes["sha256"] != meta["sha256Checksum"])):
            raise VerificationError("Downloaded blob failed size/checksum verification")


class DriveBlobStore(_StoreBase):
    """Fixed-ID, create-only Google Drive store; does not authenticate.

    ``media_factory`` is a test seam with the MediaIoBaseUpload signature.
    Only the exact pre-authorized private My Drive folder is accepted. Named
    user/group sharing already on that folder is preserved; public, domain,
    unknown, empty, or unreadable ACLs fail closed. ACLs are always fully paged.
    """

    def __init__(self, service: Any, folder_id: str = AUTHORIZED_FOLDER_ID, *,
                 media_factory: Callable[..., Any] | None = None,
                 fault: FaultHook | None = None,
                 max_blob_bytes: int = _DEFAULT_LIMIT) -> None:
        super().__init__(fault=fault, max_blob_bytes=max_blob_bytes)
        if folder_id != AUTHORIZED_FOLDER_ID:
            raise ValueError("Destination is not the authorized checkpoint folder")
        self.service = service
        self.folder_id = folder_id
        self._media_factory = media_factory

    def _raw_meta(self, file_id: str) -> dict[str, Any]:
        try:
            result = _execute(self.service.files().get(
                fileId=file_id, fields=_FIELDS, supportsAllDrives=True))
        except Exception as exc:
            if _status(exc) == 404:
                raise FileNotFoundError(file_id) from exc
            raise
        if not isinstance(result, dict):
            raise VerificationError("Drive did not return metadata")
        return result

    def _private(self, file_id: str) -> None:
        token = None
        seen: set[str] = set()
        count = 0
        while True:
            kwargs = {"fileId": file_id, "pageSize": 100,
                      "supportsAllDrives": True,
                      "fields": "nextPageToken,permissions(id,type,role,deleted)"}
            if token is not None:
                kwargs["pageToken"] = token
            result = _execute(self.service.permissions().list(**kwargs))
            if not isinstance(result, dict) or not isinstance(result.get("permissions"), list):
                raise VerificationError("Cannot verify complete checkpoint permissions")
            for permission in result["permissions"]:
                if not isinstance(permission, dict):
                    raise VerificationError("Invalid checkpoint permission metadata")
                if permission.get("deleted") is True:
                    continue
                if (permission.get("type") not in ("user", "group")
                        or not permission.get("id")
                        or permission.get("role") not in (
                            "owner", "organizer", "fileOrganizer", "writer", "commenter", "reader")):
                    raise VerificationError("Checkpoint ACL is public/domain, unknown, or unverifiable")
                count += 1
            token = result.get("nextPageToken")
            if token is None:
                break
            if not isinstance(token, str) or not token or token in seen:
                raise VerificationError("Invalid permission pagination")
            seen.add(token)
        if count == 0:
            raise VerificationError("Empty checkpoint ACL cannot establish privacy")

    def _folder(self, *, writable: bool = False) -> None:
        meta = self._raw_meta(self.folder_id)
        if (meta.get("id") != self.folder_id or meta.get("mimeType") != _FOLDER_MIME
                or meta.get("trashed") is not False or meta.get("driveId")):
            raise VerificationError("Destination must be the authorized, untrashed My Drive folder")
        if writable and meta.get("capabilities", {}).get("canAddChildren") is not True:
            raise VerificationError("Cannot verify write access to checkpoint folder")
        self._private(self.folder_id)

    def generate_id(self) -> str:
        self._folder(writable=True)
        result = _execute(self.service.files().generateIds(count=1, space="drive", type="files"))
        if not isinstance(result, dict) or not isinstance(result.get("ids"), list) or len(result["ids"]) != 1:
            raise VerificationError("Drive did not return exactly one generated ID")
        try:
            return _id(result["ids"][0])
        except ValueError as exc:
            raise VerificationError("Drive returned an invalid generated ID") from exc

    def _read(self, file_id: str) -> tuple[bytes, dict[str, Any]]:
        _id(file_id)
        self._folder()
        before = self._validate_meta(self._raw_meta(file_id), file_id, self.folder_id)
        if before.get("driveId") or before.get("capabilities", {}).get("canDownload") is not True:
            raise VerificationError("Cannot verify access to an ordinary downloadable blob")
        self._private(file_id)
        try:
            data = _execute(self.service.files().get_media(fileId=file_id, supportsAllDrives=True))
        except Exception as exc:
            if _status(exc) == 404:
                raise FileNotFoundError(file_id) from exc
            raise
        after = self._validate_meta(self._raw_meta(file_id), file_id, self.folder_id)
        stable_fields = ("id", "name", "mimeType", "parents", "trashed", "size",
                         "md5Checksum", "sha256Checksum", "version", "modifiedTime", "driveId")
        if any(before.get(key) != after.get(key) for key in stable_fields):
            raise VerificationError("Drive blob changed during readback")
        self._check_bytes(data, after)
        self._private(file_id)
        self._folder()
        return data, after

    def get_bytes(self, file_id: str) -> bytes:
        return self._read(file_id)[0]

    def metadata(self, file_id: str) -> dict[str, Any]:
        # Metadata is returned only after the content has also been verified.
        return self._read(file_id)[1]

    def put_bytes(self, file_id: str, name: str, data: bytes, *,
                  mime_type: str = "application/octet-stream") -> dict[str, Any]:
        self._input(file_id, name, data, mime_type)
        self._folder(writable=True)
        factory = self._media_factory
        if factory is None:
            try:
                from googleapiclient.http import MediaIoBaseUpload
            except ImportError as exc:
                raise ImportError("Drive writes require google-api-python-client; no authentication is performed") from exc
            factory = MediaIoBaseUpload
        media = factory(io.BytesIO(data), mimetype=mime_type, resumable=False)
        reused = False
        self._fault("before_create", file_id)
        try:
            created = _execute(self.service.files().create(
                body={"id": file_id, "name": name, "parents": [self.folder_id], "mimeType": mime_type},
                media_body=media, fields="id", supportsAllDrives=True))
        except Exception as exc:
            status = _status(exc)
            uncertain = (status in (408, 409, 429) or (status is not None and 500 <= status <= 599)
                         or isinstance(exc, (TimeoutError, ConnectionError, OSError)))
            if not uncertain:
                raise
            # A lost response and a 409 are both reconciled by the ORIGINAL ID.
            try:
                observed, meta = self._read(file_id)
            except FileNotFoundError as missing:
                raise CommitUncertain("Create is unconfirmed; retain and retry the SAME blob ID") from missing
            _same(data, name, mime_type, observed, meta)
            reused = True
        else:
            if not isinstance(created, dict) or created.get("id") != file_id:
                raise VerificationError("Drive did not preserve the pre-generated file ID")
        self._fault("after_create", file_id)
        observed, meta = self._read(file_id)
        _same(data, name, mime_type, observed, meta)
        self._fault("after_readback", file_id)
        return _receipt(observed, meta, reused)


class DirectoryStore(_StoreBase):
    """Private POSIX create-only store with fixed-ID atomic publication.

    Existing directories must belong to this UID and have no group/world mode
    bits. The store creates only its final directory (parents must exist), never
    changes existing permissions. All root components and blob paths reject
    symlinks. dir_fd + O_NOFOLLOW pins operations to the checked directory.
    Close the store, or use its context manager, when done.
    """

    def __init__(self, directory: str | Path, *, fault: FaultHook | None = None,
                 max_blob_bytes: int = _DEFAULT_LIMIT) -> None:
        super().__init__(fault=fault, max_blob_bytes=max_blob_bytes)
        if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
            raise StoreError("DirectoryStore requires POSIX O_NOFOLLOW and O_DIRECTORY")
        # Do not normalize away a symlink-bearing component such as link/../x.
        if ".." in Path(directory).parts:
            raise ValueError("Parent traversal is forbidden in DirectoryStore paths")
        self.path = Path(os.path.abspath(os.fspath(directory)))
        self._fd: int | None = None
        self._reject_symlinks()
        created = False
        try:
            os.mkdir(self.path, mode=0o700)
            created = True
        except FileExistsError:
            pass
        self._reject_symlinks()
        self._fd = os.open(self.path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            self._check_root()
            if created:
                # Persist the new directory entry as well as its later files.
                parent_fd = os.open(self.path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    os.fsync(parent_fd)
                finally:
                    os.close(parent_fd)
        except BaseException:
            self.close()
            raise

    def _reject_symlinks(self) -> None:
        for part in reversed((self.path, *self.path.parents)):
            if part.is_symlink():
                raise VerificationError("Symlinks are forbidden in DirectoryStore paths")

    def _check_root(self) -> int:
        if self._fd is None:
            raise StoreError("DirectoryStore is closed")
        self._reject_symlinks()
        opened = os.fstat(self._fd)
        current = os.stat(self.path, follow_symlinks=False)
        if (not stat.S_ISDIR(opened.st_mode) or opened.st_uid != os.getuid()
                or stat.S_IMODE(opened.st_mode) & 0o077
                or (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino)):
            raise VerificationError("DirectoryStore must remain private, owned, and unchanged")
        return self._fd

    def close(self) -> None:
        if self._fd is not None:
            os.close(self._fd)
            self._fd = None

    def __enter__(self) -> "DirectoryStore":
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()

    def __del__(self) -> None:
        fd = getattr(self, "_fd", None)
        if fd is not None:
            os.close(fd)
            self._fd = None

    def generate_id(self) -> str:
        self._check_root()
        return "local_" + uuid.uuid4().hex

    def _read(self, file_id: str) -> tuple[bytes, dict[str, Any]]:
        _id(file_id)
        root = self._check_root()
        try:
            fd = os.open(file_id, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root)
        except OSError as exc:
            if exc.errno == errno.ELOOP:
                raise VerificationError("Symlink blob is forbidden") from exc
            raise
        with os.fdopen(fd, "rb") as stream:
            before = os.fstat(stream.fileno())
            if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid()
                    or stat.S_IMODE(before.st_mode) & 0o077):
                raise VerificationError("Blob must be a private owned regular file")
            if stream.read(len(_MAGIC)) != _MAGIC:
                raise VerificationError("Invalid local blob envelope")
            length_bytes = stream.read(4)
            if len(length_bytes) != 4:
                raise VerificationError("Truncated local blob header")
            length = struct.unpack(">I", length_bytes)[0]
            if not 0 < length <= _HEADER_LIMIT:
                raise VerificationError("Invalid local blob header length")
            try:
                meta = json.loads(stream.read(length))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise VerificationError("Invalid local blob metadata") from exc
            meta = self._validate_meta(meta, file_id, str(self.path))
            data = stream.read(self.max_blob_bytes + 1)
            after = os.fstat(stream.fileno())
            if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                    after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise VerificationError("Local blob changed during readback")
        self._check_root()
        self._check_bytes(data, meta)
        return data, meta

    def get_bytes(self, file_id: str) -> bytes:
        return self._read(file_id)[0]

    def metadata(self, file_id: str) -> dict[str, Any]:
        return self._read(file_id)[1]

    def put_bytes(self, file_id: str, name: str, data: bytes, *,
                  mime_type: str = "application/octet-stream") -> dict[str, Any]:
        self._input(file_id, name, data, mime_type)
        root = self._check_root()
        hashes = _hashes(data)
        meta = {"id": file_id, "name": name, "mimeType": mime_type,
                "parents": [str(self.path)], "trashed": False, "size": len(data),
                "md5Checksum": hashes["md5Checksum"], "sha256Checksum": hashes["sha256"]}
        header = json.dumps(meta, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        if len(header) > _HEADER_LIMIT:
            raise ValueError("Local envelope metadata exceeds size limit")
        temp = ".uncommitted-" + uuid.uuid4().hex
        reused = False
        self._fault("before_create", file_id)
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=root)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(_MAGIC + struct.pack(">I", len(header)) + header)
                stream.write(data)
                stream.flush()
                self._fault("after_temp_write", file_id)
                os.fsync(stream.fileno())
                self._fault("after_temp_fsync", file_id)
            self._check_root()
            try:
                # link(2) is atomic and fails with EEXIST; never os.replace().
                os.link(temp, file_id, src_dir_fd=root, dst_dir_fd=root, follow_symlinks=False)
            except FileExistsError:
                reused = True
                observed, existing = self._read(file_id)
                _same(data, name, mime_type, observed, existing)
            self._fault("after_publish", file_id)
            os.fsync(root)
            self._fault("after_directory_fsync", file_id)
        finally:
            # Only our unreferenced private staging entry is removed, never IDs.
            os.unlink(temp, dir_fd=root)
            os.fsync(root)
        self._fault("after_create", file_id)
        observed, actual = self._read(file_id)
        _same(data, name, mime_type, observed, actual)
        self._fault("after_readback", file_id)
        return _receipt(observed, actual, reused)


# Readable alternative name for callers that prefer the backend prefix.
GoogleDriveBlobStore = DriveBlobStore
