from pathlib import Path
import json
import tempfile
import unittest

from cmresearchengine.dispatch import validate_request


class DispatchRequestTests(unittest.TestCase):
    def test_s05_request_is_valid(self):
        request = validate_request({
            "request_id": "s05-1",
            "mode": "run",
            "stage": "base",
            "offset": 4,
            "count": 1,
            "max_seconds": 3000,
        })
        self.assertEqual(request["stage"], "base")
        self.assertEqual(request["offset"], 4)
        self.assertEqual(request["count"], 1)
        self.assertEqual(request["workers"], 1)

    def test_two_workers_are_explicitly_bounded(self):
        request = validate_request({
            "request_id": "parallel-2",
            "mode": "run",
            "stage": "base",
            "offset": 0,
            "count": 2,
            "max_seconds": 6000,
            "workers": 2,
        })
        self.assertEqual(request["workers"], 2)
        with self.assertRaises(ValueError):
            validate_request({
                "request_id": "parallel-bad",
                "mode": "run",
                "stage": "base",
                "offset": 0,
                "count": 1,
                "max_seconds": 6000,
                "workers": 2,
            })
        with self.assertRaises(ValueError):
            validate_request({
                "request_id": "parallel-bad",
                "mode": "run",
                "stage": "base",
                "offset": 0,
                "count": 3,
                "max_seconds": 6000,
                "workers": 3,
            })

    def test_bounds_and_unknown_fields_fail_closed(self):
        with self.assertRaises(ValueError):
            validate_request({
                "request_id": "bad",
                "mode": "run",
                "stage": "base",
                "offset": 0,
                "count": 17,
                "max_seconds": 3000,
            })
        with self.assertRaises(ValueError):
            validate_request({
                "request_id": "bad",
                "mode": "run",
                "stage": "base",
                "offset": 0,
                "count": 1,
                "max_seconds": 3000,
                "secret": "never-allowed",
            })

    def test_push_trigger_is_narrowly_scoped(self):
        root = Path(__file__).resolve().parents[3]
        workflow = (root / ".github/workflows/cmresearchengine-run.yml").read_text()
        self.assertIn("push:", workflow)
        self.assertIn("research/cmresearchengine/DISPATCH_REQUEST.json", workflow)
        self.assertIn("cmresearchengine.dispatch", workflow)
        self.assertIn("workflow_dispatch:", workflow)
        self.assertIn("MANUAL_WORKERS", workflow)
        self.assertIn("CM_WORKERS", workflow)


if __name__ == "__main__":
    unittest.main()
