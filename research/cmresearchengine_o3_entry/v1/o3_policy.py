"""Calendar-month counts of intrinsic ENTRY deliveries, independent of orders.

The executable contract binds the approved choices. Alternatives remain testable;
calling this pure function does not itself authorize a research execution.
No reference demand log, amount, NAV, holding, budget, cash, slot or fill is input.
"""
from datetime import date
import math
import re
import pandas as pd

ENGINES = ("K", "E", "U")
ASSETS = (*ENGINES, "C")
VERSION = "o3-delivered-entry-calendar-month-v1"
PROPOSED_OPTIONS = {
    "cap": 0.60,
    "zero_signal_month": "CASH100",
    "first_partial_month": "USE_RESEARCH_PREFIX",
    "initial_weights": {"K": 1/3, "E": 1/3, "U": 1/3, "C": 0.0},
}


def utc(value):
    stamp = pd.Timestamp(value)
    if stamp.tzinfo is None or pd.isna(stamp):
        raise ValueError("Explicit valid timestamp required")
    return stamp.tz_convert("UTC")


def valid_target(value):
    if not isinstance(value, dict) or set(value) != set(ASSETS):
        return None
    if any(type(x) not in (float, int) or not math.isfinite(x) or not 0 <= x <= 1
           for x in value.values()) or not math.isclose(sum(value.values()), 1, abs_tol=1e-10):
        return None
    return dict(value)


def options(value=None):
    result = dict(PROPOSED_OPTIONS if value is None else value)
    if (set(result) != set(PROPOSED_OPTIONS) or
        (result["cap"] is not None and
         (type(result["cap"]) not in (float, int) or not 0 < result["cap"] <= 1)) or
        result["zero_signal_month"] not in ("CASH100", "KEEP_PREVIOUS") or
        result["first_partial_month"] not in ("USE_RESEARCH_PREFIX", "HOLD_PRIOR_FULL_MONTH") or
        not valid_target(result["initial_weights"])):
        raise ValueError("Unsupported explicit O3 boundary choices")
    return result


def target(month, cutoff, signals, calendars, observations, start_date, previous=None, policy_options=None):
    """Review confirmation/session month, apply only after its decision cutoff.

Deduplicate globally by engine+symbol+origin_date BEFORE selecting the month.
Research-start truncation is distinct from missing observations in that prefix.
"""
    policy = options(policy_options)
    prior = valid_target(previous) or dict(policy["initial_weights"])
    diagnostic = {"policy_id": "O3", "implementation_version": VERSION,
                  "signal_source": "FROZEN_INTRINSIC_ENTRY_BEFORE_PORTFOLIO_GATES",
                  "reviewed_month": month, "boundary_options": policy}
    try:
        cutoff = utc(cutoff)
        diagnostic["cutoff"] = cutoff.isoformat()
        if not isinstance(month, str) or re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", month) is None:
            raise ValueError("invalid_calendar_month")
        first = date.fromisoformat(month + "-01")
        following = date(first.year + (first.month == 12), first.month % 12 + 1, 1)
        start = date.fromisoformat(start_date)
        if first >= following or start >= following or set(calendars) != set(ENGINES):
            raise ValueError("invalid_research_month")
        partial = first < start
        diagnostic.update(partial_start_month=partial, coverage_start=max(first, start).isoformat(),
                          target_month=following.isoformat()[:7])
        if partial and policy["first_partial_month"] == "HOLD_PRIOR_FULL_MONTH":
            raise ValueError("first_partial_month_hold_policy")
        expected, all_days = {}, {}
        for engine in ENGINES:
            rows = calendars[engine]
            days = [date.fromisoformat(r["session_date"]) for r in rows]
            opens = [utc(r["open_at"]) for r in rows]
            closes = [utc(r["close_available_at"]) for r in rows]
            if (not rows or days != sorted(set(days)) or opens != sorted(set(opens)) or
                any(c < o for o, c in zip(opens, closes)) or days[0] > max(first, start) or
                days[-1] < following):
                raise ValueError("incomplete_verified_calendar")
            chosen = [r for r in rows if max(first, start) <= date.fromisoformat(r["session_date"]) < following]
            if not chosen:
                raise ValueError("empty_verified_month")
            if any(utc(r["close_available_at"]) > cutoff for r in chosen):
                raise ValueError("month_observations_not_available")
            next_open = next(utc(r["open_at"]) for r in rows if date.fromisoformat(r["session_date"]) >= following)
            if cutoff >= next_open:
                raise ValueError("review_not_before_next_market_open")
            expected[engine] = {r["session_date"] for r in chosen}
            all_days[engine] = {r["session_date"]: r for r in rows}
        observed = {}
        for row in observations:
            engine, day = row["engine"], row["session_date"]
            if engine not in ENGINES or day not in all_days[engine]:
                raise ValueError("invalid_observation_session")
            if utc(row["available_at"]) > cutoff:
                continue
            key = (engine, day)
            if key in observed and observed[key] != row:
                raise ValueError("conflicting_observation")
            observed[key] = row
        for engine in ENGINES:
            if any((engine, day) not in observed or observed[engine, day]["status"] != "COMPLETE"
                   for day in expected[engine]):
                raise ValueError("missing_market_signal_observation")
        first_delivery = {}
        for row in sorted(signals, key=lambda r: utc(r["available_at"])):
            if utc(row["available_at"]) > cutoff:
                continue
            engine, origin, confirmed = row["engine"], row["origin_date"], row["confirmation_date"]
            if (engine not in ENGINES or not isinstance(row["symbol"], str) or not row["symbol"] or
                date.fromisoformat(origin) > date.fromisoformat(confirmed) or
                origin not in all_days[engine] or confirmed not in all_days[engine] or
                utc(row["available_at"]) < utc(all_days[engine][confirmed]["close_available_at"])):
                raise ValueError("invalid_entry_delivery")
            if origin < start_date or confirmed < start_date:
                continue
            first_delivery.setdefault((engine, row["symbol"], origin), row)
        counts = {engine: sum(r["engine"] == engine and r["confirmation_date"] in expected[engine]
                              for r in first_delivery.values()) for engine in ENGINES}
        total = sum(counts.values())
        if not total and policy["zero_signal_month"] == "KEEP_PREVIOUS":
            weights, raw = prior, {engine: 0.0 for engine in ENGINES}
        else:
            raw = {engine: counts[engine] / total if total else 0.0 for engine in ENGINES}
            weights = {engine: min(raw[engine], policy["cap"]) if policy["cap"] is not None else raw[engine]
                       for engine in ENGINES}
            weights["C"] = max(0.0, 1.0 - sum(weights.values()))
        diagnostic.update(status="ok", fallback=False, unique_entry_counts=counts,
                          total_entries=total, known_signal_none=not total, uncapped_weights=raw,
                          source_month_sessions={e: {"first": min(d), "last": max(d), "count": len(d)}
                                                 for e, d in expected.items()})
        return {"weights": weights, "diagnostics": diagnostic}
    except (ValueError, TypeError, KeyError, StopIteration) as error:
        allowed = {"first_partial_month_hold_policy", "missing_market_signal_observation",
                   "month_observations_not_available", "review_not_before_next_market_open"}
        diagnostic.update(status="fallback", fallback=True,
                          reason=str(error) if str(error) in allowed else "invalid_or_incomplete_signal_inputs")
        return {"weights": prior, "diagnostics": diagnostic}
