import { it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { UNDERLYING_INDEX_RELEASE as release } from "../src/lib/underlyingIndexSupplementRelease";
it("backfills immutable owner receipts, survives object loss, enforces RLS and denies anonymous/update/delete", async () => {
  const db = new PGlite();
  const owner = "11111111-1111-4111-8111-111111111111",
    other = "22222222-2222-4222-8222-222222222222";
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth; create schema storage;
      create table auth.users(id uuid primary key); create table storage.objects(bucket_id text, name text);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema public,auth to authenticated,anon;
      insert into auth.users values ('${owner}'),('${other}');
      insert into storage.objects values ('cloudtrend-data','${owner}/results/ingestion/underlying-index/${release.sha256}.json');`);
    await db.exec(
      readFileSync(
        "supabase/migrations/20261017190000_operational_index_installations.sql",
        "utf8",
      ),
    );
    await db.exec("delete from storage.objects");
    await db.exec(
      `set role authenticated; select set_config('request.jwt.claim.sub','${owner}',false);`,
    );
    expect(
      (await db.query("select user_id from public.operational_index_installations")).rows,
    ).toEqual([{ user_id: owner }]);
    await expect(db.exec("delete from public.operational_index_installations")).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      db.exec("update public.operational_index_installations set installed_at=now()"),
    ).rejects.toThrow(/permission denied/);
    const insert = (uid: string) =>
      db.query(
        "insert into public.operational_index_installations(user_id,artifact_sha256,original_sha256) values($1,$2,$3)",
        [uid, release.sha256, release.originalArtifactSha256],
      );
    await expect(insert(other)).rejects.toThrow(/row-level security/);
    await db.exec(`select set_config('request.jwt.claim.sub','${other}',false)`);
    expect((await db.query("select * from public.operational_index_installations")).rows).toEqual(
      [],
    );
    await db.exec(`select set_config('request.jwt.claims','{"is_anonymous":true}',false)`);
    await expect(insert(other)).rejects.toThrow(/row-level security/);
    await db.exec("set role anon");
    await expect(db.query("select * from public.operational_index_installations")).rejects.toThrow(
      /permission denied/,
    );
  } finally {
    await db.close();
  }
}, 30_000);
