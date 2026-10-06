#!/usr/bin/env python3
"""Test the owner-only October RPC in a new disposable, loopback PostgreSQL cluster.

No production connection, credentials, remote URL or existing data directory is
accepted. The checked-in migration is applied unmodified first. A TEST-LOCAL
replacement of its two statement_timestamp() initializers simulates future
exchange closes without adding any production clock override or test API.

python3 tests/october-shadow-postgres.test.py --pg-bin-dir /path/to/bin \
    --pg-share-dir /path/to/share/postgresql/17
"""
import argparse
import copy
from datetime import date, timedelta
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
USER_A = "11111111-1111-4111-8111-111111111111"
USER_B = "22222222-2222-4222-8222-222222222222"
USER_C = "33333333-3333-4333-8333-333333333333"
USER_D = "44444444-4444-4444-8444-444444444444"
USER_E = "55555555-5555-4555-8555-555555555555"
PREFIX = "adopted-shadow-2026-10-05-v1:"
KINDS = ["KR_MIXED", "KR_KOSPI", "KR_KOSDAQ", "US_A0", "ETF_V02", "US_A2", "US_B3", "KR_KOSPI_CONFIRM1_BEAR"]
SIGNATURE = "public.ledger_append_own_october_model_session(jsonb,date,text)"


def literal(value):
    return "NULL" if value is None else "'" + str(value).replace("'", "''") + "'"


def json_literal(value):
    return literal(json.dumps(value)) + "::jsonb"


def digest(value):
    return "sha256:" + hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def series(kind):
    return dict(book="MODEL", bookId=PREFIX + kind, version=PREFIX[:-1],
                accountingStartDate="2026-10-05", policy=dict(kind=kind, market="US" if kind.startswith("US_") else "KR"),
                sourceHash=digest("frozen-source"), configHash=digest(kind + "config"),
                codeHash=digest("synthetic-code"), contractHash=digest(kind + "contract"))


def calendar(market, end):
    holidays = {"2026-10-05", "2026-10-09", "2026-12-25", "2026-12-31"} if market == "KR" else {"2026-11-26", "2026-12-25"}
    start, through = date(2026, 10, 5), date.fromisoformat(end)
    sessions = [(start + timedelta(days=i)).isoformat() for i in range((through - start).days + 1)
                if (start + timedelta(days=i)).weekday() < 5 and (start + timedelta(days=i)).isoformat() not in holidays]
    return dict(market=market, sourceHash=digest([market, end]), coverageStart="2026-10-05", coverageEnd=end, regularSessions=sessions)


def sign(run):
    body = {key: value for key, value in run["receipt"].items() if key != "runHash"}
    run["receipt"]["runHash"] = digest(body)
    run["stateHash"] = digest({key: value for key, value in run.items() if key != "stateHash"})
    return run


def next_kr_session(session):
    current = date.fromisoformat(session) + timedelta(days=1)
    holidays = {date(2026, 10, 9), date(2026, 12, 25), date(2026, 12, 31)}
    while current <= date(2026, 12, 31):
        if current.weekday() < 5 and current not in holidays:
            return current.isoformat()
        current += timedelta(days=1)
    return None


def run_for(spec, session, previous=None, coverage=None):
    market = spec["policy"]["market"]
    if market == "KR":
        next_session = next_kr_session(session)
        available_at = (next_session + "T08:00:00+09:00") if next_session else (session + "T23:59:59+09:00")
        decision_at = (next_session + "T08:10:00+09:00") if next_session else (session + "T23:59:59+09:00")
    else:
        close = "20:01:00" if session < "2026-11-01" else "21:01:00"
        decision = "20:02:00" if session < "2026-11-01" else "21:02:00"
        available_at = session + "T" + close + "Z"
        decision_at = session + "T" + decision + "Z"
    receipt = dict(book="MODEL", bookId=spec["bookId"], date=session,
                   contractHash=spec["contractHash"], codeHash=spec["codeHash"],
                   configHash=spec["configHash"], sourceHash=digest(["engine-input", session]))
    return sign(dict(book="MODEL", bookId=spec["bookId"], contractHash=spec["contractHash"], receipt=receipt,
                     previousStateHash=previous["stateHash"] if previous else None,
                     calendar=calendar(market, coverage or session),
                     publication=dict(version="october-manual-publication-v1", inputHash=digest(["input", session]),
                                      sourceHash=digest(["publication-source", session]),
                                      availableAt=available_at, decisionAt=decision_at),
                     result=dict(synthetic=True, cash="100000000")))


def call(run, previous=None, previous_date=None, previous_hash=None):
    if previous:
        previous_date, previous_hash = previous["receipt"]["date"], previous["stateHash"]
    return "SELECT public.ledger_append_own_october_model_session(" + ",".join([
        json_literal(run), literal(previous_date), literal(previous_hash)]) + ")"


class Suite:
    def __init__(self, binaries, port, env):
        self.base = [str(binaries / "psql"), "-X", "-qAt", "-h", "127.0.0.1", "-p", str(port),
                     "-U", "ledger_test_admin", "-v", "ON_ERROR_STOP=1"]
        self.env, self.passed = env, 0

    def sql(self, sql, role=None, user=None, database="cloudtrend_ledger_test", error=None):
        setup = "" if database == "postgres" else "SET statement_timeout='10s'; "
        if role:
            setup += f"SET ROLE {role}; "
        if user:
            setup += f"SET request.jwt.claim.sub={literal(user)}; "
        result = subprocess.run(self.base + ["-d", database, "-f", "-"], input=setup + sql,
                                capture_output=True, text=True, env=self.env, timeout=15)
        if error is not None:
            assert result.returncode != 0, "Expected SQL rejection"
            assert error in result.stderr, result.stderr
        else:
            assert result.returncode == 0, result.stderr
        return result.stdout.strip()

    def check(self, message):
        self.passed += 1
        print(f"PASS {self.passed:02d}: {message}", flush=True)

    def snapshot(self):
        return {table: self.sql(f"SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') FROM public.{table} t")
                for table in ["ledger_model_series", "ledger_model_sessions", "ledger_event_versions", "ledger_provenance_archive"]}

    def reject(self, statement, error="", role="authenticated", user=USER_A):
        before = self.snapshot()
        self.sql(statement, role, user, error=error)
        assert self.snapshot() == before, "Rejected action partially changed immutable journals"

    def record(self, run, previous=None, user=USER_A):
        return json.loads(self.sql(call(run, previous), "authenticated", user))

    def register(self, spec, user=USER_A):
        kind = spec["policy"]["kind"]
        role = "ALTERNATIVE_SHADOW" if kind in {"US_A2", "US_B3", "KR_KOSPI_CONFIRM1_BEAR"} else "ADOPTED_SHADOW"
        self.sql("INSERT INTO public.ledger_model_series(user_id,series_id,strategy_id,role,scheduled_start,config_hash,payload) VALUES (" + ",".join([
            literal(user), literal(spec["bookId"]), literal(kind), literal(role), "'2026-10-05'", literal(spec["configHash"]), json_literal(spec)]) + ")", "service_role")

    def race(self, book_id, requests, user=USER_C, artifact_source=None):
        """Hold the real per-owner/series lock and release blocked RPC calls together."""
        holder = subprocess.Popen(self.base + ["-d", "cloudtrend_ledger_test"], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=self.env)
        workers = []
        try:
            identity = user + (":OCTOBER_ARTIFACT:" + artifact_source if artifact_source else ":MODEL:" + book_id)
            lock = "SELECT pg_advisory_xact_lock(hashtextextended(" + literal(identity) + ",0))"
            holder.stdin.write("BEGIN; " + lock + "; SELECT 'ready';\n")
            holder.stdin.flush()
            while True:
                line = holder.stdout.readline()
                assert line, "Lock holder unexpectedly exited"
                if line.strip() == "ready":
                    break
            for i, request in enumerate(requests):
                setup = f"SET application_name='october-race-{i}'; SET ROLE authenticated; SET statement_timeout='10s'; SET request.jwt.claim.sub={literal(user)}; "
                workers.append(subprocess.Popen(self.base + ["-d", "cloudtrend_ledger_test", "-c", setup + request],
                                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=self.env))
            deadline = time.monotonic() + 5
            while int(self.sql("SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'october-race-%' AND wait_event_type='Lock'")) != len(workers):
                assert time.monotonic() < deadline, "Requests did not contend on the expected owner-series lock"
                time.sleep(0.02)
            holder.stdin.write("COMMIT;\n")
            holder.stdin.flush()
            outcomes = []
            for worker in workers:
                stdout, stderr = worker.communicate(timeout=15)
                outcomes.append((worker.returncode, stdout.strip(), stderr))
            return outcomes
        finally:
            for process in [holder] + workers:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=5)

    def clock(self, instant):
        """The test alone replaces one function initializer in its disposable DB."""
        marker = "v_now timestamptz := pg_catalog.statement_timestamp();"
        assert self.migration.count(marker) == 1
        owner_source = getattr(self, "timing_migration", self.migration)
        marker_name = "create or replace function public.ledger_append_own_october_model_session"
        if marker_name in owner_source:
            body = owner_source.split(marker_name, 1)[1].split("alter function", 1)[0]
            body = marker_name + body
        else:
            body = owner_source.split("create function public.ledger_append_own_october_model_session", 1)[1].split("alter function", 1)[0]
            body = "create or replace function public.ledger_append_own_october_model_session" + body
        body = body.replace(marker, "v_now timestamptz := " + literal(instant) + "::timestamptz;")
        self.sql(body)
        generic = self.migration.split("create or replace function public.ledger_append_model_session", 1)[1].split("create function public.ledger_append_own_october_model_session", 1)[0]
        generic = "create or replace function public.ledger_append_model_session" + generic
        marker = "v_artifact_now timestamptz := pg_catalog.statement_timestamp();"
        assert generic.count(marker) == 1
        self.sql(generic.replace(marker, "v_artifact_now timestamptz := " + literal(instant) + "::timestamptz;"))

    def application_fixtures(self):
        """Optional synthetic engine output, with hashes produced by TypeScript."""
        source = os.environ.get("CLOUDTREND_OCTOBER_APP_FIXTURES")
        if not source:
            return
        path = Path(source)
        assert path.stat().st_size <= 32 * 1024 * 1024, "Synthetic fixture file exceeds 32 MiB"
        fixtures = json.loads(path.read_text())
        assert set(fixtures) == {"series", "archives", "prepared", "preparedPayloadHashes"}
        assert len(fixtures["series"]) == 8
        assert len(fixtures["preparedPayloadHashes"]) == len(fixtures["prepared"])
        owned = {value["policy"]["kind"]: value for value in fixtures["series"]}
        assert set(owned) == set(KINDS)
        self.clock("2027-01-02T00:00:00Z")
        for value in fixtures["series"]:
            self.register(value, USER_E)

        def stage(payload, digest_value, kind, representative):
            registry = owned[representative]
            value = dict(book="MODEL", bookId=registry["bookId"], contractHash=registry["contractHash"],
                         publicationArtifact=dict(kind=kind, hash=digest_value, payload=payload))
            stored = json.loads(self.sql(call(value), "authenticated", USER_E))["artifact"]
            assert stored == payload, "TypeScript artifact changed during SQL staging/readback"
            return stored

        for archive in fixtures["archives"]:
            assert archive["date"] == archive["payload"]["date"]
            stage(archive["payload"], archive["hash"], "KR_DAILY_INPUT", "KR_MIXED")
        count = 0
        for prepared, payload_hash in zip(fixtures["prepared"], fixtures["preparedPayloadHashes"]):
            representative = "KR_MIXED" if prepared["market"] == "KR" else "US_A0"
            stored = stage(prepared, payload_hash, "PREPARED_PUBLICATION", representative)
            for entry in stored["entries"]:
                run = entry["run"]
                statement = call(run, previous_date=entry["previousDate"], previous_hash=entry["previousHash"])
                acknowledgement = json.loads(self.sql(statement, "authenticated", USER_E))
                assert acknowledgement == dict(reused=False, stateHash=run["stateHash"])
                readback = json.loads(self.sql("SELECT payload FROM public.ledger_model_sessions WHERE user_id=" + literal(USER_E)
                                              + " AND series_id=" + literal(run["bookId"]) + " AND session_date=" + literal(run["receipt"]["date"]), "authenticated", USER_E))
                assert readback == run, "Actual TypeScript engine run changed in SQL storage"
                assert json.loads(self.sql(statement, "authenticated", USER_E))["reused"] is True
                count += 1
        assert count >= 8
        self.check(f"Real TypeScript synthetic engine fixtures: {len(fixtures['archives'])} input archives, {len(fixtures['prepared'])} prepared publications and {count} exact owner-appended/retried runs")

    def run(self):
        self.sql("CREATE DATABASE cloudtrend_ledger_test", database="postgres")
        self.sql("""
          CREATE ROLE anon NOLOGIN;
          CREATE ROLE authenticated NOLOGIN;
          CREATE ROLE service_role NOLOGIN BYPASSRLS;
          CREATE ROLE postgres NOLOGIN SUPERUSER;
          CREATE SCHEMA auth;
          CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
            SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
          $$;
          CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
            SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}')
          $$;
          GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
          GRANT EXECUTE ON FUNCTION auth.uid(),auth.jwt() TO anon,authenticated,service_role;
        """)
        self.sql((ROOT / "docs/ledger-foundation.sql").read_text())
        migrations = list((ROOT / "supabase/migrations").glob("*_owner_october_shadow_append.sql"))
        assert len(migrations) == 1
        self.migration = migrations[0].read_text()
        self.sql(self.migration, error="Reviewed postgres-owned model append prerequisite missing")
        assert self.sql("SELECT to_regprocedure(" + literal(SIGNATURE) + ") IS NULL") == "t"
        self.sql("ALTER FUNCTION public.ledger_append_model_session(uuid,jsonb,jsonb,date,text) OWNER TO postgres")
        catalog = "SELECT jsonb_agg(jsonb_build_object('table',c.relname,'acl',c.relacl,'rls',c.relrowsecurity,'policies',(select jsonb_agg(to_jsonb(p)) from pg_policy p where p.polrelid=c.oid),'triggers',(select jsonb_agg(to_jsonb(t)) from pg_trigger t where t.tgrelid=c.oid)) order by c.relname) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'"
        before_catalog = self.sql(catalog)
        generic_acl = self.sql("SELECT proacl FROM pg_proc WHERE oid='public.ledger_append_model_session(uuid,jsonb,jsonb,date,text)'::regprocedure")
        self.sql(self.migration)
        assert self.sql("SELECT proacl FROM pg_proc WHERE oid='public.ledger_append_model_session(uuid,jsonb,jsonb,date,text)'::regprocedure") == generic_acl
        original = (ROOT / "docs/ledger-foundation.sql").read_text().split("  if p_user_id is null or v_series is null or v_date is null", 1)[1].split("revoke all on function public.ledger_append_model_session", 1)[0]
        retained = self.migration.split("  if p_user_id is null or v_series is null or v_date is null", 1)[1].split("create function public.ledger_append_own_october_model_session", 1)[0]
        assert retained.strip() == original.strip(), "Normal service append behavior must be preserved verbatim"
        assert self.sql(catalog) == before_catalog
        assert self.sql("SELECT prosecdef::text || ':' || pg_get_userbyid(proowner) || ':' || proconfig[1] FROM pg_proc WHERE oid=" + literal(SIGNATURE) + "::regprocedure") == 'true:postgres:search_path=""'
        timing_migrations = list((ROOT / "supabase/migrations").glob("*_kr_shadow_next_morning.sql"))
        assert len(timing_migrations) == 1
        self.timing_migration = timing_migrations[0].read_text()
        self.sql(self.timing_migration)
        assert self.sql(catalog) == before_catalog
        assert self.sql("SELECT prosecdef::text || ':' || pg_get_userbyid(proowner) || ':' || proconfig[1] FROM pg_proc WHERE oid=" + literal(SIGNATURE) + "::regprocedure") == 'true:postgres:search_path=""'
        self.check("Migration fails closed on changed prerequisite; timing update preserves postgres ownership, ACLs, tables, RLS and triggers")

        specs = {kind: series(kind) for kind in KINDS}
        for spec in specs.values():
            self.register(spec)
        spec, first = specs["US_A0"], run_for(specs["US_A0"], "2026-10-05")
        for role in ["anon", "service_role"]:
            self.reject(call(first), "permission denied", role=role)
        self.reject(call(first), "Authenticated non-anonymous model owner", user=None)
        self.reject("SET request.jwt.claims='{" + '"is_anonymous":true' + "}'; " + call(first), "Authenticated non-anonymous")
        self.reject(call(first), "Existing owner October registry required", user=USER_B)
        for role in ["anon", "authenticated", "service_role"]:
            expected = "t" if role == "authenticated" else "f"
            assert self.sql(f"SELECT has_function_privilege({literal(role)},{literal(SIGNATURE)},'EXECUTE')") == expected
        self.check("Anonymous, missing JWT, anonymous-signin, cross-owner and unregistered-owner writes are blocked; only authenticated has EXECUTE")

        # Unmodified production-clock guard must reject a definitely future date.
        future = run_for(spec, "2999-01-04")
        future["calendar"] = calendar("US", "2026-10-05")
        self.reject(call(future), "in the future")
        self.clock("2026-10-12T22:00:00Z")
        for bad_id in ["ACTUAL", "historic-model", PREFIX + "US_A1", PREFIX + "US_A0:extra", PREFIX + "KR_KOSPI_CONFIRM1"]:
            bad = copy.deepcopy(first)
            bad["bookId"] = bad_id
            self.reject(call(bad), "Only the eight")
        bad = copy.deepcopy(first)
        bad["book"] = "ACTUAL"
        self.reject(call(bad), "Only the eight")
        self.check("Production clock rejects future data; ACTUAL, historical and non-allowlisted series cannot enter the owner RPC")

        for path in [["contractHash"], ["receipt", "contractHash"], ["receipt", "configHash"], ["receipt", "codeHash"], ["receipt", "bookId"], ["receipt", "book"]]:
            bad = copy.deepcopy(first)
            target = bad
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = digest("tampered")
            self.reject(call(bad), "identity mismatch")
        for path in [["stateHash"], ["receipt", "sourceHash"], ["receipt", "runHash"], ["calendar", "sourceHash"], ["publication", "sourceHash"], ["publication", "inputHash"]]:
            bad = copy.deepcopy(first)
            target = bad
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = "bad-digest"
            self.reject(call(bad), "provenance hash")
        bad = copy.deepcopy(first)
        bad["receipt"]["sourceHash"] = digest("changed-source-without-new-receipt")
        self.reject(call(bad), "receipt hash mismatch")
        bad = copy.deepcopy(first)
        bad["receipt"]["extra"] = "forbidden"
        self.reject(call(bad), "receipt fields")
        self.check("Frozen contract/code/config/book identity, every required hash syntax and independent string-only receipt digest are enforced")

        for session in ["2026-10-02", "2026-10-13"]:
            self.reject(call(run_for(spec, session)), "before first regular close or in the future")
        self.reject(call(run_for(spec, "2026-10-06")), "cannot skip")
        for session in ["2026-10-05", "2026-10-09", "2026-10-10"]:
            self.reject(call(run_for(specs["KR_KOSPI"], session)))
        self.check("First US session is Oct 5, first KR session is Oct 6; prestart/future/weekend/KR holidays are refused")

        for mutate in [
            lambda r: r["calendar"]["regularSessions"].clear(),
            lambda r: r["calendar"]["regularSessions"].append("2026-10-05"),
            lambda r: r["calendar"].update(market="KR"),
            lambda r: r["calendar"].update(coverageStart="2026-10-06"),
            lambda r: r["calendar"].update(coverageEnd="2027-01-01"),
        ]:
            bad = copy.deepcopy(first)
            mutate(bad)
            self.reject(call(bad))
        self.check("Reviewed calendar completeness, duplicate dates, market, start and bounded Q4 coverage are validated server-side")

        for change in [dict(availableAt="2026-10-05T19:59:59Z"), dict(decisionAt="2026-10-05T20:00:00Z"),
                       dict(decisionAt="2026-10-06T20:02:00Z"), dict(availableAt="2026-10-04T20:01:00Z"),
                       dict(availableAt="2026-10-05T20:01:00"), dict(version="unrecognized")]:
            bad = copy.deepcopy(first)
            bad["publication"].update(change)
            self.reject(call(bad))
        self.clock("2026-10-05T20:01:30Z")
        self.reject(call(first), "not be future")
        self.clock("2026-10-05T20:03:00Z")
        assert self.record(first) == dict(reused=False, stateHash=first["stateHash"])
        assert self.record(first)["reused"] is True
        self.check("Same-session post-close source <= decision <= current time; valid first append and exact same-day retry succeed")

        kr_first = run_for(specs["KR_KOSPI"], "2026-10-06")
        same_evening = copy.deepcopy(kr_first)
        same_evening["publication"]["availableAt"] = "2026-10-06T20:00:00+09:00"
        same_evening["publication"]["decisionAt"] = "2026-10-06T20:10:00+09:00"
        self.clock("2026-10-07T08:20:00+09:00")
        self.reject(call(same_evening), "next regular-session morning refresh")
        after_open = copy.deepcopy(kr_first)
        after_open["publication"]["decisionAt"] = "2026-10-07T09:01:00+09:00"
        self.reject(call(after_open), "next regular-session morning refresh")
        assert self.record(kr_first) == dict(reused=False, stateHash=kr_first["stateHash"])
        assert self.record(kr_first)["reused"] is True
        self.check("KR same-evening publication is preview-only; next-session 08:xx KST succeeds and post-open decisions fail")

        altered = copy.deepcopy(first)
        altered["result"]["cash"] = "999"
        sign(altered)
        self.reject(call(altered), "Immutable October model date conflict")
        self.reject(call(first, previous_date="2026-10-02", previous_hash=None), "predecessor")
        self.clock("2026-10-12T22:00:00Z")
        second = run_for(spec, "2026-10-06", first)
        assert self.record(second, first)["reused"] is False
        assert self.record(first)["reused"] is True
        self.reject(call(run_for(spec, "2026-10-08", second), second), "cannot skip")
        removed = run_for(spec, "2026-10-08", second)
        removed["calendar"]["regularSessions"].remove("2026-10-07")
        self.reject(call(sign(removed), second), "calendar is incomplete")
        stale = run_for(spec, "2026-10-07", first)
        self.reject(call(stale, first), "predecessor/head conflict")
        self.check("Changed same-day body cannot overwrite; exact old retries survive newer heads; missing sessions and stale predecessors are refused")

        # No new decision is stamped by recovery: this exact Oct 5 prepared run is
        # appended for a still-empty owner series on Oct 12 with original evidence.
        recovery = run_for(specs["US_A2"], "2026-10-05")
        assert self.record(recovery)["reused"] is False
        stored = json.loads(self.sql("SELECT payload FROM public.ledger_model_sessions WHERE series_id=" + literal(recovery["bookId"]), "authenticated", USER_A))
        assert stored == recovery and stored["publication"]["decisionAt"] == "2026-10-05T20:02:00Z"
        self.check("A previously prepared original decision can be appended after the session, without relabeling date or decision evidence")

        for kind in KINDS:
            if kind in ["US_A0", "US_A2"]:
                continue
            initial = run_for(specs[kind], "2026-10-05" if kind.startswith("US_") else "2026-10-06")
            assert self.record(initial)["reused"] is False
        assert self.sql("SELECT count(distinct series_id) FROM public.ledger_model_sessions") == "8"
        self.register(spec, USER_B)
        assert self.record(first, user=USER_B)["reused"] is False
        assert self.sql("SELECT count(*) FROM public.ledger_model_sessions WHERE user_id=" + literal(USER_A), "authenticated", USER_B) == "0"
        self.check("All eight exact books append; identical book ID under another owner remains a separate RLS-isolated journal")

        # A prior full-quarter calendar cannot silently shrink on the next run.
        wide_spec = specs["US_B3"]
        self.register(wide_spec, USER_C)
        wide = run_for(wide_spec, "2026-10-05", coverage="2026-12-31")
        self.record(wide, user=USER_C)
        small = run_for(wide_spec, "2026-10-06", wide)
        self.reject(call(small, wide), "calendar coverage changed", user=USER_C)
        self.check("Prior calendar overlap and coverage cannot be rewritten or shrunk")

        race_spec = specs["US_A2"]
        self.register(race_spec, USER_C)
        race_first = run_for(race_spec, "2026-10-05")
        outcomes = self.race(race_spec["bookId"], [call(race_first)] * 2)
        assert all(result[0] == 0 for result in outcomes), outcomes
        assert sorted(json.loads(result[1])["reused"] for result in outcomes) == [False, True]
        next_run = run_for(race_spec, "2026-10-06", race_first)
        conflict = copy.deepcopy(next_run)
        conflict["result"]["cash"] = "888"
        sign(conflict)
        outcomes = self.race(race_spec["bookId"], [call(next_run, race_first), call(conflict, race_first)])
        assert sorted(result[0] for result in outcomes) == [0, 1], outcomes
        assert any("Immutable October model date conflict" in result[2] for result in outcomes)
        self.check("Truly concurrent owner RPC calls share the existing series lock: identical append/reuse and one winner on conflicting payloads")

        # Exercise continuity against an existing privileged-writer record whose
        # calendar was incomplete. A new owner call must not perpetuate that gap.
        old_spec = specs["US_A0"]
        self.register(old_spec, USER_C)
        old = run_for(old_spec, "2026-10-05")
        old["calendar"]["regularSessions"] = []
        sign(old)
        self.sql("SELECT public.ledger_append_model_session(" + ",".join([literal(USER_C), json_literal(old_spec), json_literal(old), "NULL", "NULL"]) + ")", "service_role")
        valid_next = run_for(old_spec, "2026-10-06", old)
        self.reject(call(valid_next, old), "calendar coverage changed", user=USER_C)
        self.check("A newly correct calendar cannot silently rewrite incompatible overlap in an earlier privileged-writer record")

        self.clock("2026-12-31T23:00:00Z")
        for market_kind, session in [("KR_KOSPI", "2026-11-19"), ("KR_KOSPI", "2026-12-25"), ("US_A0", "2026-11-26"), ("US_A0", "2026-12-25")]:
            self.reject(call(run_for(specs[market_kind], session)))
        # Time checks are evaluated before head checks; passing this check reaches
        # predecessor conflict. Early US close is 13:00 New York (18:00 UTC).
        early = run_for(spec, "2026-11-27")
        early["publication"].update(availableAt="2026-11-27T17:59:59Z", decisionAt="2026-11-27T18:02:00Z")
        self.reject(call(early), "same-session regular close")
        early["publication"]["availableAt"] = "2026-11-27T18:01:00Z"
        self.reject(call(early), "predecessor/head conflict")
        self.check("KR pending special hours fail closed; Q4 holidays and US early-close/New York timezone are enforced")

        self.clock("2026-10-12T22:00:00Z")
        for owned in specs.values():
            self.register(owned, USER_D)
        daily = dict(version="kr-daily-inputs-v1", date="2026-10-06", inputs=dict(
            snapshots=[dict(date="2026-10-06", asOfDate="2026-10-06", savedAt="2026-10-06T06:32:00Z",
                            entries=[dict(symbol="005930", instrumentType="STOCK", name="Synthetic stock")])],
            bars={"005930": [dict(tradeDate="2026-10-06", open=100, high=102, low=99, close=101, volume=123)]},
            markets={"005930": "KOSPI"}, marketGates={}))

        def envelope(payload, kind, book="KR_MIXED", value_hash=None):
            return dict(book="MODEL", bookId=specs[book]["bookId"], contractHash=specs[book]["contractHash"],
                        publicationArtifact=dict(kind=kind, hash=value_hash or digest(payload), payload=copy.deepcopy(payload)))

        def stage(value, user=USER_D, service=False):
            statement = call(value)
            if service:
                own = specs[value["bookId"].split(":")[1]]
                statement = "SELECT public.ledger_append_model_session(" + ",".join([literal(user), json_literal(own), json_literal(value), "NULL", "NULL"]) + ")"
            return json.loads(self.sql(statement, "service_role" if service else "authenticated", user))["artifact"]

        daily_envelope = envelope(daily, "KR_DAILY_INPUT")
        assert stage(daily_envelope) == daily
        assert stage(daily_envelope) == daily
        assert stage(daily_envelope, service=True) == daily
        input_id = "october-input:KR:2026-10-06:" + digest(daily)[7:]
        assert self.sql("SELECT count(*) FROM public.ledger_provenance_archive WHERE user_id=" + literal(USER_D) + " AND source_id=" + literal(input_id)) == "1"
        changed = copy.deepcopy(daily_envelope)
        changed["publicationArtifact"]["payload"]["inputs"]["bars"]["005930"][0]["close"] = 999
        self.reject(call(changed), "Immutable October daily input conflict", user=USER_D)
        self.check("Bounded KR daily input stages once, reuses exactly via owner and unchanged service RPC, and rejects same-hash payload substitution")
        raced_day = copy.deepcopy(daily)
        raced_day["date"] = "2026-10-07"
        raced_day["inputs"]["snapshots"][0].update(date="2026-10-07", asOfDate="2026-10-07", savedAt="2026-10-07T06:32:00Z")
        raced_day["inputs"]["bars"]["005930"][0]["tradeDate"] = "2026-10-07"
        raced_id = "october-input:KR:2026-10-07:" + digest(raced_day)[7:]
        outcomes = self.race(specs["KR_MIXED"]["bookId"], [
            call(envelope(raced_day, "KR_DAILY_INPUT", "KR_MIXED")),
            call(envelope(raced_day, "KR_DAILY_INPUT", "KR_KOSPI")),
        ], user=USER_D, artifact_source=raced_id)
        assert all(result[0] == 0 and json.loads(result[1])["artifact"] == raced_day for result in outcomes), outcomes
        assert self.sql("SELECT count(*) FROM public.ledger_provenance_archive WHERE user_id=" + literal(USER_D) + " AND source_id=" + literal(raced_id)) == "1"
        self.check("Different representative books serialize on one owner/source artifact lock and archive the concurrent daily input exactly once")

        self.reject(call(daily_envelope), "permission denied", role="anon", user=USER_D)
        self.reject(call(daily_envelope), "Authenticated non-anonymous", user=None)
        self.reject(call(daily_envelope), "Existing owner October registry", user=USER_B)
        assert self.sql("SELECT count(*) FROM public.ledger_provenance_archive WHERE user_id=" + literal(USER_D), "authenticated", USER_B) == "0"
        for key, value in [("book", "ACTUAL"), ("bookId", "old-model"), ("contractHash", digest("wrong")), ("sourceId", "private/path")]:
            bad = copy.deepcopy(daily_envelope)
            bad[key] = value
            self.reject(call(bad), user=USER_D)
        for mutation in [
            lambda a: a["publicationArtifact"].update(kind="ARBITRARY_FILE"),
            lambda a: a["publicationArtifact"]["payload"].update(extra="secret-like generic data"),
            lambda a: a["publicationArtifact"]["payload"].update(date="2026-10-13"),
            lambda a: a["publicationArtifact"]["payload"]["inputs"]["snapshots"].append({}),
            lambda a: a["publicationArtifact"]["payload"]["inputs"]["bars"]["005930"].append({"tradeDate":"2026-10-05"}),
            lambda a: a["publicationArtifact"]["payload"]["inputs"]["markets"].update({"005930":"US"}),
        ]:
            bad = copy.deepcopy(daily_envelope)
            mutation(bad)
            self.reject(call(bad), user=USER_D)
        oversized = copy.deepcopy(daily_envelope)
        oversized["publicationArtifact"]["payload"]["inputs"]["snapshots"][0]["entries"][0]["name"] = "x" * 16777216
        self.reject(call(oversized), "bounded October artifact envelope", user=USER_D)
        self.check("Artifact writes reject anonymous/cross-owner/ACTUAL/old/unregistered/arbitrary-path/schema/future/multiday/oversize requests, while archive SELECT remains owner-isolated")

        def prepared(market):
            session = "2026-10-05" if market == "US" else "2026-10-06"
            kinds = ["US_A0", "US_A2", "US_B3"] if market == "US" else ["KR_MIXED", "KR_KOSPI", "KR_KOSDAQ", "ETF_V02", "KR_KOSPI_CONFIRM1_BEAR"]
            entries = []
            for kind in kinds:
                value = run_for(specs[kind], session)
                if kind in ["KR_MIXED", "KR_KOSPI", "KR_KOSDAQ"]:
                    value.update(frozenInputs=dict(snapshots=[], bars={}, markets={}, marketGates={}),
                                 frozenInputArchive=dict(version="kr-daily-inputs-v1", days=[dict(date=session, hash=digest(daily))], prefixHash=digest(daily["inputs"])))
                    sign(value)
                entries.append(dict(series=specs[kind], run=value, previousDate=None, previousHash=None))
            first_run = entries[0]["run"]
            result = dict(version="october-prepared-publication-v1", market=market, date=session,
                          sourceHash=first_run["publication"]["sourceHash"], codeHash=first_run["receipt"]["codeHash"],
                          inputHash=first_run["publication"]["inputHash"], preparedAt=first_run["publication"]["decisionAt"], entries=entries)
            result["preparedHash"] = digest(result)
            return result

        kr_prepared, us_prepared = prepared("KR"), prepared("US")
        assert stage(envelope(kr_prepared, "PREPARED_PUBLICATION")) == kr_prepared
        assert stage(envelope(us_prepared, "PREPARED_PUBLICATION", "US_A0"), service=True) == us_prepared
        retried = copy.deepcopy(kr_prepared)
        retried["preparedAt"] = "2026-10-12T06:32:00Z"
        retried["preparedHash"] = digest({key:value for key,value in retried.items() if key != "preparedHash"})
        assert stage(envelope(retried, "PREPARED_PUBLICATION")) == kr_prepared
        changed = copy.deepcopy(kr_prepared)
        changed["inputHash"] = digest("changed-input")
        for entry in changed["entries"]:
            entry["run"]["publication"]["inputHash"] = changed["inputHash"]
            sign(entry["run"])
        self.reject(call(envelope(changed, "PREPARED_PUBLICATION")), "Immutable prepared October input conflict", user=USER_D)
        for payload in [kr_prepared, us_prepared]:
            for entry in payload["entries"]:
                assert self.record(entry["run"], user=USER_D)["reused"] is False
        self.check("Prepared KR/US artifacts stage complete owner-bound sets; same input identity returns the original decision; changed input conflicts; all eight stored runs append successfully")

        for mutation in [
            lambda p: p["entries"].pop(),
            lambda p: p["entries"].reverse(),
            lambda p: p["entries"][0]["series"].update(codeHash=digest("different-registry")),
            lambda p: p["entries"][0]["run"].update(book="ACTUAL"),
            lambda p: p["entries"][0]["run"].update(privatePath="arbitrary"),
            lambda p: p["entries"][0]["run"]["frozenInputArchive"]["days"][0].update(hash=digest("missing-input")),
            lambda p: p.update(preparedAt="2026-10-13T06:32:00Z"),
        ]:
            bad = copy.deepcopy(kr_prepared)
            mutation(bad)
            self.reject(call(envelope(bad, "PREPARED_PUBLICATION")), user=USER_D)
        self.reject(call(envelope(us_prepared, "PREPARED_PUBLICATION", "US_A0")), "owner registry identity mismatch", user=USER_B)
        self.reject(call(daily_envelope, previous_date="2026-10-05", previous_hash=digest("wrong")), "artifact envelope", user=USER_D)
        assert self.sql("SELECT proacl FROM pg_proc WHERE oid='public.ledger_append_model_session(uuid,jsonb,jsonb,date,text)'::regprocedure") == generic_acl
        self.check("Incomplete/reordered/foreign-registry/prepared ACTUAL/extra-field/missing-input/future/predecessor artifacts are refused; service RPC ACL remains unchanged")

        for table in ["ledger_model_series", "ledger_model_sessions", "ledger_event_versions", "ledger_provenance_archive"]:
            for statement in [f"UPDATE public.{table} SET user_id=user_id", f"DELETE FROM public.{table}",
                              f"TRUNCATE public.{table}", f"INSERT INTO public.{table} SELECT * FROM public.{table}"]:
                self.reject(statement, "permission denied")
        self.reject("SELECT public.ledger_append_model_session(" + ",".join([literal(USER_A), json_literal(spec), json_literal(first), "NULL", "NULL"]) + ")", "permission denied")
        self.sql("UPDATE public.ledger_model_sessions SET state_hash=state_hash", error="append-only")
        assert self.sql("SELECT count(*) FROM public.ledger_event_versions") == "0"
        assert self.sql(catalog) == before_catalog
        self.check("No direct registry/session/ACTUAL insert/update/delete/truncate or service RPC grant; immutable triggers and RLS remain unchanged")
        self.application_fixtures()
        print(f"\nAll {self.passed} October PostgreSQL integration groups passed", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    default_psql = shutil.which("psql")
    parser.add_argument("--pg-bin-dir", type=Path,
                        default=Path(default_psql).parent if default_psql else None)
    parser.add_argument("--pg-share-dir", type=Path)
    args = parser.parse_args()
    if not args.pg_bin_dir:
        parser.error("PostgreSQL binaries missing; provide --pg-bin-dir")
    for name in ["initdb", "postgres", "psql"]:
        if not (args.pg_bin_dir / name).is_file():
            parser.error(f"Missing {args.pg_bin_dir / name}")
    env = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
    env.update(PGCONNECT_TIMEOUT="2", LC_ALL="C")
    with tempfile.TemporaryDirectory(prefix="cloudtrend-ledger-postgres-") as temporary:
        directory = Path(temporary)
        data = directory / "data"
        command = [str(args.pg_bin_dir / "initdb"), "-D", str(data), "-U", "ledger_test_admin",
                   "--auth=trust", "--no-locale", "-E", "UTF8"]
        if args.pg_share_dir:
            command += ["-L", str(args.pg_share_dir)]
        subprocess.run(command, check=True, capture_output=True, text=True, env=env, timeout=30)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        with (directory / "postgres.log").open("w+") as log:
            server = subprocess.Popen([str(args.pg_bin_dir / "postgres"), "-D", str(data),
                                       "-h", "127.0.0.1", "-p", str(port), "-k", ""],
                                      stdout=log, stderr=log, env=env)
            try:
                suite = Suite(args.pg_bin_dir, port, env)
                deadline = time.monotonic() + 15
                while True:
                    result = subprocess.run(suite.base + ["-d", "postgres", "-c", "SELECT version()"],
                                            capture_output=True, text=True, env=env, timeout=5)
                    if result.returncode == 0:
                        print(result.stdout.strip(), flush=True)
                        break
                    assert server.poll() is None and time.monotonic() < deadline, result.stderr
                    time.sleep(0.05)
                suite.run()
            except Exception:
                log.seek(0)
                print("\nDisposable PostgreSQL server log (last 6000 characters):\n" + log.read()[-6000:])
                raise
            finally:
                if server.poll() is None:
                    server.terminate()
                    try:
                        server.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        server.kill()
                        server.wait()


if __name__ == "__main__":
    main()
