"""Narrow, credential-free transport recovery for the existing private bucket gate.

Wrap a zero-argument session factory with ``PrivateBucketSession(session_factory)``.
The factory must produce a new, equivalently configured session each time. Request
arguments, responses, TLS configuration, and the caller's bucket checks are left
intact. Only the exact metadata GET rotates the connection and retries network
failures. Object reads and writes are never retried by this module.
"""
from __future__ import annotations

import time

import requests


BUCKET_METADATA_URL = "https://ahbvrtugugwnbrfnbxzp.supabase.co/storage/v1/bucket/cloudtrend-data"
BUCKET_ATTEMPTS = 3
RETRY_DELAYS = (1, 2)


class PrivateTransportError(RuntimeError):
    """Fixed-code failure; never includes request data or exception details."""


class PrivateBucketSession:
    """Small request/close adapter; successful responses remain caller-owned.

    A fresh session is opened even for the first metadata read after a long idle
    scoring phase. It remains available for the immediately following requests.
    The caller must close each response before its next request, as safe_response
    already does. There is no auth refresh, credential creation, or HTTP-status
    retry. In particular, certificate failures fail closed without retrying.
    """

    def __init__(self, session_factory=None, *, sleep=time.sleep):
        self._session_factory = requests.Session if session_factory is None else session_factory
        self._sleep = sleep
        self._session = None
        self._closed = False

    def _discard_session(self):
        session, self._session = self._session, None
        try:
            if session is not None:
                session.close()
        except Exception:
            return False
        return True

    def _attempt(self, method, url, kwargs, *, fresh):
        request_started = False
        try:
            if fresh and not self._discard_session():
                return None, False
            if self._session is None:
                self._session = self._session_factory()
            request_started = True
            return self._session.request(method, url, **kwargs), False
        except Exception as error:
            retryable = request_started and isinstance(error, (requests.ConnectionError, requests.Timeout)) and not isinstance(
                error, requests.exceptions.SSLError)
            try:
                # Requests may attach a response even when request() raises.
                response = getattr(error, "response", None)
                if response is not None:
                    response.close()
            except Exception:
                retryable = False
            if not self._discard_session():
                retryable = False
        # Return outside the except block: no exception object/context is kept.
        return None, retryable

    def request(self, method, url, **kwargs):
        if self._closed:
            raise PrivateTransportError("PRIVATE_TRANSPORT_CLOSED")
        metadata = method == "GET" and url == BUCKET_METADATA_URL
        if metadata and (kwargs.get("allow_redirects") is not False or kwargs.get("verify", True) is False):
            raise PrivateTransportError("PRIVATE_METADATA_TRANSPORT_UNSAFE")
        # Do not retry a caller's query variant, body, or streamed request. The
        # existing bucket gate supplies none of these; forward all kwargs intact.
        retry_metadata = metadata and not kwargs.get("params") and all(
            kwargs.get(key) is None for key in ("data", "json", "files")) and not kwargs.get("stream")
        for attempt in range(BUCKET_ATTEMPTS if retry_metadata else 1):
            response, retryable = self._attempt(method, url, kwargs, fresh=metadata)
            if response is not None:
                return response
            if not retry_metadata or not retryable or attempt + 1 == BUCKET_ATTEMPTS:
                raise PrivateTransportError("NETWORK_OR_SESSION_ERROR")
            failed_sleep = False
            try:
                self._sleep(RETRY_DELAYS[attempt])
            except Exception:
                failed_sleep = True
            if failed_sleep:
                raise PrivateTransportError("NETWORK_OR_SESSION_ERROR")

    def close(self):
        if self._closed:
            return
        self._closed = True
        if not self._discard_session():
            raise PrivateTransportError("PRIVATE_TRANSPORT_CLOSE_FAILED")
