"""Pure production US atomic features shared by daily collection and offline research.

Input rows contain symbol/date/open/high/low/close/volume. Missing sessions are
aligned to observed SPY dates without filling price or volume. Caller controls
the as-of cutoff and universe; this module has no I/O or portfolio rules.
"""
import numpy as np
import pandas as pd


def compute_us_feature_panel(prices: pd.DataFrame) -> pd.DataFrame:
    required = {"symbol", "date", "open", "high", "low", "close", "volume"}
    missing = sorted(required - set(prices.columns))
    if missing:
        raise ValueError("US feature input missing columns: " + ", ".join(missing))
    if prices.empty or not prices.symbol.eq("SPY").any():
        raise ValueError("US feature input requires observed SPY sessions")
    if prices.duplicated(["symbol", "date"]).any():
        raise ValueError("US feature input requires already-normalized unique symbol/date rows")
    px = prices.copy()
    for c in ['open','high','low','close','volume']:
        px[c]=pd.to_numeric(px[c],errors='coerce')
    # Align observations to SPY sessions so gaps cannot count as active trading days.
    sessions=sorted(px.loc[px.symbol.eq('SPY'),'date'].unique())
    aligned=[]
    for symbol, frame in px.groupby('symbol'):
        first_date=frame.date.min()
        frame=frame.set_index('date').reindex([d for d in sessions if d>=first_date])
        frame.index.name='date'
        frame['symbol']=symbol
        aligned.append(frame.reset_index())
    px=pd.concat(aligned,ignore_index=True).sort_values(['symbol','date'])
    del aligned  # no longer keep one DataFrame per symbol in memory
    g=px.groupby('symbol',group_keys=False)
    px['ret1']=g['close'].pct_change(fill_method=None)
    px['ret120']=g['close'].pct_change(120,fill_method=None)
    px['ret252']=g['close'].pct_change(252,fill_method=None)
    px['dollar_volume']=px['close']*px['volume']
    px['adv20_usd']=g['dollar_volume'].transform(lambda s:s.rolling(20,min_periods=20).mean())
    px['amihud_raw']=px['ret1'].abs()/px['dollar_volume'].replace(0,np.nan)
    px['amihud20']=g['amihud_raw'].transform(lambda s:s.rolling(20,min_periods=20).mean())
    px['vol20_avg']=g['volume'].transform(lambda s:s.rolling(20,min_periods=20).mean())
    px['relvol1_20']=px['volume']/px['vol20_avg']-1
    px['tenkan9']=(g['high'].transform(lambda s:s.rolling(9,min_periods=9).max())+g['low'].transform(lambda s:s.rolling(9,min_periods=9).min()))/2
    px['kijun26']=(g['high'].transform(lambda s:s.rolling(26,min_periods=26).max())+g['low'].transform(lambda s:s.rolling(26,min_periods=26).min()))/2
    px['ichimoku_tk_gap']=px['tenkan9']/px['kijun26']-1
    px['active20']=g['volume'].transform(lambda s:s.gt(0).rolling(20,min_periods=20).sum()).ge(20)

    # beta60_spy: 종목 일수익률과 SPY 일수익률의 최근 60개 공통 관측 cov/var
    del g  # release old frame reference before merge creates a new frame
    spy=px[px.symbol.eq('SPY')][['date','ret1']].rename(columns={'ret1':'spy_ret1'})
    px=px.merge(spy,on='date',how='left')
    # Per-symbol Series rolling yields the same 60-session beta without copying
    # or concatenating the full feature table for every symbol.
    _beta = np.full(len(px), np.nan, dtype='float64')
    _ret_col, _spy_col = px['ret1'], px['spy_ret1']
    for _row_positions in px.groupby('symbol',sort=False).indices.values():
        _ix = np.asarray(_row_positions,dtype=np.intp)
        _r, _s = _ret_col.iloc[_ix], _spy_col.iloc[_ix]
        _cov = _r.rolling(60,min_periods=50).cov(_s)
        _var = _s.rolling(60,min_periods=50).var()
        _beta[_ix] = (_cov / _var.replace(0,np.nan)).to_numpy()
    px['beta60_spy'] = _beta


    return px
