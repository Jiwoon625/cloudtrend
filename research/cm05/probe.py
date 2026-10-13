"""Bounded schema/resource probe. Private data never enters public artifacts."""
import io,json,os,hashlib,resource,shutil
from pathlib import Path
import pandas as pd
from cmresearchengine.storage import SupabaseCMStore, StorageSecurityError
from cmresearchengine.ingest import FROZEN_STAGES,validate_stage,extract_archive

class ExpandedReader(SupabaseCMStore):
    def object_key(self,key):
        allowed={'manifest.json','reference/sector_map_extended.csv','reference/verified_event_overrides.csv','benchmark/spy.parquet'}|{f'prices/year={y}/data_0.parquet' for y in range(2015,2027)}
        if key not in allowed: raise StorageSecurityError('Unapproved expanded input')
        return self.prefix.split('/')[0]+'/research/us/expanded/'+key
    def put_object(self,*args,**kwargs): raise StorageSecurityError('Read-only expanded inputs')

class CM05Store(SupabaseCMStore):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        self.prefix=self.prefix.replace('/research/cm/','/research/cm05/')

def main():
    work=Path(os.environ['RUNNER_TEMP'])/'cm05-probe';work.mkdir(exist_ok=True)
    report={'cpu_count':os.cpu_count(),'memory_kib':int(Path('/proc/meminfo').read_text().split('MemTotal:')[1].split()[0]),'free_disk_bytes':shutil.disk_usage(work).free,'schemas':{}}
    cm=SupabaseCMStore.from_env();us=ExpandedReader.from_env()
    for key in ['manifest.json','reference/sector_map_extended.csv','reference/verified_event_overrides.csv','prices/year=2025/data_0.parquet','benchmark/spy.parquet']:
        raw=us.get_object(key,max_bytes=64*1024**2)
        item={'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
        if key.endswith('.json'): item['manifest']=json.loads(raw)
        else:
            df=pd.read_parquet(io.BytesIO(raw)) if key.endswith('.parquet') else pd.read_csv(io.BytesIO(raw))
            item.update(rows=len(df),columns={c:str(t) for c,t in df.dtypes.items()})
            for col in ['sectorCode','sector','market','historicalTimelineComplete','historicalIndustryVerified']:
                if col in df: item[col]=df[col].fillna('NULL').astype(str).value_counts().to_dict()
        report['schemas'][key]=item
    for expected in FROZEN_STAGES:
        raw=cm.get_object('inputs/cm06.batched.stage.'+expected['stage']+'.json',max_bytes=2*1024**2)
        doc,records=validate_stage(raw,expected)
        selected=doc['archives'] if expected['stage']=='Stage2_reference_time' else [next(a for a in doc['archives'] if any('/K/' in n and n.endswith('.parquet') for n in a['members']))]
        for a in selected:
            p=work/'probe.tar';cm.download_object('inputs/cm06.batched.'+expected['stage']+'.'+a['sha256']+'.tar',p,expected_size=a['size'],expected_sha256=a['sha256'])
            extract_archive(p,a,records,work);p.unlink()
        paths=list(work.rglob('*.parquet'))
        for p in paths:
            df=pd.read_parquet(p)
            report['schemas'][str(p.relative_to(work))]={'rows':len(df),'columns':{c:str(t) for c,t in df.dtypes.items()}}
            if '/K/' in str(p): break
    for p in work.rglob('*calendar.json'):
        obj=json.loads(p.read_text());report['schemas'][p.name]={'structure':str(obj)[:2400]}
    report['peak_rss_kib']=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    payload=json.dumps(report,default=str,sort_keys=True).encode()
    CM05Store.from_env().put_object('results/probe-'+os.environ['GITHUB_RUN_ID']+'.json',payload)
    print(json.dumps(report,default=str,sort_keys=True))
if __name__=='__main__': main()
