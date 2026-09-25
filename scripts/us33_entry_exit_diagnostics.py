from __future__ import annotations

import json
import math
import os
from pathlib import Path
from urllib.parse import quote

import numpy as np
import pandas as pd
import requests

BUCKET = "cloudtrend-data"
SOURCE_RUN_ID = "36166049484"
TARGET_CONFIGS = {
    "aggressive": "phase_c__E80_X70__M+B+T__RANK",
    "balanced": "phase_c__E80_X50__M+B+V__RANK",
    "basic": "phase_c__E90_X70__M+T__RANK",
}


def download(object_path: str, destination: Path) -> None:
    url = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    endpoint = (
        f"{url}/storage/v1/object/authenticated/{quote(BUCKET, safe='')}/"
        f"{quote(object_path, safe='/=._-')}"
    )
    headers = {"Authorization": f"Bearer {key}", "apikey": key}
    destination.parent.mkdir(parents=True, exist_ok=True)
    with requests.get(endpoint, headers=headers, stream=True, timeout=(20, 300)) as r:
        r.raise_for_status()
        with destination.open("wb") as f:
            for chunk in r.iter_content(1024 * 1024):
                if chunk:
                    f.write(chunk)


def sf(v):
    try:
        x = float(v)
    except Exception:
        return None
    return x if math.isfinite(x) else None


def drawdown_diagnostics(d: pd.DataFrame) -> dict:
    d = d.sort_values("entryDate").copy()
    equity = (1.0 + d["netReturn"].fillna(0.0)).cumprod()
    peak = equity.cummax()
    dd = equity / peak - 1.0
    trough_idx = dd.idxmin()
    trough_pos = d.index.get_loc(trough_idx)
    pre = equity.iloc[: trough_pos + 1]
    peak_value = pre.max()
    peak_idx = pre[pre == peak_value].index[-1]
    peak_pos = d.index.get_loc(peak_idx)
    recovery = equity.iloc[trough_pos + 1 :]
    recovery = recovery[recovery >= peak_value]
    recovery_date = None
    recovery_days = None
    if len(recovery):
        recovery_idx = recovery.index[0]
        recovery_date = str(pd.Timestamp(d.loc[recovery_idx, "entryDate"]).date())
        recovery_days = int(d.index.get_loc(recovery_idx) - trough_pos)

    underwater = dd < 0
    max_underwater = 0
    current = 0
    for value in underwater:
        if value:
            current += 1
            max_underwater = max(max_underwater, current)
        else:
            current = 0

    rolling = (1.0 + d["netReturn"].fillna(0.0)).rolling(252).apply(np.prod, raw=True) - 1.0
    worst_roll = rolling.min()
    best_roll = rolling.max()
    worst_idx = rolling.idxmin() if rolling.notna().any() else None
    best_idx = rolling.idxmax() if rolling.notna().any() else None

    return {
        "maxDrawdown": sf(dd.min()),
        "peakDate": str(pd.Timestamp(d.loc[peak_idx, "entryDate"]).date()),
        "troughDate": str(pd.Timestamp(d.loc[trough_idx, "entryDate"]).date()),
        "recoveryDate": recovery_date,
        "peakToTroughTradingDays": int(trough_pos - peak_pos),
        "troughToRecoveryTradingDays": recovery_days,
        "maxUnderwaterTradingDays": int(max_underwater),
        "currentlyUnderwater": bool(dd.iloc[-1] < 0),
        "endingDrawdown": sf(dd.iloc[-1]),
        "worstRolling252Return": sf(worst_roll),
        "worstRolling252EndDate": (
            str(pd.Timestamp(d.loc[worst_idx, "entryDate"]).date()) if worst_idx is not None else None
        ),
        "bestRolling252Return": sf(best_roll),
        "bestRolling252EndDate": (
            str(pd.Timestamp(d.loc[best_idx, "entryDate"]).date()) if best_idx is not None else None
        ),
    }


def monthly_diagnostics(d: pd.DataFrame) -> dict:
    d = d.sort_values("entryDate").copy()
    d["month"] = pd.to_datetime(d["entryDate"]).dt.to_period("M")
    m = d.groupby("month", observed=True).agg(
        return_=("netReturn", lambda x: float((1.0 + x).prod() - 1.0)),
        spyReturn=("spyReturn", lambda x: float((1.0 + x).prod() - 1.0)),
    )
    m["excess"] = m["return_"] - m["spyReturn"]
    worst = m["return_"].idxmin()
    best = m["return_"].idxmax()
    return {
        "months": int(len(m)),
        "positiveMonthRate": sf((m["return_"] > 0).mean()),
        "beatSpyMonthRate": sf((m["excess"] > 0).mean()),
        "medianMonthlyReturn": sf(m["return_"].median()),
        "worstMonth": str(worst),
        "worstMonthReturn": sf(m.loc[worst, "return_"]),
        "bestMonth": str(best),
        "bestMonthReturn": sf(m.loc[best, "return_"]),
    }


def capture_diagnostics(d: pd.DataFrame) -> dict:
    d = d.copy()
    up = d[d["spyReturn"] > 0]
    down = d[d["spyReturn"] < 0]
    up_capture = up["netReturn"].sum() / up["spyReturn"].sum() if len(up) and up["spyReturn"].sum() else np.nan
    down_capture = down["netReturn"].sum() / down["spyReturn"].sum() if len(down) and down["spyReturn"].sum() else np.nan
    corr = d[["netReturn", "spyReturn"]].corr().iloc[0, 1]
    beta = np.cov(d["netReturn"], d["spyReturn"], ddof=1)[0, 1] / np.var(d["spyReturn"], ddof=1)
    return {
        "dailyCorrelationToSpy": sf(corr),
        "dailyBetaToSpy": sf(beta),
        "upCaptureSimple": sf(up_capture),
        "downCaptureSimple": sf(down_capture),
        "returnOnSpyDownDaysAnnualizedApprox": sf(down["netReturn"].mean() * 252),
        "returnOnSpyUpDaysAnnualizedApprox": sf(up["netReturn"].mean() * 252),
    }


def trade_concentration(t: pd.DataFrame) -> dict:
    returns = pd.to_numeric(t["grossTradeReturn"], errors="coerce").dropna()
    positive = returns[returns > 0].sort_values(ascending=False)
    positive_total = positive.sum()
    result = {
        "tradeCount": int(len(returns)),
        "positiveTradeCount": int((returns > 0).sum()),
        "negativeTradeCount": int((returns < 0).sum()),
        "winnerRate": sf((returns > 0).mean()),
        "medianTradeReturn": sf(returns.median()),
        "top1ShareOfPositiveTradeReturnMass": sf(positive.head(1).sum() / positive_total),
        "top5ShareOfPositiveTradeReturnMass": sf(positive.head(5).sum() / positive_total),
        "top10ShareOfPositiveTradeReturnMass": sf(positive.head(10).sum() / positive_total),
        "top20ShareOfPositiveTradeReturnMass": sf(positive.head(20).sum() / positive_total),
        "winsOver100Pct": int((returns > 1.0).sum()),
        "lossesBelowMinus50Pct": int((returns < -0.5).sum()),
        "note": "Trade-return-mass concentration is diagnostic only; it is not exact portfolio P&L attribution because weights drift and positions overlap.",
    }
    top = t.nlargest(10, "grossTradeReturn")[
        ["symbol", "sectorCode", "entryDate", "exitDate", "holdingIntervals", "grossTradeReturn"]
    ].copy()
    result["topTrades"] = top.to_dict(orient="records")
    return result


def main() -> None:
    user_id = os.environ["SUPABASE_USER_ID"]
    root = Path("analysis-runs/us33-entry-exit-diagnostics")
    source = root / "source"
    out = root / "output"
    out.mkdir(parents=True, exist_ok=True)
    prefix = f"{user_id}/results/us33-entry-exit/{SOURCE_RUN_ID}"

    for name in ["phase_c_daily.parquet", "phase_c_trades.csv", "phase_c_annual.csv", "phase_c_summary.csv"]:
        download(f"{prefix}/{name}", source / name)

    daily = pd.read_parquet(source / "phase_c_daily.parquet")
    daily["entryDate"] = pd.to_datetime(daily["entryDate"])
    trades = pd.read_csv(source / "phase_c_trades.csv")
    annual = pd.read_csv(source / "phase_c_annual.csv")
    summary = pd.read_csv(source / "phase_c_summary.csv")

    diagnostics = {
        "sourceRunId": SOURCE_RUN_ID,
        "researchGrade": "SURVIVOR_ONLY_EXPLORATORY",
        "configs": {},
    }
    rows = []
    for label, config_id in TARGET_CONFIGS.items():
        d = daily[daily["configId"] == config_id].copy()
        t = trades[trades["configId"] == config_id].copy()
        a = annual[annual["configId"] == config_id].copy()
        s = summary[summary["configId"] == config_id].iloc[0].to_dict()
        annual_positive = int((a["return"] > 0).sum())
        annual_beat = int((a["excessReturnVsSpy"] > 0).sum())
        annual_block = {
            "positiveYears": annual_positive,
            "years": int(len(a)),
            "beatSpyYears": annual_beat,
            "medianAnnualReturn": sf(a["return"].median()),
            "annualReturnStd": sf(a["return"].std(ddof=1)),
            "geometricMeanExcludingBestYear": None,
            "bestYear": int(a.loc[a["return"].idxmax(), "year"]),
        }
        without_best = a.drop(index=a["return"].idxmax())
        annual_block["geometricMeanExcludingBestYear"] = sf(
            np.prod(1.0 + without_best["return"]) ** (1.0 / len(without_best)) - 1.0
        )
        record = {
            "label": label,
            "configId": config_id,
            "headline": {
                "CAGR": sf(s["CAGR"]),
                "Sharpe": sf(s["Sharpe"]),
                "MDD": sf(s["MDD"]),
                "annualTurnover": sf(s["annualTurnover"]),
                "avgHoldingIntervals": sf(s["avgHoldingIntervals"]),
                "excessCAGRVsSpy": sf(s["excessCAGRVsSpy"]),
            },
            "drawdown": drawdown_diagnostics(d),
            "monthly": monthly_diagnostics(d),
            "capture": capture_diagnostics(d),
            "annual": annual_block,
            "tradeConcentration": trade_concentration(t),
        }
        diagnostics["configs"][label] = record
        flat = {
            "label": label,
            "configId": config_id,
            **record["headline"],
            **{f"dd_{k}": v for k, v in record["drawdown"].items()},
            **{f"month_{k}": v for k, v in record["monthly"].items()},
            **{f"capture_{k}": v for k, v in record["capture"].items()},
            **{f"annual_{k}": v for k, v in record["annual"].items()},
        }
        rows.append(flat)

    (out / "stability_diagnostics.json").write_text(
        json.dumps(diagnostics, ensure_ascii=False, indent=2, default=str), encoding="utf-8"
    )
    pd.DataFrame(rows).to_csv(out / "stability_diagnostics.csv", index=False)
    print(json.dumps(diagnostics, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
