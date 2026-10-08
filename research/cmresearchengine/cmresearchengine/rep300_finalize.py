"""Fail-closed CM06 finalization after Notion report acknowledgement.

No periodic research watcher is disabled until the report is saved and read
back through the connected Notion app, followed by an independent private
result verification in this GitHub workflow.
"""
from __future__ import annotations
import contextlib
import io
import json
import os
from pathlib import Path
from .rep300_coordinator import GitHub, REPO, PLAN_HASH, approved, decision, json_markers
from .storage import SupabaseCMStore

RECEIPT = Path(__file__).resolve().parents[1] / "CM300_NOTION_RECORDED.json"
NOTION_ID = "3f0d908cac2f816c9476ec74c6431ac8"
NOTION_URL = "https://app.notion.com/p/" + NOTION_ID
WATCH_WORKFLOW = "cmresearchengine-300-native-watch.yml"
ISSUE_TITLE = "CM06: representative 300 verified and recorded in Notion"
ISSUE_STAMP = "CM300_FINALIZED_AFTER_NOTION_V1"

def validated_receipt(raw):
    if not isinstance(raw, dict) or set(raw) != {
        "schema", "plan_sha256", "verified_candidates", "research_run_id",
        "notion_page_id", "notion_url", "notion_write_verified",
    }:
        raise ValueError("Notion acknowledgement schema mismatch")
    if raw["schema"] != "CM300_NOTION_RECORDED_V1":
        raise ValueError("Notion acknowledgement version mismatch")
    if raw["plan_sha256"] != PLAN_HASH or raw["verified_candidates"] != 300:
        raise ValueError("Unapproved candidate count or manifest")
    if raw["notion_page_id"] != NOTION_ID or raw["notion_url"] != NOTION_URL:
        raise ValueError("Notion report destination differs from approved page")
    if raw["notion_write_verified"] is not True:
        raise ValueError("Notion write and readback must be verified first")
    run_id = raw["research_run_id"]
    if type(run_id) is not int or run_id < 1:
        raise ValueError("Invalid completion run ID")
    return raw

def confirm_final_research(gh, store, receipt):
    # Repeat the bounded, private last-batch result checks before shutdown.
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        decision(gh, approved(), store, dry=True)
    markers = json_markers(buf.getvalue())
    finished = [x for x in markers if x.get("status") == "REPRESENTATIVE_300_FINISHED"]
    if len(finished) != 1 or finished[0].get("verified_candidates") != 300:
        raise ValueError("Private 300th-candidate audit not complete")
    latest = gh.runs()
    if not latest or latest[0]["id"] != receipt["research_run_id"]:
        raise ValueError("Final research run differs from Notion acknowledgement")

def finalize(gh, store, receipt, dry_run=False):
    validated_receipt(receipt)
    confirm_final_research(gh, store, receipt)
    if store.verify_private_bucket()["public"] is not False:
        raise ValueError("Results bucket is not private")
    if dry_run:
        return {"status": "CM300_FINALIZER_DRY_RUN_VERIFIED"}
    gh.api("/actions/workflows/" + WATCH_WORKFLOW + "/disable", "PUT", {})
    # Idempotent GitHub issue also serves as the owner's completion alert.
    issues = gh.api("/issues?state=all&per_page=100")
    existing = [x for x in issues if x.get("title") == ISSUE_TITLE
                and str(x.get("body") or "").startswith(ISSUE_STAMP)
                and (x.get("user") or {}).get("login") == "github-actions[bot]"]
    if not existing:
        body = (ISSUE_STAMP + "\n\n"
                "Approved CM06 representative 300/300 completed and private "
                "results verified. The Notion report was written and re-read "
                "before disabling the research-only CM300 watcher.\n\n"
                "Notion report: " + NOTION_URL + "\n"
                "Final research run: https://github.com/" + REPO
                + "/actions/runs/" + str(receipt["research_run_id"]) + "\n"
                "Plan SHA256: " + PLAN_HASH + "\n\n"
                "Other screening workflows and private result objects remain unchanged.")
        gh.api("/issues", "POST", {"title": ISSUE_TITLE, "body": body,
                                    "assignees": ["Jiwoon625"]})
    return {"status": "CM300_NOTION_RECORDED_WATCH_DISABLED_OWNER_NOTIFIED",
            "completed": 300, "run_id": receipt["research_run_id"]}

def main():
    if os.environ.get("GITHUB_REPOSITORY") != REPO:
        raise ValueError("Repository mismatch")
    receipt = validated_receipt(json.loads(RECEIPT.read_text(encoding="utf-8")))
    gh = GitHub(os.environ.get("GH_TOKEN"))
    store = SupabaseCMStore.from_env()
    print(json.dumps(finalize(gh, store, receipt), sort_keys=True))

if __name__ == "__main__":
    main()
