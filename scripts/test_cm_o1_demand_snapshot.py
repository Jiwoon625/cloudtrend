"""Pure synthetic tests; no backtest, original data, network, or external writes.

Run with the reviewed runtime on PYTHONPATH and PYTHONDONTWRITEBYTECODE=1.
"""
from __future__ import annotations

import base64
from contextlib import redirect_stdout
from copy import deepcopy
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import unittest
from unittest.mock import patch
import zipfile

import pandas as pd
from pandas.testing import assert_frame_equal

from cmresearchengine import runtime
from cmresearchengine import ingest
from cmresearchengine.storage import _DuplicateObject, ImmutableConflict

SCRIPT = Path(__file__).with_name("export-cm-o1-demand-snapshot.py")
SPEC = importlib.util.spec_from_file_location("o1_snapshot_under_test", SCRIPT)
snapshot = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(snapshot)

DEMAND_COLUMNS = ["engine", "demand_id", "session_at", "available_at", "desired_amount", "eligible"]
CUTOFF = pd.Timestamp("2026-09-11T22:00:00Z")
MONTHLY = pd.Timestamp("2026-08-31T22:00:00Z")


def calendars():
    result = {}
    for engine in "KEU":
        rows = []
        for day in pd.bdate_range("2026-07-01", "2026-09-30", tz="UTC"):
            # Deliberately different calendars; these are synthetic holidays.
            if (engine == "K" and day.day == 10) or (engine == "U" and day.day == 7):
                continue
            hour, minute = (14, 30) if engine == "U" else (0, 0)
            rows.append({"session_date": day.date().isoformat(),
                         "open_at": (day + pd.Timedelta(hours=hour, minutes=minute)).isoformat(),
                         "close_available_at": (day + pd.Timedelta(hours=21 if engine == "U" else 7)).isoformat()})
        result[engine] = rows
    return result


def event(cal, engine, date, identity, amount=100, **changes):
    row = next(x for x in cal[engine] if x["session_date"] == date)
    return {"engine": engine, "demand_id": identity, "session_at": row["open_at"],
            "available_at": row["open_at"], "desired_amount": amount, "eligible": True, **changes}


def references(events=()):
    return {"nav": pd.DataFrame({e: [1., 1.] for e in "KEU"}, index=[MONTHLY, CUTOFF]),
            "demands": pd.DataFrame(events, columns=DEMAND_COLUMNS),
            "capital": {"K": 100000000., "E": 100000000., "U": 100000.}}


def derive_inputs():
    cal = calendars()
    demands = [event(cal, "K", "2026-08-28", "k-old"), event(cal, "U", "2026-09-09", "u-new")]
    refs = references(demands)
    files = {}
    for engine in "KEU":
        files[engine] = {
            "summary.json": snapshot.canonical({"candidate_id": "REF_" + engine,
                "execution_contract": {"cash_movement": "NONE"},
                "initial_native_capital": {engine: refs["capital"][engine]}}),
            "nav.csv": pd.DataFrame({"at": [MONTHLY.isoformat(), CUTOFF.isoformat()],
                "gross_nav_krw": [100000000., 100000000.]}).to_csv(index=False).encode(),
            "demands.csv": refs["demands"].loc[refs["demands"].engine.eq(engine)].to_csv(index=False).encode(),
        }
    actual = {"K": .6, "E": 0., "U": 0., "C": .4}
    review = {"at": MONTHLY.isoformat(), "month": "2026-08",
        "policy": {"policy_id": "O1", "status": "ok", "fallback": False,
                   "demand_unique_positive_counts": {"K": 1, "E": 0, "U": 0}},
        "movement": {"targets": {e: str(v) for e, v in actual.items()}}}
    o1 = {"nav.csv": pd.DataFrame([{ "at": stamp.isoformat(),
                **{"target_" + e: v for e, v in actual.items()}}
                for stamp in (MONTHLY, CUTOFF)]).to_csv(index=False).encode(),
          "reviews.json": snapshot.canonical([review])}
    sources = {"stage_sha256": "5ffb9c2c8c7ff280d68d4abaea26917287f813f7c191373c90211b99e1f53f73",
               "archive_sha256": "1272caccc39531d4db2bc958570775bc6a002778c923d9e15e3b4adbb35a6c8a",
               "calendars_sha256": {e: "c" * 64 for e in "KEU"}}
    context = {"run_id": "123", "attempt": 1, "commit": "d" * 40}
    empty_events = pd.DataFrame(columns=["at", "kind", "sleeve", "quantity", "id"]).to_csv(index=False).encode()
    o1["events.csv"] = empty_events
    for fileset in files.values():
        fileset["events.csv"] = empty_events
    return o1, files, cal, sources, context


def report():
    return snapshot.derive_snapshot(*derive_inputs())


class MemoryStore:
    """Narrow in-memory stand-in. No HTTP client or real storage is invoked."""
    def __init__(self, *, objects=None, blobs=None, public=False, race=False, bad_readback=False):
        self.objects = dict(objects or {})
        self.blobs = dict(blobs or {})
        self.public = public
        self.race = race
        self.bad_readback = bad_readback
        self.posts = []

    def get_object(self, key, *, max_bytes):
        if key not in self.objects:
            raise FileNotFoundError(key)
        raw = self.objects[key]
        if len(raw) > max_bytes:
            raise ValueError("synthetic bounded read exceeded")
        return raw

    def get_bytes(self, key):
        return self.blobs[key]

    def scoped_checkpoints(self, plan, candidate):
        return self

    def verify_private_bucket(self):
        return {"public": self.public}

    def _object_route(self, key):
        return key

    def _bounded(self, response, size):
        return b""

    def _request(self, method, route, consume, *, data, headers):
        if method != "POST" or headers["x-upsert"] != "false":
            raise AssertionError("Only create-only writes are permitted in this fake")
        self.posts.append((route, data, dict(headers)))
        if route in self.objects:
            raise AssertionError("Attempted overwrite")
        self.objects[route] = b"X" * len(data) if self.bad_readback else data
        if self.race:
            raise _DuplicateObject("Synthetic concurrent creation")


def result_store(*, invalid_file_hash=False):
    execution = {"cash_movement": "MONTHLY"}
    descriptor = {"candidate": {"candidate_id": "O1"}, "plan_sha256": snapshot.PLAN,
                  "code_hashes": runtime.code_hashes(), "execution": execution}
    identity = snapshot.sha(snapshot.canonical(descriptor))
    summary = snapshot.canonical({"candidate_id": "O1", "evaluation_start": "2017-08-21",
        "evaluation_end": "2026-09-11", "execution_contract": execution,
        "ordinary_and_proxy_sales_share_one_way_fee": "0.0015"})
    files = {"summary.json": summary, "demands.csv": b"synthetic,only\n"}
    manifest = {name: {"size": len(raw), "sha256": snapshot.sha(raw)} for name, raw in files.items()}
    if invalid_file_hash:
        manifest["demands.csv"]["sha256"] = "0" * 64
    files["file_manifest.json"] = snapshot.canonical({"files": manifest})
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        for name, raw in files.items():
            archive.writestr(name, raw)
    raw = stream.getvalue()
    completion = snapshot.canonical({"schema": "CM06_FRESH_COMPLETED_V1", "identity": descriptor,
        "outputs_id": "synthetic-output", "outputs_size": len(raw), "outputs_sha256": snapshot.sha(raw)})
    prefix = f"results/{snapshot.PLAN}/O1/{identity}/"
    store = MemoryStore(objects={prefix + "completion.json": completion, prefix + "summary.json": summary},
        blobs={"complete_" + identity: completion, "synthetic-output": raw})
    return store, {"O1": (identity, snapshot.sha(raw))}, files


class PurePolicyTests(unittest.TestCase):
    def setUp(self):
        self.cal = calendars()

    def test_exactly_twenty_sessions_accepts_nineteen_blocks(self):
        twenty = {e: [x for x in rows if pd.Timestamp(x["open_at"]) <= CUTOFF][-20:]
                  for e, rows in self.cal.items()}
        result = snapshot.evaluate(CUTOFF, references(), twenty)
        self.assertEqual(result["weights"], {"K": 0., "E": 0., "U": 0., "C": 1.})
        twenty["E"] = twenty["E"][1:]
        with self.assertRaisesRegex(snapshot.SnapshotError, "O1_DERIVATION_FALLBACK"):
            snapshot.evaluate(CUTOFF, references(), twenty)

    def test_dedup_precedes_window_and_positive_filter(self):
        events = [event(self.cal, "K", "2026-07-01", "old", 10),
                  event(self.cal, "K", "2026-09-09", "old", 999),
                  event(self.cal, "E", "2026-08-28", "zero", 0),
                  event(self.cal, "E", "2026-09-09", "zero", 999),
                  event(self.cal, "U", "2026-08-28", "u", 10),
                  event(self.cal, "U", "2026-09-09", "u", 999)]
        result = snapshot.evaluate(CUTOFF, references(events), self.cal)
        self.assertEqual(result["unique_positive_demand_counts"], {"K": 0, "E": 0, "U": 1})
        self.assertEqual(result["weights"], {"K": 0., "E": 0., "U": .6, "C": .4})

    def test_future_observation_and_future_session_each_excluded(self):
        events = [event(self.cal, "K", "2026-09-09", "late-available", available_at="2026-09-12T00:00:00Z"),
                  event(self.cal, "E", "2026-09-14", "late-session", available_at="2026-09-09T00:00:00Z"),
                  event(self.cal, "U", "2026-09-11", "on-cutoff", available_at=CUTOFF.isoformat())]
        result = snapshot.evaluate(CUTOFF, references(events), self.cal)
        self.assertEqual(result["unique_positive_demand_counts"], {"K": 0, "E": 0, "U": 1})

    def test_first_window_boundary_is_inclusive_and_own_market_calendar_used(self):
        events = []
        expected_first = {}
        for engine in "KEU":
            rows = [x for x in self.cal[engine] if pd.Timestamp(x["open_at"]) <= CUTOFF]
            expected_first[engine] = rows[-20]["session_date"]
            events += [event(self.cal, engine, rows[-20]["session_date"], engine + "-boundary"),
                       event(self.cal, engine, rows[-21]["session_date"], engine + "-too-old")]
        result = snapshot.evaluate(CUTOFF, references(events), self.cal)
        self.assertEqual(result["unique_positive_demand_counts"], dict.fromkeys("KEU", 1))
        self.assertEqual({e: x["first"] for e, x in result["session_windows"].items()}, expected_first)
        self.assertEqual(result["weights"], {"K": 1/3, "E": 1/3, "U": 1/3, "C": 0.})

    def test_ineligible_row_does_not_preempt_later_eligible_row(self):
        events = [event(self.cal, "K", "2026-08-28", "same", eligible=False),
                  event(self.cal, "K", "2026-09-09", "same", 10)]
        self.assertEqual(snapshot.evaluate(CUTOFF, references(events), self.cal)["active_engines"], ["K"])

    def test_evaluation_does_not_mutate_inputs(self):
        refs = references([event(self.cal, "K", "2026-08-28", "k")])
        before = deepcopy(refs)
        before_cal = deepcopy(self.cal)
        snapshot.evaluate(CUTOFF, refs, self.cal)
        assert_frame_equal(refs["nav"], before["nav"], check_exact=True)
        assert_frame_equal(refs["demands"], before["demands"], check_exact=True)
        self.assertEqual(refs["capital"], before["capital"])
        self.assertEqual(self.cal, before_cal)


class SnapshotTests(unittest.TestCase):
    def test_actual_monthly_and_virtual_are_distinct_and_sources_unchanged(self):
        args = derive_inputs()
        before = deepcopy(args)
        result = snapshot.derive_snapshot(*args)
        self.assertEqual(args, before)
        self.assertEqual(result["actual_last_monthly"]["cutoff"], MONTHLY.isoformat())
        self.assertEqual(result["actual_last_monthly"]["month"], "2026-08")
        self.assertEqual(result["actual_last_monthly"]["weights"], {"K": .6, "E": 0., "U": 0., "C": .4})
        self.assertEqual(result["virtual_asof"]["weights"], {"K": .5, "E": 0., "U": .5, "C": 0.})
        self.assertIs(result["virtual_asof"]["is_executed_monthly_review"], False)

    def test_fallback_retains_last_valid_target_and_preserves_both_dates(self):
        args = list(derive_inputs())
        earlier = pd.Timestamp("2026-07-31T22:00:00Z")
        args[1]["K"]["demands.csv"] = pd.DataFrame([
            event(args[2], "K", "2026-07-29", "k-early")], columns=DEMAND_COLUMNS).to_csv(index=False).encode()
        actual = json.loads(args[0]["reviews.json"])[0]
        valid = deepcopy(actual)
        valid.update(at=earlier.isoformat(), month="2026-07")
        actual["policy"] = {"policy_id": "O1", "status": "fallback", "fallback": True,
                            "fallback_source": "previous_valid_target", "reason": "synthetic_input_missing"}
        args[0]["reviews.json"] = snapshot.canonical([valid, actual])
        result = snapshot.derive_snapshot(*args)
        self.assertTrue(result["actual_last_monthly"]["fallback"])
        self.assertFalse(result["actual_last_monthly"]["same_as_last_valid_review"])
        self.assertEqual(result["actual_last_monthly"]["cutoff"], MONTHLY.isoformat())
        self.assertEqual(result["last_valid_monthly_calculation"]["cutoff"], earlier.isoformat())
        self.assertEqual(result["actual_last_monthly"]["weights"], result["last_valid_monthly_calculation"]["weights"])
        self.assertEqual(result["virtual_asof"]["weights"], {"K": 0., "E": 0., "U": .6, "C": .4})
        snapshot.validate_report(result)

    def test_fallback_cannot_invent_a_new_target(self):
        args = list(derive_inputs())
        valid = json.loads(args[0]["reviews.json"])[0]
        actual = deepcopy(valid)
        actual.update(at="2026-09-01T22:00:00+00:00", month="2026-09")
        actual["policy"] = {"policy_id": "O1", "status": "fallback", "fallback": True}
        other = {"K": 0., "E": .6, "U": 0., "C": .4}
        actual["movement"]["targets"] = other
        args[0]["reviews.json"] = snapshot.canonical([valid, actual])
        nav = pd.read_csv(io.BytesIO(args[0]["nav.csv"]))
        for engine, weight in other.items():
            nav.loc[nav.index[-1], "target_" + engine] = weight
        args[0]["nav.csv"] = nav.to_csv(index=False).encode()
        with self.assertRaisesRegex(snapshot.SnapshotError, "LAST_FALLBACK_TARGET_NOT_RETAINED"):
            snapshot.derive_snapshot(*args)

    def test_recorded_target_mismatch_blocks(self):
        args = list(derive_inputs())
        reviews = json.loads(args[0]["reviews.json"])
        reviews[-1]["movement"]["targets"] = {"K": .5, "E": .5, "U": 0., "C": 0.}
        args[0]["reviews.json"] = snapshot.canonical(reviews)
        with self.assertRaisesRegex(snapshot.SnapshotError, "MONTHLY_TARGET_RECONCILIATION_FAILED"):
            snapshot.derive_snapshot(*args)

    def test_monthly_counts_mismatch_blocks(self):
        args = list(derive_inputs())
        reviews = json.loads(args[0]["reviews.json"])
        reviews[-1]["policy"]["demand_unique_positive_counts"]["K"] = 999
        args[0]["reviews.json"] = snapshot.canonical(reviews)
        with self.assertRaisesRegex(snapshot.SnapshotError, "MONTHLY_DEMAND_RECONCILIATION_FAILED"):
            snapshot.derive_snapshot(*args)


class PrivatePublicationTests(unittest.TestCase):
    def test_accounting_audit_gate_precedes_all_reads(self):
        with patch.object(snapshot.runpy, "run_path") as helper, \
             self.assertRaisesRegex(snapshot.SnapshotError, "ACCOUNTING_AUDIT_REQUIRED"):
            snapshot.export_snapshot(accounting_audit_passed=False, store=MemoryStore())
        helper.assert_not_called()

    def test_failure_output_does_not_disclose_private_exception(self):
        output = io.StringIO()
        with patch.object(snapshot, "export_snapshot", side_effect=RuntimeError("synthetic-private-demand-id")), \
             redirect_stdout(output), self.assertRaises(SystemExit) as caught:
            snapshot.export_snapshot_safely(accounting_audit_passed=True)
        self.assertEqual(caught.exception.code, 1)
        self.assertEqual(output.getvalue(), '{"status":"PRIVATE_O1_DEMAND_SNAPSHOT_BLOCKED"}\n')

    def test_private_create_only_idempotent_and_metadata_bounded(self):
        value = report()
        store = MemoryStore()
        digest = snapshot.publish(store, value)
        self.assertEqual(snapshot.publish(store, value), digest)
        self.assertEqual(len(store.posts), 1)
        target, raw, headers = store.posts[0]
        self.assertTrue(target.startswith("results/reports/o1-demand-snapshot/" + snapshot.PLAN + "/O1/"))
        self.assertEqual(raw, snapshot.canonical(value))
        self.assertEqual(headers["x-upsert"], "false")
        self.assertLessEqual(len(headers["x-metadata"]), snapshot.MAX_BYTES)
        self.assertEqual(json.loads(base64.b64decode(headers["x-metadata"]))["report_sha256"], digest)

    def test_public_bucket_blocks_before_any_write(self):
        store = MemoryStore(public=True)
        with self.assertRaisesRegex(snapshot.SnapshotError, "PRIVATE_BUCKET_REQUIRED"):
            snapshot.publish(store, report())
        self.assertEqual(store.posts, [])

    def test_concurrent_create_succeeds_only_with_exact_readback(self):
        store = MemoryStore(race=True)
        snapshot.publish(store, report())
        self.assertEqual(len(store.posts), 1)
        bad = MemoryStore(race=True, bad_readback=True)
        with self.assertRaisesRegex(snapshot.SnapshotError, "PRIVATE_REPORT_READBACK_MISMATCH"):
            snapshot.publish(bad, report())

    def test_existing_conflicting_object_is_not_overwritten(self):
        value = report()
        digest = snapshot.sha(snapshot.canonical(value))
        target = f"results/reports/o1-demand-snapshot/{snapshot.PLAN}/O1/{value['identity']}/{digest}.json"
        store = MemoryStore(objects={target: b"bad"})
        with self.assertRaises(ImmutableConflict):
            snapshot.publish(store, value)
        self.assertEqual(store.posts, [])

    def test_top_level_raw_data_rejected(self):
        value = report()
        value["demands"] = [{"demand_id": "synthetic-secret"}]
        store = MemoryStore()
        with self.assertRaises(snapshot.SnapshotError):
            snapshot.publish(store, value)
        self.assertEqual(store.posts, [])

    def test_nested_raw_data_rejected(self):
        for location in ("audit", "virtual_asof", "actual_last_monthly", "last_valid_monthly_calculation", "calendar_sources"):
            with self.subTest(location=location):
                value = report()
                value[location]["raw_demands"] = [{"demand_id": "synthetic-secret"}]
                store = MemoryStore()
                with self.assertRaises(snapshot.SnapshotError):
                    snapshot.publish(store, value)
                self.assertEqual(store.posts, [])

    def test_plan_and_status_are_fixed(self):
        for field, bad in (("plan_sha256", "0" * 64), ("status", "UNVERIFIED")):
            with self.subTest(field=field):
                value = report()
                value[field] = bad
                with self.assertRaises(snapshot.SnapshotError):
                    snapshot.publish(MemoryStore(), value)

    def test_invalid_cap_is_rejected(self):
        with self.assertRaises(snapshot.SnapshotError):
            snapshot.clean_weights({"K": .7, "E": 0., "U": 0., "C": .3})


class HistoricalMonthlyTests(unittest.TestCase):
    def test_incomplete_early_window_is_fallback_not_zero_demand(self):
        args = derive_inputs()
        rows = json.loads(args[0]["reviews.json"])
        first = {"at": "2026-07-08T22:00:00+00:00", "month": "2026-07",
                 "policy": {"policy_id": "O1", "status": "fallback", "fallback": True},
                 "movement": {"targets": {"K": 1/3, "E": 1/3, "U": 1/3, "C": 0.}}}
        args[0]["reviews.json"] = snapshot.canonical([first] + rows)
        value = snapshot.derive_monthly_history(*args)
        self.assertEqual(value["review_count"], 2)
        self.assertEqual(value["fallback_review_count"], 1)
        self.assertEqual(value["valid_review_count"], 1)
        self.assertEqual(value["markets"]["E"]["zero_demand_valid_reviews"], 1)
        self.assertEqual(value["markets"]["E"]["zero_target_reviews"], 1)

    def test_positive_demand_with_no_actual_buy_preserves_nonzero_target(self):
        args = derive_inputs()
        before = deepcopy(args)
        value = snapshot.derive_monthly_history(*args)
        self.assertEqual(args, before)
        self.assertEqual(value["review_count"], 1)
        self.assertEqual(value["markets"]["K"]["zero_target_reviews"], 0)
        self.assertEqual(value["markets"]["K"]["nonzero_target_zero_o1_buys_valid_reviews"], 1)
        self.assertEqual(value["markets"]["K"]["positive_demand_zero_ref_buys_valid_reviews"], 1)
        self.assertEqual(value["markets"]["E"]["zero_target_examples"][0]["demands"], 0)
        snapshot.validate_history_report(value)

    def test_buy_occurrence_and_target_zero_are_independent(self):
        args = derive_inputs()
        args[0]["events.csv"] = pd.DataFrame([
            {"at": "2026-08-28T00:00:00Z", "kind": "BUY", "sleeve": "E", "quantity": 1, "id": "e-buy"},
            {"at": "2026-07-01T00:00:00Z", "kind": "BUY", "sleeve": "K", "quantity": 1, "id": "old-buy"},
            {"at": "2026-09-01T00:00:00Z", "kind": "BUY", "sleeve": "K", "quantity": 1, "id": "future-buy"},
            {"at": "2026-08-28T00:00:00Z", "kind": "SELL", "sleeve": "K", "quantity": 1, "id": "sell"},
        ]).to_csv(index=False).encode()
        value = snapshot.derive_monthly_history(*args)
        self.assertEqual(value["markets"]["E"]["zero_target_examples"][0]["o1_buys"], 1)
        self.assertEqual(value["markets"]["E"]["zero_o1_buys_valid_reviews"], 0)
        self.assertEqual(value["markets"]["K"]["zero_o1_buys_valid_reviews"], 1)

    def test_any_historical_count_or_target_mismatch_blocks(self):
        for field in ("count", "target"):
            args = derive_inputs()
            rows = json.loads(args[0]["reviews.json"])
            if field == "count":
                rows[0]["policy"]["demand_unique_positive_counts"]["E"] = 1
            else:
                rows[0]["movement"]["targets"] = {"K": .5, "E": .5, "U": 0., "C": 0.}
            args[0]["reviews.json"] = snapshot.canonical(rows)
            with self.assertRaises(snapshot.SnapshotError):
                snapshot.derive_monthly_history(*args)

    def test_duplicate_buy_fill_and_duplicate_month_block(self):
        args = derive_inputs()
        event = {"at": "2026-08-28T00:00:00Z", "kind": "BUY", "sleeve": "K", "quantity": 1, "id": "same"}
        args[0]["events.csv"] = pd.DataFrame([event, event]).to_csv(index=False).encode()
        with self.assertRaisesRegex(snapshot.SnapshotError, "DUPLICATE_BUY_EVENT"):
            snapshot.derive_monthly_history(*args)
        args = derive_inputs()
        rows = json.loads(args[0]["reviews.json"])
        repeated = deepcopy(rows[0])
        repeated["at"] = "2026-09-01T22:00:00+00:00"
        args[0]["reviews.json"] = snapshot.canonical(rows + [repeated])
        with self.assertRaisesRegex(snapshot.SnapshotError, "DUPLICATE_MONTHLY_REVIEW"):
            snapshot.derive_monthly_history(*args)

    def test_private_history_is_bounded_create_only_and_rejects_raw_fields(self):
        value = snapshot.derive_monthly_history(*derive_inputs())
        store = MemoryStore()
        snapshot.publish(store, value)
        snapshot.publish(store, value)
        self.assertEqual(len(store.posts), 1)
        self.assertLessEqual(len(store.posts[0][2]["x-metadata"]), snapshot.MAX_BYTES)
        for place in (value, value["markets"]["K"], value["markets"]["E"]["zero_target_examples"][0]):
            place["raw_id"] = "not-allowed"
            with self.assertRaises(snapshot.SnapshotError):
                snapshot.publish(MemoryStore(), value)
            del place["raw_id"]


class IntegrityTests(unittest.TestCase):
    def test_pinned_result_reads_original_bytes_without_mutation(self):
        store, sources, expected = result_store()
        before = deepcopy((store.objects, store.blobs))
        with patch.object(snapshot, "SOURCES", sources):
            self.assertEqual(snapshot.verified_result(store, "O1"), expected)
        self.assertEqual((store.objects, store.blobs), before)
        self.assertEqual(store.posts, [])

    def test_changed_zip_bytes_fail_hash_check(self):
        store, sources, _ = result_store()
        raw = store.blobs["synthetic-output"]
        store.blobs["synthetic-output"] = raw[:-1] + bytes([raw[-1] ^ 1])
        with patch.object(snapshot, "SOURCES", sources), self.assertRaisesRegex(ValueError, "Output integrity changed"):
            snapshot.verified_result(store, "O1")

    def test_file_manifest_hash_mismatch_blocks(self):
        store, sources, _ = result_store(invalid_file_hash=True)
        with patch.object(snapshot, "SOURCES", sources), self.assertRaisesRegex(snapshot.SnapshotError, "FILE_HASH_MISMATCH"):
            snapshot.verified_result(store, "O1")

    def test_unapproved_zip_pin_blocks(self):
        store, sources, _ = result_store()
        sources["O1"] = (sources["O1"][0], "0" * 64)
        with patch.object(snapshot, "SOURCES", sources), self.assertRaisesRegex(snapshot.SnapshotError, "PINNED_ZIP_MISMATCH"):
            snapshot.verified_result(store, "O1")

    def test_calendar_archive_hash_mismatch_blocks(self):
        data = io.BytesIO()
        records = {}
        with tarfile.open(fileobj=data, mode="w") as archive:
            for engine, rows in calendars().items():
                name = ingest.REFERENCE_ROOT + f"data/reference_time/{engine}_calendar.json"
                raw = snapshot.canonical(rows)
                member = tarfile.TarInfo(name)
                member.size = len(raw)
                archive.addfile(member, io.BytesIO(raw))
                records[name] = {"size": len(raw), "sha256": snapshot.sha(raw)}
        raw = data.getvalue()
        record = {"size": len(raw), "sha256": snapshot.sha(raw)}
        key = "inputs/cm06.batched.Stage2_reference_time." + record["sha256"] + ".tar"
        store = MemoryStore(objects={"inputs/cm06.batched.stage.Stage2_reference_time.json": b"synthetic-stage",
                                     key: raw[:-1] + b"X"})
        with patch.object(ingest, "validate_stage", return_value=({"archives": [record]}, records)), \
             self.assertRaisesRegex(snapshot.SnapshotError, "REFERENCE_ARCHIVE_HASH_MISMATCH"):
            snapshot.verified_calendars(store)


if __name__ == "__main__":
    unittest.main()
