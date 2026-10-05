"""Parity tests for the bounded monthly panel read fast-path."""
from pathlib import Path
import hashlib
import json
import sys
import tempfile
import unittest
from unittest.mock import patch

import pandas as pd

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from cmresearchengine import runtime
runtime.activate()
from cm06_comparison_panels import MonthlyDayPanels, panel_records


class MonthlyPanelFastPathTests(unittest.TestCase):
    def test_repeated_session_reads_preserve_values_and_avoid_reparse(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            part=root/"2020-01.parquet"
            part.write_bytes(b"synthetic-placeholder")
            part_hash=hashlib.sha256(part.read_bytes()).hexdigest()
            sessions=["2020-01-02","2020-01-03"]
            manifest={
                "status":"COMPLETE_NORMALIZED_INPUTS",
                "months":{"2020-01":{
                    "path":part.name,
                    "sha256":part_hash,
                    "rows":4,
                    "sessions":sessions,
                }},
            }
            manifest_path=root/"manifest.json"
            manifest_path.write_text(json.dumps(manifest,sort_keys=True),encoding="utf-8")
            manifest_hash=hashlib.sha256(manifest_path.read_bytes()).hexdigest()
            frame=pd.DataFrame([
                {"session_date":"2020-01-02","symbol":"A","available_at":"2020-01-02T07:00:00+00:00","comparison_open":10.0,"comparison_close":11.0,"market":"US","currency":"USD"},
                {"session_date":"2020-01-02","symbol":"B","available_at":"2020-01-02T07:00:00+00:00","comparison_open":20.0,"comparison_close":None,"market":"US","currency":"USD"},
                {"session_date":"2020-01-03","symbol":"A","available_at":"2020-01-03T07:00:00+00:00","comparison_open":12.0,"comparison_close":13.0,"market":"US","currency":"USD"},
                {"session_date":"2020-01-03","symbol":"B","available_at":"2020-01-03T07:00:00+00:00","comparison_open":21.0,"comparison_close":22.0,"market":"US","currency":"USD"},
            ])
            with patch("cm06_comparison_panels.pd.read_parquet",return_value=frame) as read:
                panels=MonthlyDayPanels(manifest_path,manifest_hash)
                first=panel_records(panels,"2020-01-02")
                second=panel_records(panels,"2020-01-02")
                self.assertEqual(first,second)
                self.assertIsNone(first[1]["comparison_close"])
                self.assertEqual(first[0]["available_at"],"2020-01-02T07:00:00+00:00")
                self.assertEqual(read.call_count,1)
                self.assertEqual(panels.loads,1)
                other=panel_records(panels,"2020-01-03")
                self.assertEqual(len(other),2)
                self.assertEqual(read.call_count,1)


if __name__=="__main__":
    unittest.main()
