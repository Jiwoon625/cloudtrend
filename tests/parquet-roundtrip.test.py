import csv
import importlib.util
import tempfile
from pathlib import Path
import pyarrow.parquet as pq

spec = importlib.util.spec_from_file_location("converter", "scripts/csv-to-parquet.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as temp:
    source, target = Path(temp)/"input.csv", Path(temp)/"out.parquet"
    rows = [["symbol", "empty", "precise", "name", "extra"],
            ["005930", "", "12345678901234567890.001", '한글, "인용"\n다음행', "NA"],
            ["0193T0", "", "0.0", "ETF", "null"]]
    with source.open("w", encoding="utf-8-sig", newline="") as f:
        csv.writer(f).writerows(rows)
    info = module.convert(source,target)
    restored = pq.read_table(target).to_pydict()
    assert info["roundtripVerified"] and info["rowCount"] == 2
    assert [list(values) for values in zip(*restored.values())] == rows[1:]
print("PASS: every cell, blank, Unicode, quotes/newlines, symbol zeros and numeric precision preserved")
