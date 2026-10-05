"""Preregistered CM06 candidates; enumeration is not evidence of execution."""
from __future__ import annotations

from dataclasses import asdict, dataclass
from fractions import Fraction
from hashlib import sha256
from itertools import product
import json
from pathlib import Path

POLICY_IMPLEMENTATION_VERSION = "cm06-policy-1.0.2"
METRICS_IMPLEMENTATION_VERSION = "cm06-metrics-1.0.0"
SOURCE_URL = "https://app.notion.com/p/3eed908cac2f8144b068e016ecc13fba"
ENGINES = ("K", "E", "U")
ASSETS = (*ENGINES, "C")
DYNAMIC_IDS = tuple(f"{family}{n}" for family in "OGVRMD" for n in (1, 2))


@dataclass(frozen=True)
class Candidate:
    candidate_id: str
    family: str
    initial_weights: dict[str, float]
    policy_id: str | None = None
    aliases: tuple[str, ...] = ()
    stage: str = "base"

    def to_dict(self):
        return asdict(self)


def _weights(values):
    return dict(zip(ASSETS, map(float, values)))


def simplex_grid(step_percent=25, assets=ASSETS, prefix="Q"):
    """Complete simplex, including cash; no result-dependent local search."""
    if step_percent <= 0 or 100 % step_percent:
        raise ValueError("step_percent must be a positive integer divisor of 100")
    units = 100 // step_percent
    result = []
    for coordinates in product(range(units + 1), repeat=len(assets)):
        if sum(coordinates) != units:
            continue
        weights = {a: c / units for a, c in zip(assets, coordinates)}
        ident = prefix + "_" + "_".join(f"{a}{c * step_percent:03d}" for a, c in zip(assets, coordinates))
        result.append(Candidate(ident, "static_grid", weights, stage="conditional_extension"))
    return result


def base_registry():
    anchors = [
        (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0),
        (Fraction(1, 2), 0, Fraction(1, 2), 0),
        (Fraction(1, 3), Fraction(1, 3), Fraction(1, 3), 0),
        (Fraction(2, 5), Fraction(1, 5), Fraction(2, 5), 0),
        (Fraction(3, 5), Fraction(1, 5), Fraction(1, 5), 0),
        (Fraction(1, 5), Fraction(1, 5), Fraction(3, 5), 0),
        (Fraction(1, 5), Fraction(3, 5), Fraction(1, 5), 0),
    ]
    grid = simplex_grid()
    result = []
    seen = set()
    for i, values in enumerate(anchors, 1):
        w = _weights(values)
        aliases = tuple(c.candidate_id for c in grid if c.initial_weights == w)
        result.append(Candidate(f"S{i:02d}", "static_anchor", w, aliases=aliases))
        seen.add(tuple(w.values()))
    for c in grid:
        if tuple(c.initial_weights.values()) not in seen:
            result.append(Candidate(c.candidate_id, c.family, c.initial_weights, stage="base"))
    for ident in DYNAMIC_IDS:
        result.append(Candidate(ident, ident[0], _weights((Fraction(1, 3),) * 3 + (0,)), ident))
    assert len(result) == 52
    assert sum(c.policy_id is None for c in result) == 40
    assert sum(bool(c.aliases) for c in result) == 4
    return result


def candidate_registry():
    return base_registry()


def candidate_by_id(candidate_id):
    for candidate in base_registry():
        if candidate.candidate_id == candidate_id or candidate_id in candidate.aliases:
            return candidate
    raise KeyError(candidate_id)


def manifest_definition():
    """Numerical conventions must be frozen before looking at candidate performance."""
    return {
        "schema_version": "cm06-preregistration-1.0.2",
        "policy_implementation_version": POLICY_IMPLEMENTATION_VERSION,
        "metrics_implementation_version": METRICS_IMPLEMENTATION_VERSION,
        "authoritative_plan": SOURCE_URL,
        "user_scope_amendment": "Finalists up to about ten, gated, robust, diverse and Pareto-comparable; no forced ten",
        "base_count": 52, "static_anchors": 9, "quarter_grid_count": 35,
        "anchor_grid_duplicates": 4, "unique_static_count": 40, "dynamic_count": 12,
        "conditional_grids": {"three_engines_cash_10pct": 286, "split_korea_cash_25pct": 70,
                              "split_korea_cash_10pct": 1001},
        "conditional_grid_not_base": True,
        "detailed_cell_upper_bounds": {"execution": 40, "capital_capacity": 200, "tax_cashflow": 40},
        "etf_distribution_sensitivity": {
            "annual_assumed_rates": [0.01, 0.05, 0.10],
            "payments_per_year": [1, 4, 12], "conditional_scenarios_per_finalist": 9,
            "basis": "Identical daily economic accrual basis across cadences; cadence changes cash availability only; track unpaid receivable at period end",
            "daily_accrual": "On each eligible KRX session: prior-close held ETF market value * annual_assumed_rate / 12 / verified_KRX_sessions_in_that_calendar_month",
            "holding_treatment": "No accrual for missed holding sessions; receivable survives a later sale; prior-close inventory determines eligible held value",
            "payment_clock": "First KRX open after the relevant calendar month, quarter or year; only recognized receivable becomes cash",
            "calendar_gate": "Require a full verified KRX calendar for every accrual month and future payment dates; do not use incomplete endpoint-month session counts",
            "tax_and_eligibility": "Withholding and eligibility are explicit model assumptions, separate from actual legal entitlement or verified historical distributions",
            "price_treatment": "Keep observed raw ex-distribution prices unchanged; no second price deduction; first verify that inputs are not total-return or distribution-adjusted",
            "input_gate_at_preregistration": "BLOCKED: Toss adjusted=true does not establish raw/ex-distribution versus distribution-adjusted basis",
            "support_status": "Hypothetical missing-distribution sensitivity only; not verified total-return history or full-tax performance",
            "version_note": "User expanded quarterly-only sensitivity to annual/quarterly/monthly before candidate rankings"
        },
        "initial_total_krw": 100_000_000,
        "dynamic_initial_weights": _weights((Fraction(1, 3),) * 3 + (0,)),
        "engine_order_and_momentum_tiebreak": list(ENGINES),
        "decision_clock": "Once after all necessary month-end observations are available; subsequent actual market open only",
        "history_index_contract": "Unique increasing timezone-aware available_at timestamps on a common KRW cutoff grid; input NAV is external fixed-budget reference TWR, never allocation-dependent cashflow-contaminated NAV",
        "causality": "Only available_at <= cutoff; session counts are completed observations; no forward fill, backfill, interpolation or future-session use",
        "new_orders": "Original signal, slots, cash and execution gates reapplied at the actual order time",
        "fallback": "Missing/invalid required input or insufficient warm-up: prior valid target; absent valid prior target: S05. R numerical optimizer/covariance failure: S05 even when prior exists. Every event records reason and fallback source",
        "rounding": "Float64 target weights; no percentage rounding before allocation; clip tiny numerical negatives at 1e-12; quantity flooring belongs to accounting engine",
        "cap": "Dynamic weights individually clipped at 0.60; excess left in cash, never redistributed. R cap is enforced inside optimizer",
        "O": {"lookback_sessions_per_engine": 20, "eligible_demand": "One event per stable engine+demand_id when first qualifying for a new entry under signal and non-cash engine constraints; repeat pending/retry events are duplicates; failures before qualification excluded; future and ineligible records excluded",
              "required_event_columns": ["engine", "demand_id", "session_at", "available_at", "desired_amount", "eligible"],
              "required_sessions": "Per-engine completed session available_at timestamps; events session_at matches one of these timestamps",
              "O1": "Equal among engines with strictly positive first eligible demand in last 20 engine sessions; none => all cash",
              "O2": "Sum first eligible desired_amount / frozen reference capital per engine, normalize positive intensities; none => all cash"},
        "G": {"nav_observations": 200, "boundary": "Latest NAV strictly greater than arithmetic SMA200 is trend-positive; equality is non-positive",
              "G1": "Each trend-positive engine receives 1/3, others cash", "G2": "2 for trend-positive, otherwise 1; normalize then cap"},
        "V": {"return_observations": 63, "volatility": "Sample standard deviation ddof=1 multiplied by sqrt(252)",
              "vol_floor": 0.05, "V1": "Inverse floored volatility weights, normalize then cap",
              "V2": "V1 weights multiplied by min(1,0.12/sqrt(w.T@annual_shrunk_cov126@w)); then cap; no leverage", "target_vol": 0.12},
        "R": {"return_observations": 126, "covariance": "0.5 sample covariance ddof=1 + 0.5 diagonal(sample covariance); annualize 252",
              "R1": "Long-only equal-risk-contribution objective sum((w_i*(Sigma*w)_i/(w.T*Sigma*w)-1/3)^2; sum(w)=1; 0<=w<=0.60",
              "R2": "Minimize w.T*Sigma*w; sum(w)=1; 0<=w<=0.60",
              "optimizer": "scipy SLSQP from equal weights, ftol=1e-12, maxiter=1000; normalized covariance for numerical scale; reject invalid solution; zero-risk covariance falls back to S05"},
        "M": {"return_horizon": 126, "return": "NAV_t/NAV_t-126 - 1, requires 127 observations",
              "M1": "Top two receive 0.50 each", "M2": "Same top two, each receives 0.50 only when return > 0; rejected slots stay cash"},
        "D": {"reference_peak": "Cumulative high since fixed reference-path inception, not rolling peak",
              "D1": "Drawdown <= -0.10 halves 1/3 target; otherwise 1/3", "D2": "Drawdown <= -0.15 sets target to zero; otherwise 1/3",
              "recovery": "Return to baseline only when strictly above the boundary at a later monthly observation"},
        "metrics": {"cash_rate": 0.0, "annualization_sessions": 252, "cagr_days_per_year": 365.2425,
                    "missing": "Any missing/invalid NAV in supplied evaluation series => unsupported; never silently drop or bridge missing NAV",
                    "rolling": "Calendar 3/6/12 months, last available NAV at or before calendar start boundary, no partial starting windows",
                    "sortino": "Mean per-session excess return divided by sqrt(mean(min(excess,0)^2)), annualized sqrt(252)",
                    "bootstrap": "Paired common-date circular moving-block bootstrap, default block length 20, same sampled rows across all candidates; uncertainty diagnostic, not new historical/OOS evidence"},
        "finalist_selection": {"upper_bound": 10, "mandatory_valid_controls": ["S04", "S05"],
                               "eligibility": "Explicit accounting, timing, data and robustness gates; incomplete full-tax support blocks full-tax adoption",
                               "selection_data": "Training/diagnostic segment only; label period and reused-history status",
                               "method": "Pareto front on return, drawdown magnitude, turnover, FX cost and complexity; family diversity then objective-space crowding; no arbitrary fill when gates fail"},
        "candidate_registry": [c.to_dict() for c in base_registry()],
    }


def write_frozen_manifest(path, extra=None):
    manifest = manifest_definition()
    if extra:
        overlap = set(extra) & set(manifest)
        if overlap:
            raise ValueError(f"Cannot overwrite preregistration fields: {sorted(overlap)}")
        manifest.update(extra)
    encoded = json.dumps(manifest, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
    manifest["definition_sha256"] = sha256(encoded).hexdigest()
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(manifest, sort_keys=True, ensure_ascii=False, indent=2) + "\n")
    return manifest
