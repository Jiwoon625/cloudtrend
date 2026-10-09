import sys,json,unittest
from pathlib import Path
from decimal import Decimal,ROUND_CEILING
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from audit_us_roundtrips import aggregate,RoundtripError,stats

def fixture(spec):
 ts=[];positions={};cash=Decimal('74671.44');fees=Decimal(0);counts={'BUY':0,'SELL':0};cycles=0;proxy=0
 for i,(side,symbol,q,p) in enumerate(spec):
  gross=Decimal(str(p))*q;fee=(gross*Decimal('.0015')).quantize(Decimal('.00000001'),rounding=ROUND_CEILING);counts[side]+=1;fees+=fee
  t={'tradeKey':str(i),'executionDate':f'2020-01-{i+2:02}','status':'EXECUTED','side':side,'symbol':symbol,'modelShares':q,'modelPrice':p,'modelNotional':str(gross),'feeUsd':str(fee),'reason':'ENTRY' if side=='BUY' else 'EXIT'};ts.append(t)
  if side=='BUY':positions[symbol]=positions.get(symbol,0)+q;cash-=gross+fee
  else:
   positions[symbol]-=q;cash+=gross-fee
   if positions[symbol]==0:del positions[symbol];cycles+=1
 state={'positions':{s:{'shares':q} for s,q in positions.items()},'modelCashExact':str(cash),'modelFeesExact':str(fees)}
 audit={'status':'PASS','arithmeticAndLedgerChecksPassed':True,'performance':{'mdd':-.2},'ledger':{'initialCashExact':'74671.44','finalCashExact':str(cash),'totalFeesExact':str(fees),'completedPositionLifecycles':cycles,'retrospectiveProxyExitFills':proxy},'tradeCounts':{'allFills':counts}}
 summary={'US_A0':{'status':'COMPLETE','startDate':'2020-01-02','endDate':'2020-01-31','mdd':-.2,'missingValuationCount':0,'staleValuationCount':0}}
 return ts,state,audit,summary

class Roundtrips(unittest.TestCase):
 def test_splits_topup_after_partial_and_open_exclusion(self):
  f=fixture([('BUY','A',3,10),('BUY','A',2,11),('SELL','A',2,12),('BUY','A',1,13),('SELL','A',4,14),('BUY','B',1,100)])
  r,c=aggregate(*f);self.assertEqual(r['sampleCount'],1);self.assertEqual(r['excludedOpenPositions'],1)
  self.assertEqual(c[0]['buyGross'],'65');self.assertEqual(c[0]['sellGross'],'80');self.assertEqual(c[0]['buyFills'],3);self.assertEqual(c[0]['sellFills'],2)
  self.assertAlmostEqual(r['meanNetReturn'],(80*.9985-65*1.0015)/(65*1.0015));self.assertEqual(r['meanNetReturn'],r['medianNetReturn'])
 def test_reentry_separate_and_pending_not_counted(self):
  f=fixture([('BUY','A',1,10),('SELL','A',1,20),('BUY','A',1,20),('SELL','A',1,10)])
  f[0].insert(0,{'executionDate':None,'status':'PENDING'});f[0].insert(0,{'executionDate':None,'status':'PENDING'})
  r,c=aggregate(*f);self.assertEqual(r['sampleCount'],2);self.assertEqual(r['ignoredPendingRows'],2);self.assertEqual(r['winningCount'],1);self.assertEqual(r['losingCount'],1)
  self.assertEqual(r['byExitYear'][0]['sampleCount'],2)
 def test_empty_closed_is_null_not_zero(self):
  r,_=aggregate(*fixture([('BUY','A',1,10)]));self.assertIsNone(r['meanNetReturn']);self.assertIsNone(r['medianNetReturn']);self.assertEqual(r['sampleCount'],0)
 def test_odd_even_median_equal_weight(self):
  self.assertEqual(stats([Decimal(-1),Decimal(1),Decimal(9)])['medianNetReturn'],1)
  self.assertEqual(stats([Decimal(-1),Decimal(1),Decimal(9),Decimal(11)])['medianNetReturn'],5)
 def test_proxy_closes_same_cycle(self):
  f=fixture([('BUY','A',1,10),('SELL','A',1,9)]);f[0][-1]['reason']='US_A0_ALL_HELD_LAST_VALID_CLOSE_EXIT_V1';f[2]['ledger']['retrospectiveProxyExitFills']=1
  self.assertEqual(aggregate(*f)[0]['proxyClosedPositions'],1)
 def test_invalid_inputs_fail_closed(self):
  for mutate in [lambda f:f[0].append(f[0][0].copy()),lambda f:f[0][-1].update(modelShares=2),lambda f:f[0][0].update(feeUsd=10),lambda f:f[2].update(status='FAIL'),lambda f:f[1].update(modelCashExact='1'),lambda f:f[2]['ledger'].update(completedPositionLifecycles=3)]:
   f=fixture([('BUY','A',1,10),('SELL','A',1,11)]);mutate(f)
   with self.assertRaises(RoundtripError):aggregate(*f)
if __name__=='__main__':unittest.main()
