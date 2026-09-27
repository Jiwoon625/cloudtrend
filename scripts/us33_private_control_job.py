"""Run private research without public logs, artifacts, or input caches."""
from pathlib import Path
import os,subprocess,sys,json
import requests
import us3_supabase_io as storage

def main():
    url,key=storage.env()
    r=requests.get(f'{url}/storage/v1/bucket/{storage.BUCKET}',headers=storage.headers(key),timeout=30,allow_redirects=False)
    if r.status_code!=200 or r.json().get('public') is not False:
        raise RuntimeError('Private destination verification failed')
    root=Path(os.environ['RUNNER_TEMP'])/'us33-private';root.mkdir(exist_ok=True)
    out=root/'results';out.mkdir(exist_ok=True)
    data=root/'inputs';panel=root/'panel.parquet';sector=root/'sector.csv'
    commands=[
        ['scripts/us3_supabase_io.py','download','--root',str(data)],
        ['scripts/us32_build_feature_panel.py','--input',str(data),'--output',str(panel),'--threads','1','--memory-limit','3GB'],
        ['scripts/us33_download_sector_map.py','--output',str(sector)],
        ['scripts/research_us33_survivorship_replay.py','--panel',str(panel),'--input-root',str(data),'--sector-map',str(sector),'--output',str(out)],
    ]
    success=True
    with (out/'execution.log').open('w',encoding='utf-8') as log:
        for i,cmd in enumerate(commands):
            log.write(f'Stage {i+1}\n');log.flush()
            if subprocess.run([sys.executable,*cmd],stdout=log,stderr=subprocess.STDOUT).returncode:
                success=False;break
    run_id=os.environ['GITHUB_RUN_ID'];attempt=os.environ['GITHUB_RUN_ATTEMPT']
    prefix=storage.USER_PREFIX.rsplit('/research/',1)[0]+f'/results/us33-survivorship-control/{run_id}/{attempt}'
    (out/'run_status.json').write_text(json.dumps({'success':success,'sha':os.environ['GITHUB_SHA'],'runId':run_id,'attempt':attempt}))
    for p in out.iterdir():
        if p.is_file() and p.suffix in {'.csv','.json','.log'}:
            storage.upload_object(url,key,f'{prefix}/{p.name}',p)
    if not success:raise RuntimeError('Research verification failed; details saved privately')
    print('Eight controls completed; results saved to verified private storage.')

if __name__=='__main__':
    try:main()
    except Exception:
        print('Private research job failed. Inspect private run status and logs.');sys.exit(1)
