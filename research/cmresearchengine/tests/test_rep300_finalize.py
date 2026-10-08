"""CM300 automatic shutdown: fail-closed Notion-before-disable contract."""
import json
import unittest
from pathlib import Path
from unittest.mock import patch

from cmresearchengine.rep300_finalize import (
    validated_receipt, confirm_final_research, finalize,
    NOTION_ID, NOTION_URL, ISSUE_TITLE, ISSUE_STAMP,
)
from cmresearchengine.rep300_coordinator import PLAN_HASH


def good_receipt():
    return {
        "schema": "CM300_NOTION_RECORDED_V1",
        "plan_sha256": PLAN_HASH,
        "verified_candidates": 300,
        "research_run_id": 37777777777,
        "notion_page_id": NOTION_ID,
        "notion_url": NOTION_URL,
        "notion_write_verified": True,
    }


class FinalizeAfterNotionTests(unittest.TestCase):
    def test_valid_receipt_and_untrusted_modifications_rejected(self):
        raw = good_receipt()
        self.assertEqual(validated_receipt(raw)["verified_candidates"], 300)
        for replacement in (
            {"verified_candidates": 299}, {"verified_candidates": True},
            {"research_run_id": "37777777777"},
            {"notion_write_verified": "true"},
            {"notion_write_verified": False},
            {"notion_page_id": "different"},
            {"plan_sha256": "0" * 64},
            {"notion_url": "https://evil.invalid/" + NOTION_ID},
            {"schema": "CM300_NOTION_RECORDED_V0"},
            {"extra": "skip-audit"},
        ):
            with self.subTest(replacement=replacement), self.assertRaises(ValueError):
                validated_receipt({**raw, **replacement})

    def test_no_side_effects_before_notion_and_private_verification(self):
        class GH:
            actions = []
            def api(self, *args):
                self.actions.append(args)
        class Store:
            def verify_private_bucket(self):
                return {"public": False}
        gh = GH()
        with patch("cmresearchengine.rep300_finalize.confirm_final_research",
                   side_effect=ValueError("No final proof")):
            with self.assertRaisesRegex(ValueError, "No final proof"):
                finalize(gh, Store(), good_receipt())
        self.assertEqual(gh.actions, [])

    def test_after_verification_disable_exact_watcher_then_one_issue(self):
        class GH:
            def __init__(self):
                self.actions = []
            def api(self, path, method="GET", payload=None):
                self.actions.append((path,method,payload))
                if path.startswith("/issues?"):
                    return []
                return {}
        class Store:
            def verify_private_bucket(self):
                return {"public": False}
        gh = GH()
        with patch("cmresearchengine.rep300_finalize.confirm_final_research"):
            final=finalize(gh,Store(),good_receipt())
        self.assertEqual(final["completed"],300)
        self.assertEqual(gh.actions[0][:2],(
            "/actions/workflows/cmresearchengine-300-native-watch.yml/disable","PUT"))
        self.assertEqual(gh.actions[1][0],"/issues?state=all&per_page=100")
        self.assertEqual(gh.actions[2][:2],("/issues","POST"))
        self.assertEqual(gh.actions[2][2]["title"],ISSUE_TITLE)
        self.assertTrue(gh.actions[2][2]["body"].startswith(ISSUE_STAMP))
        self.assertEqual(gh.actions[2][2]["assignees"],["Jiwoon625"])

    def test_existing_bot_issue_is_not_repeated(self):
        class GH:
            def __init__(self):
                self.actions = []
            def api(self,path,method="GET",payload=None):
                self.actions.append(path)
                if path.startswith("/issues?"):
                    return [{"title": ISSUE_TITLE, "body": ISSUE_STAMP + "\n",
                             "user":{"login":"github-actions[bot]"}}]
                return {}
        class Store:
            def verify_private_bucket(self):
                return {"public": False}
        gh=GH()
        with patch("cmresearchengine.rep300_finalize.confirm_final_research"):
            finalize(gh,Store(),good_receipt())
        self.assertEqual(len(gh.actions),2)

    def test_dry_run_has_no_github_writes(self):
        class GH:
            def api(self,*args):
                raise AssertionError("dry run must not access mutation APIs")
        class Store:
            def verify_private_bucket(self):
                return {"public": False}
        with patch("cmresearchengine.rep300_finalize.confirm_final_research"):
            result=finalize(GH(),Store(),good_receipt(),dry_run=True)
        self.assertEqual(result["status"],"CM300_FINALIZER_DRY_RUN_VERIFIED")

    def test_final_research_requires_explicit_verified_300_event_and_run(self):
        class GH:
            def runs(self):
                return [{"id":37777777777}]
        with patch("cmresearchengine.rep300_finalize.approved",return_value=[]):
            with patch("cmresearchengine.rep300_finalize.decision",
                       side_effect=lambda *a,**k: print(json.dumps({
                           "status":"REPRESENTATIVE_300_FINISHED",
                           "verified_candidates":300}))):
                confirm_final_research(GH(),object(),good_receipt())
            with patch("cmresearchengine.rep300_finalize.decision",
                       side_effect=lambda *a,**k: print(json.dumps({
                           "status":"PRIVATE_BATCH_VERIFIED",
                           "candidate_count":2}))):
                with self.assertRaisesRegex(ValueError,"not complete"):
                    confirm_final_research(GH(),object(),good_receipt())

    def test_workflow_triggers_only_on_approved_marker(self):
        w=(Path(__file__).resolve().parents[3] /
           ".github/workflows/cmresearchengine-300-finalize.yml").read_text()
        self.assertIn("research/cmresearchengine/CM300_NOTION_RECORDED.json",w)
        self.assertIn("  actions: write",w)
        self.assertIn("  issues: write",w)
        self.assertIn("cmresearchengine.rep300_finalize",w)
        self.assertNotIn("schedule:",w)
        self.assertNotIn("cron:",w)


if __name__ == "__main__":
    unittest.main()
