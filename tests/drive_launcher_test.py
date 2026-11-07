import ast
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT=Path(__file__).parents[1]
spec=importlib.util.spec_from_file_location('launcher',ROOT/'scripts/launch-drive-screening-v1_1.py')
launcher=importlib.util.module_from_spec(spec);spec.loader.exec_module(launcher)

class LauncherTests(unittest.TestCase):
    def test_notebook_is_executable_and_pins_the_reviewed_launcher(self):
        book=json.loads((ROOT/'collectors/CloudTrend_screening_executor_v1.1.ipynb').read_text())
        code='\n'.join(''.join(c['source']) for c in book['cells'] if c['cell_type']=='code')
        ast.parse(code)
        expected=hashlib.sha256((ROOT/'scripts/launch-drive-screening-v1_1.py').read_bytes()).hexdigest()
        self.assertIn(expected,code)
        self.assertIn('"publish"',code)
        self.assertNotIn('SUPABASE_SERVICE_ROLE_KEY',code)

    def test_success_announcement_requires_the_actual_publication_step(self):
        run={'status':'completed','conclusion':'success'}
        with patch.object(launcher,'github',side_effect=lambda _token,path: {'jobs':[]} if path.endswith('/jobs') else run),patch('builtins.print'):
            with self.assertRaisesRegex(RuntimeError,'게시 단계'):
                launcher.monitor_publication('not-a-real-key',1)
        job={'name':'screening','steps':[{'name':'Run existing engine on completed input','status':'completed','conclusion':'success'}]}
        with patch.object(launcher,'github',side_effect=lambda _token,path: {'jobs':[job]} if path.endswith('/jobs') else run),patch('builtins.print') as output:
            self.assertEqual(launcher.monitor_publication('not-a-real-key',1),run)
            self.assertTrue(any('홈페이지 게시와 읽기 검증' in str(c) for c in output.call_args_list))

    def test_post_publication_failure_is_reported_separately(self):
        run={'status':'completed','conclusion':'failure'}
        job={'name':'screening','steps':[{'name':'Run existing engine on completed input','status':'completed','conclusion':'success'}]}
        with patch.object(launcher,'github',side_effect=lambda _token,path: {'jobs':[job]} if path.endswith('/jobs') else run),patch('builtins.print'):
            with self.assertRaisesRegex(RuntimeError,'홈페이지 게시 후'):
                launcher.monitor_publication('not-a-real-key',1)

if __name__=='__main__': unittest.main()
