#!/usr/bin/env python3
"""Verify the US operating replay RPC in a disposable loopback PostgreSQL cluster.

Synthetic fixtures only. No connection URL, existing data directory, credentials,
or production service is accepted. Apply the checked-in migrations unmodified.

python3 tests/us-operating-replay-postgres.test.py --pg-bin-dir /path/to/bin \
    --pg-share-dir /path/to/share/postgresql/17
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / 'supabase/migrations'
MIGRATION = MIGRATIONS / '20261008030458_atomic_us_operating_replay.sql'
A = '11111111-1111-4111-8111-111111111111'
B = '22222222-2222-4222-8222-222222222222'
STRATEGIES = ['A0_QUARTER_PRIMARY', 'A2_QUARTER_SHADOW',
              'B3_BETA_SHADOW', 'SPY_BENCHMARK']
RULE = 'us-prospective-1.1.0-a0-anchor'
BASE = '2026-10-05'
DAYS = ['2026-10-06', '2026-10-07']
TABLES = ['us_strategy_registry', 'us_portfolio_snapshots', 'us_portfolio_trades',
          'us_screening_history', 'us_actual_portfolio_ledgers', 'us_operating_replays']
SIGNATURE = 'public.apply_us_operating_replay(uuid,jsonb,boolean)'


def literal(value):
    return 'NULL' if value is None else "'" + str(value).replace("'", "''") + "'"


def jl(value):
    return literal(json.dumps(value, ensure_ascii=False)) + '::jsonb'


def seal(plan):
    body = {key: value for key, value in plan.items()
            if key not in {'planHash', 'canonicalPayload'}}
    canonical = json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
    plan['canonicalPayload'] = canonical
    plan['planHash'] = 'sha256:' + hashlib.sha256(canonical.encode()).hexdigest()
    return plan


def call(plan, owner=A, apply=True):
    apply_arg = '' if apply is None else ',' + ('true' if apply else 'false')
    return f'SELECT {SIGNATURE.split("(")[0]}({literal(owner)},{jl(plan)}{apply_arg});'


def source_hash(day):
    return 'sha256:' + hashlib.sha256(('synthetic-source:' + day).encode()).hexdigest()


def snapshot(strategy, day):
    benchmark = strategy == 'SPY_BENCHMARK'
    state = dict(basePrice=100, currentPrice=100, symbol='SPY') if benchmark else dict(
        initializedDate=BASE, initialCapital=100000, cash=100000, positions={},
        pendingTargets={}, pendingExits={}, lastQuarterRebalance=None,
        benchmarkBasePrice=100, benchmarkBaseDate=BASE, totalFees=0, lastDate=day,
        allocationPolicy=dict(version='us-initial-capital-slots-v1',
                              effectiveDate=BASE, targetPositions=20,
                              initialCapitalUsd='100000', quarterlyRebalance=False,
                              fundingOnlySales=False))
    return dict(strategy_id=strategy, date=day, rule_version=RULE,
                nav_usd=100000, cash_usd=0 if benchmark else 100000,
                benchmark_nav=100000, daily_return=None if benchmark else 0,
                cumulative_return=0, turnover=0, fees_usd=0,
                positions_count=1 if benchmark else 0, state=state)


def trade(day=BASE, key='synthetic-pending'):
    return dict(trade_key=key, strategy_id=STRATEGIES[0], signal_date=day,
                execution_date=None, symbol='SYNTH', name='Synthetic holding',
                sector='Test', side='BUY', reason='SYNTHETIC_ENTRY', status='PENDING',
                model_price=None, model_shares=None, model_notional=None,
                fee_usd=0, core_rank=0.9, detail={'synthetic': True})


class Suite:
    def __init__(self, base, env):
        self.base, self.env, self.passed = base, env, 0

    def sql(self, sql, error=None, role=None, user=None):
        setup = "SET timezone='UTC'; SET statement_timeout='10s';"
        if role:
            setup += f'SET ROLE {role};'
        if user:
            setup += f'SET request.jwt.claim.sub={literal(user)};'
        result = subprocess.run(self.base, input=setup + sql, capture_output=True,
                                text=True, env=self.env, timeout=15)
        if error is not None:
            assert result.returncode != 0, 'Expected SQL rejection'
            assert error in result.stderr, result.stderr
        else:
            assert result.returncode == 0, result.stderr
        return result.stdout.strip()

    def check(self, message):
        self.passed += 1
        print(f'PASS {self.passed:02d}: {message}', flush=True)

    def rows(self, table, where='true'):
        return json.loads(self.sql(f"SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY "
                                   f"to_jsonb(t)::text),'[]') FROM public.{table} t WHERE {where}"))

    def state(self):
        return {table: self.rows(table) for table in TABLES}

    def insert(self, table, row, owner=A):
        row = {'user_id': owner, **row}
        keys = list(row)
        # Selecting named fields preserves real defaults for timestamps and other
        # omitted columns, unlike inserting a whole jsonb_populate_record result.
        columns = ','.join(keys)
        self.sql(f'INSERT INTO public.{table}({columns}) SELECT {columns} '
                 f'FROM jsonb_populate_record(NULL::public.{table},{jl(row)});')

    def fixture(self, pending=False):
        self.sql('TRUNCATE ' + ','.join('public.' + table for table in TABLES) + ';')
        registries = []
        for index, strategy in enumerate(STRATEGIES):
            role = 'BENCHMARK' if index == 3 else 'PRIMARY' if index == 0 else 'SHADOW'
            config = {'symbol': 'SPY', 'initialCapital': 100000} if index == 3 else {
                'id': strategy, 'label': strategy, 'role': role,
                'style': 'BALANCED' if index == 2 else 'AGGRESSIVE',
                'sectorCap': None if index == 0 else index + 1,
                'exitCore': 0.5 if index == 2 else 0.7,
                'quarterlyRebalance': index != 2,
                'betaExit': None if index == 1 else {'rankBelow': 0.6, 'consecutiveDays': 3}}
            registry = dict(strategy_id=strategy, label=strategy, role=role,
                            rule_version=RULE, config=config, active=True)
            registries.append(registry)
            for owner in [A, B]:
                self.insert('us_strategy_registry', {**registry, 'frozen_at': BASE + 'T00:00:00Z'}, owner)
                self.insert('us_portfolio_snapshots', snapshot(strategy, BASE), owner)
        for day in [BASE] + DAYS:
            self.insert('us_screening_history', dict(date=day, data_hash=source_hash(day),
                                                   rule_version=RULE, summary={}, signals=[]))
        self.insert('us_actual_portfolio_ledgers', dict(revision=7, payload={'synthetic': 'leave unchanged'}))
        expected_pending = []
        resolutions = []
        if pending:
            expected = trade()
            self.insert('us_portfolio_trades', {**expected, 'actual_price': 101.25,
                                              'actual_shares': 13, 'actual_fee_usd': 2.5})
            expected_pending.append(expected)
            resolutions.append(dict(trade_key=expected['trade_key'], expected=expected, resolved_on=DAYS[0]))
        self.insert('us_portfolio_trades', {**trade(key='other-user-pending'),
                                          'actual_price': 88.5, 'actual_shares': 7,
                                          'actual_fee_usd': 0.75}, B)
        return seal(dict(version='us-operating-replay-v1', baseDate=BASE, throughDate=DAYS[-1], ruleVersion=RULE,
                         dates=[dict(date=day, previousSessionDate=previous,
                                     sourceHash=source_hash(day))
                                for day, previous in zip(DAYS, [BASE] + DAYS[:-1])],
                         expectedRegistries=registries,
                         expectedSnapshots=[snapshot(strategy, BASE) for strategy in STRATEGIES],
                         expectedPendingTrades=expected_pending,
                         snapshots=[snapshot(strategy, day) for day in DAYS for strategy in STRATEGIES],
                         trades=[], pendingResolutions=resolutions))

    def reject(self, plan, error='', role='service_role', owner=A, apply=True):
        before = self.state()
        self.sql(call(plan, owner, apply), error=error, role=role)
        assert self.state() == before, 'Rejected replay changed persistent state'

    def filled_fixture(self):
        plan = self.fixture(pending=True)
        filled = trade(key='synthetic-executed')
        filled.update(execution_date=DAYS[0], status='EXECUTED', model_price=100,
                      model_shares=1, model_notional=100, fee_usd=0.25)
        plan['trades'] = [filled]
        for item in plan['snapshots']:
            if item['strategy_id'] != STRATEGIES[0]:
                continue
            item.update(cash_usd=99899.75, nav_usd=99999.75, positions_count=1,
                        daily_return=-0.0000025 if item['date'] == DAYS[0] else 0,
                        cumulative_return=-0.0000025,
                        fees_usd=0.25 if item['date'] == DAYS[0] else 0)
            item['state'].update(cash=99899.75, totalFees=0.25, positions={
                'SYNTH': dict(symbol='SYNTH', name='Synthetic holding', sector='Test',
                              shares=1, lastPrice=100, entryDate=DAYS[0], entryCoreRank=0.9)})
        return seal(plan)

    def ledger_fixture(self):
        plan = self.filled_fixture()
        cancelled = trade(DAYS[0], 'synthetic-new-cancelled')
        cancelled.update(status='CANCELLED', detail={
            'synthetic': True, 'resolution': 'ROLLED_FORWARD_OR_RESOLVED',
            'resolved_on': DAYS[1]})
        pending = trade(DAYS[1], 'synthetic-new-pending')
        pending.update(symbol='NEXT', name='Synthetic next holding')
        plan['trades'].extend([cancelled, pending])
        plan['snapshots'][4]['state']['pendingTargets'] = {
            'NEXT': dict(symbol='NEXT', targetWeight=0.05,
                         signalDate=DAYS[1], reason='SYNTHETIC_ENTRY')}
        return seal(plan)

    def assert_retry(self, plan, receipt):
        before = self.state()
        assert json.loads(self.sql(call(plan), role='service_role')) == receipt
        validation = json.loads(self.sql(call(plan, apply=False), role='service_role'))
        assert validation == {**receipt, 'validated': True, 'alreadyApplied': True}
        assert self.state() == before, 'Saved-receipt verification modified state'

    def resolve_future_pending(self, plan, merged=True, corroborate=True):
        day = '2026-10-08'
        detail = dict(resolution='ROLLED_FORWARD_OR_RESOLVED', resolved_on=day)
        if merged:
            detail = {**plan['trades'][-1]['detail'], **detail}
        self.sql(f"UPDATE public.us_portfolio_trades SET status='CANCELLED',detail={jl(detail)},updated_at=now() "
                 f"WHERE user_id='{A}' AND trade_key='synthetic-new-pending'")
        if corroborate:
            future = copy.deepcopy(plan['snapshots'][4])
            future['date'] = day
            future['state'].update(lastDate=day, pendingTargets={})
            self.insert('us_portfolio_snapshots', future)

    def retry_readback_tests(self):
        for key in ['synthetic-executed', 'synthetic-new-cancelled',
                    'synthetic-new-pending', 'synthetic-pending']:
            for change in ['corrupt', 'delete']:
                plan = self.ledger_fixture()
                self.sql(call(plan), role='service_role')
                where = f"user_id='{A}' AND trade_key={literal(key)}"
                self.sql(f"UPDATE public.us_portfolio_trades SET reason='CORRUPTED' WHERE {where}"
                         if change == 'corrupt' else f'DELETE FROM public.us_portfolio_trades WHERE {where}')
                for apply in [True, False]:
                    try:
                        self.reject(plan, apply=apply)
                    except AssertionError as error:
                        raise AssertionError(f'Retry accepted {change} of {key}: {error}') from error
        plan = self.ledger_fixture()
        plan['trades'][0]['status'] = 'PARTIAL'
        seal(plan)
        receipt = json.loads(self.sql(call(plan), role='service_role'))
        self.assert_retry(plan, receipt)
        self.sql(f"UPDATE public.us_portfolio_trades SET model_notional=101 WHERE user_id='{A}' AND trade_key='synthetic-executed'")
        self.reject(plan)
        self.reject(plan, apply=False)
        self.check('Apply and preflight retries reject deleted/corrupted executed, partial, cancelled, pending and prior-resolution model rows')

        for key, changes in [
            ('synthetic-new-pending', "detail=detail||'{\"unexpected\":true}'::jsonb"),
            ('synthetic-new-pending', "status='CANCELLED'"),
            ('synthetic-new-cancelled', "detail=detail||'{\"resolved_on\":\"2026-10-08\"}'::jsonb"),
            ('synthetic-pending', "status='PENDING'"),
            ('synthetic-pending', "detail=detail||'{\"resolved_on\":\"2026-10-07\"}'::jsonb"),
        ]:
            plan = self.ledger_fixture()
            self.sql(call(plan), role='service_role')
            self.sql(f'UPDATE public.us_portfolio_trades SET {changes} '
                     f"WHERE user_id='{A}' AND trade_key={literal(key)}")
            self.reject(plan)
            self.reject(plan, apply=False)
        self.check('Retries require original pending detail and exact already-applied cancellation status/detail')

        plan = self.ledger_fixture()
        receipt = json.loads(self.sql(call(plan), role='service_role'))
        self.sql(f"UPDATE public.us_portfolio_trades SET actual_price=321.25,actual_shares=2,actual_fee_usd=0.5,updated_at=now() "
                 f"WHERE user_id='{A}'", role='authenticated', user=A)
        self.assert_retry(plan, receipt)
        self.check('Owner-authorized actual-only edits to inserted and resolved rows preserve exact saved-receipt retries')

        for merged in [True, False]:
            plan = self.ledger_fixture()
            receipt = json.loads(self.sql(call(plan), role='service_role'))
            self.resolve_future_pending(plan, merged=merged)
            self.assert_retry(plan, receipt)
        self.check('Later corroborated cancellation of inserted pending rows allows both merged RPC and bare legacy resolution detail')

        for changes, corroborate in [
            (None, False),
            ("detail=jsonb_set(detail,'{resolved_on}','\"2026-10-07\"')", True),
            ("detail=jsonb_set(detail,'{resolution}','\"WRONG_RESOLUTION\"')", True),
            ("detail=detail||'{\"unexpected\":true}'::jsonb", True),
            ("reason='CHANGED_MODEL'", True),
        ]:
            plan = self.ledger_fixture()
            self.sql(call(plan), role='service_role')
            self.resolve_future_pending(plan, corroborate=corroborate)
            if changes:
                self.sql(f'UPDATE public.us_portfolio_trades SET {changes} '
                         f"WHERE user_id='{A}' AND trade_key='synthetic-new-pending'")
            self.reject(plan)
            self.reject(plan, apply=False)
        self.check('Future pending transitions reject missing snapshot evidence, nonfuture dates, wrong token and unrelated model/detail edits')

        for placement in ['target', 'exit', 'overlapping-target-and-exit']:
            plan = self.ledger_fixture()
            self.sql(call(plan), role='service_role')
            self.resolve_future_pending(plan)
            pending = dict(symbol='NEXT', signalDate=DAYS[1], reason='SYNTHETIC_ENTRY')
            target = {'NEXT': pending} if placement != 'exit' else {}
            exits = {'NEXT': pending} if placement == 'exit' else {}
            if placement == 'overlapping-target-and-exit':
                exits = {'NEXT': {**pending, 'reason': 'DIFFERENT_INTENT'}}
            patch = dict(pendingTargets=target, pendingExits=exits)
            self.sql(f'UPDATE public.us_portfolio_snapshots SET state=state||{jl(patch)} '
                     f"WHERE user_id='{A}' AND strategy_id='{STRATEGIES[0]}' AND date='2026-10-08'")
            try:
                self.reject(plan)
                self.reject(plan, apply=False)
            except AssertionError as error:
                raise AssertionError('Future snapshot retains original ' + placement + ': ' + str(error)) from error
        self.check('Future cancellation evidence rejects original intent remaining in either pending map, even with overlapping symbol keys')

    def locked_replay(self, plan):
        process = subprocess.Popen(self.base, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True, env=self.env)
        command = call(plan).replace('SELECT ', 'PERFORM ', 1)
        process.stdin.write('BEGIN; SET ROLE service_role; DO $$ BEGIN ' + command +
                            ' END $$;\n\\echo LOCKED\n')
        process.stdin.flush()
        assert process.stdout.readline().strip() == 'LOCKED', 'Replay lock holder did not initialize'
        return process

    def setup(self):
        self.sql(f"""
            CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
            CREATE SCHEMA auth;
            CREATE TABLE auth.users(id uuid PRIMARY KEY);
            INSERT INTO auth.users VALUES ('{A}'),('{B}');
            CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
            'SELECT nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
            GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
            GRANT EXECUTE ON FUNCTION auth.uid() TO anon,authenticated,service_role;
            ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
        """)
        for name in ['20260928064908_us_prospective_pipeline_v1.sql',
                     '20260928083451_restrict_us_actual_execution_updates.sql',
                     '20260928085005_restrict_us_model_ledger_grants.sql',
                     '20260928162635_separate_us_actual_portfolio_ledger.sql']:
            self.sql((MIGRATIONS / name).read_text())
        self.catalog_sql = """SELECT jsonb_build_object(
          'tables',(SELECT jsonb_agg(jsonb_build_object('table',relname,'acl',relacl::text,
              'rls',relrowsecurity,'force',relforcerowsecurity) ORDER BY relname)
            FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN
              ('us_strategy_registry','us_portfolio_snapshots','us_portfolio_trades','us_actual_portfolio_ledgers')),
          'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY tablename,policyname)
            FROM pg_policies p WHERE schemaname='public' AND tablename<>'us_operating_replays'),
          'columnGrants',(SELECT jsonb_agg(to_jsonb(c) ORDER BY grantee,table_name,column_name,privilege_type)
            FROM information_schema.column_privileges c WHERE table_schema='public'
              AND table_name='us_portfolio_trades' AND grantee IN ('anon','authenticated')));"""
        self.original_catalog = self.sql(self.catalog_sql)
        self.sql(MIGRATION.read_text())
        assert self.sql(self.catalog_sql) == self.original_catalog

    def run(self):
        self.setup()
        plan = self.fixture()
        assert self.sql(f"SELECT prosecdef FROM pg_proc WHERE oid='{SIGNATURE}'::regprocedure") == 'f'
        assert self.sql("SELECT to_regprocedure('public.apply_us_operating_replay(uuid,jsonb)') IS NULL") == 't'
        for role in ['anon', 'authenticated']:
            assert self.sql(f"SELECT has_function_privilege('{role}','{SIGNATURE}','EXECUTE')") == 'f'
            self.reject(plan, 'permission denied for function', role=role)
        self.reject(plan, role=None)
        assert self.sql(f"SELECT has_function_privilege('service_role','{SIGNATURE}','EXECUTE')") == 't'
        assert self.sql("SELECT relrowsecurity FROM pg_class WHERE oid='public.us_operating_replays'::regclass") == 't'
        for role in ['anon', 'authenticated']:
            self.sql('SELECT * FROM public.us_operating_replays;', error='permission denied', role=role)
        for privilege in ['UPDATE', 'DELETE', 'TRUNCATE']:
            assert self.sql(f"SELECT has_table_privilege('service_role','public.us_operating_replays','{privilege}')") == 'f'
        self.check('Service-role-only SECURITY INVOKER RPC, audit RLS, unchanged existing ACL/RLS')

        for filled in [False, True]:
            plan = self.filled_fixture() if filled else self.fixture()
            original = self.state()
            for apply in [False, None]:
                validation = json.loads(self.sql(call(plan, apply=apply), role='service_role'))
                assert validation['validated'] is True and validation['planHash'] == plan['planHash']
                assert self.state() == original, 'Preflight changed database state'
        self.check('Explicit false and omitted apply flag fully validate cash-only and filled plans without writes')

        plan = self.filled_fixture()
        self.sql("""CREATE FUNCTION public.reject_preflight_write() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'preflight attempted a write'; END $$;""")
        guarded = ['us_portfolio_snapshots', 'us_portfolio_trades', 'us_operating_replays']
        for table in guarded:
            self.sql(f'CREATE TRIGGER reject_preflight_write BEFORE INSERT OR UPDATE OR DELETE ON public.{table} '
                     'FOR EACH ROW EXECUTE FUNCTION public.reject_preflight_write();')
        try:
            assert json.loads(self.sql(call(plan, apply=False), role='service_role'))['validated'] is True
        finally:
            for table in guarded:
                self.sql(f'DROP TRIGGER reject_preflight_write ON public.{table};')
            self.sql('DROP FUNCTION public.reject_preflight_write();')
        self.check('Preflight executes no snapshot, trade, pending-resolution or audit writes, including rolled-back writes')

        for label, mutate in [
            ('bad final-day cash', lambda p: p['snapshots'][4].update(cash_usd=100000)),
            ('bad final-day holding', lambda p: p['snapshots'][4]['state']['positions']['SYNTH'].update(shares=2)),
            ('resolution outside replay dates', lambda p: p['pendingResolutions'][0].update(resolved_on=BASE)),
            ('resolution predecessor mismatch', lambda p: p['pendingResolutions'][0]['expected'].update(reason='CHANGED')),
            ('duplicate resolution', lambda p: p['pendingResolutions'].append(copy.deepcopy(p['pendingResolutions'][0]))),
        ]:
            plan = self.filled_fixture()
            mutate(plan)
            try:
                self.reject(seal(plan), apply=False)
            except AssertionError as error:
                raise AssertionError('Preflight ' + label + ': ' + str(error)) from error
        self.check('Preflight rejects final-day accounting and pending-resolution errors before any mutation')

        for changes, error in [
            ({'model_shares': 2147483648}, 'out of range'),
            ({'model_shares': -1}, 'Invalid US trade shares'),
            ({'status': None}, 'Invalid US model trade'),
            ({'side': None}, 'Invalid US model trade'),
            ({'reason': None}, 'Invalid US model trade'),
        ]:
            plan = self.filled_fixture()
            plan['trades'][0].update(changes)
            self.reject(seal(plan), error, apply=False)
        self.check('Preflight rejects PostgreSQL int4 overflow, negative shares and null required trade fields')

        plan = self.fixture()

        original = self.state()
        receipt = json.loads(self.sql(call(plan), role='service_role'))
        after = self.state()
        assert len(after['us_operating_replays']) == 1
        assert len(after['us_portfolio_snapshots']) == len(original['us_portfolio_snapshots']) + 8
        assert all(row in after['us_portfolio_snapshots'] for row in original['us_portfolio_snapshots'])
        for table in TABLES:
            if table not in {'us_portfolio_snapshots', 'us_operating_replays'}:
                assert after[table] == original[table], table
        assert receipt['snapshotsInserted'] == 8 and receipt['tradesInserted'] == 0
        assert receipt['planHash'] == plan['planHash']
        self.check('Two-day/four-strategy append preserves prior snapshots, other owner and actual ledger')

        retry = json.loads(self.sql(call(plan), role='service_role'))
        assert retry == receipt
        assert self.state() == after
        preflight = json.loads(self.sql(call(plan, apply=False), role='service_role'))
        assert preflight['validated'] is True and preflight['alreadyApplied'] is True
        assert {key: value for key, value in preflight.items()
                if key not in {'validated', 'alreadyApplied'}} == receipt
        assert self.state() == after
        tampered = copy.deepcopy(plan)
        tampered['snapshots'][0]['daily_return'] = 0.1
        self.reject(tampered)
        tampered = copy.deepcopy(plan)
        tampered['planHash'] = 'sha256:' + 'f' * 64
        self.reject(tampered)
        tampered = copy.deepcopy(plan)
        tampered['canonicalPayload'] += ' '
        self.reject(tampered)
        self.sql(f"UPDATE public.us_portfolio_snapshots SET state=state||'{{\"changed\":true}}' WHERE user_id='{A}' AND date='{DAYS[0]}' AND strategy_id='{STRATEGIES[0]}'")
        self.reject(plan, 'Committed US replay snapshot changed')
        self.check('Exact retry returns unchanged receipt; body, hash and canonical-payload tampering fail closed')

        self.retry_readback_tests()

        plan = self.fixture()
        self.sql(f"UPDATE public.us_portfolio_snapshots SET cash_usd=cash_usd-1 WHERE user_id='{A}' AND strategy_id='{STRATEGIES[0]}'")
        self.reject(plan)
        plan = self.fixture()
        self.sql(f"UPDATE public.us_strategy_registry SET config=config||'{{\"drift\":true}}' WHERE user_id='{A}' AND strategy_id='{STRATEGIES[0]}'")
        self.reject(plan)
        plan = self.fixture()
        self.sql(f"UPDATE public.us_strategy_registry SET active=false WHERE user_id='{A}' AND strategy_id='{STRATEGIES[1]}'")
        self.reject(plan)
        self.check('Prior snapshot, frozen registry config and active-status CAS drift reject atomically')

        plan = self.fixture()
        self.insert('us_portfolio_snapshots', snapshot(STRATEGIES[0], DAYS[0]))
        self.reject(plan)
        plan = self.fixture()
        self.insert('us_portfolio_snapshots', snapshot(STRATEGIES[1], '2026-10-08'))
        self.reject(plan)
        plan = self.fixture()
        plan['expectedSnapshots'].pop()
        self.reject(seal(plan))
        plan = self.fixture()
        plan['snapshots'].pop()
        self.reject(seal(plan))
        self.check('Partial/already-existing tails and missing members of four-strategy snapshot batches reject')

        plan = self.fixture(pending=True)
        old_trade = self.rows('us_portfolio_trades', f"user_id='{A}'")[0]
        self.sql(call(plan), role='service_role')
        closed_trade = self.rows('us_portfolio_trades', f"user_id='{A}'")[0]
        assert closed_trade['status'] == 'CANCELLED'
        assert closed_trade['detail']['resolved_on'] == DAYS[0]
        for key in ['actual_price', 'actual_shares', 'actual_fee_usd', 'created_at']:
            assert closed_trade[key] == old_trade[key], key
        self.check('Expected pending resolution preserves all actual-execution fields and original creation time')

        plan = self.fixture(pending=True)
        self.sql(f"UPDATE public.us_portfolio_trades SET model_shares=4 WHERE user_id='{A}'")
        self.reject(plan)
        plan = self.fixture(pending=True)
        self.insert('us_portfolio_trades', trade(key='unexpected-pending'))
        self.reject(plan)
        plan = self.fixture(pending=True)
        self.sql(f"DELETE FROM public.us_portfolio_trades WHERE user_id='{A}'")
        self.reject(plan)
        self.check('Changed, additional and missing model pending rows invalidate exact pending CAS')

        plan = self.fixture(pending=True)
        self.sql(f"UPDATE public.us_portfolio_trades SET actual_price=222,actual_shares=3,actual_fee_usd=9 WHERE user_id='{A}'")
        self.sql(call(plan), role='service_role')
        actual = self.rows('us_portfolio_trades', f"user_id='{A}'")[0]
        assert (actual['actual_price'], actual['actual_shares'], actual['actual_fee_usd']) == (222, 3, 9)
        self.check('Concurrent owner actual-field edits do not invalidate model CAS and survive replay')

        plan = self.filled_fixture()
        receipt = json.loads(self.sql(call(plan), role='service_role'))
        assert receipt['tradesInserted'] == 1 and receipt['pendingResolved'] == 1
        filled = self.rows('us_portfolio_trades', "trade_key='synthetic-executed'")[0]
        assert filled['model_notional'] == 100 and filled['fee_usd'] == 0.25
        assert all(filled[key] is None for key in ['actual_price', 'actual_shares', 'actual_fee_usd'])
        self.check('Real model buy, 25-basis-point fee and carried holding reconcile on both replay days')

        plan = self.filled_fixture()
        self.insert('us_portfolio_trades', plan['trades'][0])
        self.reject(plan, 'Conflicting existing US trade')
        cases = [
            ('duplicate model trade key', lambda p: p['trades'].append(copy.deepcopy(p['trades'][0]))),
            ('forbidden actual field', lambda p: p['trades'][0].update(actual_price=55)),
            ('forbidden snapshot owner', lambda p: p['snapshots'][0].update(user_id=B)),
            ('wrong model gross', lambda p: p['trades'][0].update(model_notional=101)),
            ('wrong model fee', lambda p: p['trades'][0].update(fee_usd=0.5)),
            ('fractional model shares', lambda p: p['trades'][0].update(model_shares=1.5)),
            ('same-session fill', lambda p: p['trades'][0].update(signal_date=DAYS[0])),
            ('snapshot cash drift', lambda p: p['snapshots'][0].update(cash_usd=100000)),
            ('snapshot NAV drift', lambda p: p['snapshots'][0].update(nav_usd=100000)),
            ('holding valuation drift', lambda p: p['snapshots'][0]['state']['positions']['SYNTH'].update(lastPrice=101)),
            ('holding quantity invented without fill', lambda p: (
                p['snapshots'][0]['state']['positions']['SYNTH'].update(shares=2),
                p['snapshots'][0].update(nav_usd=100099.75))),
            ('SPY base drift', lambda p: p['snapshots'][3]['state'].update(basePrice=101)),
            ('operating state replaced by isolated model', lambda p: p['snapshots'][0]['state'].update(executionPolicy={})),
            ('missing state cash', lambda p: p['snapshots'][0]['state'].pop('cash')),
            ('missing cumulative fees', lambda p: p['snapshots'][0]['state'].pop('totalFees')),
        ]
        for label, mutate in cases:
            plan = self.filled_fixture()
            mutate(plan)
            try:
                self.reject(seal(plan))
            except AssertionError as error:
                raise AssertionError(label + ': ' + str(error)) from error
        self.check('Trade identity, owner/actual-field injection, fill accounting and snapshot/holding invariants fail closed')

        plan = self.fixture(pending=True)
        before = self.state()
        self.sql(f"""CREATE FUNCTION public.reject_replay_day_two() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN
            IF new.user_id='{A}' AND new.date='{DAYS[1]}' THEN
              RAISE EXCEPTION 'synthetic second-day insert failure';
            END IF; RETURN new; END $$;
          CREATE TRIGGER reject_replay_day_two BEFORE INSERT ON public.us_portfolio_snapshots
          FOR EACH ROW EXECUTE FUNCTION public.reject_replay_day_two();""")
        try:
            self.reject(plan, 'synthetic second-day insert failure')
            assert self.state() == before
        finally:
            self.sql('DROP TRIGGER reject_replay_day_two ON public.us_portfolio_snapshots; DROP FUNCTION public.reject_replay_day_two();')
        self.sql(call(plan), role='service_role')
        self.check('Real second-day write failure rolls back first-day inserts, pending changes and audit receipt; retry succeeds')

        for table in ['us_portfolio_snapshots', 'us_portfolio_trades', 'us_operating_replays']:
            plan = self.filled_fixture()
            condition = f"new.date='{DAYS[1]}' AND new.strategy_id='SPY_BENCHMARK'" if table == 'us_portfolio_snapshots' else 'true'
            self.sql(f"""CREATE FUNCTION public.skip_replay_insert() RETURNS trigger
              LANGUAGE plpgsql AS $$ BEGIN IF {condition} THEN RETURN NULL; END IF;
                RETURN new; END $$;
              CREATE TRIGGER skip_replay_insert BEFORE INSERT ON public.{table}
              FOR EACH ROW EXECUTE FUNCTION public.skip_replay_insert();""")
            try:
                self.reject(plan)
            except AssertionError as error:
                raise AssertionError('Silently skipped insert into ' + table + ': ' + str(error)) from error
            finally:
                self.sql(f'DROP TRIGGER skip_replay_insert ON public.{table}; DROP FUNCTION public.skip_replay_insert();')
        self.check('Silently suppressed snapshot, trade and audit inserts are detected and roll back all changes')

        for table, operation, mutation, expected_error in [
            ('us_portfolio_snapshots', 'INSERT', 'new.nav_usd:=new.nav_usd+1;', 'Persisted US replay snapshot differs'),
            ('us_portfolio_trades', 'INSERT', 'new.actual_price:=99;', 'Persisted US replay trade differs or has actual execution'),
            ('us_portfolio_trades', 'UPDATE', 'new.actual_price:=99;', 'US pending resolution changed protected fields'),
        ]:
            plan = self.filled_fixture()
            self.sql(f"""CREATE FUNCTION public.corrupt_replay_write() RETURNS trigger
              LANGUAGE plpgsql AS $$ BEGIN {mutation} RETURN new; END $$;
              CREATE TRIGGER corrupt_replay_write BEFORE {operation} ON public.{table}
              FOR EACH ROW EXECUTE FUNCTION public.corrupt_replay_write();""")
            try:
                self.reject(plan, expected_error)
            finally:
                self.sql(f'DROP TRIGGER corrupt_replay_write ON public.{table}; DROP FUNCTION public.corrupt_replay_write();')
        self.check('Trigger-mutated snapshots and new/existing actual fields fail postwrite verification and roll back')

        plan = self.filled_fixture()
        original = self.state()
        holder = self.locked_replay(plan)
        try:
            assert self.state() == original, 'Uncommitted replay leaked partial state'
            for statement in [
                f"UPDATE public.us_portfolio_snapshots SET cash_usd=cash_usd WHERE user_id='{A}'",
                f"UPDATE public.us_strategy_registry SET label=label WHERE user_id='{A}'",
                f"UPDATE public.us_portfolio_trades SET actual_price=101 WHERE user_id='{A}'",
            ]:
                self.sql("SET lock_timeout='200ms';" + statement, error='lock timeout')
            self.sql("SET lock_timeout='200ms';" + call(plan), error='lock timeout', role='service_role')
        finally:
            _, error = holder.communicate('COMMIT;\n', timeout=15)
            assert holder.returncode == 0, error
        retry = json.loads(self.sql(call(plan), role='service_role'))
        assert retry == self.rows('us_operating_replays')[0]['receipt']
        assert len(self.rows('us_portfolio_snapshots')) == 16
        self.check('Real concurrent legacy writers and duplicate RPC block; readers see whole old batch until commit')

        self.sql(MIGRATION.read_text())
        assert self.sql(self.catalog_sql) == self.original_catalog
        self.check('Repeated migration leaves existing data permissions and ownership policies unchanged')
        print(f'ALL {self.passed} US OPERATING REPLAY POSTGRESQL TEST GROUPS PASSED', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin-dir', type=Path, required=True)
    parser.add_argument('--pg-share-dir', type=Path)
    args = parser.parse_args()
    binaries = args.pg_bin_dir.resolve()
    for binary in ['initdb', 'pg_ctl', 'psql']:
        if not (binaries / binary).is_file():
            parser.error(f'Missing {binaries / binary}')
    env = {key: value for key, value in os.environ.items() if not key.startswith('PG')}
    env.update(PGCONNECT_TIMEOUT='2', LC_ALL='C')
    with tempfile.TemporaryDirectory(prefix='cloudtrend-us-replay-pg-') as directory:
        tmp = Path(directory)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        init = [str(binaries / 'initdb'), '-D', str(tmp / 'data'), '-A', 'trust',
                '-U', 'us_replay_test_admin', '--no-locale', '-E', 'UTF8']
        if args.pg_share_dir:
            init += ['-L', str(args.pg_share_dir.resolve())]
        subprocess.run(init, check=True, capture_output=True, text=True, env=env, timeout=30)
        ctl = [str(binaries / 'pg_ctl'), '-D', str(tmp / 'data')]
        subprocess.run(ctl + ['-l', str(tmp / 'server.log'), '-o',
                             f"-h 127.0.0.1 -p {port} -c unix_socket_directories=''", '-w', 'start'],
                       check=True, capture_output=True, text=True, env=env, timeout=30)
        try:
            base = [str(binaries / 'psql'), '-X', '-qAt', '-h', '127.0.0.1', '-p', str(port),
                    '-U', 'us_replay_test_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1']
            Suite(base, env).run()
        finally:
            subprocess.run(ctl + ['-m', 'fast', '-w', 'stop'], check=True,
                           capture_output=True, text=True, env=env, timeout=30)


if __name__ == '__main__':
    main()
