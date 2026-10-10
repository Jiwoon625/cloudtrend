"""Offline transport boundaries: synthetic sessions only, never external I/O."""
import contextlib
import importlib.util
import io
from pathlib import Path
import traceback
import unittest
from unittest import mock

import requests


ROOT = Path(__file__).resolve().parents[1]


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


transport = load_module("private_transport_under_test", "scripts/adopted_private_transport.py")
base = load_module("private_transport_base", "scripts/run-adopted-kr-etf-job.py")
URL = transport.BUCKET_METADATA_URL
SECRET = "SYNTHETIC_SECRET_NOT_FOR_OUTPUT"


class Response:
    def __init__(self, status=200, metadata=None):
        self.status_code = status
        self.metadata = metadata if metadata is not None else {
            "id": "cloudtrend-data", "public": False, "file_size_limit": None,
            "allowed_mime_types": None,
        }
        self.closed = 0

    def json(self):
        if isinstance(self.metadata, Exception):
            raise self.metadata
        return self.metadata

    def close(self):
        self.closed += 1


class Session:
    def __init__(self, *outcomes, close_error=None):
        self.outcomes = list(outcomes)
        self.calls = []
        self.closed = 0
        self.close_error = close_error
        self.idle = False

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        if self.closed or self.idle:
            raise AssertionError("old transport reused")
        outcome = self.outcomes.pop(0)
        if callable(outcome):
            outcome = outcome(method, url, kwargs)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    def close(self):
        self.closed += 1
        if self.close_error is not None:
            raise self.close_error


class Factory:
    def __init__(self, *sessions):
        self.pending = list(sessions)
        self.created = []

    def __call__(self):
        session = self.pending.pop(0)
        self.created.append(session)
        return session


class PrivateTransportTests(unittest.TestCase):
    def setUp(self):
        # Any accidental use of a real Requests network operation fails locally.
        self.network = mock.patch.object(requests.sessions.Session, "request", side_effect=AssertionError("live I/O forbidden"))
        self.network.start()
        self.addCleanup(self.network.stop)

    def adapter(self, *sessions):
        factory, delays = Factory(*sessions), []
        adapter = transport.PrivateBucketSession(factory, sleep=delays.append)
        self.addCleanup(adapter.close)
        return adapter, factory, delays

    def read(self, adapter, **kwargs):
        return adapter.request("GET", URL, allow_redirects=False, **kwargs)

    def storage(self, adapter):
        # Bucket verification needs no identity or real credentials.
        storage = base.PrivateStorage.__new__(base.PrivateStorage)
        storage.session = adapter
        storage.headers = {"apikey": SECRET, "Authorization": "Bearer " + SECRET}
        return storage

    def test_new_session_after_idle_and_for_each_metadata_read(self):
        first_response = Response()
        initial, first, second = Session(Response()), Session(first_response), Session(Response())
        adapter, factory, delays = self.adapter(initial, first, second)
        adapter.request("GET", "https://example.invalid/input", stream=True).close()
        initial.idle = True  # Simulate hours of scoring without sleeping.
        response = self.read(adapter)
        self.assertIs(response, first_response)
        self.assertEqual(initial.closed, 1)
        self.assertEqual(len(initial.calls), 1)
        response.close()
        self.read(adapter).close()
        self.assertEqual(first.closed, 1)
        self.assertEqual(len(factory.created), 3)
        self.assertEqual(delays, [])
        adapter.close()
        self.assertEqual(second.closed, 1)
        adapter.close()
        self.assertEqual(second.closed, 1)

    def test_verified_new_connection_is_reused_for_following_object_write(self):
        bucket, uploaded = Response(), Response(201)
        session = Session(bucket, uploaded)
        adapter, factory, _ = self.adapter(session)
        self.storage(adapter).verify_private_bucket()
        data = io.BytesIO(b"synthetic-output")
        with base.safe_response(adapter, "POST", "https://example.invalid/output", data=data,
                                timeout=(20, 900), headers={"x-upsert": "false"}) as response:
            self.assertIs(response, uploaded)
        self.assertEqual(len(factory.created), 1)
        self.assertEqual([call[0] for call in session.calls], ["GET", "POST"])
        self.assertIs(session.calls[1][2]["data"], data)
        self.assertEqual((bucket.closed, uploaded.closed), (1, 1))

    def test_each_network_exception_retries_on_a_fresh_session(self):
        for error_type in (requests.ConnectionError, requests.Timeout, requests.ConnectTimeout, requests.ReadTimeout):
            with self.subTest(error=error_type.__name__):
                failed_response, success = Response(), Response()
                failed = Session(error_type(SECRET, response=failed_response))
                recovered = Session(success)
                adapter, factory, delays = self.adapter(failed, recovered)
                self.assertIs(self.read(adapter, timeout=(20, 60)), success)
                self.assertEqual((failed.closed, failed_response.closed), (1, 1))
                self.assertEqual(len(factory.created), 2)
                self.assertEqual(delays, [1])
                success.close()

    def test_retry_limit_is_three_total_attempts_and_closes_every_failed_session(self):
        sessions = [Session(requests.ReadTimeout(SECRET)) for _ in range(4)]
        adapter, factory, delays = self.adapter(*sessions)
        with self.assertRaisesRegex(transport.PrivateTransportError, "^NETWORK_OR_SESSION_ERROR$") as caught:
            self.read(adapter)
        self.assertIsNone(caught.exception.__context__)
        self.assertEqual(len(factory.created), 3)
        self.assertEqual([len(session.calls) for session in sessions], [1, 1, 1, 0])
        self.assertEqual([session.closed for session in sessions], [1, 1, 1, 0])
        self.assertEqual(delays, [1, 2])

    def test_third_attempt_can_recover(self):
        response = Response()
        adapter, factory, delays = self.adapter(Session(requests.ConnectTimeout()), Session(requests.ReadTimeout()), Session(response))
        self.assertIs(self.read(adapter), response)
        self.assertEqual(len(factory.created), 3)
        self.assertEqual(delays, [1, 2])
        response.close()

    def test_http_statuses_are_not_retried_or_changed(self):
        for status in (200, 301, 302, 400, 401, 403, 404, 429, 500, 503):
            with self.subTest(status=status):
                response = Response(status)
                adapter, factory, delays = self.adapter(Session(response))
                self.assertIs(self.read(adapter), response)
                self.assertEqual(len(factory.created), 1)
                self.assertEqual(delays, [])
                self.assertEqual(response.closed, 0)  # Caller still owns it.
                response.close()

    def test_other_destinations_and_methods_never_retry(self):
        cases = [
            ("GET", URL + "/"), ("GET", URL + "?variant=1"),
            ("GET", URL.replace("cloudtrend-data", "another-bucket")),
            ("GET", URL.replace("ahbvrtugugwnbrfnbxzp", "another-project")),
            ("GET", URL.replace("/bucket/", "/object/authenticated/")),
            ("GET", URL.replace("https://", "http://")),
            ("HEAD", URL), ("POST", URL), ("PUT", URL), ("DELETE", URL),
        ]
        for method, url in cases:
            with self.subTest(method=method, url=url):
                session = Session(requests.ReadTimeout(SECRET))
                adapter, factory, delays = self.adapter(session)
                with self.assertRaises(transport.PrivateTransportError):
                    adapter.request(method, url, allow_redirects=False)
                self.assertEqual(len(session.calls), 1)
                self.assertEqual(len(factory.created), 1)
                self.assertEqual(delays, [])

    def test_query_body_and_stream_variants_are_forwarded_without_retry(self):
        for extra in ({"params": {"variant": "1"}}, {"data": b"body"}, {"json": {}}, {"files": {}}, {"stream": True}):
            with self.subTest(extra=extra):
                session = Session(requests.ReadTimeout(SECRET))
                adapter, factory, delays = self.adapter(session)
                with self.assertRaises(transport.PrivateTransportError):
                    self.read(adapter, **extra)
                self.assertEqual(session.calls[0][2], {"allow_redirects": False, **extra})
                self.assertEqual(len(factory.created), 1)
                self.assertEqual(delays, [])

    def test_ambiguous_post_after_consuming_body_is_never_retried(self):
        body = io.BytesIO(b"once-only-result")
        consumed = []

        def fail_after_consuming(method, url, kwargs):
            consumed.append(kwargs["data"].read())
            raise requests.ConnectionError(SECRET)

        session = Session(fail_after_consuming)
        adapter, factory, delays = self.adapter(session)
        with self.assertRaisesRegex(base.JobError, "^NETWORK_OR_SESSION_ERROR$"):
            with base.safe_response(adapter, "POST", "https://example.invalid/object", data=body,
                                    headers={"Authorization": SECRET, "x-upsert": "false"}):
                self.fail("unreachable")
        self.assertEqual(consumed, [b"once-only-result"])
        self.assertEqual(len(session.calls), 1)
        self.assertEqual(len(factory.created), 1)
        self.assertEqual(delays, [])

    def test_tls_redirect_headers_and_timeout_parameters_are_preserved(self):
        failed, successful = Session(requests.ReadTimeout()), Session(Response())
        adapter, _, _ = self.adapter(failed, successful)
        headers = {"apikey": SECRET, "Authorization": "Bearer " + SECRET}
        parameters = {"allow_redirects": False, "headers": headers, "timeout": (20, 60),
                      "verify": "/synthetic/ca-bundle.pem", "cert": "/synthetic/client.pem",
                      "proxies": {"https": "https://proxy.invalid"}, "stream": False}
        adapter.request("GET", URL, **parameters).close()
        for session in (failed, successful):
            self.assertEqual(session.calls, [("GET", URL, parameters)])
            self.assertIs(session.calls[0][2]["headers"], headers)

    def test_no_redirect_or_tls_downgrade_is_permitted_for_metadata(self):
        for parameters in ({}, {"allow_redirects": True}, {"allow_redirects": False, "verify": False}):
            with self.subTest(parameters=parameters):
                adapter, factory, delays = self.adapter()
                with self.assertRaisesRegex(transport.PrivateTransportError, "^PRIVATE_METADATA_TRANSPORT_UNSAFE$"):
                    adapter.request("GET", URL, **parameters)
                self.assertEqual(factory.created, [])
                self.assertEqual(delays, [])

    def test_certificate_and_non_network_errors_fail_without_retry(self):
        for error in (requests.exceptions.SSLError(SECRET), requests.HTTPError(SECRET),
                      requests.exceptions.TooManyRedirects(SECRET), ValueError(SECRET)):
            with self.subTest(error=type(error).__name__):
                session = Session(error)
                adapter, factory, delays = self.adapter(session)
                with self.assertRaisesRegex(transport.PrivateTransportError, "^NETWORK_OR_SESSION_ERROR$"):
                    self.read(adapter)
                self.assertEqual(len(factory.created), 1)
                self.assertEqual(delays, [])
                self.assertEqual(session.closed, 1)

    def test_existing_bucket_privacy_and_schema_checks_still_fail_closed(self):
        valid = Response().metadata
        cases = [
            (200, {**valid, "public": True}, "BUCKET_NOT_PRIVATE"),
            (200, {**valid, "public": "false"}, "BUCKET_NOT_PRIVATE"),
            (200, {**valid, "id": "wrong"}, "BUCKET_NOT_PRIVATE"),
            (200, {"id": "cloudtrend-data"}, "BUCKET_NOT_PRIVATE"),
            (200, {**valid, "file_size_limit": 3}, "BUCKET_FILE_LIMIT_UNVERIFIED"),
            (200, {**valid, "file_size_limit": True}, "BUCKET_FILE_LIMIT_UNVERIFIED"),
            (200, {**valid, "allowed_mime_types": ["image/png"]}, "BUCKET_RESULT_MIME_RESTRICTED"),
            (200, [], "INVALID_SERVICE_METADATA"),
            (200, ValueError(SECRET), "INVALID_SERVICE_METADATA"),
            (403, valid, "BUCKET_METADATA_UNAVAILABLE"),
            (503, valid, "BUCKET_METADATA_UNAVAILABLE"),
        ]
        for status, metadata, code in cases:
            with self.subTest(code=code, metadata=type(metadata).__name__):
                response = Response(status, metadata)
                session = Session(response)
                adapter, factory, delays = self.adapter(session)
                with self.assertRaisesRegex(base.JobError, "^" + code + "$"):
                    self.storage(adapter).verify_private_bucket(4)
                    adapter.request("POST", "https://example.invalid/must-not-write")
                self.assertEqual([call[0] for call in session.calls], ["GET"])
                self.assertEqual(response.closed, 1)
                self.assertEqual(len(factory.created), 1)
                self.assertEqual(delays, [])

    def test_recovery_does_not_bypass_public_bucket_failure(self):
        rejected = Response(metadata={"id": "cloudtrend-data", "public": True})
        adapter, factory, delays = self.adapter(Session(requests.ReadTimeout(SECRET)), Session(rejected))
        with self.assertRaisesRegex(base.JobError, "^BUCKET_NOT_PRIVATE$"):
            self.storage(adapter).verify_private_bucket()
        self.assertEqual(rejected.closed, 1)
        self.assertEqual(len(factory.created), 2)
        self.assertEqual(delays, [1])

    def test_valid_metadata_checks_and_response_closure_still_succeed(self):
        response = Response(metadata={"id": "cloudtrend-data", "public": False,
                                      "file_size_limit": 4, "allowed_mime_types": ["application/octet-stream"]})
        adapter, _, _ = self.adapter(Session(response))
        self.storage(adapter).verify_private_bucket(4)
        self.assertEqual(response.closed, 1)

    def test_error_and_logging_surface_contains_no_private_details(self):
        output = io.StringIO()
        exception = requests.ReadTimeout(SECRET + " https://private.invalid/?token=" + SECRET)
        exception.request = requests.Request("GET", URL, headers={"Authorization": SECRET}).prepare()
        adapter, _, _ = self.adapter(*[Session(exception) for _ in range(3)])
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            try:
                self.read(adapter, headers={"Authorization": SECRET})
            except transport.PrivateTransportError as error:
                rendered = "".join(traceback.format_exception(error))
                self.assertIsNone(error.__cause__)
                self.assertIsNone(error.__context__)
                self.assertNotIn(SECRET, rendered)
                self.assertNotIn("private.invalid", rendered)
                self.assertNotIn(SECRET, repr(error))
            else:
                self.fail("expected failure")
        self.assertEqual(output.getvalue(), "")

    def test_factory_failure_is_sanitized_and_not_retried(self):
        factory = mock.Mock(side_effect=requests.ConnectionError(SECRET))
        adapter = transport.PrivateBucketSession(factory, sleep=mock.Mock())
        with self.assertRaisesRegex(transport.PrivateTransportError, "^NETWORK_OR_SESSION_ERROR$") as caught:
            self.read(adapter)
        self.assertIsNone(caught.exception.__context__)
        self.assertEqual(factory.call_count, 1)
        adapter._sleep.assert_not_called()
        adapter.close()

    def test_failed_response_cleanup_does_not_leak_or_continue_retrying(self):
        response = Response()
        response.close = mock.Mock(side_effect=RuntimeError(SECRET))
        session = Session(requests.ReadTimeout(SECRET, response=response))
        adapter, factory, delays = self.adapter(session)
        with self.assertRaisesRegex(transport.PrivateTransportError, "^NETWORK_OR_SESSION_ERROR$"):
            self.read(adapter)
        self.assertEqual(response.close.call_count, 1)
        self.assertEqual(session.closed, 1)
        self.assertEqual(len(factory.created), 1)
        self.assertEqual(delays, [])

    def test_failed_session_cleanup_does_not_leak_or_continue_retrying(self):
        session = Session(requests.ReadTimeout(SECRET), close_error=RuntimeError(SECRET))
        adapter, factory, delays = self.adapter(session)
        with self.assertRaisesRegex(transport.PrivateTransportError, "^NETWORK_OR_SESSION_ERROR$"):
            self.read(adapter)
        self.assertEqual(session.closed, 1)
        self.assertEqual(len(factory.created), 1)
        self.assertEqual(delays, [])

    def test_failure_to_close_old_idle_connection_stops_before_new_request(self):
        old = Session(Response(), close_error=RuntimeError(SECRET))
        adapter, factory, delays = self.adapter(old)
        adapter.request("GET", "https://example.invalid/input").close()
        with self.assertRaisesRegex(transport.PrivateTransportError, "^NETWORK_OR_SESSION_ERROR$"):
            self.read(adapter)
        self.assertEqual(old.closed, 1)
        self.assertEqual(len(old.calls), 1)
        self.assertEqual(len(factory.created), 1)
        self.assertEqual(delays, [])

    def test_close_failure_is_sanitized_and_close_is_idempotent(self):
        session = Session(Response(), close_error=RuntimeError(SECRET))
        adapter = transport.PrivateBucketSession(Factory(session))
        self.read(adapter).close()
        with self.assertRaisesRegex(transport.PrivateTransportError, "^PRIVATE_TRANSPORT_CLOSE_FAILED$") as caught:
            adapter.close()
        self.assertIsNone(caught.exception.__context__)
        adapter.close()
        self.assertEqual(session.closed, 1)

    def test_closing_unused_adapter_does_not_create_a_session_and_use_after_close_fails(self):
        adapter, factory, _ = self.adapter()
        adapter.close()
        with self.assertRaisesRegex(transport.PrivateTransportError, "^PRIVATE_TRANSPORT_CLOSED$"):
            self.read(adapter)
        self.assertEqual(factory.created, [])

    def test_sleep_failure_is_sanitized_and_stops_retry(self):
        session = Session(requests.ReadTimeout(SECRET))
        factory = Factory(session)
        adapter = transport.PrivateBucketSession(factory, sleep=mock.Mock(side_effect=RuntimeError(SECRET)))
        with self.assertRaisesRegex(transport.PrivateTransportError, "^NETWORK_OR_SESSION_ERROR$") as caught:
            self.read(adapter)
        self.assertIsNone(caught.exception.__context__)
        self.assertEqual(len(factory.created), 1)
        self.assertEqual(session.closed, 1)
        adapter.close()


if __name__ == "__main__":
    unittest.main()
