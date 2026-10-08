"""Validate GitHub Actions research dispatch requests without secrets.

This module only validates bounded, preregistered run parameters. It never
contacts GitHub, Supabase, or market-data sources.
"""
from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path

ALLOWED_MODES = {"preflight", "run"}
ALLOWED_STAGES = {"base", "fine", "split25", "split10", "references"}
ALLOWED_KEYS = {"request_id", "mode", "stage", "offset", "count", "max_seconds", "workers", "ids"}


def validate_request(raw):
    if not isinstance(raw, dict):
        raise ValueError("Dispatch request must be a JSON object")
    unknown = set(raw) - ALLOWED_KEYS
    if unknown:
        raise ValueError("Unknown dispatch request fields: " + ",".join(sorted(unknown)))

    request_id = str(raw.get("request_id", "")).strip()
    if not request_id or len(request_id) > 120:
        raise ValueError("request_id must be 1..120 characters")

    mode = str(raw.get("mode", "")).strip()
    stage = str(raw.get("stage", "")).strip()
    if mode not in ALLOWED_MODES:
        raise ValueError("mode must be preflight or run")
    if stage not in ALLOWED_STAGES:
        raise ValueError("Unknown registered stage")

    try:
        offset = int(raw.get("offset"))
        count = int(raw.get("count"))
        max_seconds = int(raw.get("max_seconds"))
        workers = int(raw.get("workers", 1))
    except (TypeError, ValueError) as exc:
        raise ValueError("offset/count/max_seconds/workers must be integers") from exc

    if offset < 0:
        raise ValueError("offset must be nonnegative")
    if not 1 <= count <= 16:
        raise ValueError("count must be 1..16")
    if not 60 <= max_seconds <= 6300:
        raise ValueError("max_seconds must be 60..6300")
    if not 1 <= workers <= 4:
        raise ValueError("workers must be 1..4")
    if workers > count:
        raise ValueError("workers cannot exceed count")

    # Select only explicitly named preregistered strategies in sparse
    # batches; no change to candidate policies, economic logic or data.
    ids_value = raw.get("ids", "")
    if ids_value is None:
        ids_value = ""
    if not isinstance(ids_value, str):
        raise ValueError("ids must be a comma-separated string")
    ids = ids_value.strip()
    if ids:
        tokens = [item.strip() for item in ids.split(",")]
        if (len(tokens) != count or len(set(tokens)) != len(tokens) or
                any(re.fullmatch(r"[A-Za-z0-9_]{1,120}", item) is None for item in tokens)):
            raise ValueError("ids must be unique, valid, and equal count")
        if offset != 0:
            raise ValueError("Explicit ids require offset=0")
        from .plan import choose
        selected = choose(stage, offset, count, tokens)
        if [item.candidate_id for item in selected] != tokens:
            raise ValueError("Explicit ids differ from preregistered candidates")
        if workers > 1 and (stage == "references" or any(item.policy_id for item in selected)):
            raise ValueError("Parallel workers require static non-reference candidates")
        ids = ",".join(tokens)

    return {
        "ids": ids,
        "request_id": request_id,
        "mode": mode,
        "stage": stage,
        "offset": offset,
        "count": count,
        "max_seconds": max_seconds,
        "workers": workers,
    }


def _write_github_output(path, request):
    with open(path, "a", encoding="utf-8") as stream:
        for key in ("request_id", "mode", "stage", "offset", "count", "max_seconds", "workers", "ids"):
            stream.write(f"{key}={request[key]}\n")


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--request-file")
    parser.add_argument("--request-id")
    parser.add_argument("--mode")
    parser.add_argument("--stage")
    parser.add_argument("--offset")
    parser.add_argument("--count")
    parser.add_argument("--max-seconds")
    parser.add_argument("--workers", default="1")
    parser.add_argument("--ids")
    parser.add_argument("--github-output")
    args = parser.parse_args(argv)

    if args.request_file:
        if any(v is not None for v in (
            args.request_id, args.mode, args.stage, args.offset, args.count, args.max_seconds,
            None if args.workers == "1" else args.workers, args.ids
        )):
            raise ValueError("Use either --request-file or explicit request fields")
        raw = json.loads(Path(args.request_file).read_text(encoding="utf-8"))
    else:
        raw = {
            "request_id": args.request_id,
            "mode": args.mode,
            "stage": args.stage,
            "offset": args.offset,
            "count": args.count,
            "max_seconds": args.max_seconds,
            "workers": args.workers,
            "ids": args.ids or "",
        }

    request = validate_request(raw)
    output = args.github_output or os.environ.get("GITHUB_OUTPUT")
    if output:
        _write_github_output(output, request)
    print(json.dumps({"status": "DISPATCH_REQUEST_VERIFIED", **request}, sort_keys=True))


if __name__ == "__main__":
    main()
