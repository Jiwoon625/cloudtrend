"""Bounded S01-S04 benchmark for candidate-independent exact US rank sharing.

This entrypoint exists only to validate the shared-rank design before any wider
batch is allowed. It delegates orchestration to the reviewed CLI but replaces
its parallel worker with a worker that shares only exact US percentile-rank
outputs through a run-local cache. Trading state remains candidate-local.
"""
from __future__ import annotations

import sys
from pathlib import Path

from . import cli as base_cli

PARTICIPANTS = ("S01", "S02", "S03", "S04")


def _parallel_static_worker(config, candidate, plan_hash, max_seconds, event_limit):
    from .storage import SupabaseCMStore
    from .prepared import PreparedResearch
    from .runner import run_strategy, read_result
    from .us_shared_rank_cache import install_shared_us_rank_cache
    from cm06.registry import candidate_by_id
    from cm06_fresh_host_v1 import canonical, digest

    if candidate.candidate_id not in PARTICIPANTS:
        raise ValueError("Shared-rank benchmark is limited to S01-S04")
    if candidate.policy_id or candidate.stage == "references":
        raise ValueError("Shared-rank benchmark accepts static non-reference candidates only")

    cache = install_shared_us_rank_cache(
        Path(config["work"]) / "shared_us_exact_rank_cache" / plan_hash,
        candidate.candidate_id,
        PARTICIPANTS,
    )
    store = SupabaseCMStore.from_env()
    prototype = PreparedResearch(config, candidate_by_id("S05"))
    prepared = prototype.clone(candidate, None)
    scoped = store.scoped_checkpoints(plan_hash, candidate.candidate_id)
    receipt = run_strategy(
        prepared, scoped, max_seconds=max_seconds, event_limit=event_limit
    )
    receipt = dict(receipt, shared_us_rank_cache=cache.stats())
    store.put_object(
        "results/" + plan_hash + "/" + candidate.candidate_id
        + "/attempts/" + digest(receipt) + ".json",
        canonical(receipt),
    )
    if receipt["status"] == "COMPLETED_VERIFIED":
        files = read_result(receipt["completion"], scoped)
        key = (
            "results/" + plan_hash + "/" + candidate.candidate_id
            + "/" + digest(prepared.identity)
        )
        store.put_object(key + "/summary.json", files["summary.json"])
        store.put_object(
            key + "/completion.json", canonical(receipt["completion"])
        )

    stats = cache.stats()
    base_cli.emit(
        "SHARED_US_RANK_CACHE_STATS",
        candidate_id=candidate.candidate_id,
        hits=stats["hits"],
        misses=stats["misses"],
        fallbacks=stats["fallbacks"],
        rank_calls_replayed=stats["rank_calls_replayed"],
        rank_calls_computed=stats["rank_calls_computed"],
        bytes_read=stats["bytes_read"],
        bytes_written=stats["bytes_written"],
    )
    return receipt


def _arg_value(argv, name):
    try:
        index = argv.index(name)
    except ValueError:
        return None
    if index + 1 >= len(argv):
        raise ValueError("Missing value for " + name)
    return argv[index + 1]


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    mode = args[0] if args else None
    stage = _arg_value(args, "--stage")
    offset = _arg_value(args, "--offset")
    count = _arg_value(args, "--count")
    workers = _arg_value(args, "--workers")
    if not (
        mode == "run"
        and stage == "base"
        and offset == "0"
        and count == "4"
        and workers == "4"
    ):
        raise ValueError(
            "Shared-rank benchmark is hard-bounded to run/base/offset0/count4/workers4"
        )
    base_cli._parallel_static_worker = _parallel_static_worker
    return base_cli.main(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        base_cli.emit(
            "RESEARCH_BLOCKED",
            error_type=type(exc).__name__,
            detail=(
                "Inspect the bounded shared-rank benchmark; "
                "no production change was made"
            ),
        )
        raise SystemExit(2)
