"""Bounded monthly input cache for independent CM06 research ledgers.

No features, prices, eligibility, or missing observations are synthesized here.
The manifest must describe already-normalized, complete monthly cross sections.
"""
from collections.abc import Mapping
from hashlib import sha256
from pathlib import Path
import json

import pandas as pd
from cm06_prepare_comparison import clean


REQUIRED = {"session_date", "symbol", "available_at", "comparison_open", "comparison_close", "market", "currency"}


def file_hash(path):
    h = sha256()
    with Path(path).open("rb") as f:
        for b in iter(lambda: f.read(1024 * 1024), b""):
            h.update(b)
    return h.hexdigest()


class MonthlyDayPanels(Mapping):
    """Loads at most one engine-month and caches one normalized session."""
    immutable_session_cache = True

    def __init__(self, manifest_path, expected_manifest_sha256, *, market=None):
        path = Path(manifest_path).resolve()
        if file_hash(path) != expected_manifest_sha256:
            raise ValueError("Monthly panel manifest hash mismatch")
        self.manifest = json.loads(path.read_text(encoding="utf-8"))
        if self.manifest.get("status") != "COMPLETE_NORMALIZED_INPUTS":
            raise ValueError("Incomplete normalized input manifest")
        self.root, self.market = path.parent, market
        self.parts = self.manifest["months"]
        self.days = {}
        for month, part in self.parts.items():
            for day in part["sessions"]:
                if day[:7] != month or day in self.days:
                    raise ValueError("Repeated or incorrectly partitioned session")
                self.days[day] = month
        self._month, self._frame = None, None
        self._verified = set()
        self._day_cache_day, self._day_cache_frame = None, None
        self._records_cache_day, self._records_cache = None, None
        self.loads = 0
        self.peak_cached_rows = 0

    def __iter__(self):
        return iter(sorted(self.days))

    def __len__(self):
        return len(self.days)

    def __contains__(self, day):
        return day in self.days

    def _load_month(self, month):
        self._frame, self._month = None, None
        self._day_cache_day, self._day_cache_frame = None, None
        self._records_cache_day, self._records_cache = None, None
        part = self.parts[month]
        path = (self.root / part["path"]).resolve()
        if not path.is_relative_to(self.root):
            raise ValueError("Monthly panel escapes manifest directory")
        if month not in self._verified:
            if file_hash(path) != part["sha256"]:
                raise ValueError("Monthly panel file hash mismatch")
            self._verified.add(month)
        frame = pd.read_parquet(path)
        if len(frame) != part["rows"] or not REQUIRED.issubset(frame.columns):
            raise ValueError("Monthly panel row count or schema mismatch")
        if frame.duplicated(["session_date", "symbol"]).any():
            raise ValueError("Duplicate symbol/date in monthly panel")
        if frame[list(REQUIRED - {"comparison_open", "comparison_close"})].isna().any().any():
            raise ValueError("Missing normalized panel identity/time fields")
        if set(frame.session_date) != set(part["sessions"]):
            raise ValueError("Monthly panel session coverage mismatch")
        if self.market and not frame.market.eq(self.market).all():
            raise ValueError("Split-KR panel contains the other market")
        if "market_gate" in frame:
            frame["market_gate"] = frame.market_gate.map(clean)
        times = pd.to_datetime(frame.available_at, utc=True, errors="raise", format="mixed")
        frame["available_at"] = times.map(lambda x: x.isoformat())
        # Frozen signal predicates require absent numeric fields to be None.
        # Normalize once per loaded month instead of once per OPEN/CLOSE access.
        frame = frame.astype(object).where(frame.notna(), None)
        self._frame, self._month = frame, month
        self.loads += 1
        self.peak_cached_rows = max(self.peak_cached_rows, len(frame))

    def __getitem__(self, day):
        month = self.days[day]
        if self._month != month:
            self._load_month(month)
        if self._day_cache_day != day:
            self._day_cache_frame = self._frame.loc[self._frame.session_date.eq(day)].copy()
            self._day_cache_day = day
            self._records_cache_day, self._records_cache = None, None
        # Consumers receive a separate DataFrame shell while the immutable
        # normalized values remain shared for this one-session cache.
        return self._day_cache_frame.copy(deep=False)

    def records(self, day):
        """Stable row dictionaries reused by repeated same-session readers."""
        if self._records_cache_day != day:
            self._records_cache = self[day].to_dict("records")
            self._records_cache_day = day
        return self._records_cache


def panel_records(panel, day):
    """Use a wrapper's explicit records fast-path, otherwise preserve old behavior."""
    method = getattr(type(panel), "records", None)
    if method is not None:
        return method(panel, day)
    return panel[day].to_dict("records")


def normalized_day_panels(panel, engine, structural_split):
    expected_market = ("KOSPI" if engine == "P" else "KOSDAQ") if structural_split and engine in ("P", "Q") else None
    if isinstance(panel, MonthlyDayPanels):
        if panel.market != expected_market:
            raise ValueError("Monthly panel market validation contract mismatch")
        return panel
    frame = panel.copy()
    if not REQUIRED.issubset(frame.columns):
        raise ValueError(f"Missing normalized columns for {engine}: {REQUIRED-set(frame.columns)}")
    if expected_market and not frame.market.eq(expected_market).all():
        raise ValueError("Split-KR panel contains the other market")
    if frame.duplicated(["session_date", "symbol"]).any():
        raise ValueError(f"Duplicate symbol/date in {engine}")
    frame["available_at"] = pd.to_datetime(frame.available_at, utc=True, errors="raise", format="mixed").map(lambda x: x.isoformat())
    return {d: g for d, g in frame.groupby("session_date", sort=True)}
