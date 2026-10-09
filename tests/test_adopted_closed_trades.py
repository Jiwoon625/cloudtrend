"""Synthetic closed-position accounting tests; no real prices or private results."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('verify_adopted', Path(__file__).parents[1] / 'scripts/verify-adopted-kr-etf-results.py')
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)

def fill(side, quantity, price, day, **extra):
    gross = v.D(quantity) * v.D(price)
    return dict(symbol='000001', side=side, quantity=str(quantity), gross=str(gross), fee=str(v.fee(gross)),
                executionDate=day, executionAt=day+'T00:00:00Z', originDate='2020-01-01', signalDate='2020-01-02', **extra)

def kr(id, entry, exit=None, **extra):
    return dict(id=id, status='OPEN' if exit is None else 'CLOSED', shares=3, entryPrice=entry,
                exitPrice=exit, exitDate='2021-01-04' if exit is not None else None, **extra)

class ClosedTradeTests(unittest.TestCase):
    def test_kr_cost_net_even_mean_median_open_excluded_and_proxy(self):
        rows=[kr('a',100,110),kr('b',100,90,exitReason='모델 가정 청산 · synthetic'),kr('c',100)]
        result=v.closed_trade_metrics('KR_COMBINED_ADOPTED',rows)
        expected=[(v.D(330)-v.fee(v.D(330))-(v.D(300)+v.fee(v.D(300))))/(v.D(300)+v.fee(v.D(300))),
                  (v.D(270)-v.fee(v.D(270))-(v.D(300)+v.fee(v.D(300))))/(v.D(300)+v.fee(v.D(300)))]
        self.assertAlmostEqual(result['meanNetReturn'],float(sum(expected)/2))
        self.assertEqual(result['meanNetReturn'],result['medianNetReturn'])
        self.assertEqual((result['closedTradeCount'],result['excludedOpenPositionCount'],result['proxyClosedTradeCount']),(2,1,1))
        self.assertEqual(result['byFinalExitYear'][0]['exitYear'],2021)
    def test_etf_partial_fills_are_one_roundtrip_reentry_new_and_open_excluded(self):
        rows=[fill('BUY',2,100,'2020-01-03'),fill('BUY',3,110,'2020-01-04'),
              fill('SELL',2,120,'2020-01-05'),fill('SELL',3,130,'2020-01-06',reason='MODEL_UNOBSERVED'),
              fill('BUY',1,100,'2020-01-07'),fill('SELL',1,90,'2020-01-08'),fill('BUY',1,100,'2020-01-09')]
        result=v.closed_trade_metrics('ETF_V02',rows)
        first=(v.D(630)-v.fee(v.D(240))-v.fee(v.D(390))-(v.D(530)+v.fee(v.D(200))+v.fee(v.D(330))))/(v.D(530)+v.fee(v.D(200))+v.fee(v.D(330)))
        second=(v.D(90)-v.fee(v.D(90))-(v.D(100)+v.fee(v.D(100))))/(v.D(100)+v.fee(v.D(100)))
        self.assertAlmostEqual(result['meanNetReturn'],float((first+second)/2))
        self.assertEqual((result['closedTradeCount'],result['excludedOpenPositionCount'],result['proxyClosedTradeCount']),(2,1,1))
    def test_odd_median_is_middle_return_not_compounded_or_annualized(self):
        result=v.closed_trade_metrics('KOSPI_STANDALONE_DIAGNOSTIC',[kr('a',100,150),kr('b',100,90),kr('c',100,110)])
        middle=v.closed_trade_metrics('KOSPI_STANDALONE_DIAGNOSTIC',[kr('c',100,110)])
        self.assertEqual(result['medianNetReturn'],middle['medianNetReturn'])
    def test_empty_sample_and_incomplete_run_never_claim_metrics(self):
        self.assertIsNone(v.closed_trade_metrics('ETF_V02',[])['meanNetReturn'])
        r=v.closed_trade_metrics('KR_COMBINED_ADOPTED',[kr('a',100,110)],publish=False)
        self.assertEqual(r['closedTradeCount'],1)
        self.assertIsNone(r['meanNetReturn']);self.assertIsNone(r['medianNetReturn'])
        self.assertEqual(r['status'],'WITHHELD_INCOMPLETE_RUN')
    def test_partial_exit_remains_open(self):
        r=v.closed_trade_metrics('ETF_V02',[fill('BUY',3,100,'2020-01-03'),fill('SELL',1,110,'2020-01-04')])
        self.assertEqual((r['closedTradeCount'],r['excludedOpenPositionCount']),(0,1))
    def test_impossible_or_overlapping_lifecycle_rejected(self):
        cases=[[fill('SELL',1,100,'2020-01-03')],
               [fill('BUY',1,100,'2020-01-03'),fill('SELL',2,100,'2020-01-04')],
               [fill('BUY',1,100,'2020-01-04'),fill('SELL',1,100,'2020-01-03')]]
        for rows in cases:
            with self.assertRaises(ValueError):v.closed_trade_metrics('ETF_V02',rows)
        with self.assertRaises(ValueError):v.closed_trade_metrics('KR_COMBINED_ADOPTED',[kr('a',100),kr('a',100)])

if __name__=='__main__':unittest.main()
