"""Read-only cache for exact candidate-independent US cross-sectional ranks.

The cache may replace only current-session percentile-rank calculation.
Previous rank state, beta streaks, holdings, cash, orders, fills, settlement and
candidate allocation remain private to each strategy replay.
"""
from __future__ import annotations
from hashlib import sha256
from pathlib import Path
import json,os
import pandas as pd

SCHEMA="CM06_SHARED_US_RANKING_V1"
STATUS="COMPLETE_SHARED_US_RANKING"
ENV="CM_SHARED_US_RANK_MANIFEST"
CACHE_COLUMNS=("date","symbol","ret120_rank","ret252_rank","core_score","core_rank",
    "beta_rank","tk_rank","relvol_rank","liquidity_rank","amihud_rank")

def file_hash(path):
    h=sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda:stream.read(1024*1024),b""):h.update(block)
    return h.hexdigest()

def _read_manifest(path):
    resolved=Path(path).resolve();document=json.loads(resolved.read_text(encoding="utf-8"))
    if document.get("schema")!=SCHEMA or document.get("status")!=STATUS:
        raise ValueError("Shared US ranking manifest contract mismatch")
    if not isinstance(document.get("binding"),dict) or not document["binding"]:
        raise ValueError("Shared US ranking binding missing")
    if not isinstance(document.get("months"),dict):
        raise ValueError("Shared US ranking month manifest missing")
    return resolved,document

def shared_rank_binding_from_env():
    path=os.environ.get(ENV)
    if not path:return None
    return _read_manifest(path)[1]["binding"]

class SharedUSRankCache:
    def __init__(self,manifest_path):
        path,document=_read_manifest(manifest_path)
        self.root=path.parent;self.parts=document["months"];self.days={};self._verified=set()
        self._month=None;self._frame=None
        for month,part in self.parts.items():
            sessions=part.get("sessions",[])
            if not sessions:raise ValueError("Shared US ranking month has no sessions")
            for day in sessions:
                if day[:7]!=month or day in self.days:raise ValueError("Shared US ranking session partition mismatch")
                self.days[day]=month
    def _load_month(self,month):
        part=self.parts[month];path=(self.root/part["path"]).resolve()
        if not path.is_relative_to(self.root):raise ValueError("Shared US ranking part escapes cache root")
        if month not in self._verified:
            if file_hash(path)!=part["sha256"]:raise ValueError("Shared US ranking part hash mismatch")
            self._verified.add(month)
        frame=pd.read_parquet(path,columns=list(CACHE_COLUMNS))
        if len(frame)!=part["rows"] or set(frame.columns)!=set(CACHE_COLUMNS):
            raise ValueError("Shared US ranking row count or schema mismatch")
        if frame.duplicated(["date","symbol"]).any():raise ValueError("Shared US ranking duplicate symbol/date")
        if set(frame.date)!=set(part["sessions"]):raise ValueError("Shared US ranking session coverage mismatch")
        self._frame,self._month=frame.astype(object).where(frame.notna(),None),month
    def cross_section(self,input_rows):
        if not input_rows:raise ValueError("Shared US ranking requires non-empty input")
        date=max(row["date"] for row in input_rows)
        if any(row["date"]!=date for row in input_rows):raise ValueError("Shared US ranking requires one input date")
        month=self.days.get(date)
        if month is None:raise ValueError("Shared US ranking date missing: "+date)
        if self._month!=month:self._load_month(month)
        cached={row["symbol"]:row for row in self._frame.loc[self._frame.date.eq(date)].to_dict("records")}
        if len(cached)!=len(input_rows) or any(row["symbol"] not in cached for row in input_rows):
            raise ValueError("Shared US ranking symbols differ from exact session input")
        def values(column):return {s:r[column] for s,r in cached.items() if r[column] is not None}
        return {"r120":values("ret120_rank"),"r252":values("ret252_rank"),
            "core_scores":values("core_score"),"core_rank":values("core_rank"),
            "beta":values("beta_rank"),"tk":values("tk_rank"),"rv":values("relvol_rank"),
            "liq":values("liquidity_rank"),"ami":values("amihud_rank")}

_CACHE_PATH=None;_CACHE=None
def reset_shared_us_rank_cache():
    global _CACHE_PATH,_CACHE
    _CACHE_PATH=None;_CACHE=None
def maybe_shared_us_cross_section(input_rows):
    global _CACHE_PATH,_CACHE
    path=os.environ.get(ENV)
    if not path:return None
    resolved=str(Path(path).resolve())
    if _CACHE is None or _CACHE_PATH!=resolved:
        _CACHE=SharedUSRankCache(resolved);_CACHE_PATH=resolved
    return _CACHE.cross_section(input_rows)
