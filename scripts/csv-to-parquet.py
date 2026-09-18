#!/usr/bin/env python3
import json
import os
import sys

import duckdb


def quote(path: str) -> str:
    return path.replace("'", "''")


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: csv-to-parquet.py <input.csv> <output.parquet>")

    input_path = os.path.abspath(sys.argv[1])
    output_path = os.path.abspath(sys.argv[2])
    con = duckdb.connect()
    source = quote(input_path)
    target = quote(output_path)

    con.execute(
        f"""
        COPY (
          SELECT *
          FROM read_csv_auto(
            '{source}',
            header=true,
            all_varchar=true,
            sample_size=-1
          )
        )
        TO '{target}'
        (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)
        """
    )
    row_count = con.execute(
        f"SELECT COUNT(*) FROM read_parquet('{target}')"
    ).fetchone()[0]
    column_count = len(
        con.execute(f"DESCRIBE SELECT * FROM read_parquet('{target}')").fetchall()
    )
    print(
        json.dumps(
            {
                "rowCount": int(row_count),
                "columnCount": int(column_count),
                "compression": "zstd",
                "sizeBytes": os.path.getsize(output_path),
            }
        )
    )


if __name__ == "__main__":
    main()
