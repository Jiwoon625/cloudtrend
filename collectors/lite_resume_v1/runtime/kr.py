"""Exact date joins using the existing shared KRX daily adapter."""
import io
from .state import canonical, digest


def enrich_dates(frame, dates, ns):
    import pandas as pd
    out = frame.copy()
    wanted = set(dates)
    if not wanted:
        return out
    for col in ('marketCap', 'listedShares', 'marketCapSource'):
        if col not in out:
            out[col] = pd.NA
    stock = out.securityType.astype(str).eq('STOCK') & out.date.astype(str).isin(wanted)
    # One shared provider request per date/market. No symbol-level duplicate calls.
    for (day, market), target in out.loc[stock].groupby(['date', 'market'], sort=True):
        if market not in ('KOSPI', 'KOSDAQ'):
            raise ValueError('Unknown stock market')
        daily = ns['get_krx_market_cap_market_day'](day, market)
        if daily.empty:
            continue  # unpublished is missing, never a fabricated zero
        if not daily.date.astype(str).eq(str(day)).all() or daily.symbol.duplicated().any():
            raise ValueError('KRX date/identity mismatch')
        daily = daily.set_index('symbol')
        for column, source in [('marketCap', 'krxLatestMarketCap'), ('listedShares', 'krxLatestListedShares')]:
            values = pd.to_numeric(target.symbol.map(daily[source]), errors='coerce')
            valid = values.notna() & values.gt(0)
            out.loc[values.index[valid], column] = values[valid]
        valid_cap = pd.to_numeric(out.loc[target.index, 'marketCap'], errors='coerce').gt(0)
        out.loc[target.index[valid_cap], 'marketCapSource'] = 'KRX_STOCK'
    etf = out.securityType.astype(str).eq('ETF') & out.date.astype(str).isin(wanted)
    fields = ('marketCap', 'listedShares', 'etfNav', 'etfMarketCap', 'etfListedUnits',
              'etfNetAssetTotalAmount', 'etfUnderlyingIndexClose', 'etfUnderlyingIndexName', 'tradingValue')
    for day, target in out.loc[etf].groupby('date', sort=True):
        daily = ns['official_day']('ETF', day)
        if daily.empty:
            continue
        if not daily.date.astype(str).eq(str(day)).all() or daily.symbol.duplicated().any():
            raise ValueError('ETF KRX date/identity mismatch')
        daily = daily.set_index('symbol')
        for column in fields:
            if column not in daily:
                continue
            if column not in out:
                out[column] = pd.NA
            values = target.symbol.map(daily[column])
            valid = values.notna()
            out.loc[values.index[valid], column] = values[valid]
        for col, provenance in [('marketCap', 'marketCapSource'), ('tradingValue', 'tradingValueSource')]:
            values = target.symbol.map(daily[col])
            if provenance not in out:
                out[provenance] = pd.NA
            out.loc[values.index[values.notna()], provenance] = 'KRX_ETF'
    return out


def install_cache(ns, state):
    """Preserve successful per-stage frames across restarts, including incomplete shards.

    KRX results remain refreshable: empty/partial KRX data is not certified by
    this cache. The official date cache already shares positive daily responses.
    """
    import pandas as pd
    original = ns['cached_frame']
    def cached(stage, symbol, loader, refresh=None):
        # KRX publication is independently refreshable. Never let an empty stage
        # bundle suppress the next morning's official daily query.
        if str(stage).startswith('krx'):
            return original(stage, symbol, loader, refresh=True)
        dependencies = {'profile': ns['RUN_PROFILE'], 'stage': stage, 'symbol': symbol,
                        'revision': ns.get('INPUT_REVISION', 'original'),
                        'target': ns.get('TARGET_COUNT'), 'flow': ns.get('FLOW_COUNT')}
        key = 'kr-frame-' + digest(canonical(dependencies))[7:]
        saved = state.load(key, dependencies)
        if saved and not ns.get('FORCE_FULL_REFRESH'):
            return pd.read_parquet(io.BytesIO(state.blob(saved['artifacts']['frame'])))
        value = original(stage, symbol, loader, refresh=refresh)
        if isinstance(value, pd.DataFrame) and not value.empty:
            stream = io.BytesIO()
            value.to_parquet(stream, index=False)
            state.save(key, dependencies, {'frame': state.put_blob(stream.getvalue())})
        return value
    ns['cached_frame'] = cached
