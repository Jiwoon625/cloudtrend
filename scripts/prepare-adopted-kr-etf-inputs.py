#!/usr/bin/env python3
"""Offline, bounded Parquet -> canonical CSV preparation for adopted KR/ETF replays.

Input is the transfer worker's source-manifest.json and a staging root containing
each orderedFiles[].sourcePath. All inputs need pinned byte counts and SHA-256s.
Source files, columns, rows and duplicates retain their declared order. No source
values, scores, metadata, or dates are filled, recomputed, merged, or filtered.
A source-hash-pinned identity repair may append a separately documented canonical
code column while preserving every original cell, including the damaged symbol.

Requires pyarrow. Example (output must not exist):
  python scripts/prepare-adopted-kr-etf-inputs.py --source-manifest /private/source-manifest.json \
      --staged-root /private/raw --output /private/new-prepared
Then pass new-prepared/manifest.json to run-adopted-full-period-backtest.ts with
--start and --through. throughDate is an evaluation default, never a raw-row crop.
"""
from __future__ import annotations

import argparse
import csv
from datetime import date
from decimal import Decimal
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import resource
import time
import shutil
import stat


VERSION = "adopted-kr-etf-inputs-v1"
SOURCE_VERSION = "adopted-full-period-source-transfer-v1"
DEFAULT_THROUGH = "2026-09-11"
DEFAULT_BATCH_SIZE = 1024
MAX_BATCH_SIZE = 16384
MAX_PREPARED_CHARS = 32 * 1024 * 1024
CHUNK_BYTES = 1024 * 1024
ALIASES = {
    "symbol": "symbol", "code": "symbol", "종목코드": "symbol", "단축코드": "symbol",
    "date": "date", "tradedate": "date", "기준일": "date", "일자": "date",
    "market": "market", "시장": "market",
    "type": "type", "securitytype": "type", "종류": "type",
}

# Public issuer identity, applied only to the independently pinned affected source.
# The original symbol cell remains unchanged; an appended canonical code column
# supplies the existing parser's later-alias precedence. Never parse an arbitrary
# scientific-notation identifier as an ordinary numeric stock code.
VERIFIED_SYMBOL_REPAIR = {
    "sourceSha256": "238b43699209438ed1d706f182878ef9ba2192bb769d0daedcee68fd475c8ead",
    "canonicalSymbol": "0219E0", "name": "KODEX 200커버드콜액티브",
    "firstDate": "2026-07-14", "lastDate": "2026-09-11", "expectedRows": 42,
    "issuerEvidence": "https://www.samsungfund.com/etf/search.do?searchText=Kodex+200",
}


def sha256_file(path: Path) -> str:
    with path.open("rb") as stream:
        return "sha256:" + hash_stream(stream)


def hash_stream(stream) -> str:
    digest = hashlib.sha256()
    for chunk in iter(lambda: stream.read(CHUNK_BYTES), b""):
        digest.update(chunk)
    return digest.hexdigest()


def normalized_hash(value) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"(?:sha256:)?[a-f0-9]{64}", value):
        raise ValueError("Each source requires a lowercase SHA-256")
    return value.removeprefix("sha256:")


def local_source(root: Path, relative: str) -> Path:
    if not isinstance(relative, str) or not relative or "\\" in relative:
        raise ValueError("Source paths must be relative POSIX paths")
    part = PurePosixPath(relative)
    if part.is_absolute() or ".." in part.parts or str(part) != relative or ":" in relative:
        raise ValueError("Source path escapes or is not canonical relative staging path")
    path = root.joinpath(*part.parts)
    # Reject symlinks, including in ancestors, rather than following them outside
    # the read-only staged source selection.
    current = root
    for piece in part.parts:
        current = current / piece
        if current.is_symlink():
            raise ValueError("Symlink source paths are not supported")
    if not path.is_file():
        raise ValueError(f"Staged source is not a regular file: {relative}")
    return path


def verified_stream(stream, item: dict) -> None:
    info = os.fstat(stream.fileno())
    if not stat.S_ISREG(info.st_mode) or info.st_size != item["bytes"]:
        raise ValueError(f"Source byte count mismatch: {item['sourcePath']}")
    stream.seek(0)
    if hash_stream(stream) != normalized_hash(item["sha256"]):
        raise ValueError(f"Source SHA-256 mismatch: {item['sourcePath']}")
    stream.seek(0)


def calendar_columns(names: list[str]) -> dict[str, int]:
    columns = {}
    for position, name in enumerate(names):
        key = ALIASES.get(re.sub(r"\s|_", "", name).lower())
        if key:
            columns[key] = position  # Last alias wins, as in parseManualMarketData.
    if not {"date", "symbol"} <= columns.keys():
        raise ValueError("Canonical source requires recognized date and symbol columns")
    return columns


def observed_date(value: str) -> str | None:
    digits = re.sub(r"[^0-9]", "", value.strip())
    if len(digits) < 8:
        return None
    candidate = f"{digits[:4]}-{digits[4:6]}-{digits[6:8]}"
    try:
        date.fromisoformat(candidate)
    except ValueError:
        return None
    return candidate


def calendar_evidence(row: list[str], columns: dict[str, int]) -> tuple[str | None, str | None]:
    def get(key):
        return row[columns[key]].strip() if key in columns else ""
    day = observed_date(get("date"))
    symbol = re.sub(r"\.0$", "", re.sub(r"^A(?=\d{6}$)", "", get("symbol").upper()))
    kind, market = get("type").upper(), get("market").upper()
    if day and symbol:
        if symbol in {"KOSPI", "KOSDAQ"}:
            return day, "KR_INDEX"
        if kind not in {"ETF", "INDEX"} and market in {"KOSPI", "KOSDAQ", "코스피", "코스닥"}:
            return day, "KR_STOCK"
    return day, None


def supported_type(pa, data_type) -> bool:
    if pa.types.is_dictionary(data_type):
        return supported_type(pa, data_type.value_type)
    return any(check(data_type) for check in (
        pa.types.is_null, pa.types.is_string, pa.types.is_large_string,
        pa.types.is_boolean, pa.types.is_integer, pa.types.is_floating,
        pa.types.is_decimal, pa.types.is_temporal,
    )) and not pa.types.is_duration(data_type) and not pa.types.is_interval(data_type)


def csv_value(scalar) -> str:
    if not scalar.is_valid:
        return ""  # Canonical missing observation, never zero or forward-filled.
    value = scalar.as_py()
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float):
        return repr(value)  # Exact binary-float roundtrip, including signed zero.
    # Arrow temporal scalars retain sub-microsecond precision and original timezone.
    # Decimal and integer scalars do not pass through a float conversion.
    return str(scalar)


def csv_column(pa, column) -> list[str]:
    """Convert only one bounded batch column; strings never undergo inference."""
    kind = column.type.value_type if pa.types.is_dictionary(column.type) else column.type
    if pa.types.is_temporal(kind):
        return [csv_value(value) for value in column]
    values = column.to_pylist()
    return ["" if value is None else value if isinstance(value, str)
            else ("true" if value else "false") if isinstance(value, bool)
            else repr(value) if isinstance(value, float) else str(value) for value in values]


def convert_file(path: Path, target: Path, item: dict, batch_size: int) -> tuple[dict, set[str], dict[str, int]]:
    import pyarrow as pa
    import pyarrow.parquet as pq

    sessions: set[str] = set()
    evidence = {"KR_INDEX": 0, "KR_STOCK": 0}
    dates: set[str] = set()
    rows = missing_dates = 0
    with path.open("rb") as source:
        verified_stream(source, item)
        parquet = pq.ParquetFile(source)
        schema = parquet.schema_arrow
        names = schema.names
        if not names or len(set(names)) != len(names):
            raise ValueError("Empty or duplicate source column names")
        for field in schema:
            if not supported_type(pa, field.type):
                raise ValueError(f"Unsupported lossless CSV type for {field.name}: {field.type}")
        columns = calendar_columns(names)
        repair = VERIFIED_SYMBOL_REPAIR if normalized_hash(item["sha256"]).removeprefix("sha256:") == VERIFIED_SYMBOL_REPAIR["sourceSha256"] else None
        if repair and (not {"symbol", "name", "market", "securityType", "date"} <= set(names) or "code" in names):
            raise ValueError("Verified symbol-repair source schema changed")
        output_names = names + (["code"] if repair else [])
        repaired = 0
        repaired_dates = set()
        nulls = dict.fromkeys(names, 0)
        parts = []
        part_rows = part_chars = 0
        raw = compressed = text = writer = None
        def close_part():
            nonlocal raw, text
            if text is not None:
                text.close()
            if raw is not None:
                raw.close()
            raw = text = None
        def start_part():
            nonlocal raw, compressed, text, writer, part_rows, part_chars
            suffix = "" if not parts else f".part{len(parts)+1:04d}"
            name = target.name.removesuffix(".csv.gz") + suffix + ".csv.gz"
            raw = target.with_name(name).open("xb")
            compressed = gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0, compresslevel=6)
            text = io.TextIOWrapper(compressed, encoding="utf-8", newline="")
            writer = csv.writer(text, lineterminator="\n")
            part_rows, part_chars = 0, writer.writerow(output_names)
            parts.append({"name": name, "rows": 0})
        try:
            start_part()
            for batch in parquet.iter_batches(batch_size=batch_size, use_threads=False):
                for index, name in enumerate(names):
                    nulls[name] += batch.column(index).null_count
                values = [csv_column(pa, column) for column in batch.columns]
                for row in zip(*values):
                    output_row = row
                    if repair:
                        canonical = row[names.index("symbol")]
                        if re.fullmatch(r"\d+(?:\.\d+)?[Ee]\+\d+", canonical):
                            day = observed_date(row[names.index("date")])
                            if not (Decimal(canonical) == Decimal(repair["canonicalSymbol"]) and
                                    row[names.index("name")] == repair["name"] and
                                    row[names.index("market")] == "KOSPI" and
                                    row[names.index("securityType")] == "ETF" and
                                    day and repair["firstDate"] <= day <= repair["lastDate"]):
                                raise ValueError("Verified symbol-repair identity mismatch")
                            canonical = repair["canonicalSymbol"]
                            repaired += 1
                            repaired_dates.add(day)
                        output_row = (*row, canonical)
                    # A chunk boundary is always between complete CSV records,
                    # including records containing quoted newlines. No row is split.
                    if part_rows and part_chars >= MAX_PREPARED_CHARS:
                        close_part()
                        start_part()
                    part_chars += writer.writerow(output_row)
                    part_rows += 1
                    parts[-1]["rows"] = part_rows
                    rows += 1
                    day, reason = calendar_evidence(row, columns)
                    if day:
                        dates.add(day)
                    else:
                        missing_dates += 1
                    if reason:
                        sessions.add(day)
                        evidence[reason] += 1
        finally:
            close_part()
        if rows != parquet.metadata.num_rows:
            raise ValueError("Parquet row count changed during conversion")
        if repair and (repaired != repair["expectedRows"] or min(repaired_dates, default=None) != repair["firstDate"] or max(repaired_dates, default=None) != repair["lastDate"]):
            raise ValueError("Verified symbol-repair row count or date range changed")
        # Recheck the same open file descriptor after decoding to detect source
        # mutation during preparation, without reopening a substituted path.
        verified_stream(source, item)
    return {
        "rows": rows, "columnCount": len(output_names), "originalColumnCount": len(names), "preparedParts": parts,
        "symbolIdentityRepairs": ([{**repair, "affectedRows": repaired, "originalCellsRetained": True, "derivedCanonicalColumn": "code"}] if repair else []),
        "columns": [{"name": field.name, "arrowType": str(field.type), "nulls": nulls[field.name]} for field in schema] +
                   ([{"name": "code", "arrowType": "research-derived-string", "nulls": 0}] if repair else []),
        "firstDate": min(dates) if dates else None, "lastDate": max(dates) if dates else None,
        "observedDateCount": len(dates), "missingOrInvalidDateRows": missing_dates,
        "koreanSessionCount": len(sessions), "calendarEvidenceRows": evidence,
    }, sessions, evidence


def prepare(source_manifest: Path, staged_root: Path, output: Path,
            batch_size: int = DEFAULT_BATCH_SIZE, through: str = DEFAULT_THROUGH) -> dict:
    started = time.monotonic()
    if not isinstance(batch_size, int) or isinstance(batch_size, bool) or not 1 <= batch_size <= MAX_BATCH_SIZE:
        raise ValueError(f"batch_size must be between 1 and {MAX_BATCH_SIZE}")
    if observed_date(through) != through:
        raise ValueError("through must be an actual YYYY-MM-DD date")
    if output.exists() or output.is_symlink():
        raise ValueError("Output directory must be fresh and must not already exist")
    source_bytes = source_manifest.read_bytes()
    source = json.loads(source_bytes)
    if source.get("version") != SOURCE_VERSION or not isinstance(source.get("orderedFiles"), list) or not source["orderedFiles"]:
        raise ValueError("Expected ordered adopted source-transfer manifest")
    root = staged_root.resolve(strict=True)
    sources = []
    for position, item in enumerate(source["orderedFiles"], 1):
        if item.get("order") != position or isinstance(item.get("order"), bool):
            raise ValueError("Source manifest order must be contiguous, starting at one")
        if item.get("sourceGroup") not in {"STOCK_KR", "ETF"}:
            raise ValueError("Only adopted KR/ETF raw source groups are supported")
        if not isinstance(item.get("bytes"), int) or isinstance(item["bytes"], bool) or item["bytes"] < 1:
            raise ValueError("Each source requires a positive pinned byte count")
        normalized_hash(item.get("sha256"))
        path = local_source(root, item.get("sourcePath"))
        with path.open("rb") as stream:
            verified_stream(stream, item)
        sources.append((item, path))
    # Create only after complete hash preflight. Exclusive mkdir cannot replace an
    # original, prior output, or directory another run has just created.
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    try:
        (output / "files").mkdir(mode=0o700)
        files = []
        sessions: set[str] = set()
        evidence = {"KR_INDEX": 0, "KR_STOCK": 0}
        for item, path in sources:
            name = re.sub(r"[^A-Za-z0-9_.-]", "_", PurePosixPath(item["sourcePath"]).stem)
            relative = f"files/{item['order']:04d}-{name}.csv.gz"
            target = output / relative
            info, observed, counts = convert_file(path, target, item, batch_size)
            sessions.update(observed)
            for kind, count in counts.items():
                evidence[kind] += count
            parts = info.pop("preparedParts")
            for number, part in enumerate(parts, 1):
                output_part = target.with_name(part["name"])
                os.chmod(output_part, 0o600)
                files.append({"path": "files/" + part["name"], "bytes": output_part.stat().st_size, "sha256": sha256_file(output_part),
                              "source": {key: item[key] for key in ["order", "sourceGroup", "sourcePath", "bytes", "sha256"]},
                              **info, "rows": part["rows"], "sourceTotalRows": info["rows"],
                              "sourcePart": number, "sourcePartCount": len(parts),
                              "rangeEvidenceScope": "WHOLE_ORIGINAL_SOURCE"})
        if not sessions:
            raise ValueError("No observed Korean index or stock session calendar evidence")
        manifest_hash = "sha256:" + hashlib.sha256(source_bytes).hexdigest()
        copied_manifest = output / "source-manifest.json"
        with copied_manifest.open("xb") as stream:
            stream.write(source_bytes)
        os.chmod(copied_manifest, 0o600)
        manifest = {
            "preparationMetrics": {"elapsedSeconds": time.monotonic() - started, "maxRssKiB": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss},
            "version": VERSION, "sourceManifestFingerprint": manifest_hash,
            "sourceManifest": {"path": "source-manifest.json", "bytes": len(source_bytes), "sha256": manifest_hash},
            "sourceCatalogSha256": source.get("catalogSha256"),
            "sessions": sorted(sessions), "firstDate": min(sessions), "lastDate": max(sessions),
            "throughDate": through, "files": files, "sourceFileCount": len(sources), "preparedFileCount": len(files),
            "rows": sum(item["rows"] for item in files), "sessionCount": len(sessions),
            "calendarEvidenceRows": evidence,
            "sourceOrdering": "orderedFiles order; original rows, columns and duplicates retained",
            "allRawRowsRetained": True, "savedScoresReusedForSignals": False,
            "limitations": [
                "Research input only: raw source ranges do not certify continuous market or universe coverage.",
                "The calendar is sorted observed Korean KOSPI/KOSDAQ index or Korean stock dates; no weekday or foreign ETF calendar is fabricated.",
                "All original fields and row order are retained, including raw saved scores. Current-rule signals must be recomputed by the engine; saved scores are not signal evidence.",
                "Null cells serialize as empty canonical CSV cells; original string cells, zero values and numeric precision are retained without filling or current-metadata backfill.",
                "Full source history and rows after throughDate remain available. throughDate limits evaluation only and does not certify completeness.",
                "Source adjustment, corporate actions, dividends and historical universe membership are not certified by this conversion.",
            ],
        }
        with (output / "manifest.json").open("x", encoding="utf-8") as stream:
            json.dump(manifest, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write("\n")
        os.chmod(output / "manifest.json", 0o600)
        return manifest
    except BaseException:
        # Only this call's exclusively created directory is removed on failure.
        # Source inputs and any pre-existing output are never touched.
        shutil.rmtree(output)
        raise


def inspect_symbols(source_manifest: Path, staged_root: Path, output: Path) -> dict:
    """Read-only source classification audit, not a replay or symbol normalization change."""
    import pyarrow as pa
    import pyarrow.parquet as pq
    source = json.loads(source_manifest.read_bytes())
    invalid = {}
    for item in source["orderedFiles"]:
        path = local_source(staged_root.resolve(strict=True), item["sourcePath"])
        with path.open("rb") as stream:
            verified_stream(stream, item)
            parquet = pq.ParquetFile(stream)
            aliases = {}
            for name in parquet.schema_arrow.names:
                key = ALIASES.get(re.sub(r"\s|_", "", name).lower())
                if key in {"symbol", "market", "type"}:
                    aliases[key] = name
            if "symbol" not in aliases:
                raise ValueError("Canonical source requires symbol column")
            names = list(aliases.values())
            for batch in parquet.iter_batches(batch_size=16384, columns=names, use_threads=False):
                columns = {name: csv_column(pa, batch.column(batch.schema.get_field_index(name))) for name in names}
                for i in range(batch.num_rows):
                    raw = columns[aliases["symbol"]][i].strip().upper()
                    market = columns[aliases["market"]][i].strip().upper() if "market" in aliases else ""
                    kind = columns[aliases["type"]][i].strip().upper() if "type" in aliases else ""
                    if kind == "INDEX" or market in {"INDEX", "지수"} or not (kind == "ETF" or market == "ETF"):
                        continue
                    normalized = re.sub(r"\.0$", "", re.sub(r"^A(?=\d{6}$)", "", raw))
                    if re.fullmatch(r"\d{1,6}", normalized):
                        normalized = normalized.zfill(6)
                    if re.fullmatch(r"[A-Z0-9]{6}", normalized):
                        continue
                    key = (raw, normalized, market, kind)
                    value = invalid.setdefault(key, {"rawSymbol": raw, "normalizedSymbol": normalized, "market": market, "type": kind, "rows": 0, "sourceOrders": []})
                    value["rows"] += 1
                    if item["order"] not in value["sourceOrders"]:
                        value["sourceOrders"].append(item["order"])
            verified_stream(stream, item)
    result = {"schema": "adopted-kr-etf-symbol-audit-v1", "status": "INPUT_CLASSIFICATION_ONLY", "sourceFileCount": len(source["orderedFiles"]), "invalid": list(invalid.values())}
    with output.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, allow_nan=False)
        stream.write("\n")
    os.chmod(output, 0o600)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-manifest", required=True)
    parser.add_argument("--staged-root", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    parser.add_argument("--through", default=DEFAULT_THROUGH, help="Evaluation default only; raw rows are never cropped")
    parser.add_argument("--inspect-symbols-only", action="store_true")
    args = parser.parse_args()
    try:
        if args.inspect_symbols_only:
            result = inspect_symbols(Path(args.source_manifest), Path(args.staged_root), Path(args.output))
            print(json.dumps({"status": result["status"], "invalidClasses": len(result["invalid"])}))
            return
        result = prepare(Path(args.source_manifest), Path(args.staged_root), Path(args.output), args.batch_size, args.through)
    except (OSError, ValueError, ImportError) as error:
        parser.exit(1, f"Preparation failed: {error}\n")
    print(json.dumps({key: result[key] for key in ["version", "sourceManifestFingerprint", "sourceFileCount", "rows", "sessionCount", "firstDate", "lastDate", "throughDate"]}))


if __name__ == "__main__":
    main()
