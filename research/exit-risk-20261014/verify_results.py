from pathlib import Path
from decimal import Decimal,ROUND_CEILING
import json,gzip,sys
D=Decimal; UNIT=D('0.00000001')
ROOT=Path(__file__).resolve().parent
def rows(p):return [json.loads(x)for x in p.read_text().splitlines()if x]
def main(market,variant):
 p=ROOT/'results'/market/variant; complete=json.loads((p/'COMPLETE.json').read_text());fee=D(str(complete['policy'].get('fee',.0015)))
 nav=rows(p/'nav.jsonl');trades=rows(p/'trades.jsonl');bars=json.loads(gzip.decompress((ROOT/'inputs/derived'/f'{market}.bars.json.gz').read_bytes()));by={s:{r['tradeDate']:r for r in rs}for s,rs in bars.items()}
 fills=[]
 if market=='ETF':fills=trades
 else:
  partial=json.loads((p/'partial-fills.json').read_text());pm={x['id']:x for x in partial};timing=json.loads((p/'timing.json').read_text())if(p/'timing.json').exists()else{}
  for t in trades:
   part=pm.get(t['id']);q=part['initialShares']if part else t['shares'];px=D(str(t['entryPrice']));gross=px*q;f=(gross*fee).quantize(UNIT,rounding=ROUND_CEILING)
   fills.append(dict(symbol=t['symbol'],side='BUY',executionDate=t['entryDate'],executionAt='OPEN',price=str(px),quantity=str(q),gross=str(gross),fee=str(f),cashDelta=str(-gross-f)))
   if t['exitDate']:
    q=t['shares'];px=D(str(t['exitPrice']));gross=px*q;f=(gross*fee).quantize(UNIT,rounding=ROUND_CEILING)
    fills.append(dict(symbol=t['symbol'],side='SELL',executionDate=t['exitDate'],executionAt=timing.get(t['id'],'OPEN'),price=str(px),quantity=str(q),gross=str(gross),fee=str(f),cashDelta=str(gross-f)))
  for t in partial:fills.append(dict(symbol=t['symbol'],side='SELL',executionDate=t['date'],executionAt='OPEN',price=str(t['price']),quantity=str(t['shares']),gross=t['gross'],fee=t['fee'],cashDelta=str(D(t['gross'])-D(t['fee']))))
 events={}
 for f in fills:
  q=int(f['quantity']);g=D(f['price'])*q;fc=(g*fee).quantize(UNIT,rounding=ROUND_CEILING)
  assert abs(g-D(f['gross']))<=UNIT,('gross',f)
  assert abs(fc-D(f['fee']))<=UNIT,('fee',f)
  expected=-g-fc if f['side']=='BUY'else g-fc
  assert abs(D(f['cashDelta'])-expected)<=UNIT,('delta',f)
  events.setdefault(f['executionDate'],[]).append(f)
 cash=D('100000000');held={};maxcash=maxnav=D(0);worst_open=D('1e99')
 for n in nav:
  # Official OPEN sells precede OPEN buys. CLOSE proceeds become available afterward.
  es=events.get(n['date'],[]);es.sort(key=lambda f:(1 if f['executionAt']=='CLOSE'else 0,0 if f['side']=='SELL'else 1))
  for f in es:
   cash+=D(f['cashDelta']);q=int(f['quantity']);held[f['symbol']]=held.get(f['symbol'],0)+(q if f['side']=='BUY'else-q)
   assert held[f['symbol']]>=0;worst_open=min(worst_open,cash)
  maxcash=max(maxcash,abs(cash-D(n['cash'])))
  mv=D(0)
  for sym,q in held.items():
   if not q:continue
   b=by[sym].get(n['date'])
   assert b and b.get('close')and b['close']>0,('missing held mark',sym,n['date'])
   mv+=D(str(b['close']))*q
  maxnav=max(maxnav,abs(cash+mv-D(n['nav'])))
 assert maxcash<=D('.000001')and maxnav<=D('.000001'),(market,variant,maxcash,maxnav)
 assert worst_open>=0,('negative cash',worst_open)
 report=dict(status='PASS',market=market,variant=variant,sessions=len(nav),fills=len(fills),maxCashDifference=str(maxcash),maxNavDifference=str(maxnav),minimumIntradayCash=str(worst_open),independentMethod='Python Decimal, fill amount/fee/cash/observed-close NAV; open-before-close cash timing')
 (p/'INDEPENDENT_VERIFICATION.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
if __name__=='__main__':main(*sys.argv[1:])
