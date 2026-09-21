import unittest
import numpy as np
import pandas as pd
from research_etf_m0_enhance import simulate_symbol, nonoverlap, portfolio, asset_class


class ExecutionTests(unittest.TestCase):
    def hist(self):
        return pd.DataFrame(dict(symbol=['TEST']*8,date=pd.bdate_range('2020-01-01',periods=8).strftime('%Y-%m-%d'),
            open=[100,110,120,130,140,150,160,170],close=[105,115,125,135,145,155,165,175],
            scoreM0=[80,50,50,50,80,50,50,50],etfUnderlyingIndexClose=[100]*8,uMa60=[99]*8,
            originalOnset=[True,False,False,False,True,False,False,False],eligible=[True]*8))

    def spec(self,confirm=1):
        return dict(id='TEST',model='scoreM0',entry='fixed',rule='below',level=60,confirm=confirm,hold=60)

    def test_next_open_and_cost(self):
        t=simulate_symbol(self.hist(),self.spec())[0]
        self.assertEqual(t['entryOpen'],110)
        self.assertEqual(t['exitOpen'],120)
        self.assertAlmostEqual(t['netReturn'],120*.9985/(110*1.0015)-1)

    def test_confirmation_and_censor(self):
        t=simulate_symbol(self.hist(),self.spec(3))
        self.assertEqual(len(t),1)
        self.assertEqual(t[0]['exitOpen'],140)

    def test_portfolio_cash_and_mtm(self):
        h=self.hist(); t=pd.DataFrame(simulate_symbol(h,self.spec()))
        px={(r.symbol,r.date):dict(open=r.open,close=r.close) for r in h.itertuples()}
        c=portfolio(t,px,h.date.tolist(),slots=1)
        self.assertAlmostEqual(c.equity.iloc[1],115/(110*1.0015))
        self.assertAlmostEqual(c.equity.iloc[2],120*.9985/(110*1.0015))

    def test_nonoverlap(self):
        t=pd.DataFrame([dict(symbol='A',signalDate='2020-01-01',entryDate='2020-01-02',exitDate='2020-01-10'),
                        dict(symbol='A',signalDate='2020-01-03',entryDate='2020-01-04',exitDate='2020-01-06')])
        self.assertEqual(len(nonoverlap(t)),1)

    def test_equity_classification_precedes_sector(self):
        for name,expected in [('미국채30년','bond_cash'),('미국S&P500','equity'),('200커버드콜','option_overlay')]:
            self.assertEqual(asset_class(dict(name=name,etfUnderlyingIndexName='',sectorCode='MARKET_IDX')),expected)


if __name__=='__main__':
    unittest.main()
