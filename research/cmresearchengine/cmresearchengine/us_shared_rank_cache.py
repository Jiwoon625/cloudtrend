"""Run-local sharing of exact US cross-sectional ranking outputs.

This module is research-only. It never shares candidate trading state. Each
worker still owns its own adapter state, pending intents, cash, holdings,
orders, settlements, ledger, corporate actions and checkpoint chain.

The shared object is only the sequence of return values from the existing
exact Python percentile_rank() calls made by one US session analysis. A worker
that misses the cache executes the frozen us_analysis() unchanged while
recording those rank maps. Cache hits execute the same frozen us_analysis()
again, but replay the already-computed rank maps in the same call order.

Files live only in the GitHub runner's private temporary work directory. They
are never uploaded to Supabase, Actions artifacts or public caches.
"""
from __future__ import annotations

import functools
import gzip
import json
import os
from pathlib import Path
import re
import tempfile

try:
    import fcntl
except ImportError:  # pragma: no cover - GitHub research runner is Linux.
    fcntl = None

from cm06_fresh_host_v1 import canonical

SCHEMA = "CM_SHARED_US_EXACT_RANK_CACHE_V1"
EXPECTED_RANK_CALLS = 8
SAFE_ID = re.compile(r"[A-Za-z0-9_-]{1,200}\Z")


class SharedUSRankCacheError(RuntimeError):
    pass


class SharedUSRankCache:
    """One process' view of a run-local, cross-process exact-rank cache."""

    def __init__(self, root, candidate_id, participants):
        candidate_id = str(candidate_id)
        participants = tuple(str(value) for value in participants)
        if SAFE_ID.fullmatch(candidate_id) is None:
            raise ValueError("Invalid candidate ID for shared rank cache")
        if (not participants or len(set(participants)) != len(participants)
                or candidate_id not in participants
                or any(SAFE_ID.fullmatch(value) is None for value in participants)):
            raise ValueError("Invalid shared rank cache participants")
        root = Path(root)
        root.mkdir(parents=True, exist_ok=True)
        if root.is_symlink() or not root.is_dir():
            raise SharedUSRankCacheError("Shared rank cache root must be a real directory")
        try:
            os.chmod(root, 0o700)
        except OSError:
            pass
        self.root = root.resolve()
        self.candidate_id = candidate_id
        self.participants = participants
        self._stats = {
            "hits": 0,
            "misses": 0,
            "fallbacks": 0,
            "rank_calls_replayed": 0,
            "rank_calls_computed": 0,
            "bytes_read": 0,
            "bytes_written": 0,
        }

    def stats(self):
        return dict(self._stats)

    @staticmethod
    def _session_key(input_rows):
        if not input_rows:
            return None
        dates = {row.get("date") for row in input_rows}
        if len(dates) != 1:
            return None
        date = next(iter(dates))
        if not isinstance(date, str) or re.fullmatch(r"\d{4}-\d{2}-\d{2}", date) is None:
            return None
        return date + "-" + str(len(input_rows))

    def _paths(self, key):
        return (
            self.root / (key + ".json.gz"),
            self.root / (key + ".lock"),
            self.root / (key + ".used." + self.candidate_id),
        )

    @staticmethod
    def _load(path, key, row_count):
        if path.is_symlink() or not path.is_file():
            raise SharedUSRankCacheError("Shared rank cache object is not a regular file")
        try:
            raw = path.read_bytes()
            doc = json.loads(gzip.decompress(raw))
        except Exception as exc:
            raise SharedUSRankCacheError("Shared rank cache object is unreadable") from exc
        calls = doc.get("rank_calls")
        if (doc.get("schema") != SCHEMA or doc.get("key") != key
                or doc.get("row_count") != row_count
                or not isinstance(calls, list) or len(calls) != EXPECTED_RANK_CALLS
                or any(not isinstance(item, dict) for item in calls)):
            raise SharedUSRankCacheError("Shared rank cache contract mismatch")
        return calls, raw

    @staticmethod
    def _write_once(path, raw):
        fd, temporary = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "wb") as handle:
                handle.write(raw)
                handle.flush()
                os.fsync(handle.fileno())
            try:
                os.link(temporary, path)
            except FileExistsError:
                if path.is_symlink() or path.read_bytes() != raw:
                    raise SharedUSRankCacheError("Concurrent shared rank cache object differs")
            directory = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass

    @staticmethod
    def _record_rank_calls(signals, base, input_rows, previous):
        original_rank = signals.percentile_rank
        recorded = []

        def recorder(pairs):
            result = original_rank(pairs)
            recorded.append(dict(result))
            return result

        signals.percentile_rank = recorder
        try:
            result = base(input_rows, previous)
        finally:
            signals.percentile_rank = original_rank
        if len(recorded) != EXPECTED_RANK_CALLS:
            raise SharedUSRankCacheError(
                "Frozen US analysis rank-call count changed; shared cache review required"
            )
        return result, recorded

    @staticmethod
    def _replay_rank_calls(signals, base, input_rows, previous, calls):
        original_rank = signals.percentile_rank
        index = 0

        def replay(pairs):
            nonlocal index
            if index >= len(calls):
                raise SharedUSRankCacheError("Shared rank cache exhausted early")
            expected = calls[index]
            index += 1
            # The cache is run-local and keyed to one verified market session.
            # Still fail closed if this caller presents a different symbol set.
            symbols = {symbol for symbol, _ in pairs}
            if len(symbols) != len(pairs) or symbols != set(expected):
                raise SharedUSRankCacheError("Shared rank cache symbol set mismatch")
            return dict(expected)

        signals.percentile_rank = replay
        try:
            result = base(input_rows, previous)
        finally:
            signals.percentile_rank = original_rank
        if index != len(calls):
            raise SharedUSRankCacheError("Shared rank cache was not fully consumed")
        return result

    def _mark_consumed_and_cleanup(self, data_path, marker_path, key):
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            fd = os.open(marker_path, flags, 0o600)
        except FileExistsError:
            fd = None
        if fd is not None:
            os.close(fd)
        marker_paths = [self.root / (key + ".used." + candidate)
                        for candidate in self.participants]
        if all(path.is_file() and not path.is_symlink() for path in marker_paths):
            try:
                data_path.unlink()
            except FileNotFoundError:
                pass
            for path in marker_paths:
                try:
                    path.unlink()
                except FileNotFoundError:
                    pass

    def analyze(self, signals, base, input_rows, previous=None):
        """Run frozen us_analysis with shared exact percentile outputs only."""
        key = self._session_key(input_rows)
        if key is None or fcntl is None:
            self._stats["fallbacks"] += 1
            return base(input_rows, previous)

        data_path, lock_path, marker_path = self._paths(key)
        flags = os.O_RDWR | os.O_CREAT
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        lock_fd = os.open(lock_path, flags, 0o600)
        try:
            with os.fdopen(lock_fd, "a+b", closefd=True) as lock_handle:
                fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
                if data_path.exists():
                    calls, raw = self._load(data_path, key, len(input_rows))
                    self._stats["hits"] += 1
                    self._stats["rank_calls_replayed"] += len(calls)
                    self._stats["bytes_read"] += len(raw)
                    result = self._replay_rank_calls(
                        signals, base, input_rows, previous, calls
                    )
                else:
                    result, calls = self._record_rank_calls(
                        signals, base, input_rows, previous
                    )
                    doc = {
                        "schema": SCHEMA,
                        "key": key,
                        "row_count": len(input_rows),
                        "rank_calls": calls,
                    }
                    raw = gzip.compress(canonical(doc), compresslevel=1, mtime=0)
                    self._write_once(data_path, raw)
                    self._stats["misses"] += 1
                    self._stats["rank_calls_computed"] += len(calls)
                    self._stats["bytes_written"] += len(raw)
                self._mark_consumed_and_cleanup(data_path, marker_path, key)
                return result
        except OSError as exc:
            raise SharedUSRankCacheError("Shared rank cache filesystem operation failed") from exc


_INSTALLED = None


def install_shared_us_rank_cache(root, candidate_id, participants):
    """Patch only the in-memory research worker's us_analysis entrypoint."""
    global _INSTALLED
    import cm06_comparison_signals as signals

    if _INSTALLED is not None:
        raise SharedUSRankCacheError("Shared US rank cache already installed in this process")
    base = signals.us_analysis
    cache = SharedUSRankCache(root, candidate_id, participants)

    @functools.wraps(base)
    def wrapper(input_rows, previous=None):
        return cache.analyze(signals, base, input_rows, previous)

    wrapper._cm_shared_us_rank_cache = cache
    wrapper._cm_shared_us_rank_cache_base = base
    signals.us_analysis = wrapper
    _INSTALLED = (signals, base, wrapper, cache)
    return cache


def uninstall_shared_us_rank_cache(cache):
    """Test helper; production workers install once and exit."""
    global _INSTALLED
    if _INSTALLED is None:
        return
    signals, base, wrapper, installed = _INSTALLED
    if installed is not cache or signals.us_analysis is not wrapper:
        raise SharedUSRankCacheError("Shared US rank cache installation changed unexpectedly")
    signals.us_analysis = base
    _INSTALLED = None
