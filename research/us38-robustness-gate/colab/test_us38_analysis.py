"""Small adversarial checks; historical replay parity is the engine test."""
import ast
from pathlib import Path
import unittest
import numpy as np
import pandas as pd

tree=ast.parse(Path(__file__).with_name('run_us38_gate.py').read_text(encoding='utf-8'))
ns={'np':np,'pd':pd}
exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in ['metrics','schedule']],type_ignores=[]),'extracted_helpers','exec'),ns)

class AnalysisChecks(unittest.TestCase):
    def frame(self,r):return pd.DataFrame({'return':r,'spyReturn':np.zeros(len(r)),'turnover':np.zeros(len(r))})
    def test_initial_loss_counts_as_drawdown(self):
        self.assertAlmostEqual(ns['metrics'](self.frame([-.1,0]))['MDD'],-.1)
    def test_drawdown_keeps_initial_cash_peak(self):
        self.assertAlmostEqual(ns['metrics'](self.frame([-.1, .05,-.1]))['MDD'],-.1495)
    def test_invalid_return_cannot_silently_pass(self):
        for r in [[np.nan,0],[np.inf,0],[-1,0]]:
            with self.assertRaises(AssertionError):ns['metrics'](self.frame(r))
    def test_calendar_and_session_cadence_differ(self):
        ns['dates']=pd.bdate_range('2020-01-02',periods=80)
        fixed=[d for d in range(1,80) if ns['schedule']('d60',d)]
        quarter=[d for d in range(1,80) if ns['schedule']('quarter',d)]
        self.assertEqual(fixed,[1,61])
        self.assertNotEqual(fixed,quarter)

if __name__=='__main__':unittest.main()
