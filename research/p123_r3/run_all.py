"""Offline reproduction with Drive-resident, identity-bound step checkpoints."""
import argparse,hashlib,json,pathlib,subprocess,sys,time
from metrics import save,sha
def main():
 p=argparse.ArgumentParser();p.add_argument('--workspace',type=pathlib.Path,required=True);p.add_argument('--run-dir',type=pathlib.Path,required=True);p.add_argument('--node',default='node');a=p.parse_args();W=a.workspace.resolve();O=a.run_dir.resolve();E=W/'evidence';S=W/'cloudtrend/research/p123_r3';O.mkdir(parents=True,exist_ok=True)
 # The outer identity binds every executable script and every bounded input in
 # the delivery manifest. An edited input never resumes an old experiment.
 man=json.loads((W/'DELIVERY_MANIFEST.json').read_text());identity=hashlib.sha256(json.dumps(man,sort_keys=True).encode()).hexdigest()
 for f in man['files']:
  if f['path'].startswith(('cloudtrend/','evidence/')) and sha(W/f['path'])!=f['sha256']:raise ValueError('Delivery input/code changed: '+f['path'])
 frozen=E/'kosdaq-long/CloudTrend_KOSDAQ_Fixed05to20_Analysis_20261023/frozen_research';engine=frozen/'overlay';loader=str(engine/'research-loader.mjs');P=lambda s:str(O/s);py=sys.executable
 steps=[('tests',[py,str(S/'test_research.py')]),('recent',[py,str(S/'analyze_recent.py'),'--evidence',str(E),'--output',P('recent')]),('long_kr',[a.node,'--no-warnings','--loader',loader,str(S/'long_kr_runner.ts'),str(engine),str(frozen/'inputs-cap-restored'),P('long-kr'),str(S/'long_kr_specs.json')]),('long_analysis',[py,str(S/'analyze_long.py'),'--evidence',str(E),'--accounts',P('long-kr'),'--output',P('long-analysis')]),('prepare_accounts',[py,str(S/'prepare_accounts.py'),'--evidence',str(E),'--recent',P('recent'),'--output',P('account-inputs')]),('official_accounts',[a.node,'--no-warnings','--loader',loader,str(S/'account_runner.ts'),str(W/'cloudtrend'),str(engine),P('account-inputs'),P('official-accounts')]),('account_audit',[py,str(S/'analyze_accounts.py'),'--inputs',P('account-inputs'),'--accounts',P('official-accounts'),'--output',P('official-analysis')]),('diagnostics',[py,str(S/'diagnostics.py'),'--evidence',str(E),'--recent',P('recent'),'--long-analysis',P('long-analysis'),'--account-inputs',P('account-inputs'),'--official-accounts',P('official-accounts'),'--output',P('diagnostics')])]
 for name,cmd in steps:
  marker=O/(name+'.step.json')
  if marker.exists():
   old=json.loads(marker.read_text())
   if old['identity']!=identity or old['command']!=cmd:raise ValueError('Resume identity changed; use another run directory')
   for n,h in old['files'].items():
    if sha(O/n)!=h:raise ValueError('Checkpoint changed: '+n)
   print(name+': verified checkpoint',flush=True);continue
  print(name+': running; log and checkpoints saved under '+str(O),flush=True);start=time.time();log=O/(name+'.log')
  with log.open('a') as f:r=subprocess.run(cmd,cwd=W,stdout=f,stderr=subprocess.STDOUT)
  if r.returncode:raise RuntimeError(name+' failed; see '+str(log))
  outputs={'recent':'recent','long_kr':'long-kr','long_analysis':'long-analysis','prepare_accounts':'account-inputs','official_accounts':'official-accounts','account_audit':'official-analysis','diagnostics':'diagnostics'};folder=O/outputs[name] if name in outputs else None;files={str(z.relative_to(O)):sha(z) for z in folder.rglob('*') if z.is_file()} if folder else {log.name:sha(log)}
  save(marker,dict(identity=identity,command=cmd,elapsed_seconds=time.time()-start,files=files,status='PASS'))
 save(O/'COMPLETE.json',dict(status='PASS',identity=identity,steps=[n for n,_ in steps],no_network_or_operational_writes=True));print('All eight steps completed and saved.',flush=True)
if __name__=='__main__':main()
