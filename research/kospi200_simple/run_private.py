#!/usr/bin/env python3
"""One-off PRIVATE fixed-P30 replay reusing original 2026-10-10 KR signal caches.

This job checks every old checkpoint completion and file SHA, downloads the
original immutable canonical sources, and computes ONLY new portfolio cash/NAV.
No signal rescore, no old source mutation, no public raw uploads.
"""
from __future__ import annotations
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
def load(name, rel):
    spec = importlib.util.spec_from_file_location(name, ROOT / rel)
    if spec is None or spec.loader is None:
        raise RuntimeError("MISSING_REPLAY_MODULE")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module

rs = load("original_kr_resume", "scripts/run-adopted-kr-etf-resumable-job.py")
base = rs.base
EXPECTED_ORIGIN_RUN = "38016639367"
EXPECTED_ORIGIN_COMMIT = "38da620ced597eaae4e07b54f36a2173c70d9640"
CATALOG = "78e59c019a579b704a40c1d9a6a5de414dfaad8e71da1312f583327c2306ca89"
SOURCE_MANIFEST = "0a87b02838ea0cd2c084c98c82cdc9f798beb6d10d3c6e563b55595577e2daf6"
REQUEST = ROOT / ".github/kr-etf-resumable-request.json"
BRANCH = "refs/heads/research/kospi200-simple-fixed-budget-20261012"


def require(check, reason):
    if not check:
        raise RuntimeError(reason)


def main():
    e = os.environ
    require(e.get("GITHUB_ACTIONS") == "true" and e.get("GITHUB_REF") == BRANCH,
            "ONE_SHOT_RESEARCH_BRANCH_REQUIRED")
    require(e.get("GITHUB_EVENT_NAME") == "push", "ONE_SHOT_PUSH_REQUIRED")
    require(e.get("GITHUB_RUN_ID", "").isdigit(), "MISSING_RUN_ID")
    request = json.loads(REQUEST.read_text(encoding="utf8"))
    require(request.get("catalog_sha") == CATALOG and request.get("source_manifest_sha") == SOURCE_MANIFEST
            and request.get("through") == "2026-09-11", "SOURCE_PINS_CHANGED")
    options = SimpleNamespace(**request)
    owner = e["SUPABASE_USER_ID"]
    url = e["SUPABASE_URL"]
    secret = e["SUPABASE_SERVICE_ROLE_KEY"]
    import requests
    session = rs.transport.PrivateBucketSession(requests.Session)
    private = rs.ReadOnlyOriginStorage(session, url, owner, secret, CATALOG,
                                      EXPECTED_ORIGIN_RUN, "plan")
    results_store = base.PrivateStorage(session, url, owner, secret, CATALOG,
                                        e["GITHUB_RUN_ID"] + "-" + e.get("GITHUB_RUN_ATTEMPT","1"))
    child = base.child_environment(e)
    try:
        with tempfile.TemporaryDirectory(prefix="kospi200-fixed-budget-",dir=e.get("RUNNER_TEMP")) as temp:
            root = Path(temp)
            # Read and validate immutable original plan and every signal cache
            # BEFORE paying for expensive canonical data preparation.
            scope_base = {
                "owner":owner,
                "runId":EXPECTED_ORIGIN_RUN,
                "codeCommit":EXPECTED_ORIGIN_COMMIT,
                "request":request,
            }
            plan_dir = root/"original-plan"
            plan_scope = {**scope_base,"role":"plan"}
            plan_complete = private.restore("plan", plan_scope, plan_dir)
            plan = base.read_local_json(plan_dir/"plan.json", rs.MAX_CHECKPOINT,"INVALID_ORIGINAL_PLAN")
            parity = base.read_local_json(plan_dir/"parity.json", rs.MAX_CHECKPOINT,"INVALID_ORIGINAL_PARITY")
            plan_hash = hashlib.sha256((plan_dir/"plan.json").read_bytes()).hexdigest()
            require(plan_complete["proof"]["planSha256"] == plan_hash, "ORIGINAL_PLAN_HASH_CHANGED")
            require(parity["status"] == "PASS", "ORIGINAL_SPLIT_PARITY_NOT_PASS")
            require(plan["identity"]["version"] == rs.CACHE_VERSION and
                    plan["sessions"][0] <= options.kr_start and
                    options.through in plan["sessions"], "ORIGINAL_SIGNAL_SCOPE_MISMATCH")
            chunks=[]
            for piece in plan["matrix"]["include"]:
                role="score-%03d" % piece["chunkIndex"]
                target = root/role
                proof=rs.score_proof(plan,plan_hash,piece)
                completion = private.restore(role,{**scope_base,"role":role},target,expected_proof=proof)
                rs.validate_score_completion(completion,target,plan,plan_hash,piece)
                chunks.append(target)
            index = root/"signal-cache.index.json"
            rs.make_index(index,chunks)
            print(json.dumps({"stage":"verified_old_signals","chunks":len(chunks),
                              "source_start":options.kr_start,"through":options.through}),flush=True)
            # Use the same hash-pinned source manifest and observed prices as the
            # old full-period backtest. Do not regenerate entry/exit scores.
            manifest,sources,source_path = rs.source_contract(private,options,root)
            prepared,parsed = rs.prepare(private,options,root,sources,source_path,child,base.run_command)
            require(parsed["sessions"] == plan["sessions"],"PREPARED_KR_DATES_CHANGED")
            target=root/"new-kospi-fixed"
            cmd=rs.driver(prepared,target,"kr",options.kr_start,options.through,index=index)
            cmd.extend(["--fixed-initial-budget","--historical-signal-code-hash",
                        plan["identity"]["codeHash"]])
            base.run_command(cmd,root/"replay.log",child)
            quality=base.read_local_json(target/"quality.json",rs.MAX_CHECKPOINT,"RESULT_QUALITY_MISSING")
            require(quality.get("runStatus") == "FINISHED" and
                    quality.get("generatedScoringSessions") == 0 and
                    quality.get("fixedInitialBudget") is True and
                    quality.get("signalGeneratorCodeHash") == plan["identity"]["codeHash"],
                    "NON_REPLAY_OR_WRONG_POLICY")
            fixed=base.read_local_json(target/"KOSPI_FIXED_P30.evidence.json",
                                       rs.MAX_CHECKPOINT,"FIXED_ENTRY_POLICY_MISSING")
            require(fixed.get("entryBudgetPolicy") == "FIXED_INITIAL_CAPITAL"
                    and fixed.get("scope") == "KOSPI"
                    and fixed.get("initialCapital") == 100000000,
                    "FIXED_BUDGET_NOT_APPLIED")
            # Benchmark: actual KODEX200 adjusted price bars. No payout cash.
            report_dir=root/"comparison"
            result=subprocess.run([sys.executable,"-m","research.kospi200_simple.compare",
                         "--results",str(target),"--output",str(report_dir)],
                         env=child,cwd=ROOT,capture_output=True,text=True,timeout=600)
            if result.returncode:
                raise RuntimeError("KOSPI200_COMPARISON_FAILED_"+str(result.returncode))
            report=json.loads((report_dir/"comparison.json").read_text(encoding="utf8"))
            require(report["status"]=="RESEARCH_COMPARISON_COMPLETE","INVALID_REPORT_STATUS")
            # New create-only, private bucket objects. No credentials or raw
            # NAV/trade files are ever uploaded as public Actions artifacts.
            outfiles={
                "KOSPI_FIXED_P30.daily-nav.jsonl":target/"KOSPI_FIXED_P30.daily-nav.jsonl",
                "KOSPI_FIXED_P30.trades.jsonl":target/"KOSPI_FIXED_P30.trades.jsonl",
                "KOSPI_FIXED_P30.yearly-budgets.json":target/"KOSPI_FIXED_P30.yearly-budgets.json",
                "KOSPI_FIXED_P30.evidence.json":target/"KOSPI_FIXED_P30.evidence.json",
                "KODEX200_069500.adjusted-daily.jsonl":target/"KODEX200_069500.adjusted-daily.jsonl",
                "kospi200-comparison.json":report_dir/"comparison.json",
                "kospi200-comparison-daily.csv":report_dir/"daily-comparison.csv",
                "kospi200-comparison-brief.json":report_dir/"brief.json",
            }
            uploads = []
            for name,path in outfiles.items():
                receipt=results_store.create_result("result/"+name,path)
                uploads.append({"path":receipt["path"],"bytes":receipt["bytes"],"sha256":receipt["sha256"]})
            meta={
                "status":"COMPLETE_RESEARCH_ONLY",
                "sourceRun":EXPECTED_ORIGIN_RUN,
                "sourceCodeCommit":EXPECTED_ORIGIN_COMMIT,
                "studyCodeCommit":e["GITHUB_SHA"],
                "sourceCatalogSha256":CATALOG,
                "sourceManifestSha256":SOURCE_MANIFEST,
                "verifiedSignalCacheChunks":len(chunks),
                "originalSignalGeneratorCodeHash":plan["identity"]["codeHash"],
                "fixedEntryBudgetKrw":100_000_000/30,
                "dividendPolicy":"adjusted-prices-only-no-additional-cash",
                "compareSource":"KODEX200 adjusted 069500",
                "outputs":uploads,
            }
            evidence=root/"run-manifest.json"
            base.local_json(evidence,meta)
            results_store.create_result("run-manifest.json",evidence)
            # No personal holdings in public stdout. Aggregate headline metrics are
            # allowed; raw journal/cash/trades stay private only.
            compact={key:{
                arm:{field:round(report["segments"][key][arm][field],8) if report["segments"][key][arm][field] is not None else None
                     for field in ("total_return","cagr","sharpe","mdd")}
                for arm in ("kospi_fixed_p30","kodex200_buy_hold","kodex200_exposure_mirror")}
                     for key in ("2018_2024","2025","excluding_2025_daily_returns_stitched","all_2018_2026_partial")}
            print(json.dumps({"status":"COMPLETE","supabase_result_prefix":results_store.run_prefix,
                              "segments":compact,"rolling":report["rolling_two_year"]},
                              ensure_ascii=False),flush=True)
    finally:
        results_store.close()
        private.headers.clear()
        session.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Errors in source/payout/credentials never echo private data or paths.
        message=str(exc)
        safe=message if message.isupper() and len(message)<90 else "PRIVATE_STUDY_FAILED"
        print(json.dumps({"status":"STOPPED","code":safe}),flush=True)
        sys.exit(1)
