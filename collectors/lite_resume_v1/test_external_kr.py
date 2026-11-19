"""Integration against the preserved private KR ZIP, with a fake HTTP boundary.

Run with CLOUDTREND_KR_RUNTIME_ZIP pointing to the existing fixed dependency.
No credentials, network, Drive mount or operational writes are used here.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock
import zipfile

ROOT = Path(__file__).resolve().parent
if 'cloudtrend_lite_resume_v1' not in sys.modules:
    spec = importlib.util.spec_from_file_location('cloudtrend_lite_resume_v1', ROOT/'runtime/__init__.py',
                                                submodule_search_locations=[str(ROOT/'runtime')])
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
from cloudtrend_lite_resume_v1.state import RunState
from cloudtrend_lite_resume_v1.kr import install_official_cache, enrich_dates


@unittest.skipUnless(os.environ.get('CLOUDTREND_KR_RUNTIME_ZIP'), 'private fixed KR dependency not supplied')
class ExternalKrTests(unittest.TestCase):
    def setUp(self):
        raw = Path(os.environ['CLOUDTREND_KR_RUNTIME_ZIP']).read_bytes()
        self.assertEqual(hashlib.sha256(raw).hexdigest(),
                         '91d4992be9a2d06916ee2e425cb43d210350eed5e73a83429dbb4d041c8b7aba')
        import io
        with zipfile.ZipFile(io.BytesIO(raw)) as bundle:
            self.source = bundle.read('step_06.py').decode()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = RunState(self.tmp.name, 'run', {}, started_at='2026-10-13T11:10:00+00:00')
        self.provider_root = Path(self.tmp.name)/'original-provider'
        self.original = self.provider_root/'cache/ETF/20261013.json'
        self.original.parent.mkdir(parents=True)
        self.original.write_text('original VF bytes: do not read or overwrite')

    def attempt(self, row):
        ns = {'_kr_steps': {'step_06.py': self.source}, '_CT_KR_WATERMARKS': {
            'ETF_V02': {'session_date': '2026-10-12', 'state_hash': 'h'}}}
        install_official_cache(ns, self.state)
        exec(compile(ns['_kr_steps']['step_06.py'], 'verified-kr-step06', 'exec'), ns, ns)
        client = ns['OfficialClient']('synthetic-key', self.provider_root)
        response = Mock(status_code=200)
        response.json.return_value = {'OutBlock_1': [row]}
        client.session = Mock()
        client.session.get.return_value = response
        ns['_OFFICIAL_CLIENT'] = client
        return ns, client

    @staticmethod
    def row(close):
        return {'BAS_DD': '20261013', 'ISU_CD': '123456', 'TDD_CLSPRC': str(close),
                'MKTCAP': '1000', 'ACC_TRDVAL': '100', 'NAV': '11',
                'INVSTASST_NETASST_TOTAMT': '1000', 'LIST_SHRS': '100',
                'OBJ_STKPRC_IDX': '200'}

    def test_evening_reference_only_rechecked_on_resume_and_budget_remains_shared(self):
        first, client1 = self.attempt(self.row(0))
        self.assertTrue(first['official_day']('ETF', '2026-10-13').empty)
        # A second symbol on the same attempt shares the already queried day.
        self.assertTrue(first['official_day']('ETF', '2026-10-13').empty)
        self.assertEqual(client1.session.get.call_count, 1)
        second, client2 = self.attempt(self.row(10))
        daily = second['official_day']('ETF', '2026-10-13')
        self.assertEqual(daily.close.tolist(), [10])
        self.assertEqual(client2.session.get.call_count, 1)
        counts = list((self.provider_root/'usage').glob('*.json'))
        self.assertEqual(sum(json.loads(p.read_text())['attempts'] for p in counts), 2)
        self.assertEqual(self.original.read_text(), 'original VF bytes: do not read or overwrite')
        self.assertEqual(len(list((self.state.root/'kr-official-cache').glob('*/*/*.json'))), 2)

    def test_official_enrichment_keeps_adjusted_ohlc_and_csv_dated_fields(self):
        import io
        import pandas as pd
        ns, client = self.attempt(self.row(10))
        frame = pd.DataFrame([{'symbol': '123456', 'date': '2026-10-13',
            'securityType': 'ETF', 'market': 'ETF', 'close': 9.5, 'open': 9.0,
            'priceSource': 'TOSS_ADJUSTED_CANDLE'}])
        out = enrich_dates(frame, ['2026-10-13'], ns)
        readback = pd.read_csv(io.StringIO(out.to_csv(index=False)), dtype={'symbol': str})
        self.assertEqual(readback.close.tolist(), [9.5])
        self.assertEqual(readback.etfTradingValue.tolist(), [100])
        self.assertEqual(readback.marketCapSource.tolist(), ['KRX_ETF'])
        self.assertEqual(readback.date.tolist(), ['2026-10-13'])
        self.assertEqual(client.session.get.call_count, 1)

    def test_auth_failure_stops_without_a_success_cache(self):
        ns, client = self.attempt(self.row(10))
        client.session.get.return_value.status_code = 401
        with self.assertRaises(ns['KRXServiceUnavailable']):
            ns['official_day']('ETF', '2026-10-13')
        self.assertEqual(list((self.state.root/'kr-official-cache').glob('*/*/*.json')), [])


if __name__ == '__main__':
    unittest.main()
