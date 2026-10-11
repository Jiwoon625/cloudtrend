"""Simplified, reproducible KOSPI fixed-P30 vs adjusted KODEX 200 comparison.
No dividend cash is added: source prices are accepted as adjusted (per user).
A research comparison, not proof of a certified total-return index or true historical PIT universe.
"""
from __future__ import annotations
import argparse
import csv
import json
import math
import statistics
from datetime import date
from pathlib import Path

CAPITAL = 100_000_000.0
ONE_WAY = 0.0015
PER_SLOT = CAPITAL / 30
ARMS = ["kospi_fixed_p30", "kodex200_buy_hold", "kodex200_exposure_mirror"]


def check(test, message):
    if not test:
        raise ValueError(message)


def read_jsonl(p):
    with Path(p).open(encoding="utf8") as f:
        return [json.loads(line) for line in f if line.strip()]


def calc(returns):
    if not returns:
        return None
    peak = nav = 1.0
    drawdown = 0.0
    for r in returns:
        check(math.isfinite(r) and r > -1, "Nonfinite or impossible portfolio return")
        nav *= 1 + r
        peak = max(peak, nav)
        drawdown = min(drawdown, nav / peak - 1)
    mean = statistics.mean(returns)
    vol = statistics.stdev(returns) * math.sqrt(252) if len(returns) > 1 else 0
    sharpe = mean * 252 / vol if vol > 0 else None
    cagr = nav ** (252 / len(returns)) - 1
    return dict(sessions=len(returns), total_return=nav - 1, cagr=cagr, sharpe=sharpe,
                volatility=vol, mdd=drawdown, calmar=cagr / abs(drawdown) if drawdown < 0 else None)


def make_report(stock_path: Path, etf_path: Path, budgets_path: Path, through="2026-09-11"):
    stock, etf = read_jsonl(stock_path), read_jsonl(etf_path)
    budgets = json.loads(Path(budgets_path).read_text(encoding="utf8"))
    check(stock and etf and len(stock) == len(etf), "Unmatched stock/ETF price sessions")
    dates = [row["date"] for row in stock]
    check(dates == [row["date"] for row in etf] and dates == sorted(set(dates)),
          "KOSPI and ETF sessions not aligned")
    check(dates[0] == "2017-08-21" and dates[-1] == through,
          "Unexpected study period")
    check(len(budgets) >= 9, "Missing annual budgets")
    for b in budgets:
        check(abs(float(b["budget"]) - PER_SLOT) < 1e-6,
              "Found annual-NAV re-budgeting instead of fixed initial P30")
    holdings = []
    etf_cash, etf_shares = CAPITAL, 0
    mirror_cash, mirror_shares = CAPITAL, 0.0
    stock_prev = etf_prev = mirror_prev = CAPITAL
    etf_turnover = mirror_turnover = 0.0
    etf_fees = mirror_fees = 0.0
    previous_exposure = 0.0

    for i, (s, e) in enumerate(zip(stock, etf)):
        d = s["date"]
        check(s["valuationStatus"] == "COMPLETE" and s["nav"] is not None,
              "Missing/stale stock NAV "+d)
        snav = float(s["nav"])
        scash = float(s["cash"])
        smarket = float(s["marketValue"])
        check(snav > 0 and scash >= -0.00001 and smarket >= 0 and
              abs(snav - (scash + smarket)) <= 0.001, "Stock NAV cash/mark mismatch "+d)
        op, cl = float(e["adjustedOpen"]), float(e["adjustedClose"])
        check(op > 0 and cl > 0 and math.isfinite(op+cl), "ETF missing adjusted prices "+d)
        if i == 0:
            # Buy integer ETF shares at the observed first-session open.
            etf_shares = math.floor(etf_cash / (op * (1+ONE_WAY)))
            buy = etf_shares * op
            fee = buy * ONE_WAY
            etf_cash -= buy + fee
            etf_fees += fee
            etf_turnover += buy
        # Exposure mirror has fractional model units and trades at each next open.
        # Only prior-day stock exposures influence today's ETF weight.
        before = mirror_cash + mirror_shares * op
        target = previous_exposure
        numerator = target * before - mirror_shares * op
        denominator = 1 + target * ONE_WAY if numerator >= 0 else 1 - target * ONE_WAY
        trade = numerator / denominator
        fee = abs(trade) * ONE_WAY
        mirror_cash -= trade + fee
        mirror_shares += trade / op
        check(mirror_cash >= -0.001 and mirror_shares >= -1e-8, "Mirror cash negative "+d)
        mirror_fees += fee
        mirror_turnover += abs(trade)
        enav = etf_cash + etf_shares * cl
        mnav = mirror_cash + mirror_shares * cl
        check(enav > 0 and mnav > 0, "ETF NAV below zero")
        holdings.append({
            "date":d,
            "kospi_fixed_p30":snav,
            "kodex200_buy_hold":enav,
            "kodex200_exposure_mirror":mnav,
            "stock_exposure_close":smarket / snav,
            "etf_open_adjusted":op,
            "etf_close_adjusted":cl,
            "mirror_prior_exposure_target":previous_exposure,
            "stock_ret":snav / stock_prev - 1,
            "etf_ret":enav / etf_prev - 1,
            "mirror_ret":mnav / mirror_prev - 1,
        })
        stock_prev, etf_prev, mirror_prev = snav, enav, mnav
        previous_exposure = smarket / snav
    # Restrict analysis to full 2018+ calendar years, retaining 2017 price
    # history and portfolio state (including ETF's original initial fee).
    eligible = [r for r in holdings if r["date"] >= "2018-01-02"]
    mapping = {ARMS[0]:"stock_ret", ARMS[1]:"etf_ret", ARMS[2]:"mirror_ret"}

    def slice_stats(predicate):
        subset = [row for row in eligible if predicate(row["date"])]
        return {arm:calc([row[column] for row in subset]) for arm,column in mapping.items()}

    years = {str(y):slice_stats(lambda d,y=y: d.startswith(str(y))) for y in range(2018,2027)}
    segments = {
        "2018_2024":slice_stats(lambda d:"2018"<=d[:4]<="2024"),
        "2025":slice_stats(lambda d:d.startswith("2025")),
        "2026_partial":slice_stats(lambda d:d.startswith("2026")),
        "all_2018_2026_partial":slice_stats(lambda d:True),
        "excluding_2025_daily_returns_stitched":slice_stats(lambda d:not d.startswith("2025")),
    }
    leave_one_year_out = {
        str(y):slice_stats(lambda d,y=y:not d.startswith(str(y))) for y in range(2018,2026)
    }
    # Non-overlapping years and rolling ~2yr blocks, no significance overclaim.
    rolling = {}
    for arm,col in mapping.items():
        if arm == "kospi_fixed_p30":
            continue
        shares = {"stock_total_return_higher":0,"stock_sharpe_higher":0,"windows":0}
        for last in range(504,len(eligible)+1):
            left = eligible[last-504:last]
            sm = calc([x["stock_ret"] for x in left])
            bm = calc([x[col] for x in left])
            shares["windows"] += 1
            shares["stock_total_return_higher"] += sm["total_return"] > bm["total_return"]
            shares["stock_sharpe_higher"] += (sm["sharpe"] is not None and bm["sharpe"] is not None
                                             and sm["sharpe"] > bm["sharpe"])
        rolling[arm] = {
            "windows": shares["windows"],
            "stock_total_return_higher_share": shares["stock_total_return_higher"]/max(1,shares["windows"]),
            "stock_sharpe_higher_share": shares["stock_sharpe_higher"]/max(1,shares["windows"]),
        }
    compare = {}
    for arm in ARMS[1:]:
        compare[arm] = {}
        for key in ("2018_2024","2025","excluding_2025_daily_returns_stitched","all_2018_2026_partial"):
            a = segments[key][ARMS[0]]; b = segments[key][arm]
            compare[arm][key] = {
                "stock_minus_etf_cagr_pp":(a["cagr"]-b["cagr"])*100,
                "stock_minus_etf_sharpe":None if a["sharpe"] is None or b["sharpe"] is None else a["sharpe"]-b["sharpe"],
                "stock_mdd_smaller":a["mdd"]>b["mdd"],
                "stock_has_higher_sharpe":a["sharpe"] is not None and b["sharpe"] is not None and a["sharpe"]>b["sharpe"],
            }
    result = {
        "status":"RESEARCH_COMPARISON_COMPLETE",
        "investment_verdict":"Historical simple comparison; not PIT/OOS investment proof",
        "policy":"2026-10-12 adopted KOSPI signals, initial KRW100m / 30 fixed per-entry budget",
        "price_policy":"Toss/KRX adjusted OHLC; no additional cash dividends/distributions (per CM research interpretation)",
        "period":{"input_start":dates[0],"analysis_start":eligible[0]["date"],"end":dates[-1],"sessions":len(eligible)},
        "model_cost_one_way":ONE_WAY,
        "base_currency":"KRW",
        "annualization":"252 sessions; annualized Sharpe with risk-free rate 0",
        "etf_execution":"KODEX200 069500 entry at first observed open, integer shares, 0.15% model entry cost, no terminal liquidation",
        "exposure_mirror":"prior-day stock invested fraction, ETF/cash, fractional synthetic units, daily next-open rebalancing with 0.15% cost",
        "notes":["2017 pre-analysis portfolio history is retained.",
                 "2025-removal is a non-executable stitch of daily returns; not a replay skipping 2025.",
                 "Current retrospective universe and corporate action adjusted-price assumptions were not independently PIT-audited.",
                 "Actual ETF distribution cash is not added again to adjusted prices."],
        "segments":segments,"annual":years,"leave_one_calendar_year_out":leave_one_year_out,
        "rolling_two_year":rolling,"comparisons":compare,
        "fees_and_turnover":{"etf_buy_hold":{"fees":etf_fees,"turnover":etf_turnover},
                            "etf_exposure_mirror":{"fees":mirror_fees,"turnover":mirror_turnover}},
        "source_observations":len(holdings),
    }
    return result, holdings


def main():
    p=argparse.ArgumentParser()
    p.add_argument("--results",type=Path,required=True)
    p.add_argument("--output",type=Path,required=True)
    args=p.parse_args()
    r=args.results
    report, nav=make_report(r/"KOSPI_FIXED_P30.daily-nav.jsonl",
                            r/"KODEX200_069500.adjusted-daily.jsonl",
                            r/"KOSPI_FIXED_P30.yearly-budgets.json")
    args.output.mkdir(parents=True,exist_ok=False)
    (args.output/"comparison.json").write_text(json.dumps(report,ensure_ascii=False,indent=2,allow_nan=False)+"\n",encoding="utf8")
    with (args.output/"daily-comparison.csv").open("w",encoding="utf8",newline="") as out:
        writer=csv.DictWriter(out,fieldnames=list(nav[0]))
        writer.writeheader();writer.writerows(nav)
    brief={"status":report["status"],"period":report["period"],"segments":report["segments"],
           "comparisons":report["comparisons"]}
    (args.output/"brief.json").write_text(json.dumps(brief,ensure_ascii=False,indent=2,allow_nan=False)+"\n",encoding="utf8")
    # Aggregate numeric output contains no personal trade/holding detail.
    print(json.dumps(brief,ensure_ascii=False,allow_nan=False))


if __name__=="__main__":
    main()
