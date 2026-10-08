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
        self.assertIs(request["hybrid_shared_us_analysis"], False)

    def test_exact_sparse_registered_ids(self):
        raw = {
            "request_id": "representative-300-sparse",
            "mode": "run", "stage": "fine", "offset": 0,
            "count": 2, "max_seconds": 3000, "workers": 2,
            "ids": "F10_K000_E000_U040_C060,F10_K000_E010_U080_C010",
        }
        result = validate_request(raw)
        self.assertEqual(result["ids"], raw["ids"])
        self.assertEqual(result["workers"], 2)
        self.assertEqual(validate_request({**raw, "ids": ""})["ids"], "")
        for change in (
            {"ids": "F10_K000_E000_U040_C060"},
            {"ids": "F10_K000_E000_U040_C060,F10_K000_E000_U040_C060"},
            {"ids": "NOT_REGISTERED,F10_K000_E010_U080_C010"},
            {"stage": "split25"},
            {"offset": 4},
            {"ids": "F10_K000_E000_U040_C060,XX;malicious"},
        ):
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_request({**raw, **change})

    def test_hybrid_2x2_requires_four_static_base_candidates(self):
        raw = {
            "request_id": "hybrid-v4b-2x2",
            "mode": "run", "stage": "base", "offset": 7,
            "count": 4, "max_seconds": 3000, "workers": 2,
            "hybrid_shared_us_analysis": True,
        }
        self.assertIs(validate_request(raw)["hybrid_shared_us_analysis"], True)
        self.assertIs(validate_request({**raw, "hybrid_shared_us_analysis": False})["hybrid_shared_us_analysis"], False)
        # A mixed static/dynamic base selection must not reach checkpoint or input restore.
        for change in (
            {"mode": "preflight"},
            {"stage": "fine"},
            {"stage": "split25"},
            {"stage": "references"},
            {"count": 2},
            {"workers": 1},
            {"workers": 4},
            {"offset": 40},
            {"offset": 50},
            {"offset": 51},
            {"hybrid_shared_us_analysis": "true"},
            {"hybrid_shared_us_analysis": 1},
            {"hybrid_shared_us_analysis": None},
        ):
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_request({**raw, **change})
        # Exact sparse static base IDs can also use the same preregistered engine.
        named = {**raw, "offset": 0,
                 "ids": "S08,S09,Q_K000_E000_U000_C100,Q_K000_E000_U025_C075"}
        self.assertEqual(validate_request(named)["ids"], named["ids"])
        with self.assertRaises(ValueError):
            validate_request({**named, "ids": "S08,S09,O1,O2"})

    def test_hybrid_2x2_request_writes_explicit_lowercase_boolean(self):
        from cmresearchengine.dispatch import main
        with tempfile.TemporaryDirectory() as tmp:
            request_path = Path(tmp) / "request.json"
            output_path = Path(tmp) / "github_output"
            raw = {
                "request_id": "hybrid-from-file", "mode": "run", "stage": "base",
                "offset": 7, "count": 4, "max_seconds": 3000,
                "workers": 2, "hybrid_shared_us_analysis": True,
            }
            request_path.write_text(json.dumps(raw), encoding="utf-8")
            main(["--request-file", str(request_path), "--github-output", str(output_path)])
            self.assertIn("hybrid_shared_us_analysis=true", output_path.read_text())
            output_path.unlink()
            main(["--request-id", "hybrid-manual", "--mode", "run",
                  "--stage", "base", "--offset", "7", "--count", "4",
                  "--max-seconds", "3000", "--workers", "2",
                  "--hybrid-shared-us-analysis", "true",
                  "--github-output", str(output_path)])
            self.assertIn("hybrid_shared_us_analysis=true", output_path.read_text())

    def test_four_workers_are_explicitly_bounded(self):
        request = validate_request({
            "request_id": "parallel-4",
            "mode": "run",
            "stage": "base",
            "offset": 0,
            "count": 4,
            "max_seconds": 6000,
            "workers": 4,
        })
        self.assertEqual(request["workers"], 4)
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
                "request_id": "parallel-too-many-workers",
                "mode": "run",
                "stage": "base",
                "offset": 0,
                "count": 5,
                "max_seconds": 6000,
                "workers": 5,
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
        self.assertIn("CM_IDS", workflow)
        self.assertIn("--ids", workflow)
        self.assertIn("MANUAL_HYBRID_SHARED_US_ANALYSIS", workflow)
        self.assertIn("CM_HYBRID_SHARED_US_ANALYSIS", workflow)
        self.assertIn("cmd+=(--hybrid-shared-us-analysis)", workflow)
        self.assertIn("default: false", workflow)


if __name__ == "__main__":
    unittest.main()
