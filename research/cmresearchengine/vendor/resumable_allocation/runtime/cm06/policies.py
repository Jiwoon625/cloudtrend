"""Causal CM06 target policies. These targets never rebalance existing holdings.

The caller owns exchange calendars and observation availability. A row's index is
the actual common cutoff availability time, not an unqualified trading date.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Mapping
import numpy as np
import pandas as pd
from scipy.optimize import minimize

from .registry import ASSETS, DYNAMIC_IDS, ENGINES, POLICY_IMPLEMENTATION_VERSION, candidate_by_id

ANNUAL_SESSIONS = 252
CAP = 0.60
EPSILON = 1e-12


@dataclass
class PolicyResult:
    weights: dict[str, float]
    diagnostics: dict = field(default_factory=dict)

    def to_dict(self):
        return {"weights": self.weights, "diagnostics": self.diagnostics}


def _equal():
    return {"K": 1 / 3, "E": 1 / 3, "U": 1 / 3, "C": 0.0}


def _valid_target(value):
    if isinstance(value, PolicyResult):
        value = value.weights
    if not isinstance(value, Mapping) or set(value) != set(ASSETS):
        return None
    values = np.array([value[k] for k in ASSETS], dtype=float)
    if not np.isfinite(values).all() or (values < -EPSILON).any() or abs(values.sum() - 1) > 1e-8:
        return None
    if (values[:3] > CAP + 1e-8).any():
        return None
    return {a: max(0.0, float(value[a])) for a in ASSETS}


def _fallback(reason, diagnostics, previous, force_equal=False):
    old = None if force_equal else _valid_target(previous)
    diagnostics.update({"status": "fallback", "fallback": True, "reason": reason,
                        "fallback_source": "previous_valid_target" if old else "S05",
                        "optimizer_failed": bool(force_equal)})
    return PolicyResult(old or _equal(), diagnostics)


def _finish(weights, diagnostics, enforce_cap=True):
    values = np.asarray(weights, dtype=float)
    if values.shape != (3,) or not np.isfinite(values).all() or np.min(values) < -EPSILON:
        raise ValueError("Invalid proposed target")
    values = np.maximum(values, 0)
    uncapped = values.copy()
    if enforce_cap:
        values = np.minimum(values, CAP)
    if values.sum() > 1 + 1e-8:
        raise ValueError("Leverage is prohibited")
    cash = max(0.0, 1 - float(values.sum()))
    diagnostics.update({"status": "ok", "fallback": False,
                        "capped_to_cash": float((uncapped - values).sum()),
                        "target_sum": float(values.sum() + cash)})
    return PolicyResult(dict(zip(ASSETS, [*map(float, values), cash])), diagnostics)


def _timestamp(value):
    value = pd.Timestamp(value)
    if value.tzinfo is None:
        raise ValueError("Timezone-aware availability timestamps are required")
    return value.tz_convert("UTC")


def _history_before(history_nav, cutoff):
    if not isinstance(history_nav, pd.DataFrame):
        raise ValueError("history_nav must be a DataFrame")
    if not set(ENGINES).issubset(history_nav.columns):
        raise ValueError("Reference NAV requires K, E and U columns")
    if not isinstance(history_nav.index, pd.DatetimeIndex) or history_nav.index.tz is None:
        raise ValueError("Reference NAV index must be timezone-aware availability timestamps")
    history = history_nav.loc[history_nav.index <= cutoff, list(ENGINES)]
    if history.index.has_duplicates or not history.index.is_monotonic_increasing:
        raise ValueError("Reference NAV timestamps must be unique and increasing")
    return history.astype(float)


def _window(history, rows):
    if len(history) < rows:
        raise ValueError(f"insufficient_warmup:need_{rows}_nav_observations:have_{len(history)}")
    window = history.iloc[-rows:]
    values = window.to_numpy()
    if not np.isfinite(values).all() or (values <= 0).any():
        raise ValueError("missing_or_invalid_reference_nav")
    return window


def _returns(history, observations):
    values = _window(history, observations + 1).to_numpy()
    return values[1:] / values[:-1] - 1


def shrunk_covariance(returns, annualize=True):
    values = np.asarray(returns, dtype=float)
    if values.ndim != 2 or values.shape[1] != 3 or values.shape[0] < 2 or not np.isfinite(values).all():
        raise ValueError("Invalid covariance input")
    sample = np.cov(values, rowvar=False, ddof=1)
    covariance = 0.5 * sample + 0.5 * np.diag(np.diag(sample))
    return covariance * (ANNUAL_SESSIONS if annualize else 1)


def _risk_weights(covariance, policy_id):
    scale = float(np.max(np.diag(covariance)))
    if not np.isfinite(covariance).all() or scale <= EPSILON:
        raise ValueError("zero_or_invalid_covariance")
    sigma = covariance / scale
    if np.linalg.eigvalsh(sigma).min() < -1e-10:
        raise ValueError("non_positive_semidefinite_covariance")

    def objective(w):
        variance = float(w @ sigma @ w)
        if policy_id == "R2":
            return variance
        if variance <= EPSILON:
            return 1e6
        risk_fraction = w * (sigma @ w) / variance
        return float(np.sum((risk_fraction - 1 / 3) ** 2))

    solution = minimize(objective, np.ones(3) / 3, method="SLSQP", bounds=[(0, CAP)] * 3,
                        constraints=[{"type": "eq", "fun": lambda w: w.sum() - 1}],
                        options={"ftol": 1e-12, "maxiter": 1000})
    w = solution.x
    if (not solution.success or not np.isfinite(w).all() or abs(w.sum() - 1) > 1e-8
            or w.min() < -EPSILON or w.max() > CAP + 1e-8):
        raise ValueError(f"optimizer_failure:{solution.message}")
    variance = float(w @ covariance @ w)
    risk_fraction = w * (covariance @ w) / variance if variance > EPSILON else np.full(3, np.nan)
    return w, {"optimizer_iterations": int(solution.nit), "optimizer_objective": float(solution.fun),
               "risk_contribution_fraction": dict(zip(ENGINES, map(float, risk_fraction))),
               "predicted_volatility": float(np.sqrt(max(0, variance)))}


def _demand_weights(policy_id, cutoff, events, reference_capital, sessions):
    if events is None or sessions is None:
        raise ValueError("eligible_demand_or_engine_sessions_unavailable")
    required = {"engine", "demand_id", "session_at", "available_at", "desired_amount", "eligible"}
    if not isinstance(events, pd.DataFrame) or not required.issubset(events.columns):
        raise ValueError("eligible_demand_schema_incomplete")
    frame = events.copy()
    # Do not let later updates move the first qualified demand into a later window.
    if len(frame):
        if frame["demand_id"].isna().any() or not frame["engine"].isin(ENGINES).all():
            raise ValueError("invalid_demand_identity")
        frame["available_at"] = frame["available_at"].map(_timestamp)
        frame["session_at"] = frame["session_at"].map(_timestamp)
        frame = frame.loc[(frame.available_at <= cutoff) & (frame.session_at <= cutoff)]
        if not frame["eligible"].map(lambda x: isinstance(x, (bool, np.bool_))).all():
            raise ValueError("eligible_demand_flag_must_be_boolean")
        frame = frame.loc[frame.eligible].sort_values("available_at", kind="stable")
        frame = frame.drop_duplicates(["engine", "demand_id"], keep="first")
        amounts = pd.to_numeric(frame.desired_amount, errors="coerce")
        if not np.isfinite(amounts).all() or (amounts < 0).any():
            raise ValueError("invalid_eligible_demand_amount")
        frame["desired_amount"] = amounts
    counts, amounts, intensity = {}, {}, {}
    for engine in ENGINES:
        if engine not in sessions:
            raise ValueError(f"missing_completed_sessions:{engine}")
        available = pd.DatetimeIndex([_timestamp(v) for v in sessions[engine]])
        if available.has_duplicates or not available.is_monotonic_increasing:
            raise ValueError(f"invalid_completed_sessions:{engine}")
        available = available[available <= cutoff]
        if len(available) < 20:
            raise ValueError(f"insufficient_demand_warmup:{engine}:have_{len(available)}")
        matching = frame.loc[frame.engine == engine]
        in_calendar_range = matching.loc[(matching.session_at >= available[0]) & (matching.session_at <= available[-1])]
        if not in_calendar_range.session_at.isin(available).all():
            raise ValueError(f"demand_session_not_in_verified_calendar:{engine}")
        chosen = frame.loc[(frame.engine == engine) & frame.session_at.isin(available[-20:])]
        positive = chosen.loc[chosen.desired_amount > 0]
        counts[engine] = len(positive)
        amounts[engine] = float(positive.desired_amount.sum())
        if policy_id == "O2":
            capital = None if reference_capital is None else reference_capital.get(engine)
            if capital is None or not np.isfinite(capital) or capital <= 0:
                raise ValueError(f"invalid_reference_capital:{engine}")
            intensity[engine] = amounts[engine] / capital
        else:
            intensity[engine] = float(counts[engine] > 0)
    raw = np.array([intensity[e] for e in ENGINES])
    total = raw.sum()
    return (raw / total if total > 0 else np.zeros(3)), {
        "demand_unique_positive_counts": counts, "demand_desired_amounts": amounts,
        "demand_intensity": intensity, "known_demand_none": bool(total == 0)}


def policy_target(policy_id, history_nav, cutoff, previous=None, demand_events=None,
                  reference_capital=None, engine_sessions=None):
    """Produce a target from information available at cutoff, with no trade side effects.

    Required history: G=200 NAVs, V1=64, V2/R/M=127, D=all since reference
    inception. O requires explicit event and calendar data, even for empty demand.
    Static IDs use the same API but preserve their original 100% allocations.
    """
    cutoff = _timestamp(cutoff)
    diagnostics = {"policy_id": policy_id, "cutoff": cutoff.isoformat(),
                   "implementation_version": POLICY_IMPLEMENTATION_VERSION}
    if policy_id not in DYNAMIC_IDS:
        candidate = candidate_by_id(policy_id)
        diagnostics.update({"status": "ok", "fallback": False, "static": True})
        return PolicyResult(dict(candidate.initial_weights), diagnostics)
    if policy_id.startswith("O"):
        try:
            weights, details = _demand_weights(policy_id, cutoff, demand_events, reference_capital, engine_sessions)
            diagnostics.update(details)
            return _finish(weights, diagnostics)
        except (ValueError, TypeError, KeyError) as exc:
            return _fallback(str(exc), diagnostics, previous)
    try:
        history = _history_before(history_nav, cutoff)
        diagnostics["available_nav_observations"] = len(history)
        if len(history):
            diagnostics["last_input_available_at"] = history.index[-1].isoformat()
        if policy_id.startswith("G"):
            window = _window(history, 200)
            mean = window.mean().to_numpy()
            latest = window.iloc[-1].to_numpy()
            good = latest > mean
            diagnostics.update({"trend_positive": dict(zip(ENGINES, map(bool, good))),
                                "sma200": dict(zip(ENGINES, map(float, mean)))})
            weights = good.astype(float) / 3 if policy_id == "G1" else np.where(good, 2.0, 1.0)
            if policy_id == "G2":
                weights /= weights.sum()
        elif policy_id.startswith("V"):
            returns = _returns(history, 63)
            vol = np.std(returns, axis=0, ddof=1) * np.sqrt(ANNUAL_SESSIONS)
            inv = 1 / np.maximum(vol, 0.05)
            weights = inv / inv.sum()
            diagnostics.update({"realized_volatility": dict(zip(ENGINES, map(float, vol))),
                                "volatility_floor_active": dict(zip(ENGINES, map(bool, vol < .05)))})
            if policy_id == "V2":
                diagnostics["v1_cap_cash_before_risk_scaling"] = float(np.maximum(weights - CAP, 0).sum())
                weights = np.minimum(weights, CAP)
                covariance = shrunk_covariance(_returns(history, 126))
                predicted = float(np.sqrt(max(0, weights @ covariance @ weights)))
                scale = min(1.0, .12 / predicted) if predicted > EPSILON else 1.0
                weights *= scale
                diagnostics.update({"predicted_volatility_before_scale": predicted,
                                    "risk_budget_scale": scale,
                                    "predicted_volatility_after_scale": predicted * scale})
        elif policy_id.startswith("R"):
            covariance = shrunk_covariance(_returns(history, 126))
            try:
                weights, details = _risk_weights(covariance, policy_id)
                diagnostics.update(details)
            except (ValueError, FloatingPointError, np.linalg.LinAlgError) as exc:
                return _fallback(str(exc), diagnostics, previous, force_equal=True)
        elif policy_id.startswith("M"):
            window = _window(history, 127)
            returns = window.iloc[-1].to_numpy() / window.iloc[0].to_numpy() - 1
            order = sorted(range(3), key=lambda i: (-returns[i], i))
            weights = np.zeros(3)
            for i in order[:2]:
                if policy_id == "M1" or returns[i] > 0:
                    weights[i] = 0.5
            diagnostics.update({"momentum126": dict(zip(ENGINES, map(float, returns))),
                                "ranking": [ENGINES[i] for i in order]})
        elif policy_id.startswith("D"):
            window = _window(history, max(len(history), 1))
            drawdown = window.iloc[-1].to_numpy() / window.max().to_numpy() - 1
            weights = np.ones(3) / 3
            threshold = -0.10 if policy_id == "D1" else -0.15
            # Floating arithmetic must not turn an exact decimal threshold into a miss.
            triggered = (drawdown < threshold) | np.isclose(drawdown, threshold, rtol=0, atol=EPSILON)
            weights[triggered] *= 0.5 if policy_id == "D1" else 0
            diagnostics.update({"reference_drawdown": dict(zip(ENGINES, map(float, drawdown))),
                                "drawdown_triggered": dict(zip(ENGINES, map(bool, triggered)))})
        return _finish(weights, diagnostics)
    except (ValueError, TypeError, KeyError, FloatingPointError, np.linalg.LinAlgError) as exc:
        return _fallback(str(exc), diagnostics, previous)


def target_weights(*args, **kwargs):
    """Convenience alias retaining all diagnostic evidence in the result."""
    return policy_target(*args, **kwargs)
