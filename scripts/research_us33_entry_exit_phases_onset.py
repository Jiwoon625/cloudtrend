from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

import research_us33_entry_exit_phases as base

_ORIGINAL_ARCHITECTURE_MASK = base.architecture_mask


def architecture_mask(g: pd.DataFrame, architecture: str) -> pd.Series:
    """Apply the original confirmation logic and require a true entry onset."""
    mask = _ORIGINAL_ARCHITECTURE_MASK(g, architecture)
    if "_entry_onset" in g.columns:
        mask &= g["_entry_onset"].fillna(False)
    return mask


def exit_reason(row: pd.Series | None, config: base.Config) -> str | None:
    """Rank exits are state-based; optional trend/return exits require a breakdown crossing."""
    if row is None:
        return "DATA_MISSING"

    rank = row.get("mom_pct")
    if pd.isna(rank) or float(rank) < config.exit_cut:
        return "RANK_EXIT"

    if config.exit_rule in {"RANK_OR_ICHIMOKU", "RANK_OR_ICHIMOKU_OR_RET120_NEG"}:
        previous = row.get("prev_ichimoku_tk_gap")
        current = row.get("ichimoku_tk_gap")
        if (
            pd.notna(previous)
            and pd.notna(current)
            and float(previous) >= 0.0
            and float(current) < 0.0
        ):
            return "ICHIMOKU_BREAKDOWN"

    if config.exit_rule in {"RANK_OR_RET120_NEG", "RANK_OR_ICHIMOKU_OR_RET120_NEG"}:
        previous = row.get("prev_ret120")
        current = row.get("ret120")
        if (
            pd.notna(previous)
            and pd.notna(current)
            and float(previous) >= 0.0
            and float(current) < 0.0
        ):
            return "RET120_NEGATIVE"

    return None


def run_configs(
    con: Any,
    prepared_dir: Path,
    configs: list[base.Config],
):
    """Run each configuration with strict upward-crossing entry onset semantics."""
    states = {c.config_id: base.PortfolioState(c) for c in configs}
    previous_by_symbol: dict[str, tuple[float | None, float | None, float | None]] = {}

    for i, raw in enumerate(base.stream_days(con, prepared_dir), 1):
        g = raw.copy()
        symbols = g["symbol"].astype(str)
        previous = symbols.map(previous_by_symbol)
        g["prev_mom_pct"] = previous.map(
            lambda x: x[0] if isinstance(x, tuple) else np.nan
        )
        g["prev_ichimoku_tk_gap"] = previous.map(
            lambda x: x[1] if isinstance(x, tuple) else np.nan
        )
        g["prev_ret120"] = previous.map(
            lambda x: x[2] if isinstance(x, tuple) else np.nan
        )

        for state in states.values():
            state_view = g.copy()
            previous_rank = state_view["prev_mom_pct"]
            state_view["_entry_onset"] = (
                state_view["mom_pct"].fillna(-np.inf) >= state.config.entry_cut
            ) & (
                previous_rank.isna()
                | (previous_rank < state.config.entry_cut)
            )
            if state.positions:
                # A currently held name cannot be sold and repurchased at the same open.
                state_view.loc[
                    state_view["symbol"].astype(str).isin(state.positions),
                    "_entry_onset",
                ] = False
            base.process_day(state, state_view)

        for row in g.itertuples(index=False):
            previous_by_symbol[str(row.symbol)] = (
                base.sf(row.mom_pct),
                base.sf(row.ichimoku_tk_gap),
                base.sf(row.ret120),
            )

        if i % 250 == 0:
            print(
                json.dumps(
                    {
                        "processedSignalDates": i,
                        "configs": len(states),
                        "entryMode": "UPWARD_CROSSING_ONSET",
                    }
                )
            )

    for state in states.values():
        base.finalize_state(state)

    summary_rows = []
    annual_rows = []
    period_rows = []
    regime_rows = []
    daily_frames = []
    trade_frames = []

    for state in states.values():
        daily = pd.DataFrame(state.daily)
        trades = pd.DataFrame(state.trades)
        metrics = base.annualized_metrics(daily, trades)
        summary_rows.append({**state.config.to_dict(), **metrics})
        for rec in base.annual_metrics(daily):
            annual_rows.append({**state.config.to_dict(), **rec})
        for rec in base.period_metrics(daily):
            period_rows.append({**state.config.to_dict(), **rec})
        for rec in base.regime_metrics(daily):
            regime_rows.append({**state.config.to_dict(), **rec})
        daily_frames.append(daily)
        trade_frames.append(trades)

    summary = pd.DataFrame(summary_rows)
    annual = pd.DataFrame(annual_rows)
    period = pd.DataFrame(period_rows)
    regime = pd.DataFrame(regime_rows)
    daily_all = pd.concat(daily_frames, ignore_index=True) if daily_frames else pd.DataFrame()
    trades_all = pd.concat(trade_frames, ignore_index=True) if trade_frames else pd.DataFrame()
    scored = base.add_robust_score(summary, period)
    return scored, annual, period, regime, daily_all, trades_all


def output_directory() -> Path | None:
    try:
        idx = sys.argv.index("--output")
        return Path(sys.argv[idx + 1]).resolve()
    except (ValueError, IndexError):
        return None


def annotate_outputs(out: Path | None) -> None:
    if out is None or not out.exists():
        return

    decision_path = out / "decision_summary.json"
    if decision_path.exists():
        decision = json.loads(decision_path.read_text(encoding="utf-8"))
        decision["entryMechanism"] = {
            "mode": "UPWARD_CROSSING_ONSET",
            "definition": "Enter only when core momentum rank crosses upward from below the entry threshold to at or above it.",
            "initialization": "A missing prior observation is treated as below threshold so the first eligible date can seed the portfolio.",
            "sameDayReentry": False,
        }
        decision["phaseCExitMechanism"] = {
            "rank": "Exit whenever current core momentum rank is below the selected exit threshold.",
            "ichimoku": "Optional early exit only on a crossing from ichimoku_tk_gap >= 0 to < 0.",
            "ret120": "Optional early exit only on a crossing from ret120 >= 0 to < 0.",
        }
        decision_path.write_text(
            json.dumps(decision, ensure_ascii=False, indent=2, default=str),
            encoding="utf-8",
        )

    basic_path = out / "basic_model_summary.json"
    if basic_path.exists():
        basic = json.loads(basic_path.read_text(encoding="utf-8"))
        basic["interpretation"] = (
            "Core momentum rank crosses upward into Top 10% (E90 onset), "
            "Ichimoku must be in its daily top 20% at entry, and the position is held "
            "until core momentum rank falls below Top 30% (X70). Confirmation is entry-only."
        )
        basic_path.write_text(
            json.dumps(basic, ensure_ascii=False, indent=2, default=str),
            encoding="utf-8",
        )


def main() -> None:
    base.architecture_mask = architecture_mask
    base.exit_reason = exit_reason
    base.run_configs = run_configs
    out = output_directory()
    base.main()
    annotate_outputs(out)


if __name__ == "__main__":
    main()
