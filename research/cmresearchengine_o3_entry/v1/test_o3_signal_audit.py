from dataclasses import asdict
from copy import deepcopy
import io
import json
import unittest
import zipfile
from test_o3_replay import make
from cmresearchengine.runner import serialize_result
from o3_audit import audit_entry_evidence


class SignalAudit(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r=make();r.run();cls.execution=asdict(r.contract);cls.options=r.o3_options
        with zipfile.ZipFile(io.BytesIO(serialize_result(r))) as z:
            cls.files={name:z.read(name) for name in z.namelist()}

    def test_full_recount_from_serialized_evidence(self):
        result=audit_entry_evidence(self.files,self.execution,self.options)
        self.assertEqual(result['entry_deliveries_checked'],10)
        self.assertEqual(result['entry_month_reviews_checked'],1)
        self.assertEqual(result['entry_observations_checked'],69)

    def test_changed_monthly_count_or_target_rejected(self):
        for item in ('count','target'):
            files=dict(self.files);reviews=json.loads(files['reviews.json'])
            if item=='count':reviews[0]['policy']['unique_entry_counts']['K']=999
            else:reviews[0]['movement']['targets']['K']='0.2'
            files['reviews.json']=json.dumps(reviews).encode()
            with self.assertRaises(ValueError):audit_entry_evidence(files,self.execution,self.options)

    def test_missing_duplicate_or_demand_only_evidence_rejected(self):
        files=dict(self.files);lines=files['o3_entry_signals.csv'].splitlines(keepends=True)
        for modified in (lines[:-1],lines+[lines[1]],[b'engine,demand_id,desired_amount\n']):
            files['o3_entry_signals.csv']=b''.join(modified)
            with self.assertRaises((ValueError,KeyError)):audit_entry_evidence(files,self.execution,self.options)

    def test_missing_monthly_review_cannot_publish(self):
        files=dict(self.files);files['reviews.json']=b'[]'
        with self.assertRaises(ValueError):audit_entry_evidence(files,self.execution,self.options)

if __name__=='__main__':unittest.main()
