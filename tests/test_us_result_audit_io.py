import importlib.util,json,tempfile,unittest,hashlib
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
s=importlib.util.spec_from_file_location('audit_io',ROOT/'scripts/audit-adopted-us-result.py');a=importlib.util.module_from_spec(s);s.loader.exec_module(a)
REQ=json.loads((ROOT/'.github/adopted-us-audit-request.json').read_text())
class AuditIO(unittest.TestCase):
 def test_request_scope(self):
  self.assertEqual(a.validate_request(REQ)['source_run'],'37941149947-1')
  for edit in [{'source_run':'../main'},{'manifest_bytes':0},{'source_commit':'main'},{'extra':True}]:
   with self.assertRaises(a.job.JobError):a.validate_request({**REQ,**edit})
 def test_stages_only_completed_results_no_benchmark_or_raw(self):
  manifest={'status':'COMPLETE','mode':'full','market':'us','codeCommit':REQ['source_commit'],'catalogSha256':REQ['catalog_sha256'],'outputs':[{'path':'result/'+name,'bytes':2,'sha256':hashlib.sha256(b'{}').hexdigest()} for name in a.RESULT_FILES]}
  class Storage:
   owner='11111111-1111-4111-8111-111111111111';input_keys=set()
   def __init__(self):self.keys=[]
   def download(self,key,target,evidence):
    self.keys.append(key);Path(target).write_text(json.dumps(manifest) if key.endswith('/run-manifest.json') else '{}')
  x=Storage()
  with tempfile.TemporaryDirectory() as p:
   result=a.stage_result(x,REQ,Path(p));self.assertEqual({f.name for f in result.iterdir()},a.RESULT_FILES)
  self.assertEqual(len(x.keys),5);self.assertTrue(all('/runs/37941149947-1/' in k for k in x.keys))
  self.assertFalse(any('benchmark' in k or '/inputs/' in k or '/cm/' in k for k in x.keys))
 def test_bounded_aggregate_rejects_private_fields(self):
  valid={'schema':'us-a0-roundtrip-summary-v1','status':'VERIFIED','sampleCount':2,'meanNetReturn':.1,'medianNetReturn':.1,'byExitYear':[{'year':2020,'sampleCount':2}]}
  self.assertTrue(a.bounded_metadata(valid))
  for x in [{'owner':'x'},{'token':'x'},{'url':'https://private'},{'symbol':'private\nvalue'},{'meanNetReturn':float('nan')}]:
   with self.assertRaises(a.job.JobError):a.bounded_metadata({**valid,**x})
 def test_admission_requires_explicit_audit_subject(self):
  with tempfile.TemporaryDirectory() as p:
   f=Path(p)/'event.json';f.write_text(json.dumps({'head_commit':{'message':'audit(adopted-backtest): result'}}))
   e={'GITHUB_ACTIONS':'true','GITHUB_WORKFLOW':'Audit completed US A0 result','GITHUB_EVENT_NAME':'push','GITHUB_REF':a.job.REQUEST_BRANCH,'GITHUB_SHA':'1'*40,'GITHUB_EVENT_PATH':str(f)}
   self.assertEqual(a.authorize(e),'1'*40)
   f.write_text(json.dumps({'head_commit':{'message':'run(adopted-backtest): full'}}))
   with self.assertRaises(a.job.JobError):a.authorize(e)
if __name__=='__main__':unittest.main()
