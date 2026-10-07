#!/usr/bin/env python3
"""Real PostgreSQL atomic-compaction tests using synthetic data only.

Creates/stops its own disposable loopback cluster; accepts no database URL or
existing data directory. Run with --pg-bin-dir and optional --pg-share-dir.
"""
import argparse
import copy
from datetime import datetime, timedelta
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / 'supabase/migrations/20261006155556_atomic_screening_source_compaction.sql'
A = '11111111-1111-4111-8111-111111111111'
B = '22222222-2222-4222-8222-222222222222'
H = 'sha256:' + 'a' * 64
H2 = 'sha256:' + 'b' * 64
KEYS = ['id', 'user_id', 'source_type', 'original_filename', 'storage_bucket',
        'storage_path', 'content_type', 'canonical_format', 'file_size_bytes',
        'normalized_size_bytes', 'file_hash', 'data_hash', 'schema_hash', 'row_count',
        'upload_source', 'created_at', 'activated_at', 'min_date', 'max_date']


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def jl(value):
    return literal(json.dumps(value)) + '::jsonb'


def call(parents, candidates, verification, operation, owner=A):
    return ('select public.compact_screening_source_set('
            f'{literal(owner)}, {literal(operation)}, {jl(parents)}, '
            f'{jl(candidates)}, {jl(verification)});')


class Suite:
    def __init__(self, base, env):
        self.base, self.env = base, env
        self.passed = 0

    def sql(self, text, error=None, role=None):
        prefix = "set timezone='UTC';" + (f'set role {role};' if role else '')
        result = subprocess.run(self.base, input=prefix + text, capture_output=True,
                                text=True, env=self.env, timeout=20)
        if error:
            assert result.returncode != 0 and error in result.stderr, result.stderr
        else:
            assert result.returncode == 0, result.stderr
        return result.stdout.strip()

    def check(self, label):
        self.passed += 1
        print(f'PASS {self.passed:02d}: {label}', flush=True)

    def snapshot(self):
        return self.sql('select jsonb_agg(to_jsonb(s) order by id) from public.analysis_source_files s;')

    def fixture(self):
        self.sql('truncate public.analysis_source_files;')
        ids = [str(uuid.UUID(int=i + 1)) for i in range(6)]
        for index, ident in enumerate(ids):
            owner = B if index == 5 else A
            active = index < 3 or index == 5
            self.sql(f'''insert into public.analysis_source_files(
              id,user_id,source_type,original_filename,storage_bucket,storage_path,
              content_type,canonical_format,file_size_bytes,normalized_size_bytes,
              file_hash,data_hash,schema_hash,row_count,symbol_count,upload_source,
              status,validation_result,created_at,activated_at,min_date,max_date)
              values ({literal(ident)},{literal(owner)},'screening','part.csv','cloudtrend-data',
              {literal(owner + '/source/screening/' + ident + '/part.csv')},'text/csv','csv',
              100,100,{literal(H)},{literal(H)},{literal(H)},3,1,
              {literal('gpt' if active else 'migration')},
              {literal('active' if active else 'valid')},
              {jl({'valid': True, 'hashes': {'file': H, 'data': H, 'schema': H}, 'original': index})},
              {literal(f'2026-10-01T00:00:0{index}Z')},
              {literal(f'2026-10-02T00:00:0{index}Z') if active else 'null'},'2026-01-01','2026-09-30');''')
        self.sql('truncate storage.objects;')
        self.sql("insert into storage.objects(id,bucket_id,name,version) select id,storage_bucket,storage_path,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' from public.analysis_source_files;")
        rows = json.loads(self.snapshot())
        parents = [{k: row[k] for k in KEYS} for row in rows[:3]]
        candidates = [{k: row[k] for k in KEYS} for row in rows[3:5]]
        for descriptor in parents + candidates:
            descriptor.update(storage_object_id=descriptor['id'], storage_object_version='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
        verification = dict(schema_version=103, algorithm='screening-compaction-v1',
                            source_fingerprint=H, candidate_fingerprint=H2,
                            dataset_before=H, dataset_after=H, analysis_before=H2,
                            analysis_after=H2, timing_before=H, timing_after=H, effective_rows_before=6,
                            effective_rows_after=6, config_hash=H, code_version='synthetic-v1')
        return parents, candidates, verification, str(uuid.uuid4())

    def descriptors(self, condition):
        rows = json.loads(self.sql("select jsonb_agg(to_jsonb(s) order by activated_at nulls first,created_at,id) from public.analysis_source_files s where " + condition))
        result = [{k: row[k] for k in KEYS} for row in rows]
        for descriptor in result:
            descriptor.update(storage_object_id=descriptor['id'], storage_object_version='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
        return result

    def second_compaction(self):
        first = self.fixture()
        receipt = json.loads(self.sql(call(*first), role='service_role'))
        # Two previously compacted parents share all three original origins.
        # Add one new raw source, then create a single staged replacement.
        # Cutover activation uses clock_timestamp(), so a fixed calendar date
        # eventually puts the new raw source before the compacted parents.
        created_at = datetime.fromisoformat(receipt['committed_at']) + timedelta(seconds=1)
        activated_at = created_at + timedelta(seconds=1)
        for number, status, rows in [(7, 'active', 3), (8, 'valid', 9)]:
            ident = str(uuid.UUID(int=number))
            extra = dict(id=ident, storage_path=f'{A}/source/screening/{ident}/part.csv',
                         status=status, row_count=rows, superseded_by=None,
                         created_at=created_at.isoformat(),
                         activated_at=activated_at.isoformat() if status == 'active' else None,
                         validation_result={'valid':True,'hashes':{'file':H,'data':H,'schema':H}})
            self.sql("insert into public.analysis_source_files select (jsonb_populate_record(null::public.analysis_source_files,to_jsonb(s)||" + jl(extra) + ")).* from public.analysis_source_files s where id=" + literal(first[1][0]['id']))
            self.sql("insert into storage.objects(id,bucket_id,name,version) select id,storage_bucket,storage_path,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' from public.analysis_source_files where id=" + literal(ident))
        parents = self.descriptors(f"user_id='{A}' and status='active'")
        assert [parent['id'] for parent in parents] == receipt['candidate_ids'] + [str(uuid.UUID(int=7))]
        candidate = self.descriptors(f"id='{str(uuid.UUID(int=8))}'")
        verification = {**first[2], 'effective_rows_before':9, 'effective_rows_after':9}
        second = (parents,candidate,verification,str(uuid.uuid4()))
        expected = receipt['original_source_evidence'] + [{k: parents[-1][k] for k in ['id','min_date','max_date','activated_at','created_at']}]
        return second, expected

    def reject(self, args, error):
        before = self.snapshot()
        self.sql(call(*args), error=error, role='service_role')
        assert self.snapshot() == before, 'Rejected request changed database state'

    def locked_session(self, command):
        proc = subprocess.Popen(self.base, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, env=self.env)
        proc.stdin.write('begin;\n' + command + '\n\\echo LOCKED\n')
        proc.stdin.flush()
        assert proc.stdout.readline().strip() == 'LOCKED'
        return proc

    def unlock(self, proc, command='rollback;'):
        out, err = proc.communicate(command + '\n', timeout=10)
        assert proc.returncode == 0, err

    def run(self):
        self.sql(f"""
          create role anon; create role authenticated; create role service_role bypassrls;
          create schema storage;
          create table storage.buckets(id text primary key, public boolean not null);
          insert into storage.buckets values('cloudtrend-data',false);
          create table storage.objects(id uuid primary key, bucket_id text, name text, version text, unique(bucket_id,name));
          grant usage on schema storage to service_role;
          grant select,update on storage.objects,storage.buckets to service_role;
          create schema auth;
          create table auth.users(id uuid primary key);
          insert into auth.users values ('{A}'),('{B}');
          create function auth.uid() returns uuid language sql stable as
          'select nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
          grant usage on schema public, auth to anon, authenticated, service_role;
          grant execute on function auth.uid() to anon, authenticated, service_role;
        """)
        schema = (ROOT / 'supabase/migrations/20260910182823_add_analysis_source_files.sql').read_text()
        self.sql(schema.split('-- The bucket remains private.', 1)[0])
        self.sql((ROOT / 'supabase/migrations/20260910234943_harden_source_activation_and_add_merge.sql').read_text())
        security = '''select jsonb_build_object('acl',c.relacl::text,'rls',c.relrowsecurity,
          'policies',(select jsonb_agg(to_jsonb(p) order by policyname) from pg_policies p
          where schemaname='public' and tablename='analysis_source_files'))::text
          from pg_class c where c.oid='public.analysis_source_files'::regclass;'''
        before = self.sql(security)
        self.sql(MIGRATION.read_text())
        assert self.sql(security) == before
        assert self.sql("select prosecdef from pg_proc where oid='public.compact_screening_source_set(uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure") == 'f'
        args = self.fixture()
        for role in ['anon', 'authenticated']:
            self.sql(call(*args), error='permission denied for function', role=role)
        self.sql(call(*args), error='requires service_role')
        self.check('SECURITY INVOKER, service-only ACL and unchanged registry RLS/grants')

        original = json.loads(self.snapshot())
        result = json.loads(self.sql(call(*args), role='service_role'))
        assert result['reused'] is False and result['candidate_ids'] == [r['id'] for r in args[1]]
        expected_evidence = [{k: row[k] for k in ['id','min_date','max_date','activated_at','created_at']} for row in original[:3]]
        assert result['original_source_evidence'] == expected_evidence
        after = json.loads(self.snapshot())
        assert len(after) == len(original) and after[5] == original[5]
        for old, new in zip(original[:3], after[:3]):
            assert new['status'] == 'superseded' and new['activated_at'] == old['activated_at']
            assert new['created_at'] == old['created_at'] and new['storage_path'] == old['storage_path']
            assert new['file_hash'] == old['file_hash']
            assert new['validation_result']['original'] == old['validation_result']['original']
        for i, row in enumerate(after[3:5]):
            assert row['status'] == 'active'
            receipt = row['validation_result']['screeningCompaction']
            assert receipt['candidate_order'] == i
            assert receipt['original_source_evidence'] == expected_evidence
            assert receipt['request']['parents'] == args[0], (receipt['request']['parents'], args[0])
        assert self.sql(f"select extract(epoch from (max(activated_at)-min(activated_at))) from public.analysis_source_files where user_id='{A}' and status='active'") == '0.000001'
        self.check('Atomic 3-to-2 cutover retains original rows/paths/hashes and records all-parent provenance in exact order')
        committed = self.snapshot()
        retry = json.loads(self.sql(call(*args), role='service_role'))
        assert retry['reused'] is True and self.snapshot() == committed
        assert {k:v for k,v in retry.items() if k != 'reused'} == {k:v for k,v in result.items() if k != 'reused'}
        self.check('Identical retry is read-only with stable receipt and no metadata churn')
        conflict = copy.deepcopy(args); conflict[2]['code_version'] = 'changed'
        self.reject(conflict, 'receipt conflicts')
        self.sql(f"update public.analysis_source_files set status='archived' where id='{args[1][1]['id']}'")
        self.reject(args, 'active source set is stale')
        self.check('Changed retry payload and subsequent active-set drift fail closed')

        cases = [
            ('dataset digest mismatch', lambda a: a[2].update(dataset_after=H2), 'equivalence verification failed'),
            ('timing digest mismatch', lambda a: a[2].update(timing_after=H2), 'equivalence verification failed'),
            ('missing timing digest', lambda a: a[2].pop('timing_before'), 'verification contract'),
            ('original min date changed', lambda a: a[0][0].update(min_date='2026-01-02'), 'descriptor changed'),
            ('original max date changed', lambda a: a[0][0].update(max_date='2026-09-29'), 'descriptor changed'),
            ('analysis digest mismatch', lambda a: a[2].update(analysis_after=H), 'equivalence verification failed'),
            ('schema marker mismatch', lambda a: a[2].update(schema_version=101), 'verification contract'),
            ('null verification digest', lambda a: a[2].update(dataset_before=None), 'verification hash'),
            ('missing verification field', lambda a: a[2].pop('config_hash'), 'verification contract'),
            ('wrong effective row count', lambda a: a[2].update(effective_rows_before=7,effective_rows_after=7), 'candidate row count'),
            ('duplicate candidate ids', lambda a: a[1].__setitem__(1, a[1][0]), 'unique and disjoint'),
            ('overlapping candidate/parent ids', lambda a: a[1][0].update(id=a[0][0]['id'],storage_path=a[0][0]['storage_path']), 'unique and disjoint'),
            ('candidate wrong owner', lambda a: a[1][0].update(user_id=B), 'descriptor ownership'),
            ('candidate wrong path', lambda a: a[1][0].update(storage_path=f'{A}/source/screening/elsewhere/part.csv'), 'descriptor ownership'),
            ('candidate wrong bucket', lambda a: a[1][0].update(storage_bucket='public'), 'descriptor ownership'),
            ('candidate too large', lambda a: a[1][0].update(file_size_bytes=47185921), 'descriptor ownership'),
            ('candidate already activated', lambda a: a[1][0].update(activated_at='2026-10-01T00:00:00Z'), 'newly staged'),
            ('wrong candidate origin', lambda a: a[1][0].update(upload_source='web'), 'newly staged'),
            ('missing descriptor field', lambda a: a[0][0].pop('created_at'), 'descriptor keys'),
            ('unexpected descriptor field', lambda a: a[0][0].update(extra='unexpected'), 'descriptor keys'),
            ('parent order changed', lambda a: a[0].reverse(), 'active source set is stale'),
            ('parent hash changed', lambda a: a[0][0].update(file_hash=H2), 'descriptor changed'),
            ('candidate hash changed', lambda a: a[1][0].update(data_hash=H2), 'descriptor changed'),
            ('parent activation changed', lambda a: a[0][0].update(activated_at='2026-10-03T00:00:00Z'), 'descriptor changed'),
        ]
        for label, mutate, error in cases:
            args = list(self.fixture()); mutate(args); self.reject(args, error)
            self.check(label + ' rejected without mutation')

        args = self.fixture()
        self.sql(f"update public.analysis_source_files set status='invalid' where id='{args[1][0]['id']}'")
        self.reject(args, 'candidate state or validation changed')
        args = self.fixture()
        self.sql(f"update public.analysis_source_files set validation_result=jsonb_set(validation_result,'{{valid}}','false') where id='{args[1][0]['id']}'")
        self.reject(args, 'candidate state or validation changed')
        args = self.fixture()
        self.sql(f"update public.analysis_source_files set validation_result=jsonb_set(validation_result,'{{hashes,file}}','\"{H2}\"') where id='{args[1][0]['id']}'")
        self.reject(args, 'candidate state or validation changed')
        self.check('Invalid staged status, validation flag and inconsistent validation hashes rejected')

        args = self.fixture()
        self.sql(f"update public.analysis_source_files set status='active',activated_at=now() where id='{args[1][0]['id']}'")
        self.reject(args, 'active source set is stale')
        args = self.fixture()
        self.sql(call(*args, owner=B), error='descriptor ownership', role='service_role')
        self.sql(f"set role service_role; set request.jwt.claim.sub='{B}';" + call(*args), error='owner mismatch')
        self.sql('begin isolation level repeatable read;set role service_role;' + call(*args), error='READ COMMITTED')
        self.check('Unexpected active source, owner/JWT mismatch and stale-snapshot isolation rejected')

        for target in [0, 3]:
            args = self.fixture()
            ident = (args[0] + args[1])[target]['storage_object_id']
            self.sql(f"update storage.objects set version='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' where id='{ident}'")
            self.reject(args, 'descriptor changed')
            args = self.fixture()
            self.sql(f"delete from storage.objects where id='{ident}'")
            self.reject(args, 'Storage object is missing')
        args = self.fixture()
        self.sql("update storage.buckets set public=true")
        self.reject(args, 'existing private bucket')
        self.sql("update storage.buckets set public=false")
        self.check('Parent/candidate generation overwrite, object deletion and public bucket rejected')

        args = self.fixture()
        holder = self.locked_session(f"do $$ begin perform id from storage.objects where id='{args[1][0]['storage_object_id']}' for update; end $$;")
        try:
            self.reject(args, 'could not obtain lock on row')
        finally:
            self.unlock(holder)
        self.check('Concurrent Storage overwrite lock fails retryably before any registry mutation')

        args = self.fixture()
        # Fail only after originals and candidate 1 have been updated.
        self.sql(f'''create function public.fail_second_candidate() returns trigger language plpgsql as $$
          begin if new.id='{args[1][1]['id']}' and new.status='active' then raise exception 'injected late failure'; end if; return new; end; $$;
          create trigger fail_second_candidate before update on public.analysis_source_files
          for each row execute function public.fail_second_candidate();''')
        self.reject(args, 'injected late failure')
        self.sql('drop trigger fail_second_candidate on public.analysis_source_files; drop function public.fail_second_candidate();')
        self.check('Late candidate-2 failure rolls back every earlier parent/candidate/provenance update')

        args = self.fixture()
        self.sql(f"""create function public.skip_candidate() returns trigger language plpgsql as $$
          begin if new.id='{args[1][1]['id']}' then return null; end if; return new; end; $$;
          create trigger skip_candidate before update on public.analysis_source_files
          for each row execute function public.skip_candidate();""")
        self.reject(args, 'candidate update was incomplete')
        self.sql('drop trigger skip_candidate on public.analysis_source_files; drop function public.skip_candidate();')
        self.check('Silently skipped candidate update is detected and the entire cutover rolls back')

        args = self.fixture()
        holder = self.locked_session(f"do $$ begin perform pg_advisory_xact_lock(hashtextextended('{A}:screening',0)); end $$;")
        try:
            self.reject(args, 'source set is busy')
        finally:
            self.unlock(holder)
        holder = self.locked_session(f"do $$ begin perform id from public.analysis_source_files where id='{args[0][0]['id']}' for update; end $$;")
        try:
            self.reject(args, 'could not obtain lock on row')
        finally:
            self.unlock(holder)
        holder = self.locked_session('lock table public.analysis_source_files in row exclusive mode;')
        try:
            self.reject(args, 'could not obtain lock on relation')
        finally:
            self.unlock(holder)
        assert json.loads(self.sql(call(*args), role='service_role'))['reused'] is False
        self.check('Real advisory, row-first activation and concurrent writer contention fail retryably; same request succeeds after release')

        args = self.fixture()
        holder = self.locked_session('set role service_role;do $$ begin ' + call(*args).replace('select public.', 'perform public.', 1) + ' end $$;')
        try:
            self.sql("set lock_timeout='200ms'; update public.analysis_source_files set status='archived' where status='valid';", error='lock timeout')
            self.sql(f"set lock_timeout='200ms';set role service_role;select public.activate_analysis_source_file('{args[0][0]['id']}','append');", error='lock timeout')
            self.sql("set lock_timeout='200ms'; update storage.objects set version='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' where id=" + literal(args[1][0]['id']), error='lock timeout')
            self.sql("set lock_timeout='200ms'; update storage.buckets set public=true where id='cloudtrend-data'", error='lock timeout')
            # Other sessions still observe the entire old set until COMMIT.
            assert self.sql(f"select count(*) from public.analysis_source_files where user_id='{A}' and status='active'") == '3'
        finally:
            self.unlock(holder, 'commit;')
        assert self.sql(f"select count(*) from public.analysis_source_files where user_id='{A}' and status='active'") == '2'
        self.check('Uncommitted cutover exposes complete old set, blocks direct/legacy mutations, then publishes complete new set')

        args = self.fixture()
        args[0][1]['activated_at'] = args[0][0]['activated_at']
        args[0][1]['created_at'] = args[0][0]['created_at']
        self.sql(f"update public.analysis_source_files set activated_at={literal(args[0][0]['activated_at'])},created_at={literal(args[0][0]['created_at'])} where id='{args[0][1]['id']}'")
        self.reject(args, 'ordering is ambiguous')
        self.check('Ambiguous legacy parent precedence rejected rather than silently reordered')
        args = self.fixture()
        self.sql(f"update public.analysis_source_files set validation_result='[]' where id='{args[0][0]['id']}'")
        self.reject(args, 'validation metadata must be an object')
        self.check('Malformed original provenance container rejected before cutover')
        second, expected = self.second_compaction()
        result = json.loads(self.sql(call(*second), role='service_role'))
        assert result['original_source_evidence'] == expected
        assert len(result['original_source_evidence']) == 4
        assert not {p['id'] for p in second[0][:2]} & {p['id'] for p in expected}
        committed = self.snapshot()
        assert json.loads(self.sql(call(*second), role='service_role'))['reused'] is True
        assert self.snapshot() == committed
        self.check('Repeated compaction flattens shared provenance, deduplicates original IDs and preserves original capture times')

        second, expected = self.second_compaction()
        parent_id = second[0][1]['id']
        self.sql(f"update public.analysis_source_files set validation_result=jsonb_set(validation_result,'{{screeningCompaction,original_source_evidence,0,created_at}}','\"2026-10-05T00:00:00Z\"') where id='{parent_id}'")
        self.reject(second, 'conflicts for duplicate origin')
        self.check('Conflicting duplicate origin timing evidence fails closed')

        second, expected = self.second_compaction()
        origin_id = expected[0]['id']
        self.sql(f"update public.analysis_source_files set activated_at='2026-10-05T00:00:00Z' where id='{origin_id}'")
        self.reject(second, 'differs from authoritative source')
        self.check('Inherited evidence is checked against retained authoritative origin timestamps')

        second, expected = self.second_compaction()
        parent_id = second[0][0]['id']
        self.sql(f"update public.analysis_source_files set validation_result=validation_result #- '{{screeningCompaction,original_source_evidence}}' where id='{parent_id}'")
        self.reject(second, 'inherited original timing evidence is missing')
        self.check('Prior compaction missing original timing evidence cannot masquerade as fresh raw data')

        second, expected = self.second_compaction()
        self.sql(f"update public.analysis_source_files set user_id='{B}',storage_path=replace(storage_path,'{A}','{B}') where id='{expected[0]['id']}'")
        self.reject(second, 'missing or belongs to another owner')
        self.check('Cross-owner inherited origin evidence rejected')

        args = self.fixture()
        self.sql(f"update public.analysis_source_files set activated_at=null,min_date=null,max_date=null where id='{args[0][0]['id']}'")
        args[0][0].update(activated_at=None,min_date=None,max_date=None)
        result = json.loads(self.sql(call(*args), role='service_role'))
        assert result['original_source_evidence'][0]['activated_at'] is None
        assert result['original_source_evidence'][0]['min_date'] is None
        assert result['original_source_evidence'][0]['created_at'] == args[0][0]['created_at']
        self.check('Nullable date/activation evidence preserves original created_at fallback without inventing collection times')

        self.sql(MIGRATION.read_text())
        assert self.sql(security) == before
        self.check('Repeated migration preserves ACL/RLS and existing activation function')
        print(f'ALL {self.passed} POSTGRESQL TEST GROUPS PASSED', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin-dir', type=Path, required=True)
    parser.add_argument('--pg-share-dir', type=Path)
    args = parser.parse_args()
    binaries = args.pg_bin_dir.resolve()
    env = {key: value for key, value in os.environ.items() if not key.startswith('PG')}
    with tempfile.TemporaryDirectory(prefix='cloudtrend-compaction-pg-') as directory:
        tmp = Path(directory)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
        init = [str(binaries / 'initdb'), '-D', str(tmp / 'data'), '-A', 'trust',
                '-U', 'compaction_test_admin', '--no-locale', '-E', 'UTF8']
        if args.pg_share_dir:
            init += ['-L', str(args.pg_share_dir.resolve())]
        subprocess.run(init, check=True, capture_output=True, text=True, env=env)
        ctl = [str(binaries / 'pg_ctl'), '-D', str(tmp / 'data')]
        subprocess.run(ctl + ['-l', str(tmp / 'server.log'), '-o',
                             f"-h 127.0.0.1 -p {port} -c unix_socket_directories=''", '-w', 'start'],
                       check=True, capture_output=True, text=True, env=env)
        try:
            base = [str(binaries / 'psql'), '-X', '-qAt', '-h', '127.0.0.1', '-p', str(port),
                    '-U', 'compaction_test_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1']
            Suite(base, env).run()
        finally:
            subprocess.run(ctl + ['-m', 'fast', '-w', 'stop'], check=True,
                           capture_output=True, text=True, env=env)


if __name__ == '__main__':
    main()
