"""Read-only reuse of frozen expanded US CM market inputs; no CM state/results access."""
from pathlib import Path
import hashlib
import importlib.util
import json
import tarfile
import tempfile

ROOT=Path(__file__).resolve().parents[1]
P=ROOT/'research/cmresearchengine/cmresearchengine/ingest.py'
spec=importlib.util.spec_from_file_location('cm_frozen_ingest',P)
ingest=importlib.util.module_from_spec(spec);spec.loader.exec_module(ingest)
PREFIX='data/comparison_inputs_closeadj_v2/'
REFERENCE=ingest.REFERENCE_ROOT
STAGE_BYTES={'CloseadjInputsV2':131485,'Stage2_reference_time':4904}
WANTED={p for p in ingest.allowed_paths('CloseadjInputsV2') if p.startswith(PREFIX+'U/') or p==PREFIX+'PREPARATION_RESULT.json'} | {
 REFERENCE+'data/reference_time/manifest.json',REFERENCE+'data/reference_time/U_calendar.json',REFERENCE+'data/us/spy_prepared_verified.parquet'}

class UsInputError(RuntimeError): pass

def require(ok,code):
    if not ok: raise UsInputError(code)

def extract_selected(archive_path,descriptor,records,destination,wanted):
    require(ingest.hashes(archive_path)==ingest._record(descriptor),'CM_ARCHIVE_HASH_MISMATCH')
    seen=set()
    with tarfile.open(archive_path,'r:') as archive:
        for info in archive:
            require(info.name in descriptor['members'] and info.name not in seen and info.isfile() and not info.issparse() and not(info.mode&0o111),'CM_ARCHIVE_MEMBER_INVALID')
            seen.add(info.name)
            require(info.size==records[info.name]['size'],'CM_MEMBER_SIZE_MISMATCH')
            if info.name not in wanted: continue
            target=ingest.safe(destination,info.name)
            with archive.extractfile(info) as stream:
                ingest.install_stream(stream,target,records[info.name])
    require(seen==set(descriptor['members']),'CM_ARCHIVE_MEMBERS_INCOMPLETE')

def stage_us_private_inputs(storage,owner,unused_transfer_receipt,destination):
    root=Path(destination);root.mkdir(mode=0o700)
    sources=[];restored=set();all_records={}
    for expected in ingest.FROZEN_STAGES:
        stage=expected['stage'];relative='research/cm/inputs/cm06.batched.stage.'+stage+'.json'
        key=owner+'/'+relative;storage.input_keys.add(key);path=root/(stage+'.json')
        evidence={'bytes':STAGE_BYTES[stage],'sha256':expected['sha256']}
        storage.download(key,path,evidence)
        doc,records=ingest.validate_stage(path.read_bytes(),expected)
        sources.append({'source':relative,**evidence});all_records.update(records)
        for descriptor in doc['archives']:
            wanted=set(descriptor['members'])&WANTED
            if not wanted: continue
            relative='research/cm/inputs/cm06.batched.'+stage+'.'+descriptor['sha256']+'.tar'
            key=owner+'/'+relative;storage.input_keys.add(key)
            with tempfile.TemporaryDirectory(prefix='us-archive-',dir=root) as tmp:
                archive=Path(tmp)/'source.tar'
                evidence={'bytes':descriptor['size'],'sha256':descriptor['sha256']}
                storage.download(key,archive,evidence)
                extract_selected(archive,descriptor,records,root,wanted)
            sources.append({'source':relative,**evidence});restored.update(wanted)
    require(restored==WANTED,'CM_US_SOURCE_RESTORE_INCOMPLETE')
    prep=root/PREFIX/'PREPARATION_RESULT.json';u=root/PREFIX/'U/manifest.json'
    p=json.loads(prep.read_bytes());m=json.loads(u.read_bytes())
    require(p.get('status')=='NORMALIZED_INPUTS_READY_NOT_BACKTESTED' and p.get('signal_price_basis')=='CLOSEADJ_FEATURES_AND_EXECUTION','CM_US_INPUT_POLICY_MISMATCH')
    require(hashlib.sha256(u.read_bytes()).hexdigest()==p['engines']['U']['sha256'],'CM_US_MANIFEST_MISMATCH')
    require(m.get('status')=='COMPLETE_NORMALIZED_INPUTS' and len(m.get('months',{}))==141 and m.get('rows')==26353637,'CM_US_MONTH_COVERAGE_MISMATCH')
    canonical=[root/PREFIX/'U'/m['months'][month]['path'] for month in sorted(m['months'])]
    for path in canonical:
        require(path.is_file() and not path.is_symlink(),'CM_US_MONTH_MISSING')
    provenance={'version':'adopted-us-expanded-cm-inputs-v1','sourcePolicy':'ALL_SOURCE_IDENTITIES_WITH_CURRENT_CATEGORY_AND_ASOF_EXCHANGE_RESEARCH_PROXY_NOT_PIT','cmInputsReadOnly':True,'cmStateOrResultsRead':False,'corporateEventEvidenceRead':False,'sources':sources,'restoredFiles':len(restored),'restoredBytes':sum(all_records[n]['size'] for n in restored),'sourceRows':m['rows'],'firstSignalReady':m['first_signal_ready'],'normalizationSource':'CM_VERIFIED_CLOSEADJ_INPUTS_V2','liquidityBasis':'ORIGINAL_DOLLAR_VOLUME_AND_ADV_UNCHANGED'}
    return {'inputKind':'CM_EXPANDED_NORMALIZED_V2','root':root,'canonical':canonical,'master':prep,'benchmark':root/REFERENCE/'data/us/spy_prepared_verified.parquet','calendar':root/REFERENCE/'data/reference_time/U_calendar.json','provenance':provenance}
