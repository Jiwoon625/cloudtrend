"""Colab credential adapter and immutable package publication. Never updates baseline/latest."""
import json,time
from pathlib import Path
from history import Drive,require,sha,atomic
class ColabDrive(Drive):
    def __init__(self):
        from google.colab import auth
        import google.auth
        auth.authenticate_user()
        self.google_credentials,_=google.auth.default()
        self.token,self.until,self.reads='',0,[]
    def refresh(self):
        from google.auth.transport.requests import Request
        self.google_credentials.refresh(Request())
        self.token,self.until=self.google_credentials.token,time.monotonic()+1200

def children(drive,parent,name):
    require("'" not in name,'Invalid name')
    query={'q':f"'{parent}' in parents and name='{name}' and trashed=false",'fields':'files(id,name,mimeType)','pageSize':100}
    found=json.loads(drive.call('files',query=query))['files'];require(len(found)<=1,'Duplicate immutable artifacts/folders; inspect before resuming');return found

def immutable_upload(drive,parent,name,raw):
    found=children(drive,parent,name)
    if found:
        require(sha(drive.download(found[0]['id']))==sha(raw),'Same immutable artifact name contains different bytes');return found[0]
    return drive.upload(parent,name,raw)

def export_completed(run_path, *, parent_folder='14rxxO_vmmxeuSAQTZ1B7GwlTVFd8LMI-', drive=None):
    drive=drive or ColabDrive();run=Path(run_path);m=json.loads((run/'complete-manifest.json').read_text())
    require(m['complete'] is True,'Run is incomplete')
    name='drive_history_v7_run_'+m['runId'];found=children(drive,parent_folder,name)
    if found:folder=found[0]
    else:folder=json.loads(drive.call('files',data=json.dumps({'name':name,'mimeType':'application/vnd.google-apps.folder','parents':[parent_folder]}).encode(),content_type='application/json',query={'fields':'id,name,webViewLink'}))
    # API upload + authenticated full readback precede a complete API manifest.
    for file in m['files']:
        raw=(run/file['name']).read_bytes();require(sha(raw)==file['sha256'] and len(raw)==file['bytes'],'Run artifact changed')
        saved=immutable_upload(drive,folder['id'],file['name'],raw);file['fileId']=saved['id']
    raw=json.dumps(m,ensure_ascii=False,indent=2).encode()
    saved=immutable_upload(drive,folder['id'],'complete-manifest.json',raw)
    launch={'run_manifest_id':saved['id'],'run_manifest_sha256':sha(raw),'result_folder_id':folder['id'],'publish_dashboard':False}
    atomic(run/'actions-inputs.json',json.dumps(launch,indent=2).encode())
    print(json.dumps(launch,indent=2));return launch
