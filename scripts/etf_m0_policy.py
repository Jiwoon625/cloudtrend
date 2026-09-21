"""Current ETF research baseline: two active Priority slots, no index/rotation points.

This is a structural cleanup, not a claim of superior performance. Peer-mix environment adopted by user. Priority7.5 is conditional on10slots,
not robust across portfolio sizes. Research cutoff remains 2026-09-11.
"""
import numpy as np
import pandas as pd

WEIGHTS={'technicalContinuous':.625,'priorityTwo':.075,'healthCapLiquidityPlain':.15,'marketSectorMapped':.15}
CUTOFF='2026-09-11'

def priority_score(market_cap,day_return,benchmark_day_return,region):
    """Size and existing Korean-market excess-return points, each worth one of two.

    Foreign excess-return term is explicitly disabled pending a compatible
    benchmark. Never compare foreign ETF daily returns with KOSPI by default.
    """
    domestic=region.eq('KR');valid=np.isfinite(market_cap)&(market_cap>0)
    valid &= ~domestic | (np.isfinite(day_return)&np.isfinite(benchmark_day_return))
    size=(market_cap>=300e9).astype(float)
    relative=(domestic & ((day_return-benchmark_day_return)*100>=2)).astype(float)
    return ((size+relative)/2*100).where(valid)

def health_score(market_cap,trading_value20):
    valid=np.isfinite(market_cap)&(market_cap>0)&np.isfinite(trading_value20)&(trading_value20>=0)
    size=20*(market_cap>=50e9).astype(float)+10*(market_cap>=100e9).astype(float)
    return ((size+20*(trading_value20>=1e9).astype(float)+10)/60*100).where(valid)

def score_and_signals(panel:pd.DataFrame)->pd.DataFrame:
    d=panel.loc[panel.date<=CUTOFF].sort_values(['symbol','date']).copy()
    if d.duplicated(['symbol','date']).any():raise ValueError('Duplicate symbol/date')
    for k in WEIGHTS:
        x=d[k].dropna()
        if not np.isfinite(x).all() or ((x<-1e-8)|(x>100+1e-8)).any():raise ValueError(f'{k} must be normalized to0..100')
    d['m0Provisional']=sum(d[k]*v for k,v in WEIGHTS.items());prev=d.groupby('symbol').m0Provisional.shift(1)
    uvalid=np.isfinite(d.etfUnderlyingIndexClose)&(d.etfUnderlyingIndexClose>0)
    mvalid=np.isfinite(d.uMa60)&(d.uMa60>0)
    d['entrySignal']=(prev<80)&(d.m0Provisional>=80)&d.eligible.fillna(False)&uvalid&mvalid
    d['exitSignal']=uvalid&mvalid&(d.etfUnderlyingIndexClose<d.uMa60)
    d['dataErrorExitSignal']=~uvalid
    return d


def apply_environment(panel:pd.DataFrame)->pd.DataFrame:
    """Inputs peerMix/ownLag must already be lagged by one observation."""
    d=panel.copy();local=d.rotationSource.eq('domestic_stock_sector')
    peer=d.peerMixAvailable.fillna(False)&d.peerMix.notna()
    d['marketSectorMapped']=d.sectorClean.where(local,d.peerMix.where(peer,d.ownLag))
    d['environmentSource']=np.where(local,'domestic_stock_sector',np.where(peer,'regional_peer_mix_lag1','own_underlying_regime_lag1_fallback'))
    return d
