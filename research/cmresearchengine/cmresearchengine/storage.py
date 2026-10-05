"""Private, create-only Supabase Storage adapter for the isolated CM engine.

REST routes verified against Supabase's Storage source and documentation on
2026-10-05. No SDK, credential setup, bucket creation, public URLs, or upserts.
Only runtime construction reads the three named environment variables.
"""
from __future__ import annotations

import errno
import hashlib
import http.client
import io
import json
import os
from pathlib import Path
import re
import socket
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

BUCKET = "cloudtrend-data"
BLOCK = 1024 * 1024
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
COMPONENT = re.compile(r"[A-Za-z0-9_-]{1,200}\Z")
TRANSIENT_STATUS = {408, 429, 500, 502, 503, 504}


class StorageError(RuntimeError):
    """A sanitized failure which never includes HTTP headers or response bodies."""


class StorageSecurityError(StorageError):
    pass


class ImmutableConflict(StorageError):
    pass


class _DuplicateObject(StorageError):
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise StorageSecurityError("Storage redirects are forbidden")


def _component(value, label):
    if not isinstance(value, str) or COMPONENT.fullmatch(value) is None:
        raise StorageSecurityError("Invalid " + label)
    return value


def _relative(value):
    if (not isinstance(value, str) or not value or len(value) > 2048 or
            any(ord(c) < 32 or ord(c) == 127 for c in value) or
            any(c in value for c in "\\%?#:") or
            any(p in ("", ".", "..") for p in value.split("/"))):
        raise StorageSecurityError("Unsafe storage object key")
    if value != "manifest.json" and value.split("/", 1)[0] not in {"inputs", "evidence", "checkpoints", "results"}:
        raise StorageSecurityError("Object is outside the CM storage areas")
    return value


def _is_transient(exc):
    reason = exc.reason if isinstance(exc, urllib.error.URLError) else exc
    if isinstance(reason, ssl.SSLError):
        return False
    if isinstance(reason, (TimeoutError, ConnectionResetError, ConnectionAbortedError,
                           BrokenPipeError, http.client.IncompleteRead,
                           http.client.RemoteDisconnected)):
        return True
    if isinstance(reason, socket.gaierror):
        return reason.errno == socket.EAI_AGAIN
    return isinstance(reason, OSError) and reason.errno in {
        errno.ETIMEDOUT, errno.ECONNRESET, errno.ECONNABORTED,
        errno.EPIPE, errno.ENETUNREACH, errno.EHOSTUNREACH,
    }


class SupabaseCMStore:
    """Root-scoped input reader and immutable results/checkpoint writer.

    Use ``scoped_checkpoints(plan_hash, candidate_id)`` for CandidateJournal.
    Its generated IDs are opaque; the descriptive name passed to put_bytes is
    validated but does not change the object address or weaken fixed-ID fencing.
    """

    bucket = BUCKET

    def __init__(self, url, service_role_key, user_id, *, opener=None,
                 sleep=time.sleep, attempts=4, timeout=90, _scope=None):
        # A service-role credential must never be sent to an arbitrary URL, even
        # if a malformed SUPABASE_URL reaches this backend-only process.
        if not isinstance(url, str) or re.fullmatch(
                r"https://[a-z0-9]{20}\.supabase\.co/?", url) is None:
            raise StorageSecurityError("SUPABASE_URL must be a hosted Supabase HTTPS project origin")
        if not isinstance(service_role_key, str) or not service_role_key or any(
                ord(c) < 33 or ord(c) > 126 for c in service_role_key):
            raise StorageSecurityError("Missing or invalid SUPABASE_SERVICE_ROLE_KEY")
        try:
            canonical_user = str(uuid.UUID(user_id))
        except (ValueError, TypeError, AttributeError):
            raise StorageSecurityError("SUPABASE_USER_ID must be a canonical UUID") from None
        if canonical_user != user_id:
            raise StorageSecurityError("SUPABASE_USER_ID must be a canonical UUID")
        if type(attempts) is not int or not 1 <= attempts <= 5 or not 1 <= timeout <= 300:
            raise ValueError("Invalid bounded transport limits")
        self._url = url.rstrip("/")
        self._key = service_role_key
        self.prefix = user_id + "/research/cm/"
        self._opener = opener if opener is not None else urllib.request.build_opener(
            urllib.request.ProxyHandler({}), _NoRedirect())
        self._sleep = sleep
        self._attempts = attempts
        self._timeout = timeout
        self._scope = _scope

    def __repr__(self):
        return "SupabaseCMStore(bucket='cloudtrend-data', credentials=<redacted>)"

    @classmethod
    def from_env(cls, *, environ=None, **kwargs):
        env = os.environ if environ is None else environ
        names = ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_USER_ID")
        if any(not env.get(name) for name in names):
            raise StorageSecurityError("Existing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_USER_ID are required")
        return cls(*(env[name] for name in names), **kwargs)

    def scoped_checkpoints(self, plan_hash, candidate_id):
        if not isinstance(plan_hash, str) or SHA256.fullmatch(plan_hash) is None:
            raise StorageSecurityError("Invalid plan hash")
        candidate_id = _component(candidate_id, "candidate ID")
        return type(self)(self._url, self._key, self.prefix.split("/")[0],
                          opener=self._opener, sleep=self._sleep, attempts=self._attempts,
                          timeout=self._timeout,
                          _scope="checkpoints/" + plan_hash + "/" + candidate_id)

    @staticmethod
    def generate_id():
        return uuid.uuid4().hex

    def object_key(self, relative_key):
        return self.prefix + _relative(relative_key)

    def _object_route(self, relative_key):
        return "object/" + BUCKET + "/" + urllib.parse.quote(self.object_key(relative_key), safe="/")

    @staticmethod
    def _bounded(response, limit):
        data = response.read(limit + 1)
        if len(data) > limit:
            raise StorageError("Storage response exceeds its size limit")
        return data

    def _request(self, method, route, consume, *, data=None, headers=None):
        url = self._url + "/storage/v1/" + route
        request_headers = {"Authorization": "Bearer " + self._key,
                           "apikey": self._key, "Accept-Encoding": "identity"}
        request_headers.update(headers or {})
        for attempt in range(self._attempts):
            try:
                req = urllib.request.Request(url, data=data, headers=request_headers, method=method)
                with self._opener.open(req, timeout=self._timeout) as response:
                    # Defense in depth for injected/custom openers as well.
                    if response.geturl() != url:
                        raise StorageSecurityError("Storage response origin or URL changed")
                    status = response.getcode()
                    if not 200 <= status < 300:
                        raise StorageError("Unexpected storage response status")
                    return consume(response)
            except urllib.error.HTTPError as exc:
                status = exc.code
                body = b""
                try:
                    if status in {400, 404, 409}:
                        body = exc.read(8192)
                finally:
                    exc.close()
                if 300 <= status < 400:
                    raise StorageSecurityError("Storage redirects are forbidden") from None
                detail = {}
                try:
                    detail = json.loads(body)
                except (ValueError, UnicodeError):
                    pass
                code = str(detail.get("code", "")) if isinstance(detail, dict) else ""
                message = str(detail.get("message", "")) if isinstance(detail, dict) else ""
                if status == 404 or (status == 400 and (
                        code in {"NoSuchKey", "NoSuchObject", "NotFound"} or
                        message.lower() in {"object not found", "not found"})):
                    raise FileNotFoundError("CM storage object not found") from None
                if status == 409 or (status == 400 and (
                        code in {"KeyAlreadyExists", "ResourceAlreadyExists", "Duplicate"} or
                        message.lower() in {"the resource already exists", "asset already exists"})):
                    raise _DuplicateObject("Storage object already exists") from None
                if status not in TRANSIENT_STATUS or attempt + 1 == self._attempts:
                    raise StorageError("Storage request failed (HTTP " + str(status) + ")") from None
            except (urllib.error.URLError, OSError, http.client.HTTPException) as exc:
                if not _is_transient(exc) or attempt + 1 == self._attempts:
                    raise StorageError("Storage transport failed; credentials and server details withheld") from None
            self._sleep(min(0.5 * (2 ** attempt), 4.0))
        raise StorageError("Storage retry bound reached")

    def verify_private_bucket(self):
        raw = self._request("GET", "bucket/" + BUCKET,
                            lambda response: self._bounded(response, 65536))
        try:
            metadata = json.loads(raw)
        except (ValueError, UnicodeError):
            raise StorageSecurityError("Bucket metadata is unreadable") from None
        if (not isinstance(metadata, dict) or metadata.get("id") != BUCKET or
                metadata.get("name") != BUCKET or metadata.get("public") is not False):
            raise StorageSecurityError("The existing cloudtrend-data bucket must be private")
        return {"id": BUCKET, "name": BUCKET, "public": False}

    def get_object(self, relative_key, *, max_bytes=16 * BLOCK):
        route = self._object_route(relative_key)
        if type(max_bytes) is not int or max_bytes < 0:
            raise ValueError("Invalid response size limit")
        self.verify_private_bucket()
        return self._request("GET", route, lambda response: self._bounded(response, max_bytes))

    def put_object(self, relative_key, data):
        relative_key = _relative(relative_key)
        if relative_key != "manifest.json" and relative_key.split("/", 1)[0] not in {"checkpoints", "results"}:
            raise StorageSecurityError("The engine cannot upload or replace input/evidence objects")
        if not isinstance(data, bytes):
            raise TypeError("Immutable object content must be bytes")
        self.verify_private_bucket()
        try:
            self._request("POST", self._object_route(relative_key),
                          lambda response: self._bounded(response, 65536), data=data,
                          headers={"Content-Type": "application/octet-stream", "x-upsert": "false"})
        except _DuplicateObject:
            try:
                existing = self.get_object(relative_key, max_bytes=len(data))
            except StorageError:
                raise ImmutableConflict("Existing immutable object differs or cannot be verified") from None
            if existing != data:
                raise ImmutableConflict("Existing immutable object differs; no overwrite performed")
        return self.object_key(relative_key)

    def put_bytes(self, ident, name, data):
        if self._scope is None:
            raise StorageSecurityError("A candidate checkpoint scope is required")
        ident = _component(ident, "immutable object ID")
        if (not isinstance(name, str) or re.fullmatch(r"[A-Za-z0-9_.-]{1,240}", name) is None or
                name in {".", ".."}):
            raise StorageSecurityError("Invalid descriptive object name")
        return self.put_object(self._scope + "/" + ident, data)

    def get_bytes(self, ident):
        if self._scope is None:
            raise StorageSecurityError("A candidate checkpoint scope is required")
        return self.get_object(self._scope + "/" + _component(ident, "immutable object ID"),
                               max_bytes=512 * BLOCK)

    def download_object(self, relative_key, target, *, expected_size, expected_sha256):
        """Stream to a no-clobber local file; restart only transient transfers."""
        route = self._object_route(relative_key)
        if (type(expected_size) is not int or expected_size < 0 or
                not isinstance(expected_sha256, str) or SHA256.fullmatch(expected_sha256) is None):
            raise ValueError("A pinned object size and SHA256 are required")
        self.verify_private_bucket()
        # Shared no-symlink, descriptor-relative install protects local paths too.
        from .ingest import parent_fd, match_at
        target = Path(target)
        record = {"size": expected_size, "sha256": expected_sha256}
        with parent_fd(target, create=True) as (fd, name):
            if match_at(fd, name, record, target):
                return record
            temporary = ".cm-download-" + uuid.uuid4().hex
            local_fd = os.open(temporary, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                               0o600, dir_fd=fd)
            try:
                with os.fdopen(local_fd, "w+b") as output:
                    def consume(response):
                        output.seek(0)
                        output.truncate()
                        digest = hashlib.sha256()
                        size = 0
                        while True:
                            chunk = response.read(BLOCK)
                            if not chunk:
                                break
                            size += len(chunk)
                            if size > expected_size:
                                raise StorageError("Downloaded object exceeds pinned size")
                            digest.update(chunk)
                            output.write(chunk)
                        if size != expected_size or digest.hexdigest() != expected_sha256:
                            raise StorageError("Downloaded object SHA256/size mismatch")
                        output.flush()
                        os.fsync(output.fileno())
                    self._request("GET", route, consume)
                try:
                    os.link(temporary, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
                except FileExistsError:
                    if not match_at(fd, name, record, target):
                        raise
                os.fsync(fd)
            finally:
                os.unlink(temporary, dir_fd=fd)
        return record
