#!/usr/bin/env python3
import argparse
import json
from pathlib import Path

import pyarrow.compute as pc
import pyarrow.csv as csv
import pyarrow.parquet as pq


COLUMNS = [
    "symbol",
    "name",
    "market",
    "securityType",
    "date",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "tradingValue",
    "marketCap",
    "foreignNetBuyValue",
    "institutionNetBuyValue",
]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    source = Path(args.input)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)

    table = pq.read_table(source, columns=COLUMNS)
    if "securityType" not in table.column_names:
        raise RuntimeError("securityType column is required")

    mask = pc.equal(pc.utf8_upper(table["securityType"]), "ETF")
    table = table.filter(mask)

    sort_keys = [("symbol", "ascending"), ("date", "ascending")]
    table = table.sort_by(sort_keys)

    csv.write_csv(table, output)

    symbols = pc.count_distinct(table["symbol"]).as_py()
    dates = table["date"]
    first_date = pc.min(dates).as_py()
    last_date = pc.max(dates).as_py()

    print(
        json.dumps(
            {
                "rows": table.num_rows,
                "columns": table.num_columns,
                "symbols": symbols,
                "firstDate": str(first_date),
                "lastDate": str(last_date),
                "outputBytes": output.stat().st_size,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
