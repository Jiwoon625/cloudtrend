"""Stage the existing private US sources for today's-rule exploratory replay.

Imported only by the explicitly authorized private job. There is no credential
discovery, standalone network entry point, remote write, or source-listing path.
The caller validates the complete transfer catalog before calling this helper.
Known original hashes are pinned; the remaining annual hashes are observations
of this download, never represented as independently verified original hashes.
"""
from __future__ import annotations

import json
from pathlib import Path
import re

SOURCE_VERSION = "adopted-full-period-source-transfer-v1"
UNIVERSE_VERSION = "us-current-v01-20260923_092237-0212ac78353e"
RESEARCH_GRADE = "SURVIVOR_ONLY_EXPLORATORY"
SECTOR_VERSION = "us-sector-14-v1.1-yahoo-sec-curated-20260926"
UNIVERSE_ROWS = 5032
CANONICAL_ROWS = 9503107
FIRST_DATE, LAST_DATE = "2016-01-04", "2026-09-23"
YEARS = tuple(range(2016, 2027))
ANNUAL_BYTES = dict(zip(YEARS, [19695822, 19767323, 21363355, 22595134, 24594645,
                              28442717, 31178217, 32100001, 33807590, 36246706, 30865730]))
MASTER = {"bytes": 374078, "sha256": "8372f4eb7beeee187a888b11dcabacb3e8e0342ae686a63c04f8e94b9c47ba50"}
BENCHMARK = "benchmark/us_benchmarks_adjusted.parquet"
SECTOR_MAP = "sector/v1.1/us_stock_sector_map_14_v1.csv"
MANIFEST_NAMES = ("manifest_us1_price_backfill.json", "manifest_us2.json", "manifest_us2_1.json")
# These are hashes of verified original file bytes, including the CSV member of
# the original sector ZIP. No owner IDs, Drive IDs, URLs, or credentials belong here.
PINNED = {
    "canonical/year=2016/us_stock_daily.parquet": {
        "bytes": ANNUAL_BYTES[2016], "sha256": "b9a02eee4f8d614a220f004ea4b0f3bed72bb2e25fb1760f41a40538c87ac680"},
    BENCHMARK: {"bytes": 1137390, "sha256": "f36e9bd69b954eefdc448daf9e891cac8f01151cfb3987a349c990511423463e"},
    SECTOR_MAP: {"bytes": 1426209, "sha256": "cfe224d6148290abb9789856ae86d7772a7023af37a6c6b591ab4fdbb8b766e8"},
    MANIFEST_NAMES[0]: {"bytes": 1407, "sha256": "09c64e481d6c557217017404aec571d4c6433af2812cee727f3df53ff470dc7c"},
    MANIFEST_NAMES[1]: {"bytes": 1314, "sha256": "03d41a4c38cb8a80d7649096f490dfc04231fbbdd6aee1cb6ab006276c45f010"},
    MANIFEST_NAMES[2]: {"bytes": 1546, "sha256": "2b460a4f8fbce577cebec92c5dd2a7935511efc0f34551d1708abe66a9edec00"},
}


class UsInputError(RuntimeError):
    """Only fixed, credential-free codes may escape this helper."""


def require(condition, code):
    if not condition:
        raise UsInputError(code)


def validate_source_manifests(manifests):
    require(set(manifests) == set(MANIFEST_NAMES), "US_SOURCE_MANIFESTS_MISSING")
    for manifest in manifests.values():
        require(isinstance(manifest, dict), "US_SOURCE_MANIFEST_INVALID")
        require(manifest.get("universeVersion") == UNIVERSE_VERSION and
                manifest.get("researchGrade") == RESEARCH_GRADE and
                manifest.get("finalOosAllowed") is False, "US_SOURCE_POLICY_MISMATCH")
        require(type(manifest.get("canonicalRows")) is int and
                manifest["canonicalRows"] == CANONICAL_ROWS, "US_CANONICAL_COUNT_MISMATCH")
    source, features, long_horizon = (manifests[name] for name in MANIFEST_NAMES)
    require(source.get("version") == "us1-price-backfill-v0.2-crash-safe" and
            source.get("universeFrozen") is True and source.get("adjusted") is True and
            source.get("compactionStatus") == "COMPLETE" and
            source.get("readyForUs2Exploratory") is True, "US_BACKFILL_NOT_VERIFIED")
    require(source.get("refinedUniverseRows") == UNIVERSE_ROWS and
            source.get("completedSymbols") == UNIVERSE_ROWS and
            all(type(source.get(field)) is int and source[field] == 0 for field in
                ("remainingSymbols", "failedSymbolsUnresolved", "corruptShards")), "US_BACKFILL_INCOMPLETE")
    require(features.get("version") == "us2-single-feature-v0" and
            features.get("universeRows") == UNIVERSE_ROWS and
            features.get("canonicalMinDate") == FIRST_DATE and features.get("canonicalMaxDate") == LAST_DATE and
            features.get("canonicalQaPassed") is True and features.get("benchmarkReady") is True and
            features.get("featurePanelYearsDone") == list(YEARS), "US_SOURCE_COVERAGE_MISMATCH")
    require(long_horizon.get("version") == "us2.1-long-horizon-v0" and
            long_horizon.get("universeRows") == UNIVERSE_ROWS and
            long_horizon.get("targetsYearsDone") == list(YEARS), "US_SOURCE_COVERAGE_MISMATCH")


def master_entry(manifest, owner):
    require(isinstance(owner, str) and re.fullmatch(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", owner), "US_INVALID_OWNER")
    require(isinstance(manifest, dict) and manifest.get("owner") == owner and
            manifest.get("bucket") == "cloudtrend-data" and manifest.get("version") == SOURCE_VERSION,
            "US_TRANSFER_MANIFEST_SCOPE_MISMATCH")
    extras = manifest.get("extraFiles")
    require(isinstance(extras, list), "US_MASTER_CATALOG_ENTRY_MISSING")
    matches = [item for item in extras if isinstance(item, dict) and item.get("sourceGroup") == "US_METADATA"
               and item.get("sha256") == MASTER["sha256"] and item.get("bytes") == MASTER["bytes"]]
    require(len(matches) == 1, "US_MASTER_CATALOG_ENTRY_MISSING")
    item = matches[0]
    relative = item.get("sourcePath")
    require(isinstance(relative, str) and re.fullmatch(r"metadata/[A-Za-z0-9_.-]+\.parquet", relative),
            "US_MASTER_SOURCE_PATH_INVALID")
    require(item.get("storagePath") == owner + "/research/adopted-full-period/inputs/" +
            MASTER["sha256"] + "/" + relative, "US_MASTER_STORAGE_PATH_INVALID")
    return item


def read_parquet(path, columns):
    import pandas as pd
    try:
        return pd.read_parquet(path, columns=columns)
    except Exception:
        raise UsInputError("US_PARQUET_SCHEMA_OR_READ_FAILED") from None


def symbols(frame):
    require("symbol" in frame and frame.symbol.notna().all(), "US_SYMBOL_INVALID")
    values = frame.symbol
    require(values.map(lambda value: isinstance(value, str) and bool(value) and
                       value == value.strip().upper()).all(), "US_SYMBOL_INVALID")
    return set(values)


def require_bool_column(frame, name, expected, code):
    from pandas.api.types import is_bool_dtype
    require(name in frame and is_bool_dtype(frame[name]) and frame[name].notna().all() and
            frame[name].eq(expected).all(), code)


def validate_master(path):
    frame = read_parquet(path, ["symbol", "universeVersionV01", "researchGradeV01", "pointInTimeSafe",
                                "historicalBacktestEligible", "universeFrozenV01", "isCommonShare"])
    universe = symbols(frame)
    require(len(frame) == UNIVERSE_ROWS and len(universe) == UNIVERSE_ROWS, "US_MASTER_UNIVERSE_MISMATCH")
    # The unsuffixed columns describe V0, not this explicitly refined V0.1 universe.
    require(frame.universeVersionV01.eq(UNIVERSE_VERSION).all() and
            frame.researchGradeV01.eq(RESEARCH_GRADE).all(), "US_MASTER_POLICY_MISMATCH")
    for name, expected in [("pointInTimeSafe", False), ("historicalBacktestEligible", False),
                           ("universeFrozenV01", True), ("isCommonShare", True)]:
        require_bool_column(frame, name, expected, "US_MASTER_POLICY_MISMATCH")
    return universe


def validate_sector_map(path, universe):
    import pandas as pd
    try:
        frame = pd.read_csv(path, dtype=str, keep_default_na=False)
    except Exception:
        raise UsInputError("US_SECTOR_READ_FAILED") from None
    require({"symbol", "sectorCode", "mappingVersion"} <= set(frame), "US_SECTOR_SCHEMA_INVALID")
    require(len(frame) == UNIVERSE_ROWS and symbols(frame) == universe and not frame.symbol.duplicated().any(),
            "US_SECTOR_UNIVERSE_MISMATCH")
    require(frame.mappingVersion.eq(SECTOR_VERSION).all() and frame.sectorCode.str.strip().ne("").all(),
            "US_SECTOR_MAPPING_MISMATCH")
    return {"rows": len(frame), "mappingVersion": SECTOR_VERSION}


def validate_benchmark(path):
    import numpy as np
    import pandas as pd
    frame = read_parquet(path, ["dt", "spy_close"])
    try:
        dates = pd.to_datetime(frame.dt, errors="raise").dt.strftime("%Y-%m-%d")
        prices = pd.to_numeric(frame.spy_close, errors="raise")
    except Exception:
        raise UsInputError("US_BENCHMARK_VALUES_INVALID") from None
    require(not frame.empty and dates.notna().all() and not dates.duplicated().any() and
            dates.is_monotonic_increasing and prices.notna().all() and np.isfinite(prices).all() and
            prices.gt(0).all(), "US_BENCHMARK_VALUES_INVALID")
    require(dates.min() <= FIRST_DATE and dates.max() >= LAST_DATE, "US_BENCHMARK_COVERAGE_MISMATCH")
    return set(dates), {"rows": len(frame), "firstDate": dates.min(), "lastDate": dates.max(),
                        "usedColumns": ["dt", "spy_close"], "forwardLabelColumnsUsed": False}


def validate_canonical(path, year, universe, benchmark_sessions):
    import numpy as np
    import pandas as pd
    columns = ["symbol", "tradeDateUsEastern", "open", "high", "low", "close", "volume",
               "adjusted", "universeVersion", "researchGrade"]
    frame = read_parquet(path, columns)
    seen = symbols(frame)
    require(not frame.empty and seen <= universe, "US_CANONICAL_UNIVERSE_MISMATCH")
    require(frame.universeVersion.eq(UNIVERSE_VERSION).all() and frame.researchGrade.eq(RESEARCH_GRADE).all(),
            "US_CANONICAL_POLICY_MISMATCH")
    require_bool_column(frame, "adjusted", True, "US_CANONICAL_ADJUSTMENT_MISMATCH")
    try:
        dates = pd.to_datetime(frame.tradeDateUsEastern, errors="raise").dt.strftime("%Y-%m-%d")
    except Exception:
        raise UsInputError("US_CANONICAL_DATE_INVALID") from None
    require(dates.notna().all() and frame.tradeDateUsEastern.eq(dates).all() and
            dates.str.startswith(str(year) + "-").all(), "US_CANONICAL_DATE_INVALID")
    require(not frame.duplicated(["symbol", "tradeDateUsEastern"]).any(), "US_CANONICAL_DUPLICATE_ROWS")
    first, last = dates.min(), dates.max()
    require(FIRST_DATE <= first <= last <= LAST_DATE, "US_CANONICAL_DATE_RANGE_MISMATCH")
    expected = {day for day in benchmark_sessions if day.startswith(str(year) + "-") and FIRST_DATE <= day <= LAST_DATE}
    require(set(dates) == expected, "US_CANONICAL_SESSION_COVERAGE_MISMATCH")
    for name in ["open", "high", "low", "close", "volume"]:
        try:
            values = pd.to_numeric(frame[name], errors="raise").dropna()
        except Exception:
            raise UsInputError("US_CANONICAL_NUMERIC_INVALID") from None
        require(np.isfinite(values).all() and (values.ge(0).all() if name == "volume" else values.gt(0).all()),
                "US_CANONICAL_NUMERIC_INVALID")
    return {"rows": len(frame), "symbols": len(seen), "sessions": len(expected),
            "firstDate": first, "lastDate": last, "duplicateRows": 0,
            "adjusted": True, "universeVersion": UNIVERSE_VERSION, "researchGrade": RESEARCH_GRADE}, seen


def stage_us_private_inputs(storage, owner_id, manifest, workdir):
    """Return local paths and private provenance, using the job's read-only adapter."""
    require(storage.owner == owner_id, "US_STORAGE_OWNER_MISMATCH")
    master = master_entry(manifest, owner_id)
    root = Path(workdir)
    require(not root.exists() and not root.is_symlink(), "US_WORKSPACE_MUST_BE_NEW")
    root.mkdir(mode=0o700)
    prefix = owner_id + "/research/us/v0/"
    relatives = [f"canonical/year={year}/us_stock_daily.parquet" for year in YEARS]
    allowlisted = set(relatives) | {BENCHMARK, SECTOR_MAP} | set(MANIFEST_NAMES)
    storage.input_keys.update(prefix + name for name in allowlisted)
    storage.input_keys.add(master["storagePath"])
    evidence = []

    def pinned(relative, details, key=None):
        target = root / relative
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        storage.download(prefix + relative if key is None else key, target, details)
        row = {"sourcePath": relative, "bytes": details["bytes"], "sha256": details["sha256"],
               "hashStatus": "PINNED_ORIGINAL_SHA256"}
        evidence.append(row)
        return target, row

    manifests = {}
    for name in MANIFEST_NAMES:
        path, _ = pinned(name, PINNED[name])
        try:
            manifests[name] = json.loads(path.read_bytes())
        except (ValueError, UnicodeDecodeError):
            raise UsInputError("US_SOURCE_MANIFEST_JSON_INVALID") from None
    validate_source_manifests(manifests)
    master_path, _ = pinned(master["sourcePath"], MASTER, master["storagePath"])
    universe = validate_master(master_path)
    sector_path, sector_evidence = pinned(SECTOR_MAP, PINNED[SECTOR_MAP])
    sector_evidence.update(validate_sector_map(sector_path, universe))
    benchmark_path, benchmark_evidence = pinned(BENCHMARK, PINNED[BENCHMARK])
    benchmark_sessions, benchmark_quality = validate_benchmark(benchmark_path)
    benchmark_evidence.update(benchmark_quality)
    canonical, observed_symbols, rows = [], set(), 0
    for year, relative in zip(YEARS, relatives):
        if relative in PINNED:
            path, record = pinned(relative, PINNED[relative])
        else:
            path = root / relative
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            downloaded = storage.download_observed(prefix + relative, path, ANNUAL_BYTES[year])
            require(downloaded.get("bytes") == ANNUAL_BYTES[year] and
                    isinstance(downloaded.get("sha256"), str) and re.fullmatch(r"[0-9a-f]{64}", downloaded["sha256"]),
                    "US_OBSERVED_HASH_INVALID")
            record = {"sourcePath": relative, "bytes": downloaded["bytes"], "sha256": downloaded["sha256"],
                      "hashStatus": "OBSERVED_AT_DOWNLOAD_NOT_PREPINNED"}
            evidence.append(record)
        quality, seen = validate_canonical(path, year, universe, benchmark_sessions)
        record.update(quality)
        rows += quality["rows"]
        observed_symbols.update(seen)
        canonical.append(path)
    require(rows == CANONICAL_ROWS, "US_CANONICAL_COUNT_MISMATCH")
    provenance = {
        "version": "adopted-us-private-inputs-v1", "sourceFiles": len(evidence),
        "sourceBytes": sum(item["bytes"] for item in evidence), "files": evidence,
        "universeVersion": UNIVERSE_VERSION, "universeRows": UNIVERSE_ROWS,
        "canonicalRows": rows, "observedCanonicalSymbols": len(observed_symbols),
        "masterSymbolsWithoutCanonicalRows": len(universe - observed_symbols),
        "firstDate": FIRST_DATE, "lastDate": LAST_DATE, "adjusted": True,
        "researchGrade": RESEARCH_GRADE, "pointInTimeSafe": False,
        "historicalBacktestEligible": False, "finalOosAllowed": False,
        "limitations": [
            "Current survivor-only universe, shares, broker status and sector metadata are frozen retrospectively.",
            "The 2017-2026 canonical SHA-256 values are first-download observations, not independently pre-pinned original hashes.",
            "Adjusted prices are not a certified corporate-action or total-return ledger.",
            "Benchmark forward-label and precomputed-feature columns are not used by preparation.",
        ],
    }
    return {"canonical": canonical, "benchmark": benchmark_path, "master": master_path,
            "sectorMap": sector_path, "provenance": provenance}
