"""Transparent historical metrics and paired uncertainty diagnostics for CM06.

No function fills a missing observation or treats a bootstrap path as history.
Returns and annualization conventions are part of the frozen preregistration.
"""
from __future__ import annotations

import math
import numpy as np
import pandas as pd

from .registry import METRICS_IMPLEMENTATION_VERSION

ANNUAL_SESSIONS = 252
DAYS_PER_YEAR = 365.2425


def validate_nav(nav):
    if not isinstance(nav, pd.Series):
        raise ValueError("NAV must be a pandas Series")
    if not isinstance(nav.index, pd.DatetimeIndex):
        raise ValueError("NAV requires a DatetimeIndex")
    if nav.index.has_duplicates or not nav.index.is_monotonic_increasing:
        raise ValueError("NAV timestamps must be unique and increasing")
    if not len(nav):
        raise ValueError("empty_NAV")
    result = nav.astype(float)
    if not np.isfinite(result.to_numpy()).all():
        raise ValueError("missing_or_nonfinite_NAV:no_imputation_or_silent_dropping")
    if (result <= 0).any():
        raise ValueError("nonpositive_NAV:unsupported_limited_liability_or_bankruptcy_path")
    return result


def _risk_ratios(returns, annual_cash_rate=0, annual_sessions=ANNUAL_SESSIONS):
    if annual_cash_rate <= -1:
        raise ValueError("annual_cash_rate must be greater than -1")
    returns = np.asarray(returns, dtype=float)
    if len(returns) < 2:
        return {"sharpe": None, "sortino": None, "annualized_volatility": None,
                "risk_ratio_status": "insufficient_return_observations"}
    cash = (1 + annual_cash_rate) ** (1 / annual_sessions) - 1
    excess = returns - cash
    standard_deviation = float(np.std(excess, ddof=1))
    downside = float(np.sqrt(np.mean(np.minimum(excess, 0) ** 2)))
    sharpe = float(np.mean(excess) / standard_deviation * np.sqrt(annual_sessions)) if standard_deviation > 1e-15 else None
    sortino = float(np.mean(excess) / downside * np.sqrt(annual_sessions)) if downside > 1e-15 else None
    return {"sharpe": sharpe, "sortino": sortino,
            "annualized_volatility": float(np.std(returns, ddof=1) * np.sqrt(annual_sessions)),
            "risk_ratio_status": "ok" if sharpe is not None and sortino is not None else "undefined_zero_variance_or_no_downside"}


def drawdown_metrics(nav):
    nav = validate_nav(nav)
    values = nav.to_numpy()
    high = np.maximum.accumulate(values)
    drawdowns = values / high - 1
    trough = int(np.argmin(drawdowns))
    peak_value = high[trough]
    peak = int(np.where(values[:trough + 1] == peak_value)[0][-1])
    recovered = np.flatnonzero(values[trough + 1:] >= peak_value)
    recovery = int(trough + 1 + recovered[0]) if len(recovered) else None
    if drawdowns[trough] == 0:
        recovery = trough
    finish = recovery if recovery is not None else len(nav) - 1
    active_peak = 0
    longest_days, longest_sessions = 0.0, 0
    for i, value in enumerate(values):
        if value >= values[active_peak]:
            if i > active_peak:
                days = (nav.index[i] - nav.index[active_peak]).total_seconds() / 86400
                longest_days = max(longest_days, days if i - active_peak > 1 else 0)
                longest_sessions = max(longest_sessions, i - active_peak if i - active_peak > 1 else 0)
            active_peak = i
        elif i == len(values) - 1:
            longest_days = max(longest_days, (nav.index[i] - nav.index[active_peak]).total_seconds() / 86400)
            longest_sessions = max(longest_sessions, i - active_peak)
    days_to = lambda i: (nav.index[i] - nav.index[peak]).total_seconds() / 86400
    return {"mdd": float(drawdowns[trough]), "mdd_magnitude": float(-drawdowns[trough]),
            "mdd_peak_at": nav.index[peak].isoformat(), "mdd_trough_at": nav.index[trough].isoformat(),
            "mdd_recovered_at": nav.index[recovery].isoformat() if recovery is not None else None,
            "mdd_recovery_days": float(days_to(recovery)) if recovery is not None else None,
            "mdd_recovery_sessions": recovery - peak if recovery is not None else None,
            "mdd_time_underwater_days": float(days_to(finish)),
            "mdd_unrecovered": recovery is None,
            "max_underwater_calendar_days": float(longest_days), "max_underwater_sessions": int(longest_sessions)}


def yearly_returns(nav):
    nav = validate_nav(nav)
    rows = []
    for year in sorted(set(nav.index.year)):
        locations = np.flatnonzero(nav.index.year == year)
        first, last = int(locations[0]), int(locations[-1])
        base = max(0, first - 1)
        rows.append({"year": int(year), "return": float(nav.iloc[last] / nav.iloc[base] - 1),
                     "baseline_at": nav.index[base].isoformat(), "end_at": nav.index[last].isoformat(),
                     "partial_start": first == 0 and (nav.index[0].month != 1 or nav.index[0].day > 1),
                     "partial_end": last == len(nav) - 1 and nav.index[last].month < 12,
                     "observations": int(last - first + 1)})
    return rows


def rolling_returns(nav, months):
    """Calendar-horizon total returns, using only an observed prior boundary NAV."""
    nav = validate_nav(nav)
    if months not in (3, 6, 12):
        raise ValueError("Only preregistered calendar windows 3, 6 and 12 are supported")
    output = []
    for end in range(len(nav)):
        boundary = nav.index[end] - pd.DateOffset(months=months)
        start = int(nav.index.searchsorted(boundary, side="right")) - 1
        if start < 0:
            continue
        output.append({"months": months, "start_at": nav.index[start].isoformat(),
                       "end_at": nav.index[end].isoformat(),
                       "return": float(nav.iloc[end] / nav.iloc[start] - 1)})
    return output


def performance_metrics(nav, annual_cash_rate=0.0, annual_sessions=ANNUAL_SESSIONS):
    base = {"implementation_version": METRICS_IMPLEMENTATION_VERSION,
            "annual_cash_rate": float(annual_cash_rate), "annualization_sessions": annual_sessions,
            "cagr_days_per_year": DAYS_PER_YEAR, "missing_data_policy": "reject_missing_no_imputation"}
    try:
        nav = validate_nav(nav)
    except (TypeError, ValueError) as exc:
        return {**base, "supported": False, "status": "unsupported", "reason": str(exc)}
    elapsed_days = (nav.index[-1] - nav.index[0]).total_seconds() / 86400
    cumulative = float(nav.iloc[-1] / nav.iloc[0] - 1)
    cagr = float(np.expm1(np.log(nav.iloc[-1] / nav.iloc[0]) * DAYS_PER_YEAR / elapsed_days)) if elapsed_days > 0 else None
    returns = nav.to_numpy()[1:] / nav.to_numpy()[:-1] - 1
    output = {**base, "supported": True, "status": "ok", "start_at": nav.index[0].isoformat(),
              "end_at": nav.index[-1].isoformat(), "observations": len(nav), "return_observations": len(returns),
              "elapsed_calendar_days": elapsed_days, "cumulative_return": cumulative, "cagr": cagr,
              "yearly_returns": yearly_returns(nav), **_risk_ratios(returns, annual_cash_rate, annual_sessions),
              **drawdown_metrics(nav)}
    for months in (3, 6, 12):
        rows = rolling_returns(nav, months)
        worst = min(rows, key=lambda r: r["return"]) if rows else None
        output[f"worst_rolling_{months}m"] = worst["return"] if worst else None
        output[f"worst_rolling_{months}m_window"] = worst
        output[f"rolling_{months}m_windows"] = len(rows)
    return output


def summarize_nav(*args, **kwargs):
    return performance_metrics(*args, **kwargs)


def paired_return_panel(nav_panel):
    """Require a complete common-cutoff panel; do not silently intersect away gaps."""
    if not isinstance(nav_panel, pd.DataFrame) or not len(nav_panel.columns):
        raise ValueError("A nonempty NAV panel is required")
    for col in nav_panel.columns:
        validate_nav(nav_panel[col])
    values = nav_panel.to_numpy(dtype=float)
    return pd.DataFrame(values[1:] / values[:-1] - 1, index=nav_panel.index[1:], columns=nav_panel.columns)


def paired_block_bootstrap(return_panel, replicates=1000, block_length=20, seed=606,
                           confidence=0.95, benchmark=None, annual_sessions=ANNUAL_SESSIONS):
    """Paired circular moving blocks preserve within-block and cross-policy dependence.

    CIs are unadjusted descriptive intervals; this is not an independent test of
    candidates selected on the same dates, and not a multiple-testing correction.
    """
    if not isinstance(return_panel, pd.DataFrame) or not isinstance(return_panel.index, pd.DatetimeIndex):
        raise ValueError("Return panel must have common date index")
    if return_panel.index.has_duplicates or not return_panel.index.is_monotonic_increasing:
        raise ValueError("Return timestamps must be unique and increasing")
    values = return_panel.to_numpy(dtype=float)
    if not np.isfinite(values).all() or (values <= -1).any():
        raise ValueError("Incomplete/invalid paired returns; no missing-data dropping")
    n, k = values.shape
    if not isinstance(block_length, int) or block_length < 1 or n < 2 * block_length:
        raise ValueError("At least two complete blocks are required")
    if replicates < 2 or not 0 < confidence < 1:
        raise ValueError("Invalid bootstrap replication or confidence setting")
    if benchmark is not None and benchmark not in return_panel.columns:
        raise ValueError("Benchmark must be a column in the same paired panel")
    rng = np.random.default_rng(seed)
    cagr = np.empty((replicates, k))
    mdd = np.empty_like(cagr)
    sharpe = np.full_like(cagr, np.nan)
    for b in range(replicates):
        starts = rng.integers(0, n, size=math.ceil(n / block_length))
        indices = ((starts[:, None] + np.arange(block_length)) % n).ravel()[:n]
        sample = values[indices]
        lognav = np.vstack([np.zeros(k), np.cumsum(np.log1p(sample), axis=0)])
        cagr[b] = np.expm1(lognav[-1] * annual_sessions / n)
        mdd[b] = np.min(np.expm1(lognav - np.maximum.accumulate(lognav, axis=0)), axis=0)
        sd = np.std(sample, axis=0, ddof=1)
        np.divide(np.mean(sample, axis=0) * np.sqrt(annual_sessions), sd, out=sharpe[b], where=sd > 1e-15)
    q = [(1 - confidence) / 2, .5, 1 - (1 - confidence) / 2]
    def interval(array):
        finite = array[np.isfinite(array)]
        if not len(finite):
            return {"lower": None, "median": None, "upper": None, "valid_replicates": 0}
        lo, med, hi = np.quantile(finite, q)
        return {"lower": float(lo), "median": float(med), "upper": float(hi), "valid_replicates": int(len(finite))}
    columns = list(return_panel.columns)
    result = {"method": "paired_circular_moving_block_bootstrap", "replicates": replicates,
              "block_length": block_length, "seed": seed, "confidence": confidence,
              "sample_return_observations": n, "simultaneous_or_selection_adjusted": False,
              "historical_or_independent_oos_evidence": False,
              "cagr_annualization": f"geometric per-observation annualized at {annual_sessions} sessions",
              "candidates": {name: {"cagr": interval(cagr[:, i]), "mdd": interval(mdd[:, i]),
                                     "sharpe": interval(sharpe[:, i])} for i, name in enumerate(columns)}}
    if benchmark is not None:
        j = columns.index(benchmark)
        result["benchmark"] = benchmark
        result["paired_cagr_difference"] = {name: interval(cagr[:, i] - cagr[:, j]) for i, name in enumerate(columns)}
    return result


def pareto_front(rows, objectives):
    """objectives maps metric name to 'max' or 'min'; invalid rows cannot dominate."""
    if not objectives or any(d not in ("min", "max") for d in objectives.values()):
        raise ValueError("Explicit min/max objectives are required")
    usable = []
    for row in rows:
        if all(isinstance(row.get(key), (float, int, np.floating, np.integer)) and np.isfinite(row[key]) for key in objectives):
            scores = np.array([float(row[key]) * (1 if direction == "max" else -1) for key, direction in objectives.items()])
            usable.append((row, scores))
    return [row for i, (row, scores) in enumerate(usable)
            if not any(np.all(other >= scores) and np.any(other > scores)
                       for j, (_, other) in enumerate(usable) if j != i)]


def select_finalists(rows, selection_period, max_candidates=10, required_anchors=("S04", "S05"),
                     objectives=None):
    """Diagnostic selection, only explicit gate passes; never fill a quota with failures.

    Caller must provide independently checked gate_pass and robust_pass booleans.
    Tax support is retained in row metadata; full-tax adoption needs its own gate.
    """
    if not selection_period:
        raise ValueError("Record the training/diagnostic selection period")
    if max_candidates < len(required_anchors):
        raise ValueError("Upper bound cannot exclude mandatory controls")
    objectives = objectives or {"cagr": "max", "mdd_magnitude": "min", "turnover": "min",
                                "fx_cost": "min", "complexity": "min"}
    valid = [r for r in rows if r.get("gate_pass") is True and r.get("robust_pass") is True]
    front = pareto_front(valid, objectives)
    anchors = [next((r for r in valid if r["candidate_id"] == ident), None) for ident in required_anchors]
    selected = [r for r in anchors if r is not None]
    remaining = [r for r in front if r["candidate_id"] not in {x["candidate_id"] for x in selected}]
    # Objective-space crowding preserves extremes rather than maximizing one return metric.
    crowd = {r["candidate_id"]: 0.0 for r in remaining}
    for metric in objectives:
        ordered = sorted(remaining, key=lambda r: (r[metric], r["candidate_id"]))
        if not ordered:
            continue
        span = ordered[-1][metric] - ordered[0][metric]
        if span <= 0:
            continue
        crowd[ordered[0]["candidate_id"]] = float("inf")
        crowd[ordered[-1]["candidate_id"]] = float("inf")
        for i in range(1, len(ordered) - 1):
            crowd[ordered[i]["candidate_id"]] += (ordered[i + 1][metric] - ordered[i - 1][metric]) / span
    while remaining and len(selected) < max_candidates:
        families = {r.get("family", "unknown") for r in selected}
        remaining.sort(key=lambda r: (r.get("family", "unknown") in families, -crowd[r["candidate_id"]], r["candidate_id"]))
        selected.append(remaining.pop(0))
    return {"selection_period": selection_period, "status": "historical_diagnostic_not_adoption",
            "max_candidates": max_candidates, "selected": selected,
            "eligible_count": len(valid), "pareto_count": len(front),
            "missing_or_failed_controls": [ident for ident, row in zip(required_anchors, anchors) if row is None],
            "selection_adjustment_applied": False}
