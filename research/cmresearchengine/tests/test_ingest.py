import copy, hashlib, io, json, stat, sys, tarfile, tempfile, unittest, zipfile
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from cmresearchengine import ingest

def record(raw):return {'size':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
def tar_bytes(rows):
    stream=io.BytesIO()
    with tarfile.open(fileobj=stream,mode='w:') as archive:
        for name,raw,mode,kind in rows:
            item=tarfile.TarInfo(name);item.size=len(raw);item.mode=mode;item.type=kind
            if kind in {tarfile.SYMTYPE,tarfile.LNKTYPE}:item.linkname='outside'
            archive.addfile(item,io.BytesIO(raw))
    return stream.getvalue()
class MemoryStore:
    bucket='cloudtrend-data';prefix='00000000-0000-4000-8000-000000000001/research/cm/'
    def __init__(self,objects):self.objects=objects;self.downloaded=[];self.verified=0
    def object_key(self,key):return self.prefix+key
    def verify_private_bucket(self):self.verified+=1
    def get_object(self,key,*,max_bytes):
        raw=self.objects[key]
        if len(raw)>max_bytes:raise ValueError('too large')
        return raw
    def download_object(self,key,target,**kwargs):self.downloaded.append(key);Path(target).write_bytes(self.objects[key])
def full_contract():
    objects={};expected=[]
    for frozen in ingest.FROZEN_STAGES:
        names=sorted(ingest.allowed_paths(frozen['stage']));output={n:('synthetic:'+n).encode() for n in names};archives=[]
        for index in range(frozen['archives']):
            members=names[index::frozen['archives']]
            raw=tar_bytes([(n,output[n],0o600,tarfile.REGTYPE) for n in members]);rec=record(raw)
            archives.append({**rec,'members':members,'drive_file_id':'synthetic-'+str(index)})
            objects['inputs/cm06.batched.'+frozen['stage']+'.'+rec['sha256']+'.tar']=raw
        doc={'stage':frozen['stage'],'source_fingerprint':frozen['fingerprint'],'schema_version':2,'archive_format':'tar','archives':archives,
             'outputs':[{'relative_path':n,**record(output[n])} for n in names]}
        raw=json.dumps(doc,sort_keys=True).encode();expected.append({**frozen,'sha256':record(raw)['sha256']})
        objects['inputs/cm06.batched.stage.'+frozen['stage']+'.json']=raw
    return MemoryStore(objects),tuple(expected)
def evidence_zip(mutate=None):
    files={'metadata/row'+str(i)+'.json':b'{}' for i in range(16)}
    files.update({'reference_parts/reference_rows.'+str(i)+'.jsonl':b'{}\n' for i in range(19)})
    manifest={'schema':'CM06_SUPABASE_RUNTIME_PRIVATE_EVIDENCE_V1','contains_code':False,'contains_credentials':False,
              'reference_chunk_count':19,'evidence_parts_relative_path':'reference_parts',
              'files':[{'path':n,**record(raw)} for n,raw in files.items()]}
    if mutate:mutate(files,manifest)
    stream=io.BytesIO()
    with zipfile.ZipFile(stream,'w',compression=zipfile.ZIP_DEFLATED) as archive:
        for name,raw in files.items():
            info=zipfile.ZipInfo(name);info.external_attr=(stat.S_IFREG|0o600)<<16;archive.writestr(info,raw)
        archive.writestr('DATA_ONLY_MANIFEST.json',json.dumps(manifest).encode())
    return stream.getvalue()
class IngestTests(unittest.TestCase):
    def test_allowlist_exactly_401_data_files(self):
        close=ingest.allowed_paths('CloseadjInputsV2');reference=ingest.allowed_paths('Stage2_reference_time')
        self.assertEqual(len(close),389);self.assertEqual(len(reference),12);self.assertFalse(close&reference)
        self.assertTrue(all(Path(p).suffix in {'.json','.csv','.parquet'} for p in close|reference))
    def test_26_objects_401_files_deterministic_manifest(self):
        store,expected=full_contract()
        with tempfile.TemporaryDirectory() as directory,patch.object(ingest,'FROZEN_STAGES',expected):
            root=Path(directory)/'work';manifest=ingest.restore_archives(store,root)
            self.assertEqual(len(store.downloaded),24);self.assertEqual(len(manifest['sources']),26);self.assertEqual(len(manifest['outputs']),401)
            self.assertEqual(len([p for p in root.rglob('*') if p.is_file()]),401)
            self.assertTrue(all(not(p.stat().st_mode&0o111) for p in root.rglob('*') if p.is_file()))
            self.assertEqual(ingest.restore_archives(store,root),manifest);self.assertEqual(len(store.downloaded),24);self.assertEqual(store.verified,2)
    def test_frozen_hash_before_archive_download(self):
        store,expected=full_contract();store.objects['inputs/cm06.batched.stage.CloseadjInputsV2.json']+=b' '
        with tempfile.TemporaryDirectory() as directory,patch.object(ingest,'FROZEN_STAGES',expected):
            with self.assertRaisesRegex(ingest.IngestionError,'SHA256'):ingest.restore_archives(store,Path(directory)/'work')
            self.assertFalse(store.downloaded)
    def test_corrupt_final_archive_publishes_no_runtime_input(self):
        store,expected=full_contract();key=next(k for k in store.objects if k.startswith('inputs/cm06.batched.Stage2_reference_time.'));store.objects[key]=b'corrupt'
        with tempfile.TemporaryDirectory() as directory,patch.object(ingest,'FROZEN_STAGES',expected):
            root=Path(directory)/'work'
            with self.assertRaises(ingest.IngestionError):ingest.restore_archives(store,root)
            self.assertFalse(any(p.is_file() for p in root.rglob('*')))
    def test_existing_collision_preserved_before_transfer(self):
        store,expected=full_contract()
        with tempfile.TemporaryDirectory() as directory,patch.object(ingest,'FROZEN_STAGES',expected):
            root=Path(directory)/'work';target=root/sorted(ingest.allowed_paths('CloseadjInputsV2'))[0]
            target.parent.mkdir(parents=True);target.write_bytes(b'do not replace')
            with self.assertRaises(ingest.LocalConflict):ingest.restore_archives(store,root)
            self.assertFalse(store.downloaded);self.assertEqual(target.read_bytes(),b'do not replace')
    def test_schema_duplicates_assignment_and_allowlist(self):
        store,expected=full_contract();original=json.loads(store.objects['inputs/cm06.batched.stage.CloseadjInputsV2.json'])
        for mutate in (lambda d:d['outputs'].__setitem__(0,d['outputs'][1]),lambda d:d['archives'][0]['members'].append(d['archives'][0]['members'][0]),
                       lambda d:d.__setitem__('schema_version',True),lambda d:d['outputs'][0].__setitem__('relative_path','data/evil.py')):
            doc=copy.deepcopy(original);mutate(doc);raw=json.dumps(doc).encode()
            with self.assertRaises(ingest.IngestionError):ingest.validate_stage(raw,{**expected[0],'sha256':record(raw)['sha256']})
    def test_tar_rejects_links_execute_duplicates_traversal_code_unlisted(self):
        cases=[ [('data/ok.csv',b'x',0o600,tarfile.SYMTYPE)], [('data/ok.csv',b'x',0o600,tarfile.LNKTYPE)],
                [('data/ok.csv',b'x',0o700,tarfile.REGTYPE)], [('data/ok.csv',b'x',0o600,tarfile.REGTYPE)]*2,
                [('../escape.csv',b'x',0o600,tarfile.REGTYPE)], [('data/evil.py',b'x',0o600,tarfile.REGTYPE)],
                [('data/unlisted.csv',b'x',0o600,tarfile.REGTYPE)] ]
        for rows in cases:
            raw=tar_bytes(rows);name=rows[0][0] if rows[0][0]!='data/unlisted.csv' else 'data/ok.csv'
            with self.subTest(rows=rows),tempfile.TemporaryDirectory() as directory:
                path=Path(directory)/'a.tar';path.write_bytes(raw);out=Path(directory)/'out'
                with self.assertRaises(ingest.IngestionError):ingest.extract_archive(path,{**record(raw),'members':[name]},{name:record(b'x')},out)
                self.assertFalse(any(p.is_file() for p in out.rglob('*')))
    def test_member_hash_failure_atomic_per_archive(self):
        raw=tar_bytes([('data/a.csv',b'yes',0o600,tarfile.REGTYPE),('data/b.csv',b'bad',0o600,tarfile.REGTYPE)])
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'a.tar';path.write_bytes(raw);out=Path(directory)/'out';records={'data/a.csv':record(b'yes'),'data/b.csv':record(b'yes')}
            with self.assertRaises(ingest.IngestionError):ingest.extract_archive(path,{**record(raw),'members':list(records)},records,out)
            self.assertFalse(any(p.is_file() for p in out.rglob('*')))
    def test_symlink_does_not_redirect_install(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);outside=root/'outside';outside.mkdir();target=root/'work';target.symlink_to(outside,target_is_directory=True)
            with self.assertRaises((ingest.IngestionError,OSError)):ingest.install_stream(io.BytesIO(b'x'),target/'file.csv',record(b'x'))
            self.assertFalse((outside/'file.csv').exists())
    def test_verified_data_only_evidence_zip(self):
        raw=evidence_zip()
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'a.zip';path.write_bytes(raw);out=Path(directory)/'out'
            manifest=ingest.extract_verified_zip(path,out,expected_size=len(raw),expected_sha256=record(raw)['sha256'])
            self.assertEqual(len(manifest['files']),35);self.assertEqual(len(list(out.rglob('*.jsonl'))),19)
            self.assertEqual(len([p for p in out.rglob('*') if p.is_file()]),36)
    def test_zip_rejects_code_unlisted_and_traversal(self):
        for mutate in (lambda files,manifest:files.__setitem__('evil.py',b'code'),lambda files,manifest:manifest['files'][0].__setitem__('path','../escape.json')):
            raw=evidence_zip(mutate)
            with tempfile.TemporaryDirectory() as directory:
                path=Path(directory)/'a.zip';path.write_bytes(raw);out=Path(directory)/'out'
                with self.assertRaises(ingest.IngestionError):ingest.extract_verified_zip(path,out,expected_size=len(raw),expected_sha256=record(raw)['sha256'])
                self.assertFalse(any(p.is_file() for p in out.rglob('*')))
if __name__=='__main__':unittest.main()
