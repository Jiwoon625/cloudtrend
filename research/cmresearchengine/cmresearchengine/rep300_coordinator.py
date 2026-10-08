"""Research-only, fail-closed CM06 representative-300 GitHub Actions coordinator.

No browser/LLM loop, production screening, RLS, bucket or trading code changes.
Uses the pinned candidate manifest and existing private result objects only.
"""
from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

from cmresearchengine.dispatch import validate_request
from cmresearchengine.plan import choose
from cmresearchengine.runner import read_result
from cmresearchengine.storage import SupabaseCMStore

REPO = "Jiwoon625/cloudtrend"
WORKFLOW = "cmresearchengine-run.yml"
CONTROL = "research/cmresearchengine/DISPATCH_REQUEST.json"
PLAN_HASH = "ce6be8c497e45fa22a41d3a7b924913a23b18588fd05efd33ee14eb961ec7c2c"
PLAN_FILE = Path(__file__).resolve().parents[1] / "REPRESENTATIVE_300_APPROVED.json"
ACTIVE = {"queued", "in_progress", "waiting", "pending", "requested"}
IDENTITY = re.compile(r"^[0-9a-f]{64}$")

# Phases are fixed labels, not externally supplied URLs, paths or input values.
class WatchPhaseError(Exception):
    def __init__(self, phase, cause):
        self.phase = phase
        self.cause = cause
        super().__init__(phase)


def watch_call(phase, fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except Exception as exc:
        raise WatchPhaseError(phase, exc) from None


def safe_failure(exc):
    original = exc.cause if isinstance(exc, WatchPhaseError) else exc
    message = str(original)
    safe_literals = {
        "Unsafe storage object key",
        "Invalid descriptive object name",
        "Storage redirects are forbidden",
        "A candidate checkpoint scope is required",
        "Object is outside the CM storage areas",
        "Invalid candidate ID",
        "The existing cloudtrend-data bucket must be private",
        "GitHub CLI job log retrieval unavailable",
        "GitHub CLI job log retrieval failed",
        "GitHub CLI job log too large",
        "GitHub CLI returned no structured receipt markers",
    }
    # A numerical HTTP code is safe to expose; body, URL and headers are not.
    http_error = re.fullmatch(
        r"GitHub (request failed: |job log read failed )HTTP ([45][0-9]{2})(?: at (GITHUB_API|LOG_CDN))?",
        message,
    )
    reason = message if message in safe_literals or http_error else "WITHHELD"
    return {
        "phase": exc.phase if isinstance(exc, WatchPhaseError) else "UNCLASSIFIED",
        "error_type": type(original).__name__,
        "reason": reason,
    }


def emit(status, **details):
    print(json.dumps({"status": status, **details}, sort_keys=True), flush=True)


def approved():
    doc = json.loads(PLAN_FILE.read_text(encoding="utf-8"))
    rows = doc["candidates"]
    assert doc["schema"] == "CM_REPRESENTATIVE_300_APPROVED_V1"
    assert doc["plan_sha256"] == PLAN_HASH and doc["total"] == len(rows) == 300
    assert len({(r["stage"], r["id"]) for r in rows}) == 300
    assert {g: sum(x["group"] == g for x in rows) for g in (1, 2, 3, 4, 5)} == {
        1: 40, 2: 70, 3: 78, 4: 12, 5: 100}
    assert [r["group"] for r in rows] == sorted(r["group"] for r in rows)
    for r in rows:
        assert r["id"] == choose(r["stage"], r["offset"], 1)[0].candidate_id
    assert [r["id"] for r in rows[:7]] == [
        "S01", "S02", "S03", "S04", "S05", "S06", "S07"]
    assert rows[7]["id"] == "S08" and rows[7]["offset"] == 7
    return rows


def now_utc(iso):
    return datetime.fromisoformat(iso.replace("Z", "+00:00"))


class GitHub:
    def __init__(self, token, repo=REPO):
        if not token:
            raise ValueError("GITHUB_TOKEN missing")
        if repo != REPO:
            raise ValueError("Repository mismatch")
        self.token = token
        self.base = "https://api.github.com/repos/" + repo

    def api(self, path, method="GET", payload=None):
        if not path.startswith("/") or ".." in path:
            raise ValueError("Invalid GitHub endpoint path")
        url = self.base + path
        data = None if payload is None else json.dumps(payload, sort_keys=True).encode()
        headers = {"Authorization": "Bearer " + self.token,
                   "Accept": "application/vnd.github+json",
                   "X-GitHub-Api-Version": "2022-11-28"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=60) as response:
                raw = response.read(12 * 1024 * 1024 + 1)
                if len(raw) > 12 * 1024 * 1024:
                    raise ValueError("GitHub response too large")
                if not raw:
                    return {}
                return json.loads(raw)
        except urllib.error.HTTPError as exc:
            # Redact body/headers/URLs which could accidentally contain tokens.
            raise RuntimeError("GitHub request failed: HTTP " + str(exc.code)) from None

    def runs(self):
        return self.api("/actions/workflows/" + WORKFLOW + "/runs?per_page=100")["workflow_runs"]

    def jobs(self, run_id):
        return self.api("/actions/runs/" + str(int(run_id)) + "/jobs?filter=latest&per_page=100")["jobs"]

    def job_logs(self, job_id):
        path = "/actions/jobs/" + str(int(job_id)) + "/logs"
        headers = {"Authorization": "Bearer " + self.token,
                   "Accept": "application/vnd.github+json",
                   "X-GitHub-Api-Version": "2022-11-28"}
        req = urllib.request.Request(self.base + path, headers=headers)
        # GitHub redirects job logs to a signed CDN link. Follow only this
        # GitHub API-issued redirect; never transmit the token to the redirect.
        class StripAuth(urllib.request.HTTPRedirectHandler):
            def __init__(self):
                super().__init__()
                self.was_redirected = False

            def redirect_request(self, request, fp, code, msg, h, newurl):
                parsed = urllib.parse.urlparse(newurl)
                if parsed.scheme != "https":
                    raise ValueError("Log redirect must use HTTPS")
                self.was_redirected = True
                safe = {k: v for k, v in request.header_items()
                        if k.lower() not in {"authorization", "x-github-api-version"}}
                return urllib.request.Request(newurl, headers=safe)
        redirect = StripAuth()
        opener = urllib.request.build_opener(redirect)
        try:
            with opener.open(req, timeout=60) as response:
                raw = response.read(15 * 1024 * 1024 + 1)
                if len(raw) > 15 * 1024 * 1024:
                    raise ValueError("Job log too large")
                return raw.decode("utf-8-sig", errors="replace")
        except urllib.error.HTTPError as exc:
            # GitHub's signed log CDN may reject urllib with HTTP 400 while
            # the authenticated GitHub API hop was successful. Try the
            # runner's official GitHub CLI once; keep fail-closed semantics.
            if redirect.was_redirected and exc.code == 400:
                return self.job_logs_cli(job_id)
            location = "LOG_CDN" if redirect.was_redirected else "GITHUB_API"
            raise RuntimeError("GitHub job log read failed HTTP " + str(exc.code) +
                               " at " + location) from None

    def job_logs_cli(self, job_id):
        # Do not put tokens on the command line or forward Supabase secrets.
        # The CLI follows the signed HTTPS log redirect using its own client.
        safe_env = {k: os.environ[k] for k in ("HOME", "PATH", "XDG_CONFIG_HOME")
                    if k in os.environ}
        safe_env["GH_TOKEN"] = self.token
        safe_env["GH_PROMPT_DISABLED"] = "1"
        try:
            process = subprocess.run(
                ["gh", "run", "view", "--job", str(int(job_id)),
                 "--log", "--repo", REPO],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                env=safe_env, timeout=90, check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            raise RuntimeError("GitHub CLI job log retrieval unavailable") from None
        if process.returncode != 0:
            raise RuntimeError("GitHub CLI job log retrieval failed") from None
        if len(process.stdout) > 15 * 1024 * 1024:
            raise ValueError("GitHub CLI job log too large")
        raw = process.stdout.decode("utf-8-sig", errors="replace")
        if not json_markers(raw):
            raise ValueError("GitHub CLI returned no structured receipt markers")
        emit("GITHUB_LOG_CDN_FALLBACK_VERIFIED", method="gh_cli", markers=len(json_markers(raw)))
        return raw

    def contents(self):
        item = self.api("/contents/" + CONTROL + "?ref=main")
        raw = base64.b64decode(item["content"])
        return item["sha"], json.loads(raw)

    def dispatch_research(self, request):
        """Explicit workflow_dispatch is allowed from GITHUB_TOKEN.

        GitHub suppresses downstream on:push workflow runs for commits made
        by GITHUB_TOKEN. Do not depend on that suppressed trigger or push a
        new control commit each batch. The existing workflow accepts these
        exact bounded, prevalidated inputs through its native dispatch API.
        """
        req = validate_request(request)
        inputs = {name: str(req[name]) for name in
                  ("mode", "stage", "offset", "count", "max_seconds", "workers", "ids")}
        inputs["hybrid_shared_us_analysis"] = str(req["hybrid_shared_us_analysis"]).lower()
        return self.api("/actions/workflows/" + WORKFLOW + "/dispatches",
                        "POST", {"ref": "main", "inputs": inputs})

    def rerun_job(self, job_id):
        return self.api("/actions/jobs/" + str(int(job_id)) + "/rerun", "POST", {})


def json_markers(raw):
    markers = []
    for line in raw.splitlines():
        p = line.find('{"')
        if p < 0:
            continue
        try:
            obj = json.loads(line[p:])
        except (json.JSONDecodeError, ValueError):
            continue
        if isinstance(obj, dict) and obj.get("status"):
            markers.append(obj)
    return markers


def selection(request):
    req = validate_request(request)
    ids = req["ids"].split(",") if req["ids"] else None
    candidates = choose(req["stage"], req["offset"], req["count"], ids)
    if len(candidates) != req["count"]:
        raise ValueError("Out-of-range research batch")
    names = [c.candidate_id for c in candidates]
    if req["hybrid_shared_us_analysis"]:
        assert req["mode"] == "run" and req["stage"] == "base"
        assert req["count"] == 4 and req["workers"] == 2
        assert all(not c.policy_id for c in candidates)
    return req, names


def next_batch(rows, current, names):
    if current["stage"] == "references":
        assert len(names) == 1 and names[0] in ("REF_K", "REF_E", "REF_U")
        nxt = {"REF_K": "REF_E", "REF_E": "REF_U", "REF_U": None}[names[0]]
        if nxt:
            idx = {"REF_K": 0, "REF_E": 1, "REF_U": 2}[nxt]
            return make_request("references", idx, 1, 1, False)
        anchor = next(x for x in rows if x["group"] == 4)
        return make_request(anchor["stage"], anchor["offset"], 1, 1, False)
    indices = [i for i, x in enumerate(rows)
               if (x["stage"], x["id"]) in {(current["stage"], n) for n in names}]
    if sorted(indices) != list(range(min(indices), max(indices) + 1)):
        raise ValueError("Requested candidates not consecutive within approved selection")
    if len(indices) != len(names):
        raise ValueError("Invalid candidate set in completed run")
    end = max(indices)
    if end + 1 >= len(rows):
        return None
    target = rows[end + 1]
    if target["group"] == 4 and rows[end]["group"] == 3:
        return make_request("references", 0, 1, 1, False)
    family = [x for x in rows[end + 1:] if x["group"] == target["group"]]
    group = target["group"]
    if group == 1:
        count = min(4, len(family))
        if count == 4:
            return make_request("base", target["offset"], 4, 2, True)
        if count == 1:
            return make_request("base", target["offset"], 1, 1, False)
        return make_request("base", target["offset"], 2, 2, False)
    if group in (2, 3, 5):
        chosen = family[:2]
        if group == 2:
            return make_request(target["stage"], target["offset"], len(chosen), len(chosen), False)
        return make_request(target["stage"], 0, len(chosen), len(chosen), False,
                            ",".join(x["id"] for x in chosen))
    if group == 4:
        return make_request("base", target["offset"], 1, 1, False)
    raise ValueError("Unknown priority group")


def make_request(stage, offset, count, workers, hybrid, ids=""):
    # Dispatch gets a unique ID after checks. Prefix ensures no random
    # unapproved manual run can be mistaken for autopilot progress.
    result = {"mode": "run", "stage": stage, "offset": offset,
              "count": count, "max_seconds": 3000, "workers": workers,
              "hybrid_shared_us_analysis": hybrid}
    if ids:
        result["ids"] = ids
    return result


def verify_existing_request(rows, request, names):
    if request["stage"] == "references":
        return len(names) == 1 and names[0] in ("REF_K", "REF_E", "REF_U")
    approved_pairs = {(r["stage"], r["id"]) for r in rows}
    if any((request["stage"], n) not in approved_pairs for n in names):
        return False
    idx = [i for i, r in enumerate(rows) if (r["stage"], r["id"]) in {
        (request["stage"], n) for n in names}]
    if len(idx) != len(names) or sorted(idx) != list(range(min(idx), max(idx)+1)):
        return False
    return True


def storage_folders(store, relative):
    assert relative.startswith("results/" + PLAN_HASH + "/")
    prefix = store.object_key(relative.rstrip("/")) + "/"
    data = json.dumps({"prefix": prefix, "limit": 100, "offset": 0}).encode()
    raw = store._request(
        "POST", "object/list/cloudtrend-data",
        lambda resp: store._bounded(resp, 512 * 1024),
        data=data, headers={"Content-Type": "application/json"})
    entries = json.loads(raw)
    if not isinstance(entries, list) or len(entries) >= 100:
        raise ValueError("Private result directory listing incomplete")
    return entries


def D(x):
    return Decimal(str(x))


def dt(x):
    return datetime.fromisoformat(str(x).replace("Z", "+00:00"))


def verify_private_one(store, candidate, hybrid):
    base = "results/" + PLAN_HASH + "/" + candidate + "/"
    entries = storage_folders(store, base)
    identities = [e["name"] for e in entries
                  if isinstance(e, dict) and IDENTITY.fullmatch(str(e.get("name", "")))]
    if not identities:
        raise ValueError("No private completion identity directory")
    checks = []
    for identity in identities:
        try:
            completion_raw = store.get_object(base + identity + "/completion.json", max_bytes=1_000_000)
            summary_raw = store.get_object(base + identity + "/summary.json", max_bytes=1_000_000)
        except FileNotFoundError:
            continue
        scoped = store.scoped_checkpoints(PLAN_HASH, candidate)
        marker = scoped.get_bytes("complete_" + identity)
        if marker != completion_raw:
            raise ValueError("Completion marker/post mismatch")
        completion = json.loads(completion_raw)
        files = read_result(completion, scoped)
        if files["summary.json"] != summary_raw:
            raise ValueError("Result summary readback mismatch")
        summary = json.loads(summary_raw)
        if summary["candidate_id"] != candidate:
            raise ValueError("Private strategy identity mismatch")
        if summary["schema"] != "CM_RESEARCH_RESULT_V1":
            raise ValueError("Unexpected private result schema")
        if summary["historical_pit_certified"] is not False or summary["actual_historical_execution_certified"] is not False:
            raise ValueError("Forbidden historical execution claim")
        if D(summary["ordinary_and_proxy_sales_share_one_way_fee"]) != D("0.0015"):
            raise ValueError("Unexpected transaction fee")
        if summary["policy"]["policy_id"] != "RETROSPECTIVE_LAST_VALID_CLOSE_EXIT_V1":
            raise ValueError("Unexpected proxy policy")
        manifest = json.loads(files["file_manifest.json"])["files"]
        if set(manifest) != set(files) - {"file_manifest.json"}:
            raise ValueError("Result manifest file list differs")
        for name, record in manifest.items():
            buf = files[name]
            if len(buf) != record["size"] or hashlib.sha256(buf).hexdigest() != record["sha256"]:
                raise ValueError("Private result archive file hash mismatch")
        read_rows = lambda name: list(csv.DictReader(io.StringIO(files[name].decode("utf-8-sig"))))
        events = read_rows("events.csv")
        nav = read_rows("nav.csv")
        audits = read_rows("retrospective_exit_proxy_audit.csv")
        if not nav:
            raise ValueError("Missing NAV rows")
        # A pure-cash preregistered strategy may legally have zero executions.
        # Empty trading events must not be invented just to pass audit.
        trades = [e for e in events if e.get("kind") in {"BUY","SELL"}]
        if len({t["id"] for t in trades}) != len(trades):
            raise ValueError("Duplicate executed trade id")
        by_id = {e["id"]: e for e in trades}
        proxy_ids = {e["id"] for e in trades if e["kind"] == "SELL" and e.get("execution_class") == "RETROSPECTIVE_EXIT_PROXY"}
        if len(audits) != len(proxy_ids) or len(audits) != summary["proxy_exit_count"]:
            raise ValueError("Proxy trade/audit count mismatch")
        for e in trades:
            if D(e["quantity"]) <= 0 or D(e["price"]) <= 0:
                raise ValueError("Invalid trade units or price")
            if abs(D(e["fee"]) - D(e["quantity"])*D(e["price"])*D("0.0015")) > D("0.01"):
                raise ValueError("Executed fee mismatch")
            if e["kind"] == "SELL" and dt(e["settlement_at"]) < dt(e["at"]):
                raise ValueError("Backdated settlement")
        for audit in audits:
            e = by_id[audit["fill_id"]]
            if audit["fill_id"] not in proxy_ids:
                raise ValueError("Unjoined proxy event")
            if audit["policy_id"] != "RETROSPECTIVE_LAST_VALID_CLOSE_EXIT_V1" or str(audit["actual_historical_fill"]).lower() != "false":
                raise ValueError("Invalid proxy execution claim")
            if str(audit["retroactive_nav_rewrite"]).lower() != "false":
                raise ValueError("Invalid backfilled historical NAV")
            if dt(audit["reference_price_available_at"]) > dt(audit["recognition_at"]):
                raise ValueError("Proxy used unobserved price")
            if dt(audit["cash_available_at"]) < dt(audit["recognition_at"]):
                raise ValueError("Proxy released cash early")
            if dt(audit["recognition_at"]) != dt(e["at"]) or dt(audit["cash_available_at"]) != dt(e["settlement_at"]):
                raise ValueError("Proxy cash timing mismatch")
            if D(audit["reference_price"]) != D(e["price"]):
                raise ValueError("Proxy price mismatch")
        for row in nav:
            if D(row["gross_nav_krw"]) <= 0:
                raise ValueError("Invalid historical NAV")
        if abs(D(summary["final_snapshot"]["bridge_residual_krw"])) > D("0.01"):
            raise ValueError("Final ledger bridge imbalance")
        # Distinguish hybrid and ordinary result identities where possible.
        opt = completion.get("identity", {}).get("execution_optimization") if isinstance(completion.get("identity"), dict) else None
        if opt is not None:
            if bool(opt) != hybrid or (hybrid and opt.get("mode") != "HYBRID_2X2_SHARED_US_ANALYSIS_V1"):
                continue
        checks.append(identity)
    if len(checks) != 1:
        raise ValueError("Ambiguous or missing verified identity: " + candidate)
    return True


def decision(gh, rows, store, dry=False):
    runs = watch_call("GITHUB_LIST_RUNS", gh.runs)
    active = [r for r in runs if r["status"] in ACTIVE]
    if active:
        emit("ACTIVE_RESEARCH_WAIT",active_runs=len(active))
        return
    if not runs:
        raise ValueError("No historical CM research run")
    last = runs[0]
    if last["status"] != "completed" or last["conclusion"] != "success":
        raise ValueError("Last research workflow not successful")
    jobs = watch_call("GITHUB_LIST_JOBS", gh.jobs, last["id"])
    research = [j for j in jobs if j["name"] == "research"]
    if len(research) != 1 or research[0]["conclusion"] != "success":
        raise ValueError("Research job missing or unsuccessful")
    markers = json_markers(watch_call("GITHUB_READ_JOB_LOG", gh.job_logs, research[0]["id"]))
    dispatches = [x for x in markers if x["status"] == "DISPATCH_REQUEST_VERIFIED"]
    preflights = [x for x in markers if x["status"] == "PREFLIGHT_VERIFIED"]
    batches = [x for x in markers if x["status"] == "BATCH_VERIFIED"]
    if len(dispatches) != 1 or len(preflights) != 1 or len(batches) != 1:
        raise ValueError("Incomplete dispatch/preflight/batch receipts")
    # Receipt metadata is not itself a dispatch request field.
    req, selected = selection({k: v for k, v in dispatches[0].items() if k != "status"})
    if req["mode"] != "run" or preflights[0]["plan_sha256"] != PLAN_HASH:
        raise ValueError("Wrong research mode or input manifest")
    if (preflights[0]["normalized_files"],preflights[0]["reference_files"],preflights[0]["known_events"]) != (389,12,27):
        raise ValueError("Input evidence profile drift")
    if not verify_existing_request(rows, req, selected):
        raise ValueError("Run contains unapproved candidate")
    # First batch was initiated by a reviewed contents-file push. Future
    # native coordinator batches use explicit workflow_dispatch (which does
    # trigger when called with GITHUB_TOKEN). Keep the old file as an immutable
    # manual fallback; do not create hundreds of new Vercel-triggering commits.
    if last["event"] == "push":
        _, control = watch_call("GITHUB_READ_CONTROL", gh.contents)
        if control["request_id"] != req["request_id"]:
            raise ValueError("Push run differs from latest approved control")
    elif last["event"] == "workflow_dispatch":
        if last.get("actor", {}).get("login") != "github-actions[bot]":
            raise ValueError("Unexpected manual workflow actor; do not auto-advance")
        if last.get("head_branch") != "main":
            raise ValueError("Research dispatch was not run on main")
    else:
        raise ValueError("Unrecognized CM research workflow event")
    receipts = [x for x in markers if x["status"] in ("PAUSED_VERIFIED", "COMPLETED_VERIFIED")]
    if len(receipts) != len(selected) or {r.get("candidate_id") for r in receipts} != set(selected):
        raise ValueError("Incomplete candidate receipts")
    batch = batches[0]
    if batch["selected_count"] != len(selected) or batch["remaining_in_selected_batch"] != len(selected) - batch["completed_in_selected_batch"]:
        raise ValueError("Mismatched batch totals")
    if batch.get("worker_exceptions", 0) or batch.get("not_started", 0):
        raise ValueError("Worker or scheduling failure")
    done = [r for r in receipts if r["status"] == "COMPLETED_VERIFIED"]
    if len(done) != batch["completed_in_selected_batch"]:
        raise ValueError("Completed receipt count differs")
    if len(done) < len(selected):
        emit("PAUSED_VERIFIED_RETRY",run=last["id"],completed=len(done),remaining=len(selected)-len(done),dry_run=dry)
        if not dry:
            watch_call("GITHUB_RERUN_RESEARCH_JOB", gh.rerun_job, research[0]["id"])
        return
    if store is None:
        emit("PRIVATE_AUDIT_REQUIRED",candidates=len(selected))
        return
    if watch_call("STORAGE_VERIFY_BUCKET", store.verify_private_bucket)["public"] is not False:
        raise ValueError("Storage is not private")
    for candidate in selected:
        watch_call("STORAGE_VERIFY_RESULT", verify_private_one, store, candidate, bool(req["hybrid_shared_us_analysis"]))
    emit("PRIVATE_BATCH_VERIFIED",candidate_count=len(selected),run=last["id"])
    request = next_batch(rows,req,selected)
    if request is None:
        emit("REPRESENTATIVE_300_FINISHED",verified_candidates=300)
        return
    request["request_id"] = "cm300-auto-" + str(last["id"]) + "-" + request["stage"] + "-" + str(request["offset"])
    request = validate_request(request)
    selection(request)
    emit("NEXT_BOUNDED_BATCH_READY",stage=request["stage"],offset=request["offset"],count=request["count"],
         workers=request["workers"],hybrid=request["hybrid_shared_us_analysis"],dry_run=dry)
    if not dry:
        # Recheck immediately before dispatch; avoid racing any manual run.
        if any(r["status"] in ACTIVE for r in watch_call("GITHUB_RACE_CHECK", gh.runs)):
            emit("RACE_AVOIDED_ACTIVE_RESEARCH")
            return
        watch_call("GITHUB_DISPATCH_NEXT", gh.dispatch_research, request)
        emit("NEXT_BOUNDED_BATCH_DISPATCHED",count=request["count"])


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--execute",action="store_true")
    p.add_argument("--dry-run",action="store_true")
    p.add_argument("--audit-existing",action="store_true",
                   help="Read-only proof of S06/S07 private Storage audit using the existing configured secrets")
    args = p.parse_args(argv)
    if args.execute == args.dry_run:
        p.error("Choose exactly one of --execute / --dry-run")
    if os.environ.get("GITHUB_REPOSITORY") != REPO:
        raise ValueError("Repository environment mismatch")
    rows = watch_call("MANIFEST_VALIDATE", approved)
    store = watch_call("STORAGE_INIT", SupabaseCMStore.from_env)
    if args.audit_existing:
        if not args.dry_run:
            raise ValueError("Historical self-audit is read-only only")
        for candidate in ("S06", "S07"):
            verify_private_one(store, candidate, False)
        emit("CM300_PRIVATE_LIST_AND_AUDIT_VERIFIED", strategies=2)
        return
    gh = watch_call("GITHUB_INIT", GitHub, os.environ.get("GH_TOKEN"))
    decision(gh,rows,store,dry=args.dry_run)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Emit only fixed phase names, exception type and allowlisted safe codes.
        emit("CM300_WATCH_BLOCKED", **safe_failure(exc))
        sys.exit(2)
