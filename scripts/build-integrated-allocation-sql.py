import pathlib,json,hashlib
root=pathlib.Path(__file__).resolve().parent.parent
source=(root/'supabase/migrations/20261009014910_cloudtrend_consistency_restart.sql').read_text()
start=source.index('CREATE OR REPLACE FUNCTION public.ledger_append_own_october_model_session')
definition=source[start:source.index('\ncreate table public.screening_run_archive',start)].strip()
body=definition.split('AS $function$',1)[1].rsplit('$function$',1)[0]
contracts=json.loads((root/'scripts/integrated-allocation-contract-templates.generated.json').read_text())
evidence=json.loads((root/'src/lib/ledger/octoberShadowCalendarEvidence.json').read_text())
canonical=lambda x:json.dumps(x,sort_keys=True,separators=(',',':'),ensure_ascii=False)
evidenceHash='sha256:'+hashlib.sha256(canonical(evidence).encode()).hexdigest()
branch=(root/'scripts/integrated-allocation-owner-branch.sql').read_text()
for kind,item in contracts.items():
 branch=branch.replace('__CONTRACT_'+kind+'__',item['contract'].replace('sha256:'+'0'*64,'__CODE_HASH__'))
 branch=branch.replace('__SOURCE_'+kind+'__',item['sourceHash'])
 branch=branch.replace('__INITIAL_'+kind+'__',item['initial'].replace('sha256:'+'0'*64,'__CODE_HASH__').replace(item['contractHash'],'__CONTRACT_HASH__'))
branch=branch.replace('__CALENDAR_HASH__',evidenceHash)
runtime=json.loads((root/'src/lib/integratedAllocationRuntime.generated.json').read_text())['codeHash']
admissions=json.loads((root/'src/lib/integratedAllocationRuntimeAdmissions.json').read_text())
assert admissions['version']=='integrated-allocation-runtime-admissions-v1'
matching=[item for item in admissions['admissions'] if item['runtimeCodeHash']==runtime]
assert len(matching)==1, 'Explicit integrated runtime review required before SQL generation'
# Existing SQL validates frozen economic identity; never replace it with new executable identity.
frozen=matching[0]['frozenCodeHash']
assert frozen=='sha256:dffdb12c0e7b79ca68d246b0f607b83bf6d1324b90cb7a50bafea79acd2332d4'
branch=branch.replace('__REVIEWED_RUNTIME_HASH__',frozen)
anchor="  if pg_catalog.jsonb_typeof(p_run) is distinct from 'object'\n     or v_id is null"
assert body.count(anchor)==1
newbody=body.replace(anchor,branch+'\n'+anchor)
newdef=definition.replace(body,newbody)
header=f'''-- Reviewed generated migration; deployment status is recorded separately.
-- Existing RPC signature, postgres owner, SECURITY DEFINER, ACL, RLS, keys and tables unchanged.
-- Only two owner-scoped integrated IDs gain an atomic first-day initialization/append branch.
-- Reviewed calendar expires 2026-12-31; calendar SHA {evidenceHash}.
-- Prior owner-RPC body is preserved verbatim after removing the marked bounded branch.
begin;
do $guard$
begin
  if not exists(select 1 from pg_catalog.pg_proc where oid='public.ledger_append_own_october_model_session(jsonb,date,text)'::regprocedure
    and pg_catalog.pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""']
    and pg_catalog.md5(prosrc) in ('{hashlib.md5(body.encode()).hexdigest()}','{hashlib.md5(newbody.encode()).hexdigest()}')) then
    raise exception 'Reviewed unchanged owner append boundary required';
  end if;
end;
$guard$;
'''
(root/'docs/integrated-allocation-owner-append.sql').write_text(header+newdef+'\ncommit;\n')
(root/'docs/integrated-allocation-owner-append.rollback.sql').write_text('-- Reviewed rollback: restore only the original function body. Never delete integrated records.\n'+header[header.index('begin;'):]+definition+'\ncommit;\n')
print(evidenceHash,hashlib.md5(body.encode()).hexdigest())
