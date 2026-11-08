import copy,datetime,json,pathlib,unittest
import numpy as np
from recent_replay_legacy import replay
from metrics import excursion,cluster_selection_ci
from diagnostics import available_replay,opening

def bar(d,op,cl,vol=100):return dict(date=d,open=op,close=cl,high=max(op,cl),low=min(op,cl),volume=vol)
def event(d,buy=False,sell=None):return dict(date=d,signals=[dict(symbol='X',market='KOSDAQ',buy=buy,sell=sell,score=8)])
class ResearchIntegrity(unittest.TestCase):
 def test_close_entry_and_gap_stop(self):
  bs={'X':[bar('2026-11-02',100,100),bar('2026-11-03',100,85),bar('2026-11-04',60,65)]};s=replay([event('2026-11-02',True)],bs,dict(ticket=1000,fee=.0015,stop=.1),'2026-11-04');t=s['trades'][0]
  self.assertEqual(t['entry_date'],'2026-11-03');self.assertEqual(t['exit_price'],60);self.assertEqual(t['exit_reason'],'PRICE_STOP')
 def test_unresolved_exit_survives_resume(self):
  bs={'X':[bar('2026-11-02',100,100),bar('2026-11-03',100,100),bar('2026-11-04',0,90,0),bar('2026-11-05',70,70)]};ev=[event('2026-11-02',True),event('2026-11-03',sell='EXIT')];cfg=dict(ticket=1000,fee=.0015);p=replay(ev,bs,cfg,'2026-11-04');self.assertEqual(p['pending']['X']['side'],'SELL');self.assertIn('X',p['positions']);self.assertEqual(replay(ev,bs,cfg,'2026-11-05'),replay(ev,bs,cfg,'2026-11-05',p))
 def test_backfill_invalidates_checkpoint(self):
  b={'X':[bar('2026-11-02',100,100),bar('2026-11-03',100,100)]};e=[event('2026-11-02',True)];c=dict(ticket=1000,fee=0);p=replay(e,b,c,'2026-11-03');b=copy.deepcopy(b);b['X'][0]['close']=99
  with self.assertRaises(ValueError):replay(e,b,c,'2026-11-03',p)
 def test_open_mark_does_not_charge_exit_fee(self):
  b={'X':[bar('2026-11-02',100,100),bar('2026-11-03',100,100)]};s=replay([event('2026-11-02',True)],b,dict(ticket=1000,fee=.0015),'2026-11-03');self.assertAlmostEqual(s['trades'][0]['pnl'],1000/1.0015-1000)
 def test_mfe_ignores_exit_day_range(self):
  b=[dict(bar('2026-11-02',100,101),high=102,low=99),dict(bar('2026-11-03',100,200),high=900,low=1)];x=excursion(b,'2026-11-02','2026-11-03','2026-11-03',100,100);self.assertAlmostEqual(x['mfe_intraday'],.02);self.assertAlmostEqual(x['mae_intraday'],-.01)
 def test_us_dst_exchange_clock(self):
  self.assertEqual(opening('2026-10-30','US_A0').hour,13);self.assertEqual(opening('2026-11-02','US_A0').hour,14)
 def test_late_signal_cannot_fill_previous_open(self):
  b={'X':[bar('2026-11-02',100,100),bar('2026-11-03',110,110),bar('2026-11-04',120,120)]};e=[event('2026-11-02',True)];r,_,_=available_replay(e,b,{'2026-11-02':'2026-11-03T01:00:00Z'},'KOSDAQ',0,'2026-11-04');self.assertEqual(r[0]['entry_date'],'2026-11-04');self.assertEqual(r[0]['entry_price'],120)
 def test_flat_entry_with_simultaneous_held_exit_crossing(self):
  b={'X':[bar('2026-11-02',100,100),bar('2026-11-03',110,110)]};e=[event('2026-11-02',True,'UP90')];r,_,_=available_replay(e,b,{'2026-11-02':'2026-11-02T13:00:00Z'},'KOSDAQ',0,'2026-11-03');self.assertEqual(len(r),1);self.assertEqual(r[0]['entry_date'],'2026-11-03')
 def test_cluster_bootstrap_matches_direct_draws(self):
  rows=[dict(symbol='A',selected=True,**{'return':.1}),dict(symbol='A',selected=False,**{'return':-.1}),dict(symbol='B',selected=True,**{'return':.2})];v=cluster_selection_ci(rows,reps=20);rng=np.random.default_rng(20261108);groups=[[rows[0],rows[1]],[rows[2]]];out=[]
  for draw in rng.integers(0,2,size=(20,2)):
   z=sum([groups[i] for i in draw],[]);out.append(np.mean([x['return'] for x in z if x['selected']])-np.mean([x['return'] for x in z]))
  self.assertAlmostEqual(v['lo'],float(np.quantile(out,.025)));self.assertAlmostEqual(v['hi'],float(np.quantile(out,.975)))
if __name__=='__main__':unittest.main(verbosity=2)
