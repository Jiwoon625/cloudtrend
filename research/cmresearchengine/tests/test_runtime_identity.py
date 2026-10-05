from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import unittest
from unittest.mock import patch
from fixtures import make
from cmresearchengine.prepared import PreparedResearch
from cm06.registry import candidate_by_id

class RuntimeIdentityTests(unittest.TestCase):
    def prepared(self):
        p=object.__new__(PreparedResearch)
        p.base_identity={'deterministic_seed':12}
        p.research_candidate=candidate_by_id('S05');p.references={}
        p.factory=make;p.research_contract=lambda:make().contract
        return p
    def test_python_patch_version_gets_separate_resume_chain(self):
        p=self.prepared()
        with patch('cmresearchengine.runtime.fingerprint',return_value={'python':'3.12.14','pyarrow':'23.0.1'}):
            p._bind_research_identity();first=p.trial_key
            self.assertEqual(p.identity['runtime_versions']['python'],'3.12.14')
        with patch('cmresearchengine.runtime.fingerprint',return_value={'python':'3.12.15','pyarrow':'23.0.1'}):
            p._bind_research_identity();self.assertNotEqual(first,p.trial_key)
    def test_pyarrow_version_is_bound_even_when_codec_does_not_use_it(self):
        p=self.prepared()
        with patch('cmresearchengine.runtime.fingerprint',return_value={'python':'3.12.14','pyarrow':'23.0.1'}):
            p._bind_research_identity();first=p.trial_key
        with patch('cmresearchengine.runtime.fingerprint',return_value={'python':'3.12.14','pyarrow':'23.0.2'}):
            p._bind_research_identity();self.assertNotEqual(first,p.trial_key)
    def test_workflows_pin_exact_matching_python_patch(self):
        root=Path(__file__).resolve().parents[3]
        for name in ('cmresearchengine-run.yml','cmresearchengine-check.yml'):
            self.assertIn("python-version: '3.12.14'",(root/'.github/workflows'/name).read_text())

    def test_clone_cannot_relabel_loaded_classes_with_changed_source_hash(self):
        p=self.prepared()
        with patch('cmresearchengine.runtime.fingerprint',return_value={'python':'3.12.14','pyarrow':'23.0.1'}):
            p._bind_research_identity()
            with patch('cmresearchengine.runtime.code_hashes',return_value={'cmresearchengine/replay.py':'f'*64}):
                with self.assertRaisesRegex(RuntimeError,'source changed after controlled'):
                    p.clone(candidate_by_id('S05'))

    def test_new_runner_factory_checks_controlled_sources_first(self):
        p=object.__new__(PreparedResearch)
        with patch('cmresearchengine.runtime.activate',side_effect=RuntimeError('source guard first')):
            with self.assertRaisesRegex(RuntimeError,'source guard first'):
                PreparedResearch.factory(p)
