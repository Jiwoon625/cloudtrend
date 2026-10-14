from pathlib import Path
import json,subprocess,sys,os,concurrent.futures,time,shutil
R=Path(__file__).resolve().parent
def run(m,p):
 cwd=R/'official-history';log=R/'results'/f'run-{m}-{p["id"]}.log';log.parent.mkdir(exist_ok=True)
 env={**os.environ,'NODE_OPTIONS':os.environ.get('EXIT_NODE_OPTIONS','--max-old-space-size=5500')}
 cmd=[str(cwd/'node_modules/.bin/vite-node'),'--config','vitest.adopted-backtest.config.ts','scripts/exit-risk-run.ts','--',m,json.dumps(p,separators=(',',':'))]
 start=time.time()
 with log.open('w')as f:subprocess.run(cmd,cwd=cwd,env=env,stdout=f,stderr=subprocess.STDOUT,check=True)
 print('Executed',m,p['id'],round(time.time()-start,1),'seconds',flush=True)
 if not p.get('smoke'):subprocess.run([sys.executable,str(R/'verify_results.py'),m,p['id']],cwd=R,check=True,stdout=log.open('a'))
 backup=os.environ.get('EXIT_RESULTS_BACKUP_DIR')
 if backup and not p.get('smoke'):
  source=R/'results'/m/p['id'];receipt=json.load(open(source/'COMPLETE.json'));target=Path(backup)/m/p['id']/receipt['codeHash'].replace('sha256:','')[:16]
  target.parent.mkdir(parents=True,exist_ok=True)
  if not target.exists():
   temp=target.with_name(target.name+'.partial');shutil.copytree(source,temp,dirs_exist_ok=True);temp.rename(target)
  assert json.load(open(target/'COMPLETE.json'))==receipt
 return m,p['id']
def batch(jobs):
 with concurrent.futures.ThreadPoolExecutor(int(os.environ.get("EXIT_WORKERS","2")))as pool:
  for x in pool.map(lambda j:run(*j),jobs):pass
if __name__=='__main__':
 stage=sys.argv[1]
 if stage=='smoke':batch([(m,{'id':'SMOKE_OFF','smoke':True})for m in ['KOSPI','ETF']])
 elif stage=='baseline':
  batch([(m,{'id':'OFF'})for m in ['KOSPI','ETF']])
  for m in ['KOSPI','ETF']:subprocess.run([sys.executable,str(R/'baseline_compare.py'),m],check=True)
 elif stage=='base_current':batch([('KOSPI',{'id':'K0','currentExecution':True}),('ETF',{'id':'E0'})])
 elif stage=='stage1':
  jobs=[('KOSPI',{'id':'K'+str(i),'currentExecution':True,'down':d})for i,d in [(1,5),(2,4),(3,3)]]
  jobs +=[('KOSPI',{'id':'K'+str(i),'currentExecution':True,'stop':d})for i,d in [(4,.08),(5,.10),(6,.12)]]
  jobs +=[('ETF',{'id':'E'+str(i),'ma':d})for i,d in [(1,20),(2,60)]]
  jobs +=[('ETF',{'id':'E'+str(i),'trail':d})for i,d in [(3,.08),(4,.10),(5,.12)]]
  jobs +=[('ETF',{'id':'E_MA'+str(d)+'_ONLY','ma':d,'replaceIndex':True})for d in [20,60]]
  batch(jobs)
 elif stage=='file':batch(json.load(open(sys.argv[2])))
