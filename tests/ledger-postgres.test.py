#!/usr/bin/env python3
"""Execute the ledger draft on an isolated, disposable PostgreSQL cluster.

Requires local PostgreSQL server/client binaries; no Python packages are needed.
Example: python3 tests/ledger-postgres.test.py --pg-bin-dir /path/to/bin \
           --pg-share-dir /path/to/share/postgresql/17

Always initializes a fresh temporary cluster and database cloudtrend_ledger_test.
Never accepts a connection URL, existing data directory, or non-loopback host.
All fixtures are synthetic. No Supabase production connection is made.
"""

import argparse
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
HASH = "sha256:" + "1" * 64
HASH_2 = "sha256:" + "2" * 64
TABLES = [
    "ledger_security_versions", "ledger_event_sources", "ledger_event_versions",
    "ledger_evidence_refs", "ledger_reconciliation_log", "ledger_valuation_versions",
    "ledger_model_series", "ledger_model_sessions", "ledger_recording_log",
    "ledger_provenance_archive",
]


def literal(value):
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def json_literal(value):
    return "NULL" if value is None else literal(json.dumps(value)) + "::jsonb"


def event(name, revision=1, **updates):
    value = {
        "id": name, "book": "ACTUAL", "bookId": "ACTUAL", "revision": revision,
        "effectiveDate": "2026-10-01", "kind": "DEPOSIT",
        "recordedAt": "2026-10-02T00:00:00Z",
        "source": {"system": "synthetic", "recordId": name, "revision": str(revision),
                   "contentHash": HASH},
    }
    if revision > 1:
        value.update(previousRevision=revision - 1, correctionReason="Synthetic correction")
    value.update(updates)
    return value


def recording(value):
    return {
        "key": f"RECEIPT:{value['id']}:{value['revision']}",
        "requestRef": "synthetic-request", "eventId": value["id"],
        "eventRevision": value["revision"], "sourceHash": value["source"]["contentHash"],
        "status": "PENDING",
    }


def event_call(value, expected=None, task=None, user=USER_A):
    if expected is None:
        expected = value["revision"] - 1
    return ("SELECT public.ledger_append_reviewed_event("
            f"{literal(user)}, {expected}, {json_literal(value)}, {json_literal(task)});")


def series(name):
    return {"bookId": name, "accountingStartDate": "2026-10-05", "configHash": HASH,
            "codeHash": HASH, "contractHash": HASH, "policy": {"kind": "SYNTHETIC"}}


def model_run(spec, date, previous_hash=None, state_hash=HASH):
    return {"book": "MODEL", "bookId": spec["bookId"], "contractHash": HASH,
            "previousStateHash": previous_hash, "stateHash": state_hash,
            "receipt": {"date": date, "codeHash": HASH, "configHash": HASH}}


def model_call(spec, run, previous_date=None, previous_hash=None, user=USER_A):
    return ("SELECT public.ledger_append_model_session("
            f"{literal(user)}, {json_literal(spec)}, {json_literal(run)}, "
            f"{literal(previous_date)}, {literal(previous_hash)});")


class Suite:
    def __init__(self, binaries, port, env):
        self.base = [str(binaries / "psql"), "-X", "-qAt", "-h", "127.0.0.1",
                     "-p", str(port), "-U", "ledger_test_admin", "-v", "ON_ERROR_STOP=1"]
        self.env = env
        self.passed = 0

    def sql(self, sql, role=None, user=None, database="cloudtrend_ledger_test", error=None):
        setup = "" if database == "postgres" else "SET statement_timeout = '10s'; "
        if role:
            setup += f"SET ROLE {role}; "
        if user:
            setup += f"SET request.jwt.claim.sub = {literal(user)}; "
        result = subprocess.run(self.base + ["-d", database, "-c", setup + sql],
                                capture_output=True, text=True, env=self.env, timeout=15)
        if error is not None:
            assert result.returncode != 0, f"Expected rejection: {sql}"
            assert error in result.stderr, result.stderr
        else:
            assert result.returncode == 0, result.stderr
        return result.stdout.strip()

    def check(self, name):
        self.passed += 1
        print(f"PASS {self.passed:02d}: {name}", flush=True)

    def count(self, table, where="true"):
        return int(self.sql(f"SELECT count(*) FROM public.{table} WHERE {where}"))

    def rpc(self, sql):
        return json.loads(self.sql(sql, role="service_role"))

    def race(self, lock, requests):
        """Release truly blocked SQL sessions together; fail if contention is absent."""
        holder = subprocess.Popen(self.base + ["-d", "cloudtrend_ledger_test"],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True, env=self.env)
        workers = []
        try:
            holder.stdin.write(f"BEGIN; {lock}; SELECT 'ready';\n")
            holder.stdin.flush()
            while True:
                line = holder.stdout.readline()
                assert line, "Lock holder exited unexpectedly"
                if line.strip() == "ready":
                    break
            for i, request in enumerate(requests):
                sql = (f"SET application_name = 'ledger-race-{i}'; SET ROLE service_role; "
                       "SET statement_timeout = '10s'; " + request)
                workers.append(subprocess.Popen(
                    self.base + ["-d", "cloudtrend_ledger_test", "-c", sql],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=self.env))
            deadline = time.monotonic() + 5
            while True:
                waiting = int(self.sql("SELECT count(*) FROM pg_stat_activity WHERE "
                                       "application_name LIKE 'ledger-race-%' AND wait_event_type = 'Lock'"))
                if waiting == len(requests):
                    break
                assert time.monotonic() < deadline, "Workers did not all reach a real lock wait"
                time.sleep(0.03)
            holder.stdin.write("COMMIT;\n\\q\n")
            holder.stdin.flush()
            holder.wait(timeout=5)
            outcomes = []
            for worker in workers:
                stdout, stderr = worker.communicate(timeout=15)
                outcomes.append((worker.returncode, stdout.strip(), stderr))
            return outcomes
        finally:
            for process in [holder, *workers]:
                if process.poll() is None:
                    process.kill()
                    process.wait()

    @staticmethod
    def event_lock(name):
        identity = f"{USER_A}:ACTUAL:ACTUAL:{name}"
        return f"SELECT pg_advisory_xact_lock(hashtextextended({literal(identity)}, 0))"

    @staticmethod
    def model_lock(name):
        identity = f"{USER_A}:MODEL:{name}"
        return f"SELECT pg_advisory_xact_lock(hashtextextended({literal(identity)}, 0))"

    def run(self):
        self.sql("CREATE DATABASE cloudtrend_ledger_test", database="postgres")
        self.sql("""
            CREATE ROLE anon NOLOGIN;
            CREATE ROLE authenticated NOLOGIN;
            CREATE ROLE service_role NOLOGIN BYPASSRLS;
            CREATE SCHEMA auth;
            CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
              SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
            $$;
            GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
            GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
        """)
        self.sql((ROOT / "docs/ledger-foundation.sql").read_text())
        assert self.sql("SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace "
                        "AND relkind='r' AND relrowsecurity") == "10"
        assert self.sql("SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace "
                        "AND proname LIKE 'ledger_%' AND prosecdef") == "0"
        self.check("DDL executes; all 10 tables have RLS; all 4 functions are SECURITY INVOKER")

        for user in [USER_A, USER_B]:
            value = event("owner-event")
            self.rpc(event_call(value, task=recording(value), user=user))
            spec = series("owner-model")
            self.rpc(model_call(spec, model_run(spec, "2026-10-05"), user=user))
            self.sql(f"""
                INSERT INTO public.ledger_security_versions VALUES
                  ({literal(user)},'synthetic-security',1,'005930','KOSPI','KRW','{{}}',now());
                INSERT INTO public.ledger_evidence_refs VALUES
                  ({literal(user)},'synthetic-evidence',1,'synthetic://receipt',NULL,'{{}}',now());
                INSERT INTO public.ledger_reconciliation_log VALUES
                  ({literal(user)},'synthetic-reconciliation',1,'PENDING','test','test','{{}}',now());
                INSERT INTO public.ledger_valuation_versions VALUES
                  ({literal(user)},'ACTUAL','ACTUAL','2026-10-01',1,{literal(HASH)},'{{}}',now());
                INSERT INTO public.ledger_provenance_archive VALUES
                  ({literal(user)},'synthetic-source','1',{literal(HASH)},'{{}}',now());
            """, role="service_role")

        for table in TABLES:
            for user in [USER_A, USER_B]:
                rows = self.sql(f"SELECT user_id FROM public.{table}", role="authenticated", user=user)
                assert rows == user, (table, rows)
            assert self.sql(f"SELECT count(*) FROM public.{table}", role="authenticated") == "0"
            self.sql(f"SELECT * FROM public.{table}", role="anon", error="permission denied")
        self.check("Owner SELECT, other-user isolation, null JWT isolation and anon denial on all 10 tables")
        assert len(json.loads(self.sql(f"SELECT public.ledger_read_events('{USER_A}','ACTUAL','ACTUAL')",
                                       role="authenticated", user=USER_A))) == 1
        assert json.loads(self.sql(f"SELECT public.ledger_read_events('{USER_B}','ACTUAL','ACTUAL')",
                                   role="authenticated", user=USER_A)) == []
        self.sql(f"SELECT public.ledger_read_events('{USER_A}','ACTUAL','ACTUAL')",
                 role="anon", error="permission denied for function")
        self.check("Read RPC enforces ownership even with a forged other-user parameter")

        for table in TABLES:
            for command in [f"INSERT INTO public.{table} SELECT * FROM public.{table} LIMIT 1",
                            f"UPDATE public.{table} SET user_id=user_id",
                            f"DELETE FROM public.{table}", f"TRUNCATE public.{table}"]:
                self.sql(command, role="authenticated", user=USER_A, error="permission denied")
            for command in [f"UPDATE public.{table} SET user_id=user_id", f"DELETE FROM public.{table}",
                            f"TRUNCATE public.{table}"]:
                self.sql(command, role="service_role", error="permission denied")
        for role in ["anon", "authenticated"]:
            self.sql(event_call(event("forbidden")), role=role, user=USER_A,
                     error="permission denied for function")
            spec = series("forbidden")
            self.sql(model_call(spec, model_run(spec, "2026-10-05")), role=role, user=USER_A,
                     error="permission denied for function")
        self.check("Client writes and append RPCs denied; service role cannot UPDATE, DELETE or TRUNCATE")
        for table in TABLES:
            self.sql(f"UPDATE public.{table} SET user_id=user_id", error="Ledger history is append-only")
            self.sql(f"DELETE FROM public.{table}", error="Ledger history is append-only")
        self.check("Immutable trigger rejects UPDATE/DELETE even for table owner on all 10 tables")

        value = event("atomic-event")
        task = recording(value)
        assert self.rpc(event_call(value, task=task)) == {"reused": False, "revision": 1}
        assert self.rpc(event_call(value, task=task)) == {"reused": True, "revision": 1}
        assert self.count("ledger_event_versions", "event_id='atomic-event'") == 1
        assert self.count("ledger_recording_log", "task_key='RECEIPT:atomic-event:1'") == 1
        self.sql(event_call({**value, "kind": "WITHDRAWAL"}), role="service_role",
                 error="Immutable event revision conflict")
        self.sql(event_call(value, task={**task, "requestRef": "different"}), role="service_role",
                 error="Repeated recording task mismatch")
        self.check("Atomic event+tracking append, exact retry reuse and payload/tracking conflict rejection")

        successor = event("atomic-event", 2)
        assert self.rpc(event_call(successor)) == {"reused": False, "revision": 2}
        self.sql(event_call(event("atomic-event", 4)), role="service_role",
                 error="Concurrent ledger revision conflict")
        invalid_source = event("atomic-event", 3)
        invalid_source["source"]["recordId"] = "switched-source"
        self.sql(event_call(invalid_source), role="service_role",
                 error="Correction must preserve original source identity")
        self.sql(event_call(event("wrong-head", 2)), role="service_role",
                 error="Concurrent ledger revision conflict")
        self.sql(event_call(event("wrong-identity"), expected=1), role="service_role",
                 error="Invalid reviewed append identity/revision")
        self.check("Correction chain, stale/skipped revision and source-identity protections")

        invalid = event("rollback-event")
        self.sql(event_call(invalid, task={**recording(invalid), "status": "VERIFIED"}),
                 role="service_role", error="Recording task does not match")
        for table in ["ledger_event_versions", "ledger_event_sources"]:
            assert self.count(table, "event_id='rollback-event'") == 0
        assert self.count("ledger_recording_log", "task_key='RECEIPT:rollback-event:1'") == 0
        assert self.rpc(event_call(invalid, task=recording(invalid)))["reused"] is False
        self.check("Invalid recording task rolls back source, event and task; corrected retry succeeds")

        collision = event("recording-collision")
        self.sql(f"INSERT INTO public.ledger_recording_log(user_id,task_key,revision,status,payload) "
                 f"VALUES ('{USER_A}','RECEIPT:recording-collision:1',1,'PENDING','{{}}')",
                 role="service_role")
        self.sql(event_call(collision, task=recording(collision)), role="service_role",
                 error="duplicate key value violates unique constraint")
        for table in ["ledger_event_versions", "ledger_event_sources"]:
            assert self.count(table, "event_id='recording-collision'") == 0
        assert self.count("ledger_recording_log", "task_key='RECEIPT:recording-collision:1'") == 1
        self.check("Recording-log insert failure rolls back event/source without changing the existing task")

        invalid = event("constraint-rollback", kind="INVALID")
        self.sql(event_call(invalid), role="service_role", error="violates check constraint")
        assert self.count("ledger_event_sources", "event_id='constraint-rollback'") == 0
        model_event = event("model-tracking", book="MODEL", bookId="synthetic-model")
        self.sql(event_call(model_event, task=recording(model_event)), role="service_role",
                 error="Recording task does not match")
        assert self.count("ledger_event_sources", "event_id='model-tracking'") == 0
        self.check("Event constraint failure and ACTUAL-only tracking mismatch leave no partial source rows")

        duplicate = event("duplicate-source")
        duplicate["source"]["recordId"] = "atomic-event"
        self.sql(event_call(duplicate), role="service_role", error="Source already belongs")
        assert self.count("ledger_event_versions", "event_id='duplicate-source'") == 0
        self.check("One source identity cannot be relabeled into a second canonical event")

        base = event("concurrent-revision")
        self.rpc(event_call(base))
        left, right = event(base["id"], 2), event(base["id"], 2, kind="WITHDRAWAL")
        outcomes = self.race(self.event_lock(base["id"]), [event_call(left), event_call(right)])
        assert sorted(row[0] for row in outcomes) == [0, 1], outcomes
        assert any("Immutable event revision conflict" in row[2] for row in outcomes)
        assert self.count("ledger_event_versions", "event_id='concurrent-revision'") == 2
        self.check("Simultaneous different event revisions serialize: one append, one conflict, no fork")

        value = event("concurrent-reuse")
        outcomes = self.race(self.event_lock(value["id"]), [event_call(value, task=recording(value))] * 2)
        assert all(row[0] == 0 for row in outcomes), outcomes
        assert sorted(json.loads(row[1])["reused"] for row in outcomes) == [False, True]
        assert self.count("ledger_recording_log", "task_key='RECEIPT:concurrent-reuse:1'") == 1
        self.check("Simultaneous identical event+tracking requests append once and reuse once")

        left, right = event("source-race-left"), event("source-race-right")
        left["source"]["recordId"] = right["source"]["recordId"] = "shared-source-race"
        outcomes = self.race("LOCK TABLE public.ledger_event_sources IN SHARE MODE",
                             [event_call(left), event_call(right)])
        assert sorted(row[0] for row in outcomes) == [0, 1], outcomes
        assert any("Source already belongs" in row[2] for row in outcomes)
        for table in ["ledger_event_sources", "ledger_event_versions"]:
            assert self.count(table, "source_record_id='shared-source-race'") == 1
        self.check("Simultaneous different canonical IDs for one source commit exactly one source/event")

        spec = series("model-basic")
        first = model_run(spec, "2026-10-05")
        assert self.rpc(model_call(spec, first))["reused"] is False
        assert self.rpc(model_call(spec, first))["reused"] is True
        self.sql(model_call(spec, {**first, "stateHash": HASH_2}), role="service_role",
                 error="Immutable model date conflict")
        self.sql(model_call({**spec, "policy": {"kind": "MUTATED"}}, first), role="service_role",
                 error="Frozen model registry mismatch")
        second = model_run(spec, "2026-10-06", HASH, HASH_2)
        assert self.rpc(model_call(spec, second, "2026-10-05", HASH))["reused"] is False
        third = model_run(spec, "2026-10-07", HASH)
        self.sql(model_call(spec, third, "2026-10-05", HASH), role="service_role",
                 error="Model predecessor/head conflict")
        self.check("Frozen model series, append/reuse/conflict, valid continuation and stale-head rejection")

        bad_spec = series("model-rollback")
        self.sql(model_call(bad_spec, model_run(bad_spec, "2026-10-05", HASH), None, HASH),
                 role="service_role", error="Unexpected initial model predecessor")
        assert self.count("ledger_model_series", "series_id='model-rollback'") == 0
        self.sql(model_call(bad_spec, model_run(bad_spec, "2026-10-04")), role="service_role",
                 error="Invalid frozen model append")
        self.check("Invalid initial predecessor and pre-start model date reject atomically")

        spec = series("model-concurrent")
        first = model_run(spec, "2026-10-05")
        outcomes = self.race(self.model_lock(spec["bookId"]), [model_call(spec, first)] * 2)
        assert all(row[0] == 0 for row in outcomes), outcomes
        assert sorted(json.loads(row[1])["reused"] for row in outcomes) == [False, True]
        self.check("Simultaneous identical first model sessions create one registry/session and one reuse")
        outcomes = self.race(self.model_lock(spec["bookId"]), [
            model_call(spec, model_run(spec, date, HASH, HASH_2), "2026-10-05", HASH)
            for date in ["2026-10-06", "2026-10-07"]])
        assert sorted(row[0] for row in outcomes) == [0, 1], outcomes
        assert any("Model predecessor/head conflict" in row[2] for row in outcomes)
        assert self.count("ledger_model_sessions", "series_id='model-concurrent'") == 2
        self.check("Simultaneous cross-date model successors serialize with one winner and no chain fork")

        print(f"\nAll {self.passed} PostgreSQL integration groups passed", flush=True)


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
                print("\nDisposable PostgreSQL server log:\n" + log.read())
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
