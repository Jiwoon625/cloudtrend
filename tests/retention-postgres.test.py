#!/usr/bin/env python3
"""Test retention on a disposable loopback-only PostgreSQL cluster.

All records are synthetic. This script accepts only local binary/share paths,
never a database URL, existing data directory, or production connection.
"""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20261003011711_indefinite_screening_retention.sql"
A = "11111111-1111-4111-8111-111111111111"
B = "22222222-2222-4222-8222-222222222222"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pg-bin-dir", type=Path, required=True)
    parser.add_argument("--pg-share-dir", type=Path)
    args = parser.parse_args()
    binaries = args.pg_bin_dir.resolve()
    env = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
    with tempfile.TemporaryDirectory(prefix="cloudtrend-retention-") as tmp:
        tmp = Path(tmp)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        init = [str(binaries / "initdb"), "-D", str(tmp / "data"),
                "-A", "trust", "-U", "retention_test_admin", "--no-locale", "-E", "UTF8"]
        if args.pg_share_dir:
            init += ["-L", str(args.pg_share_dir.resolve())]
        subprocess.run(init, check=True, capture_output=True, text=True, env=env)
        ctl = [str(binaries / "pg_ctl"), "-D", str(tmp / "data")]
        subprocess.run(ctl + ["-l", str(tmp / "server.log"), "-o",
                             f"-h 127.0.0.1 -p {port} -c unix_socket_directories=''",
                             "-w", "start"], check=True, capture_output=True, text=True, env=env)
        try:
            base = [str(binaries / "psql"), "-X", "-qAt", "-h", "127.0.0.1", "-p", str(port),
                    "-U", "retention_test_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1"]

            def sql(text, error=None):
                result = subprocess.run(base + ["-c", text], capture_output=True,
                                        text=True, env=env, timeout=20)
                if error:
                    assert result.returncode and error in result.stderr, result.stderr
                else:
                    assert result.returncode == 0, result.stderr
                return result.stdout.strip()

            sql(f"""
              create role authenticated; create role anon;
              create schema auth;
              create table auth.users(id uuid primary key);
              insert into auth.users values ('{A}'),('{B}');
              create function auth.uid() returns uuid language sql stable as
              'select nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
              grant usage on schema public,auth to authenticated,anon;
              grant execute on function auth.uid() to authenticated,anon;
            """)
            historical = (ROOT / "docs/cloud-schema.sql").read_text().split(
                "insert into storage.buckets", 1)[0]
            sql(historical)
            sql(f"insert into public.screening_history values ('{A}','2026-01-01','{{\"original\":true}}');")
            security = """select jsonb_build_object('acl',c.relacl::text,'rls',c.relrowsecurity,
              'policies',(select jsonb_agg(to_jsonb(p) order by policyname) from pg_policies p
              where schemaname='public' and tablename='screening_history'))::text
              from pg_class c where c.oid='public.screening_history'::regclass"""
            before = sql(security)
            migration = MIGRATION.read_text()
            sql("begin;" + migration + "commit;")
            assert sql(security) == before
            assert sql("select snapshot::text from public.screening_history") == '{"original": true}'
            assert sql("select count(*) from pg_trigger where tgname='keep_90_snapshots'") == "0"
            assert sql("select to_regprocedure('public.trim_screening_history()') is null") == "t"
            print("PASS: migration preserves existing row and identical RLS/grants; pruner removed")

            for owner in (A, B):
                sql(f"set role authenticated; set request.jwt.claim.sub='{owner}';"
                    f"insert into public.screening_history select '{owner}',date '2026-01-01'+i,"
                    "jsonb_build_object('date',date '2026-01-01'+i) from generate_series(1,120) i;")
            assert sql("select count(*) from public.screening_history") == "241"
            assert sql(f"select count(*) from public.screening_history where user_id='{A}'") == "121"
            assert sql(f"select count(*) from public.screening_history where user_id='{B}'") == "120"
            print("PASS: more than 90 dates survive for both owners, including earliest record")

            own = f"set role authenticated; set request.jwt.claim.sub='{A}';"
            assert sql(own + "select count(*) from public.screening_history") == "121"
            assert sql(own + f"select count(*) from public.screening_history where user_id='{B}'") == "0"
            sql(own + f"insert into public.screening_history values ('{B}','2027-01-01','{{}}');",
                error="row-level security")
            sql("set role anon; select count(*) from public.screening_history;", error="permission denied")
            print("PASS: owner reads remain isolated; cross-owner writes and anonymous reads fail")

            shown = sql(own + "select jsonb_build_object('count',count(*),'earliest',min(date),'latest',max(date))"
                        " from (select date from public.screening_history order by date desc limit 90) s")
            shown = json.loads(shown)
            assert shown == {"count": 90, "earliest": "2026-02-01", "latest": "2026-05-01"}, shown
            sql(own + f"insert into public.screening_history values ('{A}','2026-01-01','{{\"updated\":true}}')"
                " on conflict(user_id,date) do update set snapshot=excluded.snapshot;")
            assert sql("select count(*) from public.screening_history") == "241"
            assert sql(f"select snapshot::text from public.screening_history where user_id='{A}' and date='2026-01-01'") == '{"updated": true}'
            print("PASS: UI query stays at newest 90; same-date latest-snapshot behavior preserved")

            sql("begin;" + migration + "commit;")
            assert sql("select count(*) from public.screening_history") == "241"
            assert sql(security) == before
            print("PASS: repeated migration is harmless; no data or policy changes")
        finally:
            subprocess.run(ctl + ["-m", "fast", "-w", "stop"],
                           check=True, capture_output=True, text=True, env=env)


if __name__ == "__main__":
    main()
