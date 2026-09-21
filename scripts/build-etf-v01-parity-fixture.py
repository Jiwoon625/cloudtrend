"""Build parity inputs from existing research artifacts; no raw-source downloads.

Checks external environment only: clean panel lacks original high/low and daily
turnover, so substituted OHLC/turnover must never be used for total-score parity.
"""
import argparse
import json
from pathlib import Path
import pandas as pd

p = argparse.ArgumentParser()
p.add_argument('--clean', required=True)
p.add_argument('--adopted', required=True)
p.add_argument('--output', required=True)
a = p.parse_args()
d = pd.read_parquet(a.clean)
e = pd.read_parquet(a.adopted)
mapping = json.loads(Path('src/lib/engine/etfResearchMapping.json').read_text())
dates = sorted(d.date.unique())
ds = dict(provider='RESEARCH_FIXTURE', version='20260911', asOfDate='2026-09-11', isLive=False,
          capabilities={}, notes=[], sectors=[], tradeDates=dates[-170:], instruments=[], bars={},
          indexSeries=[], financials={}, etfFacts={}, vkospiSeries=[])
for sym, g in d.groupby('symbol'):
    g = g.tail(170)
    row, m = g.iloc[-1], mapping[sym]
    ds['instruments'].append(dict(id=sym, symbol=sym, name=row['name'], instrumentType='ETF', market='ETF',
        sectorCode=m['sectorCode'], sectorName=m['sectorCode'], isPreferredStock=False, isManagementIssue=False,
        isInvestmentWarning=False, isLeveraged=False, isInverse=False, isActive=True, indexMemberships=[]))
    ds['bars'][sym] = [dict(tradeDate=r.date, open=r.open, close=r.close, high=r.close, low=r.close,
        volume=100, tradingValue=r.healthTv20, marketCap=r.etfMarketCap, foreignNetBuyValue=None,
        institutionNetBuyValue=None, etfUnderlyingIndexClose=r.etfUnderlyingIndexClose,
        etfMarketCap=r.etfMarketCap, etfTradingValue=r.healthTv20, priceSource='TOSS_ADJUSTED_CANDLE',
        marketCapSource='KRX_ETF', tradingValueSource='KRX_ETF') for r in g.itertuples()]
expected = e[(e.date == '2026-09-11') & e.environmentSource.ne('domestic_stock_sector')][
    ['symbol', 'environmentScore', 'environmentSource', 'uMa60']].to_dict('records')

def clean(x):
    if isinstance(x, float) and not pd.notna(x): return None
    if isinstance(x, dict): return {k: clean(v) for k, v in x.items()}
    if isinstance(x, list): return [clean(v) for v in x]
    return x

Path(a.output).write_text(json.dumps(clean(dict(dataset=ds, expected=expected)), ensure_ascii=False))
