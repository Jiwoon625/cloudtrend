import json
from pathlib import Path

from pykrx import stock

DATES = ["20180615", "20220615", "20250616"]
TARGET_NAMES = {"코스닥150", "코스닥 150", "KRX300", "KRX 300"}


def find_targets(date: str):
    found = {}
    for market in ["KOSDAQ", "KRX"]:
        for ticker in stock.get_index_ticker_list(date=date, market=market):
            name = stock.get_index_ticker_name(ticker)
            normalized = name.replace(" ", "")
            if normalized in {"코스닥150", "KRX300"}:
                found[normalized] = ticker
    return found


def main():
    targets = find_targets("20250616")
    out = {"targets": targets, "snapshots": []}
    for date in DATES:
        row = {"date": date, "indexes": {}}
        for name, ticker in targets.items():
            try:
                members = stock.get_index_portfolio_deposit_file(ticker, date=date)
                row["indexes"][name] = {
                    "ticker": ticker,
                    "count": len(members),
                    "sample": list(members[:10]),
                }
            except Exception as exc:
                row["indexes"][name] = {"ticker": ticker, "error": repr(exc)}
        out["snapshots"].append(row)
    Path("analysis-runs").mkdir(exist_ok=True)
    Path("analysis-runs/v8-index-membership-probe.json").write_text(json.dumps(out, ensure_ascii=False, indent=2))
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
