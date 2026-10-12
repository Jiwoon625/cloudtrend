"""Read-only intrinsic ENTRY observer using the original CM pure signal functions.

No empty-portfolio replay: that would retain the US 20-slot/pending-order filter.
State contains only market observations/ranks, never holdings or executable orders.
"""
from copy import deepcopy
from cmresearchengine import runtime
from cm06_comparison_signals import (us_session_analysis, kr_operational_signals,
    kospi_confirmation, etf_confirmation, etf_entry_weight, finite)
from o3_policy import utc

SIGNAL_COLUMNS = ["engine", "symbol", "origin_date", "confirmation_date", "available_at", "reason"]
OBSERVATION_COLUMNS = ["engine", "session_date", "available_at", "status"]


def initial_state():
    return {"history": {}, "us_state": {}, "last_date": None}


def observe(engine, rows, session, state, research_start):
    """Return detached next state, qualified intrinsic ENTRYs and coverage receipt.

Keep original model/data gates; omit cash, held/origin-held, prior NAV, sizing,
portfolio slots and execution gates. A raw onset is not a confirmed ENTRY.
"""
    if engine not in "KEU" or len(engine) != 1:
        raise ValueError("Unknown O3 market")
    day, cutoff = session["session_date"], utc(session["close_available_at"])
    if state["last_date"] and day <= state["last_date"]:
        raise ValueError("Observer sessions must increase")
    if any(r["session_date"] != day or utc(r["available_at"]) > cutoff for r in rows):
        raise ValueError("Unavailable or cross-session signal input")
    current = {r["symbol"]: dict(r) for r in rows}
    if len(current) != len(rows):
        raise ValueError("Duplicate signal instrument")
    result = deepcopy(state)
    result["last_date"] = day
    known_at = max((utc(r["available_at"]) for r in rows), default=cutoff).isoformat()
    # The caller supplies a full session from the hash-bound, preflight-verified
    # original panel. Never make execution/valuation prices a new signal gate.
    # This receipt proves that source session was consumed, not historical PIT
    # completeness or the absence of unknown instruments in the original data.
    complete = bool(rows)
    receipt = {"engine": engine, "session_date": day, "available_at": cutoff.isoformat(),
               "status": "COMPLETE" if complete else "MISSING"}
    signals = []

    def entry(symbol, origin, reason):
        if complete and day >= research_start and origin >= research_start:
            signals.append({"engine": engine, "symbol": symbol, "origin_date": origin,
                            "confirmation_date": day, "available_at": cutoff.isoformat(), "reason": reason})

    if engine == "U":
        if not rows:
            result["us_state"] = {"lastDate": day, "coreRanks": {}, "betaWeakStreak": {}}
        else:
            analysis = us_session_analysis(rows, state["us_state"])
            result["us_state"] = deepcopy(analysis["state"])
            for row in analysis["rows"]:
                if row["symbol"] != "SPY" and row["a0Entry"]:
                    entry(row["symbol"], day, "ENTRY_ONSET80")
        return result, sorted(signals, key=lambda r: (r["symbol"], r["origin_date"])), receipt

    for symbol, history in state["history"].items():
        if symbol not in current:
            previous = history[-1]
            current[symbol] = {"symbol": symbol, "session_date": day, "available_at": known_at,
                               "score": None, "eligible": False, "observed": False,
                               "market": previous.get("market"), "sector": previous.get("sector")}
    for symbol, row in current.items():
        history = state["history"].get(symbol, [])
        previous = history[-1] if history else None
        before = history[-2] if len(history) > 1 else None
        if engine == "K":
            market = row["market"]
            if market == "KOSPI":
                def observation(x):
                    return None if not x else {"date": x["session_date"], "score": x.get("score"),
                        "eligible": bool(x.get("eligible", False)), "observed": bool(x.get("observed", False)),
                        "rsAccel": x.get("rs_accel"), "marketGate": x.get("market_gate")}
                c = kospi_confirmation(observation(row), observation(previous), observation(before), historical_policy=True)
                if c["eligible"] and c["state"] == "confirmed":
                    entry(symbol, c["originDate"], "CONFIRM1_RS_BEAR")
            elif market == "KOSDAQ":
                c = kr_operational_signals(market, previous.get("score") if previous else None,
                                           row.get("score"), bool(row.get("eligible", False)), held=False)
                if c["kosdaq80Onset"]:
                    entry(symbol, day, "ONSET80")
            else:
                raise ValueError("Unknown original KR market")
        else:
            def observation(x):
                return None if not x else {"date": x["session_date"], "score": x.get("score"),
                    "eligible": bool(x.get("eligible", False)), "underlyingClose": x.get("underlying_close"),
                    "underlyingMa60": x.get("underlying_ma60")}
            c = etf_confirmation(observation(row), observation(previous), observation(before))
            adv = row.get("average_trading_value20")
            if (not row.get("krx_batch_pending", False) and c["onset"] and
                etf_entry_weight(row.get("annual_volatility")) is not None and finite(adv) and adv >= 0):
                entry(symbol, c["originDate"], "CONFIRM1")
        result["history"][symbol] = (history + [row])[-2:]
    return result, sorted(signals, key=lambda r: (r["symbol"], r["origin_date"])), receipt
