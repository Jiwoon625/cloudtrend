"""Fail-closed representative-300 coordinator transitions and checkpoint resumption."""
import json
import unittest
from unittest.mock import patch
from cmresearchengine.rep300_coordinator import (
    approved, next_batch, selection, verify_existing_request, json_markers,
    make_request, decision, storage_folders
)


class NativeCoordinatorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rows = approved()

    def test_manifest_exact_300(self):
        self.assertEqual(len(self.rows), 300)
        self.assertEqual([self.rows[i]["id"] for i in range(7, 11)],
                         ["S08", "S09", "Q_K000_E000_U000_C100",
                          "Q_K000_E000_U025_C075"])
        self.assertEqual(sum(r["group"] == 3 for r in self.rows), 78)
        self.assertEqual(sum(r["group"] == 5 for r in self.rows), 100)

    def test_first_hybrid_after_s06_s07(self):
        current = {"mode": "run", "stage": "base", "offset": 5, "count": 2,
                   "workers": 2, "max_seconds": 3000}
        self.assertEqual(
            next_batch(self.rows, current, ["S06", "S07"]),
            make_request("base", 7, 4, 2, True))
        select = {"request_id": "test", **make_request("base",7,4,2,True)}
        _, ids = selection(select)
        self.assertEqual(ids, [self.rows[i]["id"] for i in range(7,11)])

    def test_static_group_boundary_keeps_300_scope(self):
        for pos in range(7, 36, 4):
            current = {"stage":"base","offset":pos,"count":4}
            ids = [r["id"] for r in self.rows[pos:pos+4]]
            nxt = next_batch(self.rows, current, ids)
            self.assertTrue(nxt["hybrid_shared_us_analysis"] if pos+4+4<=40 else
                            not nxt["hybrid_shared_us_analysis"])
        last = self.rows[39]
        nxt = next_batch(self.rows, {"stage":"base"}, [last["id"]])
        self.assertEqual((nxt["stage"],nxt["offset"],nxt["count"],nxt["workers"]),
                         ("split25",0,2,2))
        self.assertFalse(nxt["hybrid_shared_us_analysis"])

    def test_sparse_fine_ids_only(self):
        last = self.rows[109]  # final split25 candidate after base40 + split25 70
        nxt = next_batch(self.rows,{"stage":"split25"},[last["id"]])
        self.assertEqual(nxt["stage"],"fine")
        self.assertEqual(nxt["offset"],0)
        self.assertEqual(nxt["count"],2)
        self.assertEqual(nxt["ids"].split(","),
                         [self.rows[110]["id"],self.rows[111]["id"]])
        self.assertFalse(nxt["hybrid_shared_us_analysis"])

    def test_reference_gate_dynamic_and_split10(self):
        last_fine=self.rows[187]
        ref=next_batch(self.rows,{"stage":"fine"},[last_fine["id"]])
        self.assertEqual((ref["stage"],ref["offset"]),("references",0))
        b=next_batch(self.rows,{"stage":"references"},["REF_K"])
        self.assertEqual((b["stage"],b["offset"]),("references",1))
        c=next_batch(self.rows,{"stage":"references"},["REF_E"])
        self.assertEqual((c["stage"],c["offset"]),("references",2))
        d=next_batch(self.rows,{"stage":"references"},["REF_U"])
        self.assertEqual((d["stage"],d["offset"],d["count"],d["workers"]),
                         ("base",40,1,1))
        end_dyn=self.rows[199]
        nxt=next_batch(self.rows,{"stage":"base"},[end_dyn["id"]])
        self.assertEqual(nxt["stage"],"split10")
        self.assertEqual(nxt["ids"].split(","),
                         [self.rows[200]["id"], self.rows[201]["id"]])
        last_two=[r["id"] for r in self.rows[-2:]]
        self.assertIsNone(next_batch(self.rows,{"stage":"split10"},last_two))

    def test_unapproved_or_nonsequential_selection_rejected(self):
        self.assertFalse(verify_existing_request(self.rows,{"stage":"fine"},
                         ["F10_K000_E000_U000_C100"]))
        self.assertFalse(verify_existing_request(self.rows,{"stage":"base"},
                         ["S08","S01"]))
        with self.assertRaises(ValueError):
            next_batch(self.rows,{"stage":"base"},["S08","S01"])

    def test_private_storage_list_prefix_keeps_valid_scope(self):
        class Store:
            def object_key(self, key):
                self_value = "results/" + "ce6be8c497e45fa22a41d3a7b924913a23b18588fd05efd33ee14eb961ec7c2c" + "/S06"
                if key != self_value or key.endswith("/"):
                    raise ValueError("Invalid scoped key")
                return "user/research/cm/" + key
            def _request(self, method, route, callback, *, data, headers):
                self.assert_ = (method, route)
                raw = json.loads(data)
                assert raw["prefix"].endswith("/S06/")
                return b'[]'
            def _bounded(self, r, limit):
                return b'[]'
        store = Store()
        self.assertEqual(storage_folders(store, "results/ce6be8c497e45fa22a41d3a7b924913a23b18588fd05efd33ee14eb961ec7c2c/S06/"), [])

    def test_marker_parsing_ignores_untrusted_noise(self):
        raw='2026-10-08Z {"status":"PAUSED_VERIFIED","candidate_id":"S08"}\n' + \
            'arbitrary nonsense {"status": false}\n'
        self.assertEqual(json_markers(raw),
                         [{"status":"PAUSED_VERIFIED","candidate_id":"S08"}])

    def test_workflow_dispatch_is_native_actions_api_not_contents_push(self):
        from cmresearchengine.rep300_coordinator import GitHub
        gh=GitHub("fake-token")
        calls=[]
        gh.api=lambda path,method="GET",payload=None: calls.append((path,method,payload))
        request={"request_id":"native-1","mode":"run","stage":"base",
                 "offset":7,"count":4,"workers":2,"max_seconds":3000,
                 "ids":"","hybrid_shared_us_analysis":True}
        gh.dispatch_research(request)
        self.assertEqual(len(calls),1)
        self.assertTrue(calls[0][0].endswith("/dispatches"))
        self.assertEqual(calls[0][1],"POST")
        self.assertEqual(calls[0][2]["ref"],"main")
        self.assertEqual(calls[0][2]["inputs"]["hybrid_shared_us_analysis"],"true")
        self.assertEqual(calls[0][2]["inputs"]["count"],"4")

    def test_human_started_manual_run_cannot_autoadvance(self):
        raw={"status":"DISPATCH_REQUEST_VERIFIED","request_id":"manual-1",
             "mode":"run","stage":"base","offset":5,"count":2,
             "max_seconds":3000,"workers":2,"ids":"","hybrid_shared_us_analysis":False}
        pre={"status":"PREFLIGHT_VERIFIED",
             "plan_sha256":"ce6be8c497e45fa22a41d3a7b924913a23b18588fd05efd33ee14eb961ec7c2c",
             "normalized_files":389,"reference_files":12,"known_events":27}
        batch={"status":"BATCH_VERIFIED","selected_count":2,
               "completed_in_selected_batch":2,"remaining_in_selected_batch":0}
        log="\n".join(json.dumps(z) for z in
             [raw,pre,{"status":"COMPLETED_VERIFIED","candidate_id":"S06"},
              {"status":"COMPLETED_VERIFIED","candidate_id":"S07"},batch])
        class GH:
            def runs(self):
                return [{"id":1,"status":"completed","conclusion":"success",
                         "event":"workflow_dispatch","actor":{"login":"human"},
                         "head_branch":"main"}]
            def jobs(self,x):
                return [{"id":2,"name":"research","conclusion":"success"}]
            def job_logs(self,x):
                return log
        with self.assertRaisesRegex(ValueError,"Unexpected manual workflow actor"):
            decision(GH(),self.rows,None,dry=True)

    def test_active_research_skips_all_other_io(self):
        class ActiveGH:
            def runs(self):
                return [{"status":"in_progress","id":71}]
            def __getattr__(self,name):
                raise AssertionError("No other API should be used when active")
        decision(ActiveGH(),self.rows,None,True)


if __name__ == "__main__":
    unittest.main()
