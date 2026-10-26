"""Offline real-redacted metadata -> Python archive -> TypeScript golden fixture."""
import copy,csv,hashlib,importlib.util,io,json,sys,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('quality_archive',Path(__file__).parent/'runtime/helpers/us_archive.py')
archive=importlib.util.module_from_spec(spec);spec.loader.exec_module(archive)
fixture=json.loads((ROOT/'tests/fixtures/us-scoring-holds-golden.json').read_text())
FIELDS='date symbol name market sector security_type status currency shares_outstanding open high low close volume ret120 ret252 beta60_spy ichimoku_tk_gap relvol1_20 adv20_usd amihud20 active20 toss_tradable is_common_share'.split()

def inputs(mixed=False):
    rows=[]
    for symbol in ['SPY','VJET','WQEY']+(['GAP'] if mixed else []):
        row=dict.fromkeys(FIELDS,'')
        row.update(date=fixture['asOfDate'],symbol=symbol,name=symbol,market='NYSE',sector='TEST',security_type='STOCK',status='ACTIVE',currency='USD',shares_outstanding='1000000',open='100',high='102',low='99',close='101',volume='1000',active20='false',toss_tradable='true',is_common_share=str(symbol!='SPY').lower())
        if symbol=='SPY':row.update(ret120='.1',ret252='.2',beta60_spy='1',ichimoku_tk_gap='.1',relvol1_20='1',adv20_usd='1000000',amihud20='.001',active20='true')
        if symbol=='GAP':
            for k in ['open','high','low','close','volume']:row[k]=''
        rows.append(row)
    metadata={k:copy.deepcopy(fixture[k]) for k in ['previousSessionDate','confirmedRegularClose','failedSymbols','sourceCoverageComplete','providerGapSymbols','lifecycleExcludedSymbols','guardedCandidateQuarantine','guardedCandidateScoringHolds']}
    if mixed:metadata['providerGapSymbols']=['GAP']
    return rows,metadata

def payload(rows,metadata):
    stream=io.StringIO();w=csv.DictWriter(stream,fieldnames=FIELDS,lineterminator='\n');w.writeheader();w.writerows(rows);raw=stream.getvalue().encode()
    return raw,dict(user_id='11111111-1111-4111-8111-111111111111',as_of_date=fixture['asOfDate'],data_hash='sha256:'+hashlib.sha256(raw).hexdigest(),row_count=len(rows),symbol_count=len(rows),collected_at='2026-10-24T01:00:00Z',metadata=metadata)

def golden(root,mixed=False):
    raw,ingest=payload(*inputs(mixed))
    source=archive.preserve_us_daily_before_upload(raw=raw,payload=ingest,root=root,user_id=ingest['user_id'])
    manifest,blobs=archive.prepare_us_atomic_chain(root,[source['date']],source['previousSessionDate'])
    return dict(ingest=ingest,manifest=manifest,files={p:b.decode() for p,b,m in blobs})

class QualityTests(unittest.TestCase):
    def test_golden_and_mixed(self):
        for mixed in [False,True]:
            with tempfile.TemporaryDirectory() as root:
                out=golden(root,mixed);s=out['manifest']['sessions'][0]
                self.assertFalse(s['sourceCoverageComplete']);self.assertEqual(s['sourceQuality']['priceCoverageComplete'],not mixed)
                self.assertEqual(s['sourceQuality']['scoringHolds'],fixture['guardedCandidateScoringHolds'])
                self.assertEqual(s['quarantinedSymbols'],['GAP'] if mixed else [])
                self.assertEqual(out['ingest']['metadata']['sourceQuality'],s['sourceQuality'])
    def test_exact_retry_preserves_metadata_and_capture(self):
        with tempfile.TemporaryDirectory() as root:
            first=golden(root);saved={str(p):p.read_bytes() for p in Path(root).rglob('*') if p.is_file()}
            raw,p=payload(*inputs());p['collected_at']='2026-10-24T02:00:00Z'
            archive.preserve_us_daily_before_upload(raw=raw,payload=p,root=root,user_id=p['user_id'])
            self.assertEqual(p['collected_at'],first['ingest']['collected_at']);self.assertEqual(p['metadata']['sourceQuality'],first['ingest']['metadata']['sourceQuality'])
            self.assertEqual(saved,{str(p):p.read_bytes() for p in Path(root).rglob('*') if p.is_file()})
            p['metadata']['guardedCandidateScoringHolds']['VJET']['postEventBars']=16
            with self.assertRaisesRegex(RuntimeError,'quality differs|evidence differs'):
                archive.preserve_us_daily_before_upload(raw=raw,payload=p,root=root,user_id=p['user_id'])
            self.assertEqual(saved,{str(p):p.read_bytes() for p in Path(root).rglob('*') if p.is_file()})
    def test_reviewed_lifecycle_derivative_preserves_unrelated_holds(self):
        for symbol in ['GAP','VJET']:
            with tempfile.TemporaryDirectory() as root:
                out=golden(root,True);source=out['manifest']['sessions'][0];raw=out['files'][source['storagePath']].encode()
                saved={str(p):p.read_bytes() for p in Path(root).rglob('*') if p.is_file()}
                event=dict(symbol=symbol,effective_date=source['date'],status='SUSPENDED',source_url='https://example.invalid/review',identity_name_contains=symbol)
                derived=archive.prepare_us_lifecycle_derivative(root=root,date=source['date'],original_raw=raw,events=[event],registry=[event],user_id=out['ingest']['user_id'])
                quality=derived['source']['sourceQuality']
                self.assertFalse(quality['priceCoverageComplete'])
                self.assertEqual(set(quality['scoringHolds']),set(['VJET','WQEY'])-{symbol})
                self.assertEqual(source['sourceQuality']['scoringHolds'],fixture['guardedCandidateScoringHolds'])
                for p,b in saved.items():self.assertEqual(Path(p).read_bytes(),b)

    def test_malformed_holds_fail_before_archive_writes(self):
        changes=[lambda r,m:m.update(sourceCoverageComplete=True),lambda r,m:m['guardedCandidateScoringHolds'].update(UNKNOWN=m['guardedCandidateScoringHolds']['VJET']),lambda r,m:m.update(guardedCandidateQuarantine={'OMITTED':{'reason':'identity'}})]
        for key,value in [('reason','unknown'),('postEventBars',253),('postEventBars',-1),('postEventBars',15.0),('postEventBars',True),('minimumBars',252),('historyStartDate','2026-10-24'),('historyStartDate','2026-02-31')]:
            changes.append(lambda r,m,k=key,v=value:m['guardedCandidateScoringHolds']['VJET'].update({k:v}))
        for key,value in [('ret252','0'),('beta60_spy','0'),('active20','true'),('close',''),('high','98'),('volume','-1')]:
            changes.append(lambda r,m,k=key,v=value:r[1].update({k:v}))
        for change in changes:
            with self.subTest(change=change),tempfile.TemporaryDirectory() as root:
                r,m=inputs();change(r,m);raw,p=payload(r,m)
                with self.assertRaises(RuntimeError):archive.freeze_us_atomic_archive(raw=raw,ingest=p,root=root,user_id=p['user_id'])
                self.assertEqual(list(Path(root).iterdir()),[])

if __name__=='__main__':
    if '--emit' in sys.argv:
        with tempfile.TemporaryDirectory() as root:print(json.dumps(golden(root,'--mixed' in sys.argv)))
    else:unittest.main()
