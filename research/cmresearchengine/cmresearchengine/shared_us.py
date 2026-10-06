"""Build one exact read-only US rank cache for a bounded research job."""
from __future__ import annotations
from dataclasses import asdict
from pathlib import Path
import json,shutil
import pandas as pd
from cm06_comparison_panels import MonthlyDayPanels,panel_records
from cm06_comparison_signals import US_VERSION,normalized_us_row,us_cross_section_ranks
from cm06_dated_action_dispatcher_v1 import DatedActionPanels
from cm06_fresh_host_v1 import DocumentedQuotePanels,digest
from cm06_shared_us_ranking_v1 import CACHE_COLUMNS,SCHEMA,STATUS,file_hash

def _flush_month(root,month,rows,sessions):
    frame=pd.DataFrame(rows,columns=list(CACHE_COLUMNS)).sort_values(["date","symbol"],kind="stable").reset_index(drop=True)
    path=root/(month+".parquet");frame.to_parquet(path,index=False,compression="zstd")
    return {"path":path.name,"sha256":file_hash(path),"bytes":path.stat().st_size,
        "rows":len(frame),"sessions":list(sessions)}

def write_shared_us_rank_cache(day_rows,root,binding):
    root=Path(root).resolve()
    if root.exists():shutil.rmtree(root)
    root.mkdir(parents=True)
    parts={};current=None;rows=[];sessions=[];total_rows=0;total_sessions=0;total_bytes=0
    def flush(month):
        nonlocal rows,sessions,total_bytes
        if month is None:return
        part=_flush_month(root,month,rows,sessions);parts[month]=part;total_bytes+=part["bytes"]
        rows=[];sessions=[]
    for date,input_rows in day_rows:
        if not input_rows:continue
        if any(row["date"]!=date for row in input_rows):raise ValueError("Shared rank builder received mixed dates")
        month=date[:7]
        if current is not None and month!=current:flush(current)
        current=month;cross=us_cross_section_ranks(input_rows)
        for row in input_rows:
            s=row["symbol"];rows.append({"date":date,"symbol":s,
                "ret120_rank":cross["r120"].get(s),"ret252_rank":cross["r252"].get(s),
                "core_score":cross["core_scores"].get(s),"core_rank":cross["core_rank"].get(s),
                "beta_rank":cross["beta"].get(s),"tk_rank":cross["tk"].get(s),
                "relvol_rank":cross["rv"].get(s),"liquidity_rank":cross["liq"].get(s),
                "amihud_rank":cross["ami"].get(s)})
        sessions.append(date);total_rows+=len(input_rows);total_sessions+=1
    flush(current)
    if not parts or total_sessions==0:raise ValueError("Shared US ranking cache is empty")
    doc={"schema":SCHEMA,"status":STATUS,"binding":binding,"months":parts,
        "sessions":total_sessions,"rows":total_rows}
    manifest=root/"manifest.json";manifest.write_text(json.dumps(doc,sort_keys=True,separators=(",",":")),encoding="utf-8")
    return {"manifest_path":str(manifest),"binding_sha256":digest(binding),"sessions":total_sessions,
        "rows":total_rows,"bytes":total_bytes+manifest.stat().st_size}

def build_shared_us_rank_cache(prepared,root):
    source_sha=prepared.prep["engines"]["U"]["sha256"]
    base=MonthlyDayPanels(prepared.inputs/"U"/"manifest.json",source_sha)
    wrapped=DatedActionPanels(DocumentedQuotePanels(base,prepared.quote_rules),prepared.registry)
    binding={"schema":SCHEMA,"rank_contract":"EXACT_PYTHON_PERCENTILE_RANKS_ONLY_V1",
        "source_u_manifest_sha256":source_sha,
        "registry_binding_sha256":prepared.registry.binding_sha256,
        "registry_trial_id":prepared.registry.new_trial_id,
        "documented_quote_rules_sha256":digest([asdict(r) for r in prepared.quote_rules]),
        "us_rule_version":US_VERSION,"evaluation_end":prepared.contract.end_date}
    def days():
        for session in prepared.calendars["U"]:
            date=session["session_date"]
            if date>prepared.contract.end_date or date not in base:continue
            records=panel_records(wrapped,date)
            if records:yield date,[normalized_us_row(row) for row in records]
    return write_shared_us_rank_cache(days(),root,binding)
