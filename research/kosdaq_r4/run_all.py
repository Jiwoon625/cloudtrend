"""Offline, Drive-resumable R4 reproduction from the private delivery ZIP."""
import argparse,hashlib,json,pathlib,subprocess,sys,time,shutil
from metrics import sha,save
def main():
 p=argparse.ArgumentParser();p.add_argument('--workspace',type=pathlib.Path,required=True);p.add_argument('--run-dir',type=pathlib.Path,required=True);p.add_argument('--node',default='node');a=p.parse_args();W=a.workspace.resolve();R=a.run_dir.resolve();R.mkdir(parents=True,exist_ok=True);S=W/'research/kosdaq_r4';I=W/'inputs';L=W/'long-inputs';manifest=json.loads((W/'DELIVERY_MANIFEST.json').read_text());identity=hashlib.sha256(json.dumps(manifest,sort_keys=True).encode()).hexdigest();py=sys.executable
 for f in manifest['files']:
  if f['path'].startswith(('research/','inputs/','long-inputs/','engine-original/','runs/p123-r3-')):assert sha(W/f['path'])==f['sha256'],'Changed delivery input: '+f['path']
 assert int(subprocess.check_output([a.node,'--version'],text=True).strip().lstrip('v').split('.')[0])>=24,'Node 24 required'
 def ps(name,args):return [py,str(S/name),*map(str,args)]
 def node(engine,script,args):return [a.node,'--no-warnings','--loader',str(R/engine/'research-loader.mjs'),str(S/script),*map(str,args)]
 steps=[]
 for engine,flags in [('engine',[]),('engine-strict',['--strict-observed-exits']),('engine-exploratory',['--strict-observed-exits','--profit-exit-replacement'])]:steps.append((engine,ps('prepare_engine.py',['--source',W/'engine-original','--output',R/engine,*flags]),R/engine))
 steps.extend([('engine-tests',node('engine','test_engine.ts',[R/'engine']),None),('strict-engine-tests',node('engine-strict','test_engine.ts',[R/'engine-strict']),None),('exploratory-tests',node('engine-exploratory','test_exploratory.ts',[R/'engine-exploratory']),None),('replay-tests',ps('test_replay.py',[]),None)])
 for name,engine,runner,protocol in [('accounts','engine','runner.ts','protocol.json'),('strict-accounts','engine-strict','runner.ts','protocol.json'),('exploratory-accounts','engine-exploratory','runner_exploratory.ts','protocol_exploratory.json')]:steps.append((name,node(engine,runner,[R/engine,L,I,R/name,S/protocol]),R/name))
 steps.append(('ticket',ps('recent.py',['--workspace',W,'--inputs',I,'--protocol',S/'protocol.json','--output',R/'ticket']),R/'ticket'))
 steps.append(('ticket-exploratory',ps('recent.py',['--workspace',W,'--inputs',I,'--protocol',S/'protocol_exploratory.json','--output',R/'ticket-exploratory']),R/'ticket-exploratory'))
 steps.append(('ticket-fixed',ps('ticket_fixed.py',['--inputs',I,'--protocol',S/'protocol.json','--exploratory-protocol',S/'protocol_exploratory.json','--output',R/'ticket-fixed']),R/'ticket-fixed'))
 for name,account,protocol,flags in [('analysis','accounts','protocol.json',[]),('strict-analysis','strict-accounts','protocol.json',['--strict-observed-exits']),('exploratory-analysis','exploratory-accounts','protocol_exploratory.json',['--strict-observed-exits'])]:steps.append((name,ps('analyze.py',['--workspace',W,'--accounts',R/account,'--inputs',I,'--long-inputs',L,'--protocol',S/protocol,'--output',R/name,*flags]),R/name))
 steps.append(('supplement',ps('supplement.py',['--legacy',R/'accounts','--strict',R/'strict-accounts','--legacy-analysis',R/'analysis','--strict-analysis',R/'strict-analysis','--long-inputs',L,'--recent-input',I/'recent_account_input.json','--output',R/'supplement']),R/'supplement'))
 for name,cmd,out in steps:
  marker=R/(name+'.step.json');log=R/(name+'.log')
  if marker.exists():
   m=json.loads(marker.read_text());assert m['identity']==identity and m['command']==cmd,'Changed experiment; choose a new run directory'
   for n,h in m['files'].items():assert sha(R/n)==h,'Changed checkpoint: '+n
   print(name+': verified saved checkpoint',flush=True);continue
  if name.startswith('engine') and name in ['engine','engine-strict','engine-exploratory'] and out.exists():out.rename(out.with_name(out.name+'.interrupted_'+str(time.time_ns())))
  print(name+': running; saved at '+str(R),flush=True);started=time.time()
  with log.open('a') as f:r=subprocess.run(cmd,cwd=W,stdout=f,stderr=subprocess.STDOUT)
  if r.returncode:raise RuntimeError(name+' failed; inspect '+str(log))
  files={str(p.relative_to(R)):sha(p) for p in out.rglob('*') if p.is_file() and '__pycache__' not in p.parts} if out else {log.name:sha(log)};save(marker,dict(status='PASS',identity=identity,command=cmd,files=files,elapsed_seconds=time.time()-started))
 save(R/'COMPLETE.json',dict(status='PASS',identity=identity,steps=[n for n,_,_ in steps],no_operational_or_network_writes=True));print('R4 completed; all outputs saved to Drive run directory.',flush=True)
if __name__=='__main__':main()
