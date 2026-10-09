"""Prepare private dated A0 atomic CSVs from existing canonical data, without network I/O.

The current production feature function is imported, never rewritten here. Source
OHLCV remains adjusted-price research evidence, not certified total-return/PIT data.
Processes one canonical year with 400 prior sessions at a time; no 37-feature panel.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import resource
import time
from pathlib import Path
import zipfile

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
CORE_PATH = ROOT / "collectors/lite_r3/runtime/us_feature_core.py"
spec = importlib.util.spec_from_file_location("cloudtrend_us_feature_core", CORE_PATH)
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)

ALIASES = {
    "tradeDateUsEastern": "date", "tradeDate": "date", "dt": "date",
    "ticker": "symbol", "englishName": "english_name", "securityType": "security_type",
    "sharesOutstanding": "shares_outstanding", "isCommonShare": "is_common_share",
    "tossTradable": "toss_tradable", "marketCap": "market_cap",
}
FIELDS = [
    "date", "symbol", "name", "market", "sector", "security_type", "status", "currency",
    "open", "high", "low", "close", "volume", "dollar_volume", "shares_outstanding",
    "market_cap", "ret120", "ret252", "beta60_spy", "ichimoku_tk_gap", "relvol1_20",
    "adv20_usd", "amihud20", "active20", "toss_tradable", "is_common_share", "fx_usdkrw",
]


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def read_frame(path: Path) -> pd.DataFrame:
    # Drive streams octet-stream Parquet with a .bin suffix; preserve its bytes.
    if path.name.lower().endswith((".parquet", ".parquet.bin")):
        return pd.read_parquet(path)
    return pd.read_csv(path, dtype={"symbol": str, "ticker": str}, float_precision="round_trip",
                       keep_default_na=False, na_values=[""])


def normalize(frame: pd.DataFrame) -> pd.DataFrame:
    frame = frame.rename(columns={old: new for old, new in ALIASES.items() if old in frame and new not in frame}).copy()
    if "symbol" not in frame:
        raise ValueError("Canonical/master input requires symbol")
    if frame.symbol.isna().any() or frame.symbol.astype(str).str.strip().eq("").any():
        raise ValueError("Canonical/master input requires nonempty symbols")
    frame["symbol"] = frame.symbol.astype(str).str.strip().str.upper()
    if "date" in frame:
        frame["date"] = pd.to_datetime(frame.date, errors="raise").dt.strftime("%Y-%m-%d")
    return frame


def merge_observations(frame: pd.DataFrame) -> pd.DataFrame:
    # Input order is authoritative: later nonempty cells win, matching CSV production parsing.
    frame = frame.replace(r"^\s*$", np.nan, regex=True)
    return frame.groupby(["symbol", "date"], sort=False, as_index=False).last().sort_values(["symbol", "date"])


def truthy(value) -> bool:
    return pd.notna(value) and str(value).strip().lower() in {"true", "1", "1.0", "yes", "y", "t"}


def explicit_flags(values: pd.Series, name: str) -> pd.Series:
    normalized = values.astype(str).str.strip().str.lower()
    allowed = {"true", "1", "1.0", "yes", "y", "t", "false", "0", "0.0", "no", "n", "f"}
    if values.isna().any() or not normalized.isin(allowed).all():
        raise ValueError(f"Missing or invalid explicit {name} metadata")
    return values.map(truthy)


def load_sector_map(path: Path) -> tuple[pd.DataFrame, dict]:
    evidence = {"path": str(path), "sha256": sha(path)}
    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as archive:
            csvs = [name for name in archive.namelist() if name.lower().endswith(".csv")]
            preferred = [name for name in csvs if Path(name).name == "us_stock_sector_map_14_v1.csv"]
            selected = preferred if preferred else csvs
            if len(selected) != 1:
                raise ValueError("Sector ZIP requires one unambiguous sector-map CSV")
            member = selected[0]
            raw = archive.read(member)
            evidence.update(member=member, memberSha256="sha256:" + hashlib.sha256(raw).hexdigest())
            with archive.open(member) as stream:
                sector_map = pd.read_csv(stream, dtype=str, keep_default_na=False)
    else:
        sector_map = read_frame(path)
    sector_map = normalize(sector_map)
    if "sectorCode" in sector_map:
        if "sector" in sector_map and not sector_map.sector.eq(sector_map.sectorCode).all():
            raise ValueError("Sector map has conflicting sector and sectorCode")
        sector_map = sector_map.rename(columns={"sectorCode": "sector"}) if "sector" not in sector_map else sector_map
    if "sector" not in sector_map or sector_map.symbol.duplicated().any():
        raise ValueError("Sector map requires unique symbols and explicit sector")
    if sector_map.sector.isna().any() or sector_map.sector.astype(str).str.strip().eq("").any():
        raise ValueError("Sector map has missing sector values")
    sector_map["sector"] = sector_map.sector.astype(str).str.strip()
    evidence["rows"] = len(sector_map)
    if "mappingVersion" in sector_map:
        evidence["mappingVersions"] = sorted(sector_map.mappingVersion.dropna().astype(str).unique().tolist())
    return sector_map[["symbol", "sector"]], evidence


def join_sectors(master: pd.DataFrame, sector_map: pd.DataFrame) -> pd.DataFrame:
    equity = master.symbol.ne("SPY")
    if set(master.loc[equity, "symbol"]) != set(sector_map.loc[sector_map.symbol.ne("SPY"), "symbol"]):
        raise ValueError("Sector-map symbols must exactly match the supplied frozen master universe")
    joined = master.merge(sector_map.rename(columns={"sector": "_mapped_sector"}), on="symbol",
                          how="left", validate="one_to_one")
    if "sector" in joined:
        present = joined.sector.notna() & joined.sector.astype(str).str.strip().ne("") & joined.symbol.ne("SPY")
        if not joined.loc[present, "sector"].astype(str).str.strip().eq(joined.loc[present, "_mapped_sector"]).all():
            raise ValueError("Supplied master sector conflicts with sector map")
    joined["sector"] = joined.pop("_mapped_sector")
    return joined


def enrich_atomic(features: pd.DataFrame, master: pd.DataFrame) -> pd.DataFrame:
    """Apply explicitly supplied current-universe metadata, never infer common-share status."""
    if "is_common_share" not in master or not ({"toss_tradable", "status"} & set(master)):
        raise ValueError("Master requires is_common_share and toss_tradable or status")
    # A current master may contain old derived fields. It may never replace a
    # dated feature freshly computed from canonical history.
    metadata_fields = ["symbol", "name", "english_name", "market", "sector",
                       "security_type", "status", "currency", "shares_outstanding",
                       "toss_tradable", "is_common_share"]
    cols = [c for c in metadata_fields if c in master]
    cols = list(dict.fromkeys(["symbol"] + cols))
    # Atomic market values come from the canonical row; explicit metadata comes from the master.
    out = features.drop(columns=[c for c in cols if c != "symbol" and c in features]).merge(
        master[cols], on="symbol", how="left", validate="many_to_one")
    non_spy = out.symbol.ne("SPY")
    if out.loc[non_spy, "is_common_share"].isna().any():
        raise ValueError("Canonical symbols missing explicit master common-share metadata")
    common = explicit_flags(out.loc[non_spy, "is_common_share"], "is_common_share")
    out["is_common_share"] = False
    out.loc[non_spy, "is_common_share"] = common
    if "toss_tradable" in out:
        if out.loc[non_spy, "toss_tradable"].isna().any():
            raise ValueError("Canonical symbols missing explicit toss_tradable metadata")
        tradable = explicit_flags(out.loc[non_spy, "toss_tradable"], "toss_tradable")
        out["toss_tradable"] = False
        out.loc[non_spy, "toss_tradable"] = tradable
    else:
        if out.loc[non_spy, "status"].isna().any() or out.loc[non_spy, "status"].astype(str).str.strip().eq("").any():
            raise ValueError("Canonical symbols missing explicit status metadata")
        # This is the existing production collector rule, frozen retrospectively.
        out["toss_tradable"] = out.status.astype(str).str.strip().str.upper().eq("ACTIVE") & non_spy
    if "sector" not in out or out.loc[non_spy, "sector"].isna().any() or out.loc[non_spy, "sector"].astype(str).str.strip().eq("").any():
        raise ValueError("Canonical symbols missing explicit sector metadata; supply --sector-map")
    out["shares_outstanding"] = pd.to_numeric(out.get("shares_outstanding", pd.Series(np.nan, index=out.index)), errors="coerce")
    out["market_cap"] = out.close * out.shares_outstanding
    name = out.get("english_name", pd.Series(np.nan, index=out.index))
    out["name"] = name.fillna(out.get("name", pd.Series(np.nan, index=out.index))).fillna(out.symbol)
    for field in FIELDS:
        if field not in out:
            out[field] = None
    return out[FIELDS].replace([np.inf, -np.inf], np.nan)


def benchmark_rows(frame: pd.DataFrame) -> pd.DataFrame:
    if "spy_close" in frame:
        date_col = next((c for c in ["date", "dt", "tradeDateUsEastern"] if c in frame), None)
        if not date_col:
            raise ValueError("SPY benchmark date missing")
        out = pd.DataFrame({"date": frame[date_col], "symbol": "SPY", "close": frame.spy_close})
        for col in ["open", "high", "low", "volume"]:
            out[col] = frame.get("spy_" + col, np.nan)
        return normalize(out)
    out = normalize(frame)
    out = out.loc[out.symbol.eq("SPY")].copy()
    for col in ["open", "high", "low", "volume"]:
        if col not in out:
            out[col] = np.nan
    return out


def prepare(canonical: list[Path], benchmark: Path, master_path: Path, output: Path,
            start: str, through: str | None = None, sector_map_path: Path | None = None) -> dict:
    started = time.monotonic()
    if not canonical:
        raise ValueError("No canonical files")
    # A completed output is immutable; a different replay belongs in a new directory.
    if output.exists() and any(output.iterdir()):
        raise ValueError("Output directory must be empty")
    output.mkdir(parents=True, exist_ok=True)
    master = normalize(read_frame(master_path))
    if master.symbol.duplicated().any():
        raise ValueError("Master requires unique symbols")
    sector_evidence = None
    if sector_map_path is not None:
        sector_map, sector_evidence = load_sector_map(sector_map_path)
        master = join_sectors(master, sector_map)
    spy = merge_observations(benchmark_rows(read_frame(benchmark)))
    if spy.empty or spy.close.isna().any() or (spy.close <= 0).any():
        raise ValueError("Valid SPY session closes required")
    carry = pd.DataFrame()
    previous_source_end = None
    outputs, sessions, input_files = [], [], []
    first_complete_rows = 0
    for source in canonical:
        frame = normalize(read_frame(source))
        required = {"date", "symbol", "open", "high", "low", "close", "volume"}
        if not required <= set(frame):
            raise ValueError("Canonical missing OHLCV/date/symbol: " + str(source))
        frame = frame.loc[frame.symbol.ne("SPY")].copy()
        if through:
            frame = frame.loc[frame.date.le(through)].copy()
        if frame.empty:
            continue
        first, last = frame.date.min(), frame.date.max()
        if previous_source_end is not None and first <= previous_source_end:
            raise ValueError("Canonical partitions overlap or are unordered; normalize source order first")
        previous_source_end = last
        input_files.append({"path": str(source), "sha256": sha(source), "rows": len(frame), "firstDate": first, "lastDate": last})
        raw = merge_observations(pd.concat([carry, frame], ignore_index=True))
        spy_window = spy.loc[spy.date.between(raw.date.min(), last)]
        features = core.compute_us_feature_panel(pd.concat([raw, spy_window], ignore_index=True))
        dated = enrich_atomic(features.loc[features.date.between(max(start, first), last)].copy(), master)
        for date, rows in dated.groupby("date", sort=True):
            if not sessions:
                required_features = ["ret120", "ret252", "beta60_spy", "ichimoku_tk_gap", "relvol1_20", "adv20_usd", "amihud20"]
                complete = rows[required_features].apply(pd.to_numeric, errors="coerce").replace([np.inf, -np.inf], np.nan).notna().all(axis=1)
                first_complete_rows = int((complete & rows.symbol.ne("SPY")).sum())
            if date in sessions:
                raise ValueError("Duplicate output session")
            rows = rows.sort_values("symbol")
            path = output / f"{date}.csv"
            temporary = path.with_suffix(".csv.part")
            rows.to_csv(temporary, index=False, lineterminator="\n")
            temporary.replace(path)
            outputs.append({"date": date, "file": path.name, "rows": len(rows), "bytes": path.stat().st_size, "sha256": sha(path)})
            sessions.append(date)
        history_sessions = sorted(spy.loc[spy.date.le(last), "date"].unique())[-400:]
        carry = raw.loc[raw.date.isin(history_sessions)].copy()
    expected = spy.loc[spy.date.between(start, previous_source_end or start), "date"].tolist()
    if sessions != expected:
        raise ValueError("Canonical partitions omitted benchmark sessions")
    source_start = input_files[0]["firstDate"] if input_files else None
    source_calendar = spy.loc[spy.date.ge(source_start), "date"].tolist() if source_start else []
    warmup = {"requiredPriorSessions": 252, "canonicalSourceStart": source_start,
              "earliestEvaluationDate": source_calendar[252] if len(source_calendar) > 252 else None,
              "firstOutputDate": sessions[0] if sessions else None,
              "priorSessionsBeforeFirstOutput": sum(day < sessions[0] for day in source_calendar) if sessions else 0,
              "completeRowsOnFirstOutput": first_complete_rows}
    manifest = {
        "featureWarmup": warmup,
        "preparationMetrics": {"elapsedSeconds": time.monotonic() - started, "maxRssKiB": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss},
        "version": "adopted-us-atomic-inputs-v1", "researchGrade": "RETROSPECTIVE_CURRENT_UNIVERSE_NOT_INDEPENDENT_OOS",
        "featureSource": str(CORE_PATH.relative_to(ROOT)), "featureCodeHash": sha(CORE_PATH),
        "firstDate": sessions[0] if sessions else None, "lastDate": sessions[-1] if sessions else None,
        "sessions": sessions, "canonical": input_files,
        "benchmark": {"path": str(benchmark), "sha256": sha(benchmark)},
        "master": {"path": str(master_path), "sha256": sha(master_path)},
        "files": outputs, "rows": sum(x["rows"] for x in outputs),
        "limitations": ["Current-universe metadata is frozen retrospectively, not historical membership or broker eligibility.",
                        "ACTIVE-to-toss_tradable uses the frozen explicit master status, not historical broker availability.",
                        "Sector classifications are supplied current mappings, not point-in-time historical sectors.",
                        "Adjusted source prices are not a certified corporate-action or dividend ledger.",
                        "Missing prices/volumes remain null; no future labels are exported."],
    }
    if sector_evidence is not None:
        manifest["sectorMap"] = sector_evidence
    temp = output / "manifest.json.part"
    temp.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    temp.replace(output / "manifest.json")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--canonical", required=True, nargs="+", help="Ordered annual canonical Parquet/CSV files")
    parser.add_argument("--benchmark", required=True)
    parser.add_argument("--master", required=True, help="Verified immutable universe/master CSV or Parquet")
    parser.add_argument("--sector-map", help="Matching frozen-universe sector CSV or ZIP; required if master lacks sector")
    parser.add_argument("--output", required=True)
    parser.add_argument("--start", default="2017-01-03")
    parser.add_argument("--through")
    args = parser.parse_args()
    result = prepare([Path(p) for p in args.canonical], Path(args.benchmark), Path(args.master), Path(args.output),
                     args.start, args.through, Path(args.sector_map) if args.sector_map else None)
    print(json.dumps({k: result[k] for k in ["version", "firstDate", "lastDate", "rows"]}))


if __name__ == "__main__":
    main()
