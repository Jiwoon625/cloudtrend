"""Build a separate deterministic bundle without touching the VF runtime ZIP."""
from pathlib import Path
import hashlib
import json
import zipfile

ROOT = Path(__file__).resolve().parent
BASE = ROOT.parent / 'lite_r3' / 'runtime'

def build():
    entries = {}
    for package, root in [('cloudtrend_lite_r3_runtime',BASE), ('cloudtrend_lite_resume_v1',ROOT/'runtime')]:
        for path in sorted(root.rglob('*.py')):
            compile(path.read_text(), str(path), 'exec')
            entries[package+'/'+path.relative_to(root).as_posix()] = path.read_bytes()
    manifest = {'version':'cloudtrend-lite-resume-v1-preview',
                'files':{name:hashlib.sha256(raw).hexdigest() for name,raw in entries.items()}}
    entries['resume-manifest.json']=(json.dumps(manifest,sort_keys=True,indent=2)+'\n').encode()
    target=ROOT/'runtime.zip'
    with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as archive:
        for name,raw in sorted(entries.items()):
            info=zipfile.ZipInfo(name,(2026,1,1,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED
            info.external_attr=0o644<<16;archive.writestr(info,raw,compresslevel=9)
    result={'version':manifest['version'],'sha256':hashlib.sha256(target.read_bytes()).hexdigest(), 'files':len(entries)}
    (ROOT/'release.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result))
    return result

if __name__=='__main__': build()
