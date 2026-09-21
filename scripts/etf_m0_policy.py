"""Provisional research policy. Inputs are point-in-time normalized block scores.

This module emits close-time signals, never same-close fills. Health and Priority
retain their existing definitions; no implicit rescaling of observed ranges.
"""
import numpy as np
import pandas as pd

WEIGHTS = {'technicalContinuous': .55, 'priorityM0': .15,
           'health': .15, 'marketSectorScore': .15}


def score_and_signals(panel: pd.DataFrame) -> pd.DataFrame:
    """Return sorted score, entry signal, and MA60 exit signal for each ETF day.

    Caller supplies precomputed continuous Technical in [0,100] using only
    information available at each close. Apply entry only when flat, exit only
    when held; execute at the next available session open. No time cap.
    """
    d=panel.sort_values(['symbol','date']).copy()
    if d.duplicated(['symbol','date']).any():
        raise ValueError('Duplicate symbol/date')
    for k in WEIGHTS:
        finite=d[k].dropna()
        if not np.isfinite(finite).all() or ((finite < -1e-8)|(finite > 100+1e-8)).any():
            raise ValueError(f'{k} must be normalized to 0..100')
    d['m0Provisional']=sum(d[k]*v for k,v in WEIGHTS.items())
    prev=d.groupby('symbol',sort=False).m0Provisional.shift(1)
    d['entrySignal']=(prev<80)&(d.m0Provisional>=80)&d.eligible.fillna(False)
    d['exitSignal']=d.etfUnderlyingIndexClose<d.uMa60
    return d
