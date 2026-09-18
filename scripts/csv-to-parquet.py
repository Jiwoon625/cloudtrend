#!/usr/bin/env python3
"""Preserve every CSV cell as a string, including empty values and symbol zeros."""
import csv
import json
import sys
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq


def convert(source, target):
    with open(source, encoding="utf-8-sig", newline="") as stream:
        reader = csv.reader(stream, strict=True)
        columns = next(reader)
        if len(set(columns)) != len(columns):
            raise ValueError("Duplicate CSV column names")
        rows = [row for row in reader if row]
    if any(len(row) != len(columns) for row in rows):
        raise ValueError("CSV row width mismatch")
    table = pa.Table.from_arrays(
        [pa.array([row[i] for row in rows], type=pa.string()) for i in range(len(columns))],
        names=columns,
    )
    pq.write_table(table, target, compression="zstd", compression_level=9, row_group_size=100000)
    restored = pq.read_table(target)
    if not table.equals(restored):
        raise ValueError("Parquet cell-by-cell roundtrip mismatch")
    return {"rowCount": table.num_rows, "columnCount": table.num_columns,
            "compression": "zstd", "roundtripVerified": True,
            "sizeBytes": Path(target).stat().st_size}


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: csv-to-parquet.py <input.csv> <output.parquet>")
    print(json.dumps(convert(sys.argv[1], sys.argv[2])))
