import { it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
it("isolates owners, denies anonymous users, preserves history and rejects concurrent stale writes in PostgreSQL", async () => {
  const db = new PGlite();
  const owner = "11111111-1111-4111-8111-111111111111",
    other = "22222222-2222-4222-8222-222222222222";
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema public,auth to authenticated,anon; grant execute on function auth.uid(),auth.jwt() to authenticated,anon;
      insert into auth.users values ('${owner}'),('${other}');`);
    await db.exec(
      readFileSync("supabase/migrations/20261017080545_actual_entry_decisions.sql", "utf8"),
    );
    await db.exec(
      `set role authenticated; select set_config('request.jwt.claim.sub','${owner}',false);`,
    );
    const insert = (uid: string) =>
      db.query(
        "insert into public.actual_entry_decisions(user_id,revision,events) values($1,1,$2)",
        [uid, JSON.stringify([{ id: "first" }])],
      );
    await insert(owner);
    await expect(insert(other)).rejects.toThrow(/row-level security/);
    await db.exec(`select set_config('request.jwt.claim.sub','${other}',false)`);
    expect((await db.query("select * from public.actual_entry_decisions")).rows).toEqual([]);
    expect(
      (
        await db.query(
          "update public.actual_entry_decisions set revision=2,events='[{},{}]' where user_id=$1 returning revision",
          [owner],
        )
      ).rows,
    ).toEqual([]);
    await db.exec(`select set_config('request.jwt.claim.sub','${owner}',false)`);
    await expect(
      db.query(
        'update public.actual_entry_decisions set revision=2,events=\'[{"id":"changed"},{}]\' where user_id=$1',
        [owner],
      ),
    ).rejects.toThrow(/appended/);
    const update = () =>
      db.query(
        'update public.actual_entry_decisions set revision=2,events=\'[{"id":"first"},{"id":"release"}]\' where user_id=$1 and revision=1 returning revision',
        [owner],
      );
    expect((await update()).rows).toEqual([{ revision: 2 }]);
    expect((await update()).rows).toEqual([]);
    await expect(db.query("delete from public.actual_entry_decisions")).rejects.toThrow(
      /permission denied/,
    );
    await db.exec(`select set_config('request.jwt.claims','{"is_anonymous":true}',false)`);
    expect((await db.query("select * from public.actual_entry_decisions")).rows).toEqual([]);
    await db.exec(`select set_config('request.jwt.claim.sub','${other}',false)`);
    await expect(insert(other)).rejects.toThrow(/row-level security/);
    await db.exec("set role anon");
    await expect(db.query("select * from public.actual_entry_decisions")).rejects.toThrow(
      /permission denied/,
    );
  } finally {
    await db.close();
  }
}, 30_000);
