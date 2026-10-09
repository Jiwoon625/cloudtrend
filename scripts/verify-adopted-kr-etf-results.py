#!/usr/bin/env python3
"""Independent Decimal cash/fees/NAV and return checks. Reads only local research outputs."""
from __future__ import annotations
import argparse
from collections import defaultdict
from datetime import date
from decimal import Decimal, ROUND_CEILING, ROUND_DOWN
import json
import math
from pathlib import Path

D = lambda value: Decimal(str(value))
UNIT = D('0.00000001')
INITIAL = D('100000000')
RATE = D('0.0015')

def require(ok, message):
    if not ok:
        raise ValueError(message)

def fee(gross):
    return (gross * RATE).quantize(UNIT, rounding=ROUND_CEILING)

def read_lines(path):
    return [json.loads(row) for row in path.read_text().splitlines() if row]

def verify(root: Path):
    summary = json.loads((root / 'summary.json').read_text())
    result = {'schema': 'adopted-kr-etf-independent-verification-v1', 'status': 'PASS', 'books': {}}
    for book, stats in summary.items():
        require(book in {'ETF_V02', 'KR_COMBINED_ADOPTED', 'KOSPI_STANDALONE_DIAGNOSTIC', 'KOSDAQ_STANDALONE_DIAGNOSTIC'}, 'Unexpected book')
        rows = read_lines(root / f'{book}.daily-nav.jsonl')
        trades = read_lines(root / f'{book}.trades.jsonl')
        delta, fees = defaultdict(Decimal), defaultdict(Decimal)
        if book == 'ETF_V02':
            annual = json.loads((root / f'{book}.yearly-budgets.json').read_text())
            require(annual['policy'] == 'ANNUAL_NAV_VOLATILITY_SIGNAL_YEAR_V1' and annual['yearlyReset'] is True, 'ETF annual policy mismatch')
            years = {b['year']: b for b in annual['years']}
            by_date = {row['date']: row for row in rows}
            for b in years.values():
                nav = INITIAL if b['valuationDate'] is None else D(by_date[b['valuationDate']]['nav'])
                require(nav == D(b['nav']), 'ETF annual prior-close asset mismatch')
                require(b['valuationDate'] is None or b['valuationDate'] < b['effectiveDate'], 'ETF asset lookahead')
                first = next(i for i, r in enumerate(rows) if int(r['date'][:4]) == b['year'])
                require(b['effectiveDate'] == rows[first]['date'], 'ETF asset reset not on first session')
                require(b['valuationDate'] == (rows[first-1]['date'] if first else None), 'ETF asset base not immediately prior close')
                require(not first or rows[first-1]['valuationStatus'] == 'COMPLETE', 'ETF annual stale asset base')
            running_cash = INITIAL
            for t in trades:
                quantity = D(t['quantity'])
                require(quantity > 0 and quantity == int(quantity), 'Noninteger ETF quantity')
                gross = quantity * D(t['price'])
                cost = fee(gross)
                require(gross == D(t['gross']) and cost == D(t['fee']), 'ETF amount or fee mismatch')
                if t['side'] == 'BUY':
                    b = years[int(t['signalDate'][:4])]
                    require(t['researchBudgetYear'] == b['year'] and t['budgetNavDate'] == b['valuationDate'], 'ETF pending budget year mismatch')
                    budget = (D(b['nav']) * D(t['researchEntryWeight'])).quantize(UNIT, rounding=ROUND_DOWN)
                    require(budget == D(t['targetBudget']), 'ETF annual weighted budget mismatch')
                    require(quantity == int(min(budget, running_cash) / (D(t['price']) * (1+RATE))), 'ETF integer sizing mismatch')
                change = (-gross if t['side'] == 'BUY' else gross) - cost
                running_cash += change
                require(running_cash >= 0, 'ETF intraday overspend')
                require(change == D(t['cashDelta']), 'ETF fill cash mismatch')
                delta[t['executionDate']] += change
                fees[t['executionDate']] += cost
        else:
            accounting = json.loads((root / f'{book}.accounting.json').read_text())
            for t in trades:
                quantity = D(t['shares'])
                require(quantity > 0 and quantity == int(quantity), 'Noninteger KR quantity')
                gross = quantity * D(t['entryPrice'])
                cost = fee(gross)
                require(cost == D(accounting['fees'][t['id']]['entry']), 'KR entry fee mismatch')
                require(abs(D(t['entryFee']) - cost) <= D('0.00001'), 'KR legacy fee representation mismatch')
                delta[t['entryDate']] -= gross + cost
                fees[t['entryDate']] += cost
                if t['status'] == 'CLOSED':
                    exit_gross = quantity * D(t['exitPrice'])
                    exit_fee = fee(exit_gross)
                    require(exit_fee == D(accounting['fees'][t['id']]['exit']), 'KR exit fee mismatch')
                    delta[t['exitDate']] += exit_gross - exit_fee
                    fees[t['exitDate']] += exit_fee
            budgets = json.loads((root / f'{book}.yearly-budgets.json').read_text())
            by_date = {row['date']: row for row in rows}
            for b in budgets:
                nav = INITIAL if b['valuationDate'] is None else D(by_date[b['valuationDate']]['nav'])
                require(nav == D(b['nav']) and (nav / 30).quantize(UNIT, rounding=ROUND_DOWN) == D(b['budget']), 'Annual prior-close budget mismatch')
                require(b['valuationDate'] is None or b['valuationDate'] < b['effectiveDate'], 'Budget lookahead')
                first = next(i for i, r in enumerate(rows) if int(r['date'][:4]) == b['year'])
                require(b['effectiveDate'] == rows[first]['date'], 'Budget not reset at first session')
                require(b['valuationDate'] == (rows[first-1]['date'] if first else None), 'KR budget base not immediately prior close')
                require(not first or rows[first-1]['valuationStatus'] == 'COMPLETE', 'KR annual stale asset base')
            years = {b['year']: b for b in budgets}
            timing = json.loads((root / f'{book}.evidence.json').read_text())['exitTiming']
            events = defaultdict(list)
            for index, t in enumerate(trades):
                require(t['signalDate'] < t['entryDate'], 'KR entry before confirmed signal')
                events[t['entryDate']].append((1, index, 'BUY', t))
                if t['status'] == 'CLOSED':
                    require(timing.get(t['id']) in ('OPEN', 'CLOSE'), 'KR exit timing missing')
                    events[t['exitDate']].append((0 if timing[t['id']] == 'OPEN' else 2, index, 'SELL', t))
            running_cash, held = INITIAL, set()
            for r in rows:
                for _, _, side, t in sorted(events.pop(r['date'], []), key=lambda event: event[:2]):
                    quantity = D(t['shares'])
                    if side == 'BUY':
                        b = years[int(t['signalDate'][:4])]
                        budget, price = D(b['budget']), D(t['entryPrice'])
                        require(abs(D(t['targetAmount'])-budget) <= D('0.000001'), 'KR signal-year target mismatch')
                        require(quantity == int(min(budget, running_cash) / (price*(1+RATE))), 'KR integer sizing mismatch')
                        gross = price*quantity
                        running_cash -= gross + fee(gross)
                        require(t['id'] not in held, 'KR duplicate entry')
                        held.add(t['id'])
                    else:
                        require(t['id'] in held, 'KR exit before entry')
                        gross = D(t['exitPrice'])*quantity
                        running_cash += gross-fee(gross)
                        held.remove(t['id'])
                    require(running_cash >= 0, 'KR intraday overspend')
                require(running_cash == D(r['cash']), 'KR intraday cash reconciliation mismatch')
                require(len(held) == r['openPositions'], 'KR position count mismatch')
            require(not events, 'KR event outside NAV period')
        cash, peak, mdd = INITIAL, INITIAL, D(0)
        missing = stale = 0
        previous = None
        for r in rows:
            require(previous is None or previous < r['date'], 'Dates not strictly increasing')
            previous = r['date']
            cash += delta.pop(r['date'], D(0))
            require(cash >= 0 and cash == D(r['cash']), 'Negative cash or cash reconciliation mismatch')
            require((r.get('openPositions', r.get('positionCount', 0))) <= (10 if book == 'ETF_V02' else 30), 'Slot cap exceeded')
            if book == 'ETF_V02':
                require(D(r['fees']) == fees[r['date']], 'ETF daily fees mismatch')
            stale += r['valuationStatus'] == 'STALE'
            missing += r['nav'] is None or r['valuationStatus'] == 'MISSING'
            if r['nav'] is not None:
                nav = D(r['nav'])
                require(nav == cash + D(r['marketValue']), 'NAV cash plus mark mismatch')
                peak = max(peak, nav)
                mdd = min(mdd, nav / peak - 1)
        require(not delta, 'Fill outside NAV period')
        require(stats['observations'] == len(rows) and stats['missingValuationCount'] == missing and stats['staleValuationCount'] == stale, 'Coverage summary mismatch')
        if stats['status'] == 'COMPLETE':
            require(not missing and not stale and len(rows) > 1, 'Incomplete metrics published')
            final = D(rows[-1]['nav'])
            days = (date.fromisoformat(rows[-1]['date']) - date.fromisoformat(stats['startDate'])).days
            expected = {'cumulativeReturn': float(final / INITIAL - 1), 'mdd': float(mdd),
                        'cagr': -1 if final == 0 else math.expm1(math.log(float(final / INITIAL)) * 365.2425 / days)}
            for key, value in expected.items():
                require(math.isclose(stats[key], value, rel_tol=1e-10, abs_tol=1e-10), 'Performance metric mismatch')
        else:
            require(all(stats[k] is None for k in ('cagr', 'mdd', 'cumulativeReturn')), 'Incomplete run published performance')
        result['books'][book] = {'dailyCashReconciled': len(rows), 'tradeRowsChecked': len(trades), 'feesVerified': True,
                                'navCashPlusMarksVerified': True, 'metricsVerified': stats['status'] == 'COMPLETE',
                                'annualBudgetsVerified': True}
    with (root / 'verification.json').open('x') as stream:
        json.dump(result, stream, sort_keys=True, indent=2)
        stream.write('\n')
    return result

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--results', required=True)
    args = parser.parse_args()
    verify(Path(args.results))
    print('Independent arithmetic verification passed')
