"""Validate manual dispatch selections without secrets, data, or dispatch API."""
from pathlib import Path
import sys,json,unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from cmresearchengine.plan import choose,candidates,manifest

class DispatchPlanTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.document=json.loads((Path(__file__).resolve().parents[1]/'DISPATCH_PLAN.json').read_text())
    def test_smoke_is_s05_and_default_is_bounded(self):
        preflight,smoke=self.document['gate_sequence']
        self.assertEqual(preflight['mode'],'preflight')
        self.assertEqual(choose(smoke['stage'],smoke['offset'],smoke['count'])[0].candidate_id,'S05')
        for row in sum((self.document[k] for k in ('gate_sequence','base_sequence','expanded_sequence')),[]):
            self.assertEqual(row['max_seconds'],3000)
            self.assertLessEqual(row['count'],16)
    def test_all_1409_registered_candidates_covered_exactly_once(self):
        selected={stage:[] for stage in ('base','fine','split25','split10')}
        for row in self.document['base_sequence']+self.document['expanded_sequence']:
            if row['stage']=='references':continue
            selected[row['stage']].extend(c.candidate_id for c in choose(row['stage'],row['offset'],row['count']))
        for stage,ids in selected.items():
            self.assertEqual(ids,[c.candidate_id for c in candidates(stage)])
            self.assertEqual(len(ids),len(set(ids)))
        self.assertEqual(sum(map(len,selected.values())),1409)
    def test_plan_hash_and_minimum_job_count(self):
        self.assertEqual(self.document['source_plan_sha256'],manifest()['definition_sha256'])
        self.assertEqual(self.document['minimum_fresh_jobs_if_each_batch_completes'],93)
        self.assertEqual(self.document['actual_dispatches_performed'],0)
    def test_named_ids_cannot_escape_batch_limit(self):
        ids=[c.candidate_id for c in candidates('base')[:17]]
        with self.assertRaisesRegex(ValueError,'At most16'):choose('base',count=1,ids=ids)
        with self.assertRaises(ValueError):choose('base',count=17)
