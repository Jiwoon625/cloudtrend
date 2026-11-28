import { it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

it("manual master owner isolation, anonymous denial and revision CAS", async()=>{
  const db=new PGlite();
  const owner="11111111-1111-4111-8111-111111111111",other="22222222-2222-4222-8222-222222222222";
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema public,auth to authenticated,anon; grant execute on function auth.uid(),auth.jwt() to authenticated,anon;
      insert into auth.users values ('${owner}'),('${other}');`);
    await db.exec(readFileSync("docs/operations/manual-security-master.review.sql","utf8"));
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${owner}',false);`);
    const insert=(uid:string)=>db.query("insert into public.manual_security_master(user_id,revision,as_of,rows) values($1,1,'2026-11-28','[{}]')",[uid]);
    await insert(owner);
    await expect(insert(other)).rejects.toThrow(/row-level security/);
    const update=()=>db.query("update public.manual_security_master set revision=2,rows='[{},{}]' where user_id=$1 and revision=1 returning revision",[owner]);
    expect((await update()).rows).toEqual([{revision:2}]);expect((await update()).rows).toEqual([]);
    await expect(db.query("delete from public.manual_security_master")).rejects.toThrow(/permission denied/);
    await db.exec(`select set_config('request.jwt.claim.sub','${other}',false)`);
    expect((await db.query("select * from public.manual_security_master")).rows).toEqual([]);
    expect((await update()).rows).toEqual([]);
    await db.exec(`select set_config('request.jwt.claims','{"is_anonymous":true}',false)`);
    await expect(insert(other)).rejects.toThrow(/row-level security/);
    await db.exec("set role anon");
    await expect(db.query("select * from public.manual_security_master")).rejects.toThrow(/permission denied/);
  }finally{await db.close();}
},30000);
