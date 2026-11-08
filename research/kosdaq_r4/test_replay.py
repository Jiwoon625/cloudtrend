import unittest
from replay import replay
from recent import available
def b(d,price,close=None,volume=100):return dict(date=d,open=price,close=price if close is None else close,high=price,low=price,volume=volume)
def e(d,symbol='X',buy=True,sell=None,score=9):return dict(date=d,signals=[dict(symbol=symbol,market='KOSDAQ',buy=buy,sell=sell,score=score)])
class Rules(unittest.TestCase):
 def test_high_score_trail_does_not_change_low_score_entry(self):
  bars={'X':[b('2026-11-02',100),b('2026-11-03',100,90),b('2026-11-04',60)]};c=dict(ticket=1000,fee=.0015,trail=.08,highScoreMin=9)
  x=replay([e('2026-11-02',score=8.5)],bars,c,'2026-11-04');self.assertIsNone(x['trades'][0]['exit_date']);x=replay([e('2026-11-02')],bars,c,'2026-11-04');self.assertEqual(x['trades'][0]['exit_price'],60)
 def test_gate_uses_preceding_session_not_current_close(self):
  bars={'X':[b('2026-11-02',100),b('2026-11-03',100)]};c=dict(ticket=1000,fee=0,gateSlots=0,gate_states={'2026-11-02':'BELOW','2026-11-03':'ABOVE'});x=replay([e('2026-11-02')],bars,c,'2026-11-03');self.assertEqual(len(x['trades']),0)
 def test_gate_cap_applies_after_same_open_sells(self):
  bars={s:[b('2026-11-02',100),b('2026-11-03',100),b('2026-11-04',100)] for s in ['X','Y']};events=[e('2026-11-02'),dict(date='2026-11-03',signals=e('2026-11-03',buy=False,sell='EXIT')['signals']+e('2026-11-03',symbol='Y')['signals'])];c=dict(ticket=1000,fee=0,gateSlots=1,gate_states={'2026-11-02':'BELOW','2026-11-03':'BELOW'});x=replay(events,bars,c,'2026-11-04');self.assertEqual([t['symbol'] for t in x['trades']],['X','Y']);self.assertEqual(x['trades'][0]['exit_date'],'2026-11-04')
 def test_threshold_close_pending_survives_resume(self):
  bars={'X':[b('2026-11-02',100),b('2026-11-03',100),b('2026-11-04',100,80),b('2026-11-05',60)]};ev=[e('2026-11-02')];c=dict(ticket=1000,fee=.0015,trail=.08,highScoreMin=9);x=replay(ev,bars,c,'2026-11-04');self.assertEqual(x['pending']['X']['side'],'SELL');self.assertIn('X',x['positions']);y=replay(ev,bars,c,'2026-11-05',x);self.assertEqual(y['trades'][0]['exit_price'],60);self.assertEqual(y,replay(ev,bars,c,'2026-11-05'))
 def test_retained_timestamp_cannot_fill_an_earlier_open(self):
  bars={'X':[b('2026-11-02',100),b('2026-11-03',110),b('2026-11-04',120)]};x=available([e('2026-11-02')],bars,dict(ticket=1000,fee=0),'2026-11-04',{'2026-11-02':'2026-11-03T01:00:00Z'});self.assertEqual(x['trades'][0]['entry_date'],'2026-11-04')
 def test_replacement_preserves_downside_and_lower_score_rules(self):
  ds=['2026-11-02','2026-11-03','2026-11-04','2026-11-05','2026-11-06'];bars={'X':[b(d,100) for d in ds]};cfg=dict(ticket=1000,fee=0,replaceProfitExitOnHighScore=True)
  for score,want in [(9,ds[4]),(8.5,ds[3])]:
   x=replay([e(ds[0],score=score),e(ds[2],buy=False,sell='UP90'),e(ds[3],buy=False,sell='DOWN30')],bars,cfg,ds[-1]);self.assertEqual(x['trades'][0]['exit_date'],want)
if __name__=='__main__':unittest.main(verbosity=2)
