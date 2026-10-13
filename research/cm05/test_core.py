import unittest
import numpy as np
import pandas as pd
from core import prices,sector_panel,forward_basket,asof_peer,event_labels,fdr
from build import mapping_kr

class TimeAndReturnTests(unittest.TestCase):
    def test_no_future_or_stale_join(self):
        source=pd.DataFrame({'date':['2026-03-06','2026-03-09'],'available_at':['2026-03-06T21:15:00Z','2026-03-09T20:15:00Z'],'X1':[1,2],'X2':[3,4]})
        target=pd.DataFrame({'decision_at':['2026-03-09T00:00:00Z','2026-03-09T20:15:00Z','2026-03-13T00:00:00Z']})
        out=asof_peer(target,source)
        self.assertEqual(out.peer_X1.iloc[0],1)
        self.assertEqual(out.peer_X1.iloc[1],1)
        self.assertTrue(np.isnan(out.peer_X1.iloc[2]))
    def test_open_entry_compounding_and_null(self):
        p=pd.DataFrame({'intraday_return':[.1,.2,.3],'daily_return':[.7,.1,.2],'benchmark_intraday':[0,0,0],'benchmark_daily':[0,.01,.02]})
        self.assertAlmostEqual(forward_basket(p,2).iloc[0],1.1*1.1-1.01)
        self.assertTrue(np.isnan(forward_basket(p,2).iloc[-1]))
        p.loc[1,'daily_return']=np.nan
        self.assertTrue(np.isnan(forward_basket(p,2).iloc[0]))
    def test_duplicate_rejected(self):
        f=pd.DataFrame({'date':['a','a'],'symbol':['x','x'],'open':[1,1],'close':[1,1],'volume':[1,1]})
        with self.assertRaises(ValueError):prices(f,['a'])
    def test_missing_price_not_zero_breadth(self):
        dates=pd.bdate_range('2020-01-01',periods=260).strftime('%Y-%m-%d').tolist()
        close=pd.DataFrame({'A':np.arange(260)+100.,'B':np.arange(260)+100.},index=dates)
        close.iloc[-1,0]=np.nan
        p={'close':close,'open':close.copy(),'volume':close*0+1}
        b=pd.DataFrame({'open':100.,'close':100.},index=dates)
        cal=pd.DataFrame({'session_date':dates,'open_at':pd.to_datetime(dates,utc=True),'close_available_at':pd.to_datetime(dates,utc=True)+pd.Timedelta(hours=6)})
        x=sector_panel(p,b,cal,minimum=1,coverage_min=.5)
        self.assertEqual(x.n.iloc[-1],1);self.assertEqual(x.coverage.iloc[-1],.5);self.assertEqual(x.breadth60.iloc[-1],1)
        # Prior membership denominator remains two despite today's missing price.
        self.assertEqual(x.denominator.iloc[-1],2)
    def test_labels_use_market_sessions_not_available_bars(self):
        dates=pd.bdate_range('2020-01-01',periods=70).strftime('%Y-%m-%d').tolist()
        c=pd.DataFrame({'A':np.arange(70)+100.},index=dates);o=c-1;v=c*0+1
        c.iloc[5,0]=np.nan
        e=pd.DataFrame([{'date':dates[0],'symbol':'A'}]);b=pd.DataFrame({'open':100.,'close':100.},index=dates)
        out=event_labels(e,{'open':o,'close':c,'volume':v},b,dates,5)
        self.assertEqual(out.status.iloc[0],'MISSING_ENDPOINT')
        v.iloc[1,0]=0
        out=event_labels(e,{'open':o,'close':c,'volume':v},b,dates,20)
        self.assertEqual(out.status.iloc[0],'UNEXECUTABLE_OPEN')
    def test_arrow_gate_arrays_use_existing_normalization(self):
        from cmresearchengine import runtime
        from cm06_prepare_comparison import clean
        from cm06_comparison_signals import kospi_confirmation
        def obs(day,score):
            return {'date':day,'score':score,'eligible':True,'observed':True,'rsAccel':.1,
                    'marketGate':clean({'date':day,'status':'RISK_ON','incomplete':False,'evaluatedCount':4,'issues':np.array([])})}
        c=kospi_confirmation(obs('2022-01-05',8.5),obs('2022-01-04',8.1),obs('2022-01-03',7.5),True)
        self.assertEqual(c['state'],'confirmed');self.assertTrue(c['eligible'])
    def test_fdr_retains_planned_family(self):
        x=fdr([.01,.02,np.nan],56)
        self.assertAlmostEqual(x[0],.56);self.assertAlmostEqual(x[1],.56)
    def test_reviewed_mapping_priority(self):
        m,b,h=mapping_kr();self.assertEqual(m['005930'],'SEMI');self.assertEqual(b['005930'],'REVIEWED_20260909');self.assertEqual(m['088980'],'FINANCE')
class InferenceTests(unittest.TestCase):
    def test_fx_uses_target_sessions_and_prior_publication(self):
        from analyze import add_context
        n=80;d=pd.bdate_range('2022-01-03',periods=n);times=d.tz_localize('UTC')
        target=pd.DataFrame({'date':d.strftime('%Y-%m-%d'),'decision_at':times+pd.Timedelta(hours=12)})
        local=pd.DataFrame({'available_at':times+pd.Timedelta(hours=6),'X1':.1,'X2':.2,'market_ret20':.1,'market_vol20':.03})
        fx=pd.DataFrame({'available_at':times[::5],'krw_per_usd':1000+np.arange(len(times[::5]))*10})
        out=add_context(target,local,local,fx)
        self.assertAlmostEqual(out.fx_change20.iloc[20],1040/1000-1)
        self.assertTrue((out.fx_available_at<out.decision_at).all())
    def test_cluster_bootstrap_preserves_cross_section_and_empty_days(self):
        from analyze import delta_bootstrap
        dates=pd.bdate_range('2022-01-03',periods=220).strftime('%Y-%m-%d')
        d=pd.DataFrame({'date':np.repeat(dates[::2],4),'target':np.tile([.1,.2,-.1,-.2],110),'gate':np.tile([True,True,False,False],110)})
        r=delta_bootstrap(d,63,date_universe=dates)
        self.assertAlmostEqual(r['effect'],.15);self.assertEqual(r['n'],440)

if __name__=='__main__':unittest.main()
