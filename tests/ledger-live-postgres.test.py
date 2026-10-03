#!/usr/bin/env python3
"""Exercise the website/canonical bridge on an isolated disposable PostgreSQL cluster.

Example:
  python3 tests/ledger-live-postgres.test.py --pg-bin-dir /path/to/bin \
      --pg-share-dir /path/to/share/postgresql/17

Set CLOUDTREND_LEDGER_SNAPSHOT_PATH to an optional local JSON path to export
successful synthetic RPC envelopes for cross-runtime TypeScript projection tests.
Requires Node.js for direct JavaScript Number.toFixed(8) parity assertions.

Reuses the foundation suite's LOCAL-only cluster launcher. It never accepts a
connection URL, existing database/data directory, or non-loopback host. Every
fixture is synthetic. No production service, credentials, or source data is used.
"""

import copy
import importlib.util
import json
import os
import random
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("ledger_postgres_test", ROOT / "tests/ledger-postgres.test.py")
foundation = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(foundation)
literal, json_literal = foundation.literal, foundation.json_literal
USER_A, USER_B = foundation.USER_A, foundation.USER_B
USER_C = "33333333-3333-4333-8333-333333333333"
USER_D = "44444444-4444-4444-8444-444444444444"
KR, US = "portfolio_ledgers", "us_actual_portfolio_ledgers"


def execution(record_id="migrated-kr", market="KOSPI", **changes):
    result = dict(id=record_id, symbol="AAPL" if market == "US" else "005930",
                  name="Synthetic US security" if market == "US" else "Synthetic KR security",
                  market=market, signalKey=None, side="BUY", date="2026-09-01",
                  price=100, shares=10, fee=1, note="Synthetic fixture", order=0)
    result.update(changes)
    return result


def document(executions=None, source=KR):
    result = dict(executions=executions or [], excluded={}, migratedAt="2026-09-02T00:00:00Z")
    if source == US:
        result["capital"] = 100000
    else:
        result.update(version=1, actualCapital=100000, etfCapital=10000, strategy=None,
                      settings=dict(initialCapital=100000, maxPositions=30,
                                    sectorCap=0.3, roundTripCostRate=0.003))
    return result


def security(fill, **changes):
    is_us = fill["market"] == "US"
    value = dict(id=("US:" if is_us else "KR:") + fill["symbol"], symbol=fill["symbol"],
                 name=fill["name"], market=fill["market"], assetType="STOCK",
                 currency="USD" if is_us else "KRW", notionPageId=None)
    value.update(changes)
    return value


def migrated_event(fill, source=KR, source_revision=7):
    sec = security(fill)
    account = "synthetic-confirmed-account"
    return dict(
        id=f"{source}:{fill['id']}", revision=1, previousRevision=None, correctionReason=None,
        recordedAt="2026-09-02T00:00:00Z", recordedBy="migration:synthetic-test",
        effectiveDate=fill["date"], effectiveSequence=fill["order"], settlementDate=None,
        book="ACTUAL", bookId="ACTUAL", kind=fill["side"], voided=False,
        securityId=sec["id"], quantity=str(fill["shares"]), price=str(fill["price"]),
        currency=sec["currency"], gross=str(fill["price"] * fill["shares"]), fee=str(fill["fee"]), tax=None,
        cashLegs=[dict(accountId=account, currency=sec["currency"], amount=None)],
        positionLegs=[dict(accountId=account, securityId=sec["id"], quantity=str(fill["shares"]), basisAdjustment=None)],
        source=dict(system=source, recordId=fill["id"], revision=str(source_revision), contentHash=foundation.HASH),
        evidence=[dict(id="synthetic-evidence", source=dict(system="broker", recordId="synthetic-evidence", revision="1", contentHash=foundation.HASH), locator="synthetic://evidence", sha256=None)],
        brokerEventId="synthetic-broker-event", strategyId="synthetic-strategy", signalId=fill["signalKey"],
        orderId="synthetic-order", issues=["legacy_settlement_unknown", "legacy_tax_unverified", "broker_net_cash_unverified", "opening_balance_unverified", "synthetic-reviewed-context"],
        legacyExecution=copy.deepcopy(fill))


class LiveSuite(foundation.Suite):
    database = "cloudtrend_ledger_test"

    def sql(self, sql, role=None, user=None, database=None, error=None):
        return super().sql(sql, role, user, database or self.database, error)

    def query(self, sql, role=None, user=None):
        output = self.sql(sql, role, user)
        return json.loads(output) if output else None

    def read(self, user=USER_A, source=KR, as_user=None, role="authenticated"):
        return self.query(f"SELECT public.ledger_read_website_document({literal(user)}, {literal(source)})",
                          role, as_user or user)

    def insert_sql(self, user, payload, source=KR, revision=1):
        return (f"INSERT INTO public.{source}(user_id,revision,payload) VALUES "
                f"({literal(user)},{revision},{json_literal(payload)});")

    def update_sql(self, user, payload, source=KR, revision=None, expected=None):
        rev = "revision+1" if revision is None else str(revision)
        where = "" if expected is None else f" AND revision={expected}"
        return (f"UPDATE public.{source} SET revision={rev},payload={json_literal(payload)} "
                f"WHERE user_id={literal(user)}{where} RETURNING revision;")

    def save(self, payload, user=USER_A, source=KR, **kwargs):
        return self.sql(self.update_sql(user, payload, source, **kwargs), "authenticated", user)

    def snapshot(self):
        """Compare complete rows, including provenance/head state, after rejected writes."""
        tables = ["public." + table for table in foundation.TABLES]
        tables += ["public." + KR, "public." + US, "cloudtrend_ledger_private.bridge_documents"]
        result = {}
        for table in tables:
            result[table] = self.query(
                f"SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') FROM {table} t")
        return result

    def reject_atomically(self, sql, role="authenticated", user=USER_A, error=""):
        before = self.snapshot()
        self.sql(sql, role, user, error=error)
        assert self.snapshot() == before, "Rejected operation left partial document/journal/security/head state"

    def versions(self, name, source=KR, user=USER_A):
        return self.query("SELECT coalesce(jsonb_agg(payload ORDER BY revision),'[]') "
                          "FROM public.ledger_event_versions WHERE "
                          f"user_id={literal(user)} AND source_system={literal(source)} "
                          f"AND source_record_id={literal(name)}")

    def add_security(self, value, revision=1, user=USER_A):
        self.sql("INSERT INTO public.ledger_security_versions "
                 "(user_id,security_id,revision,symbol,market,currency,payload) VALUES "
                 f"({literal(user)},{literal(value['id'])},{revision},{literal(value['symbol'])},"
                 f"{literal(value['market'])},{literal(value['currency'])},{json_literal(value)})", "service_role")

    def capture(self, label, source=KR, user=USER_A):
        value = self.read(user, source)
        self.snapshots.append(dict(label=label, sourceSystem=source, **value))
        output_path = os.environ.get("CLOUDTREND_LEDGER_SNAPSHOT_PATH")
        if output_path:
            Path(output_path).write_text(json.dumps(self.snapshots, indent=2) + "\n")
        return value

    def rounding_tests(self):
        samples = [0, -0.0, 1e-320, 0.000000005, 0.000000015, 0.000000025,
                   1.000000005, 1.234567885, 1.234567895, 100 / 3,
                   0.1 * 3, 12.3456789012345, 999999.999999995,
                   4503599627370495.5, 9007199254740991]
        randomizer = random.Random(601003)
        samples += [randomizer.random() * 10 ** randomizer.randint(-300, 15) for _ in range(150)]
        javascript = "const a=JSON.parse(process.argv[1]);console.log(JSON.stringify(a.map(n=>n.toFixed(8).replace(/0+$/, '').replace(/\\.$/, ''))))"
        result = subprocess.run(["node", "-e", javascript, json.dumps(samples)],
                                check=True, capture_output=True, text=True, timeout=10)
        expected = json.loads(result.stdout)
        actual = self.query("SELECT jsonb_agg(cloudtrend_ledger_private.js_fixed8(value::double precision) ORDER BY ordinal) "
                            "FROM jsonb_array_elements_text(" + json_literal(samples) + ") WITH ORDINALITY AS x(value,ordinal)")
        assert actual == expected, list(zip(samples, actual, expected))
        for number in ["'-1'", "'NaN'", "'Infinity'", "'9007199254740992'"]:
            self.sql(f"SELECT cloudtrend_ledger_private.js_fixed8({number}::double precision)", error="")
        self.check("Private fixed-eight helper exactly matches JavaScript toFixed(8), including binary halfway/extreme values")

    def setup(self):
        self.snapshots = []
        self.sql("CREATE DATABASE cloudtrend_ledger_test", database="postgres")
        self.sql("""
          CREATE ROLE anon NOLOGIN;
          CREATE ROLE authenticated NOLOGIN;
          CREATE ROLE service_role NOLOGIN BYPASSRLS;
          CREATE SCHEMA auth;
          CREATE TABLE auth.users (id uuid PRIMARY KEY);
          CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
            SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
          $$;
          GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
          GRANT EXECUTE ON FUNCTION auth.uid() TO anon,authenticated,service_role;
          CREATE TABLE public.us_screening_history (user_id uuid,date date,signals jsonb);
        """)
        self.sql("INSERT INTO auth.users VALUES " + ",".join(f"({literal(u)})" for u in [USER_A, USER_B, USER_C, USER_D]))
        self.sql((ROOT / "supabase/migrations/20261002213815_unified_ledger_foundation.sql").read_text())
        self.sql((ROOT / "docs/portfolio-ledgers.sql").read_text())
        self.sql((ROOT / "docs/us-actual-portfolio.sql").read_text())
        self.initial = {}
        for source, fill, revision in [(KR, execution(), 7), (US, execution("migrated-us", "US"), 3)]:
            payload = document([fill], source)
            value = migrated_event(fill, source, revision)
            self.initial[source] = (payload, value)
            self.sql(self.insert_sql(USER_A, payload, source, revision), "service_role")
            self.add_security(security(fill))
            self.sql(foundation.event_call(value), "service_role")
        self.sql(self.insert_sql(USER_B, document()), "service_role")
        self.sql(self.insert_sql(USER_B, document(source=US), US), "service_role")
        migration_paths = list((ROOT / "supabase/migrations").glob("*_website_actual_ledger_bridge.sql"))
        assert len(migration_paths) == 1, f"Expected exactly one bridge migration, found {migration_paths}"
        self.migration = migration_paths[0].read_text()

    def activation_tests(self):
        """Each deliberately mismatched activation must roll back the entire migration."""
        for i, patch in enumerate([
            "UPDATE public.portfolio_ledgers SET payload=jsonb_set(payload,'{executions,0,shares}','11') WHERE user_id=" + literal(USER_A),
            "UPDATE public.portfolio_ledgers SET payload=jsonb_set(payload,'{executions}','[]') WHERE user_id=" + literal(USER_A),
            "UPDATE public.portfolio_ledgers SET payload=jsonb_set(payload,'{executions,0,id}','\"unmapped-source\"') WHERE user_id=" + literal(USER_A),
            "DELETE FROM public.portfolio_ledgers WHERE user_id=" + literal(USER_A),
        ]):
            db = f"ledger_bad_activation_{i}"
            self.sql(f"CREATE DATABASE {db} TEMPLATE cloudtrend_ledger_test", database="postgres")
            self.sql(patch, database=db)
            self.sql(self.migration, database=db, error="")
            assert self.sql("SELECT count(*) FROM pg_namespace WHERE nspname='cloudtrend_ledger_private'", database=db) == "0"
            assert self.sql("SELECT count(*) FROM public.ledger_event_versions", database=db) == "2"
            self.sql(f"DROP DATABASE {db}", database="postgres")
        self.check("Activation refuses changed, missing and unmapped migrated source fills, rolling back DDL and data")
        self.sql(self.migration)
        self.capture("activation-kr")
        self.capture("activation-us", US)
        assert self.sql("SELECT prosecdef::text||':'||provolatile::text FROM pg_proc WHERE proname='ledger_read_website_document'") == "false:s"
        assert self.count("ledger_event_versions") == 2
        self.check("Matching legacy/canonical snapshot activates without new events; public read RPC is stable invoker")

    def authorization_tests(self):
        for source in [KR, US]:
            value = self.read(source=source)
            assert value["payload"] == self.initial[source][0]
            assert value["events"] == [self.initial[source][1]]
            assert value["revision"] == (7 if source == KR else 3)
            assert self.read(USER_B, source)["events"] == []
            foreign = self.read(USER_A, source, as_user=USER_B)
            assert foreign is None or (foreign.get("payload") is None and foreign.get("events", []) == [])
            assert self.sql(f"SELECT count(*) FROM public.{source} WHERE user_id={literal(USER_A)}", "authenticated", USER_B) == "0"
            before = self.snapshot()
            assert self.save(document(source=source), USER_A, source, expected=99) == ""
            self.sql(self.update_sql(USER_A, document(source=source), source), "authenticated", USER_B)
            assert self.snapshot() == before
            for role in ["anon", "authenticated"]:
                self.reject_atomically(self.insert_sql(USER_C, document(source=source), source), role=role, user=USER_A)
            self.sql(f"SELECT public.ledger_read_website_document({literal(USER_A)}, {literal(source)})", "anon", USER_A, error="permission denied")
            self.sql(f"SELECT * FROM public.{source}", "anon", error="permission denied")
        self.check("Owner can read; foreign/null/anonymous reads and foreign writes cannot expose or mutate another ledger")
        for table in foundation.TABLES:
            for command in [f"INSERT INTO public.{table} SELECT * FROM public.{table}",
                            f"UPDATE public.{table} SET user_id=user_id", f"DELETE FROM public.{table}"]:
                self.sql(command, "authenticated", USER_A, error="permission denied")
        self.sql(foundation.event_call(foundation.event("forbidden")), "authenticated", USER_A, error="permission denied")
        self.sql("SELECT * FROM cloudtrend_ledger_private.bridge_documents", "authenticated", USER_A, error="permission denied")
        for role in ["anon", "authenticated", "service_role"]:
            assert self.sql("SELECT count(*) FROM pg_proc p WHERE p.pronamespace='cloudtrend_ledger_private'::regnamespace "
                            f"AND has_function_privilege({literal(role)},p.oid,'EXECUTE')") == "0"
            assert self.sql(f"SELECT has_schema_privilege({literal(role)},'cloudtrend_ledger_private','USAGE')") == "f"
        for source in [KR, US]:
            self.reject_atomically(f"DELETE FROM public.{source} WHERE user_id={literal(USER_A)}", "service_role", None)
            self.reject_atomically(f"TRUNCATE public.{source}", "service_role", None)
        self.check("Private function/schema access, direct canonical writes, legacy deletion and truncate denied")

    def live_tests(self):
        kr = copy.deepcopy(self.initial[KR][0])
        kr["actualCapital"] += 100
        assert self.save(kr) == "8"
        assert self.count("ledger_event_versions") == 2
        assert self.read()["payload"] == kr
        self.capture("settings-only")
        self.check("Settings-only update advances document revision without adding a journal event")

        new_fill = execution("app-kr", symbol="000660", name="Synthetic new listing", shares=3, order=1)
        kr["executions"].append(new_fill)
        assert self.save(kr) == "9"
        created = self.versions("app-kr")[0]
        assert "legacyExecution" not in created
        assert created["appExecution"] == new_fill
        assert created["securityId"] == "KR:000660"
        assert created["cashLegs"][0]["accountId"].startswith("UNASSIGNED:")
        assert created["positionLegs"][0]["accountId"] == created["cashLegs"][0]["accountId"]
        assert created["cashLegs"][0]["amount"] is None
        assert created["tax"] is None
        assert "account_mapping_unverified" in created["issues"]
        sec = [s for s in self.read()["securities"] if s["id"] == "KR:000660"]
        assert len(sec) == 1 and sec[0]["symbol"] == "000660" and sec[0]["currency"] == "KRW"
        self.capture("app-add")
        self.check("New website fill atomically creates source/event/security with explicit unknown account and settlement")

        kr["executions"][1]["price"] = 101
        self.save(kr)
        chain = self.versions("app-kr")
        assert len(chain) == 2 and chain[-1]["revision"] == 2 and chain[-1]["previousRevision"] == 1
        assert chain[0] == created and "legacyExecution" not in chain[-1]
        assert chain[-1]["appExecution"]["price"] == 101
        self.capture("app-edit")
        self.check("New app-event correction appends one predecessor-linked revision and updates appExecution only")

        original = self.initial[KR][1]
        kr["executions"][0].update(price=102, shares=11, note="Synthetic reviewed edit")
        self.save(kr)
        chain = self.versions("migrated-kr")
        assert chain[0] == original and len(chain) == 2
        corrected = chain[-1]
        assert corrected["legacyExecution"] == original["legacyExecution"]
        assert corrected["appExecution"] == kr["executions"][0]
        for field in ["evidence", "brokerEventId", "strategyId", "orderId"]:
            assert corrected[field] == original[field], field
        assert set(original["issues"]).issubset(corrected["issues"])
        assert corrected["cashLegs"][0]["accountId"] == original["cashLegs"][0]["accountId"]
        assert corrected["positionLegs"][0]["accountId"] == original["positionLegs"][0]["accountId"]
        assert corrected["source"]["system"] == original["source"]["system"]
        assert corrected["source"]["recordId"] == original["source"]["recordId"]
        self.capture("migrated-edit")
        self.check("Migrated correction retains original source observation, confirmed account, evidence and issues")

        kr["executions"] = [fill for fill in kr["executions"] if fill["id"] != "app-kr"]
        before = self.versions("app-kr")
        self.save(kr)
        chain = self.versions("app-kr")
        assert chain[:-1] == before and chain[-1]["revision"] == 3 and chain[-1]["voided"] is True
        assert self.read()["payload"] == kr
        assert len(self.read()["events"]) == 5
        self.sql("UPDATE public.ledger_event_versions SET payload=payload", error="append-only")
        self.capture("app-void")
        self.check("Removing a fill appends a void revision; all earlier revisions remain unchanged and readable")

        us = copy.deepcopy(self.initial[US][0])
        us["executions"].append(execution("app-us", "US", symbol="MSFT", order=1))
        self.save(us, source=US)
        assert self.versions("app-us", US)[0]["securityId"] == "US:MSFT"
        assert self.read(source=US)["payload"] == us
        assert all(e["source"]["system"] == US for e in self.read(source=US)["events"])
        self.capture("us-app-add", US)
        self.check("US source uses USD and US-prefixed securities without contaminating KR source reads")

        updated = security(execution(symbol="000660"), name="Synthetic latest display name")
        self.add_security(updated, revision=2)
        self.add_security(security(execution(symbol="999999"), name="Synthetic unrelated listing"))
        returned = self.read()["securities"]
        assert [s for s in returned if s["id"] == "KR:000660"] == [updated]
        assert not any(s["id"] == "KR:999999" for s in returned)
        self.check("Read RPC returns latest relevant security payloads, including void history, and excludes unrelated listings")
        kr["executions"][0]["note"] = "Synthetic note-only update"
        self.save(kr)
        self.capture("notes-only")
        assert self.versions("migrated-kr")[-1]["appExecution"]["note"] == "Synthetic note-only update"
        self.check("Note-only edit appends audited execution revision and round-trips in the compatibility envelope")
        self.kr, self.us = kr, us

    def invalid_tests(self):
        for source, good in [(KR, self.kr), (US, self.us)]:
            revision = self.read(source=source)["revision"]
            # A stale browser using an optimistic WHERE clause changes zero rows.
            before = self.snapshot()
            assert self.save(good, source=source, expected=revision-1) == ""
            assert self.snapshot() == before
            # An unconditional stale/skipped revision must be refused by the trigger.
            for bad_revision in [revision-1, revision, revision+2]:
                self.reject_atomically(self.update_sql(USER_A, good, source, revision=bad_revision))
        self.check("Stale optimistic writes are no-ops and skipped/stale explicit revisions reject atomically")

        mutations = [
            ("void identity reuse", lambda d: d["executions"].append(execution("app-kr", symbol="000660", order=20))),
            ("duplicate execution ID", lambda d: d["executions"].append(copy.deepcopy(d["executions"][0]))),
            ("zero shares", lambda d: d["executions"][0].update(shares=0)),
            ("negative fee", lambda d: d["executions"][0].update(fee=-1)),
            ("over-precision fee", lambda d: d["executions"][0].update(fee=0.123456789)),
            ("over-precision shares", lambda d: d["executions"][0].update(shares=0.123456789)),
            ("invalid numeric text", lambda d: d["executions"][0].update(price="NaN")),
            ("null numeric", lambda d: d["executions"][0].update(price=None)),
            ("unsafe number", lambda d: d["executions"][0].update(price=9007199254740992)),
            ("fractional order", lambda d: d["executions"][0].update(order=0.5)),
            ("negative order", lambda d: d["executions"][0].update(order=-1)),
            ("impossible date", lambda d: d["executions"][0].update(date="2026-02-30")),
            ("date shape", lambda d: d["executions"][0].update(date="2026-9-1")),
            ("invalid Korean symbol", lambda d: d["executions"][0].update(symbol="5930")),
            ("cross-source market", lambda d: d["executions"][0].update(market="US", symbol="AAPL")),
            ("unknown side", lambda d: d["executions"][0].update(side="SHORT")),
            ("oversell", lambda d: d["executions"].append(execution("oversell", side="SELL", shares=999, date="2026-09-03", order=100))),
            ("missing executions", lambda d: d.pop("executions")),
        ]
        for name, mutate in mutations:
            bad = copy.deepcopy(self.kr)
            mutate(bad)
            try:
                self.reject_atomically(self.update_sql(USER_A, bad))
            except AssertionError as error:
                raise AssertionError(f"{name}: {error}") from error
        self.check("Duplicate IDs, invalid economics/date/order/symbol/market and oversell roll back every affected table")

        bad_us = copy.deepcopy(self.us)
        bad_us["executions"][0]["symbol"] = "bad symbol!"
        self.reject_atomically(self.update_sql(USER_A, bad_us, US))
        for revision in [0, 2]:
            self.reject_atomically(self.insert_sql(USER_C, document([execution("new-user")]), revision=revision), user=USER_C)
        bad = document([execution("valid-first", symbol="123456"), execution("bad-second", shares=-1, order=1)])
        self.reject_atomically(self.insert_sql(USER_C, bad), user=USER_C)
        assert self.count("ledger_security_versions", "symbol='123456'") == 0
        self.check("Invalid initial revision or later invalid fill prevents the entire document/security/event insertion")

    def etf_tests(self):
        fill = execution("synthetic-etf", "ETF", symbol="0080G0", price=12345.6789012345, shares=7)
        payload = document([fill])
        self.save(payload, USER_B)
        result = self.capture("etf-high-precision-add", KR, USER_B)
        value = result["events"][0]
        assert value["appExecution"]["price"] == fill["price"]
        assert value["price"] == "12345.67890123"
        sec = result["securities"][0]
        assert sec["id"] == "KR:0080G0" and sec["assetType"] == "ETF" and sec["currency"] == "KRW"
        payload["executions"][0]["price"] = 100 / 3
        self.save(payload, USER_B)
        result = self.capture("etf-repeating-price-edit", KR, USER_B)
        value = result["events"][-1]
        assert value["price"] == "33.33333333"
        assert value["appExecution"]["price"] == 100 / 3
        payload["executions"] = []
        self.save(payload, USER_B)
        result = self.capture("etf-void", KR, USER_B)
        assert result["events"][-1]["voided"] is True
        self.check("ETF add/edit/void retains alphanumeric code, raw high-precision app price and fixed-eight canonical values")

    def concurrency_tests(self):
        current = self.read()
        revision = current["revision"]
        payload = copy.deepcopy(current["payload"])
        payload["executions"].append(execution("race-fill", symbol="035420", order=20))
        owner = f"SET ROLE authenticated; SET request.jwt.claim.sub={literal(USER_A)}; "
        lock = f"SELECT 1 FROM public.{KR} WHERE user_id={literal(USER_A)} FOR UPDATE"
        count_before = self.count("ledger_event_versions")
        request = owner + self.update_sql(USER_A, payload, revision=revision+1, expected=revision)
        outcomes = self.race(lock, [request, request])
        assert all(row[0] == 0 for row in outcomes), outcomes
        assert sorted(row[1] for row in outcomes) == ["", str(revision+1)], outcomes
        assert self.count("ledger_event_versions") == count_before + 1
        assert len(self.versions("race-fill")) == 1
        before = self.snapshot()
        assert self.sql(request) == ""
        assert self.snapshot() == before
        self.check("Real concurrent optimistic updates commit once and stale retry changes no rows or history")

        revision += 1
        left, right = copy.deepcopy(payload), copy.deepcopy(payload)
        left["executions"][-1]["price"] = 103
        right["executions"][-1]["price"] = 104
        outcomes = self.race(lock, [owner + self.update_sql(USER_A, value, revision=revision+1)
                                   for value in [left, right]])
        assert sorted(row[0] for row in outcomes) == [0, 1], outcomes
        chain = self.versions("race-fill")
        assert len(chain) == 2 and chain[-1]["revision"] == 2 and chain[-1]["previousRevision"] == 1
        assert self.read()["revision"] == revision+1
        assert self.read()["payload"] in [left, right]
        self.check("Real concurrent unconditional same-revision writes serialize: one winner, one conflict and no journal fork")

    def service_tests(self):
        # The session database role, never a forgeable JSON/JWT role string, is trusted.
        for source, market in [(KR, "KOSDAQ"), (US, "US")]:
            payload = document([execution("fresh-source", market, symbol="TSLA" if market == "US" else "123456")], source)
            self.sql(self.insert_sql(USER_C, payload, source), "authenticated", USER_C)
            assert self.read(USER_C, source)["revision"] == 1
            payload["executions"][0]["price"] = 105
            self.sql(self.update_sql(USER_C, payload, source), "service_role", USER_B)
            assert self.read(USER_C, source)["revision"] == 2
            assert len(self.versions("fresh-source", source, USER_C)) == 2
        self.check("Fresh owner documents begin at revision 1; trusted database service role can update both sources")

        assert self.query(f"SELECT public.ledger_read_website_document({literal(USER_A)}, {literal(KR)})", "authenticated") is None
        self.reject_atomically("SET request.jwt.claim.role='service_role'; " +
                               self.insert_sql(USER_D, document([execution("forged-service")])),
                               role="authenticated", user=USER_A)
        self.reject_atomically(f"UPDATE public.{KR} SET user_id={literal(USER_D)}, revision=revision+1 WHERE user_id={literal(USER_A)}")
        self.check("Null subject, forged service-role JWT claim and owner reassignment do not confer authority")

        # A valid privileged canonical append can happen independently. The bridge must
        # not overwrite it with its older compatibility snapshot on a subsequent write.
        head = copy.deepcopy(self.versions("migrated-kr")[-1])
        head.update(revision=head["revision"]+1, previousRevision=head["revision"],
                    correctionReason="Synthetic reviewed service correction", price="106", gross="1166")
        head["appExecution"]["price"] = 106
        self.sql(foundation.event_call(head), "service_role")
        legacy = self.query(f"SELECT payload FROM public.{KR} WHERE user_id={literal(USER_A)}")
        legacy["actualCapital"] += 1
        self.reject_atomically(self.update_sql(USER_A, legacy))
        assert self.versions("migrated-kr")[-1] == head
        self.check("Independent service-role ledger correction makes stale compatibility writes fail without erasing canonical facts")

    def source_registry_tests(self):
        self.sql(f"INSERT INTO public.ledger_event_sources(user_id,book,book_id,source_system,source_record_id,event_id) VALUES ({literal(USER_C)},'ACTUAL','ACTUAL',{literal(KR)},'orphan','orphan-event')", "service_role")
        envelope = self.read(USER_C, KR)
        assert any(value["sourceRecordId"] == "orphan" and value["eventId"] == "orphan-event" for value in envelope["sourceIdentities"])
        assert not any(value["id"] == "orphan-event" for value in envelope["events"])
        self.reject_atomically(self.update_sql(USER_C, envelope["payload"]), user=USER_C)
        self.check("Read snapshot includes permanent source registry so orphan registrations cannot be silently omitted")
        self.sql(f"INSERT INTO public.ledger_event_sources(user_id,book,book_id,source_system,source_record_id,event_id) VALUES ({literal(USER_D)},'ACTUAL','ACTUAL',{literal(KR)},'orphan-no-document','orphan-no-document-event')", "service_role")
        orphan = self.read(USER_D, KR)
        assert orphan is not None and orphan["payload"] is None and orphan["integrityValid"] is False
        assert len(orphan["sourceIdentities"]) == 1
        self.check("Orphan registration without a document returns an invalid envelope rather than a false absent-document null")

        bad = migrated_event(execution("metadata-mismatch"))
        self.sql(f"INSERT INTO public.ledger_event_sources(user_id,book,book_id,source_system,source_record_id,event_id) VALUES ({literal(USER_C)},'ACTUAL','ACTUAL',{literal(KR)},'metadata-mismatch',{literal(bad['id'])})", "service_role")
        self.sql(f"INSERT INTO public.ledger_event_versions(user_id,book,book_id,event_id,revision,effective_date,event_kind,source_system,source_record_id,source_revision,content_hash,payload,recorded_at) VALUES ({literal(USER_C)},'ACTUAL','ACTUAL',{literal(bad['id'])},1,'2026-09-02','BUY',{literal(KR)},'metadata-mismatch',{literal(bad['source']['revision'])},{literal(bad['source']['contentHash'])},{json_literal(bad)},{literal(bad['recordedAt'])})", "service_role")
        assert self.read(USER_C, KR)["integrityValid"] is False
        self.check("Indexed event provenance mismatch is explicitly invalid in the same-snapshot read envelope")

        owner = "55555555-5555-4555-8555-555555555555"
        self.sql(f"INSERT INTO auth.users(id) VALUES ({literal(owner)})")
        payload = document([execution("security-mismatch", symbol="567890")])
        self.sql(self.insert_sql(owner, payload), "authenticated", owner)
        assert self.read(owner, KR)["integrityValid"] is True
        self.sql(f"INSERT INTO public.ledger_security_versions(user_id,security_id,revision,symbol,market,currency,payload) SELECT user_id,security_id,2,'654321',market,currency,payload FROM public.ledger_security_versions WHERE user_id={literal(owner)}", "service_role")
        assert self.read(owner, KR)["integrityValid"] is False
        self.check("Indexed latest-security identity mismatch invalidates reads without granting private helper access")

        payload = document([execution("binary-fee", fee=1000000000.0000001)])
        self.sql(f"SELECT cloudtrend_ledger_private.validate_document({json_literal(payload)},{literal(KR)})")
        self.sql(f"SELECT cloudtrend_ledger_private.validate_document(jsonb_set({json_literal(payload)},'{{executions,0,fee}}','0.100000000000000000001'::jsonb),{literal(KR)})", error="not safely representable")
        self.check("SQL accepts TypeScript-roundtrip large binary fees but rejects raw JSON fee precision lost by JavaScript")


    def run(self):
        self.setup()
        self.activation_tests()
        self.rounding_tests()
        self.authorization_tests()
        self.live_tests()
        self.invalid_tests()
        self.etf_tests()
        self.concurrency_tests()
        self.service_tests()
        self.source_registry_tests()
        output_path = os.environ.get("CLOUDTREND_LEDGER_SNAPSHOT_PATH")
        if output_path:
            Path(output_path).write_text(json.dumps(self.snapshots, indent=2) + "\n")
            print(f"Exported {len(self.snapshots)} synthetic SQL envelopes to {output_path}", flush=True)
        print(f"\nAll {self.passed} live-ledger PostgreSQL integration groups passed", flush=True)


if __name__ == "__main__":
    foundation.Suite = LiveSuite
    foundation.__doc__ = __doc__
    foundation.main()
