from pathlib import Path
import json,sys
R=Path(__file__).resolve().parent
def read(p):return [json.loads(s)for s in p.read_text().splitlines()if s]
def compare(market,variant='OFF'):
 p=R/'results'/market/variant;book='KOSPI_STANDALONE_DIAGNOSTIC'if market=='KOSPI'else'ETF_V02';role='replay-kr'if market=='KOSPI'else'replay-etf';ref=R/'inputs/research/stored'/role/'attempt-1/result'
 a=read(p/'nav.jsonl');b=read(ref/(book+'.daily-nav.jsonl'));assert len(a)==len(b)
 fields=['date','cash','marketValue','nav','valuationStatus'];diff=[]
 for x,y in zip(a,b):
  for k in fields:
   if x[k]!=y[k]:diff.append({'date':x['date'],'field':k,'replay':x[k],'stored':y[k]})
 ta=read(p/'trades.jsonl');tb=read(ref/(book+'.trades.jsonl'));assert len(ta)==len(tb),(len(ta),len(tb))
 tf=['symbol','entryDate','entryPrice','shares','buyAmount','entryFee','exitSignalDate','exitDate','exitPrice','exitFee','realizedPnl']if market=='KOSPI'else['symbol','side','executionDate','signalDate','quantity','price','gross','fee','cashDelta']
 td=[]
 for x,y in zip(ta,tb):
  for k in tf:
   if x.get(k)!=y.get(k):td.append({'symbol':x['symbol'],'field':k,'replay':x.get(k),'stored':y.get(k)})
 report={'status':'PASS'if not diff and not td else'FAIL','market':market,'variant':variant,'comparedSessions':len(a),'comparedTradesOrFills':len(ta),'navDifferences':len(diff),'tradeDifferences':len(td),'examples':(diff+td)[:5],'referenceRun':'38016639367','referenceCode':'86cbc05c24ad1b166d23fb28e048471a60535025'}
 (p/'BASELINE_PARITY.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(report,ensure_ascii=False));assert report['status']=='PASS'
if __name__=='__main__':compare(*sys.argv[1:])
