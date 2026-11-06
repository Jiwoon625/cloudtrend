"""New v7 transport, separate from the v1 executor. Refreshable credentials required."""
import argparse, io, json, os, stat, sys, zipfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'collectors'/'drive_history_v7'))
from history import Drive, BASELINE_SHA, atomic, checked, prepare_baseline, require, safe_member, sha

def prepare_run(drive, manifest_id, manifest_sha, output):
    raw=drive.download(manifest_id);require(sha(raw)==manifest_sha,'Run manifest hash mismatch');m=json.loads(raw)
    require(m['version']=='drive-history-collector-v7.0-preview' and m['complete'] is True,'Run incomplete or unsupported')
    require(m['history_backend']=='drive' and m['baselineSha256']==BASELINE_SHA and m['parentManifestSha256']==BASELINE_SHA,'Unsupported history parent')
    require(not m['missingSymbols'] and not m['missingIndexSymbols'] and m['missingSymbolCount']==0 and m['correctionCount']==0,'Unresolved coverage/corrections')
    require(len(m['files'])==1 and m['files'][0]['name']=='delta.zip','Expected one delta package')
    f=m['files'][0];raw_zip=checked(drive.download(f['fileId']),f)
    expected={v['name']:v for v in m['deltaMembers']};require(len(expected)==len(m['deltaMembers']) and len(expected)<=2000,'Duplicate/too many parts')
    out=Path(output);out.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(raw_zip)) as z:
        infos=z.infolist();names=[i.filename for i in infos]
        require(len(names)==len(set(names)) and set(names)==set(expected),'Delta package inventory mismatch')
        require(sum(i.file_size for i in infos)<=128*1024**2,'Delta expansion limit exceeded')
        for info in infos:
            safe_member(info.filename);require(Path(info.filename).name==info.filename and info.filename.endswith('.csv'),'Delta must contain flat CSV only')
            require(not stat.S_ISLNK(info.external_attr>>16) and info.file_size==expected[info.filename]['bytes'] and info.file_size<=45*1024**2,'Unsafe delta member')
            atomic(out/'delta'/info.filename,checked(z.read(info),expected[info.filename]))
    atomic(out/'run-manifest.json',raw)
    atomic(out/'run-identity.json',json.dumps({'fileId':manifest_id,'sha256':manifest_sha},indent=2).encode())
    return m

def main():
    p=argparse.ArgumentParser();p.add_argument('action',choices=['prepare','save']);p.add_argument('--directory',default='drive-history-work');p.add_argument('--manifest-id');p.add_argument('--manifest-sha');p.add_argument('--result-folder',required=True);a=p.parse_args()
    d=Drive();out=Path(a.directory)
    if a.action=='prepare':
        prepare_baseline(out/'baseline',drive=d)
        if a.manifest_id: require(a.manifest_sha,'Run SHA required');prepare_run(d,a.manifest_id,a.manifest_sha,out)
        atomic(out/'drive-network-receipt.json',json.dumps({'reads':d.reads,'historicalSupabaseGETs':0}).encode())
    else:
        files=[f for f in out.rglob('*.json') if f.name in ('execution-receipt.json','validation-receipt.json','screening-bundle.json','screening-summary.json','drive-network-receipt.json')]
        require(files,'No results to save');buffer=io.BytesIO()
        with zipfile.ZipFile(buffer,'w',zipfile.ZIP_DEFLATED) as z:
            for f in files:z.write(f,str(f.relative_to(out)))
        attempt=os.environ.get('GITHUB_RUN_ID','local')+'-'+os.environ.get('GITHUB_RUN_ATTEMPT','1')
        saved=d.upload(a.result_folder,'drive-history-result-'+attempt+'.zip',buffer.getvalue())
        print(json.dumps({'resultFileId':saved['id'],'readbackVerified':True}))
if __name__=='__main__':main()
