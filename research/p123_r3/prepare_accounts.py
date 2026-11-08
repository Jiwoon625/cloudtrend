"""Build complete-source subwindows without backfilling a current classification."""
import argparse,json,pathlib,pandas as pd
from metrics import save
def read(p):return json.loads(pathlib.Path(p).read_text())
def main():
 p=argparse.ArgumentParser();p.add_argument('--evidence',type=pathlib.Path,required=True);p.add_argument('--recent',type=pathlib.Path,required=True);p.add_argument('--output',type=pathlib.Path,required=True);a=p.parse_args();E=a.evidence.resolve();O=a.output.resolve();ext=read(a.recent/'inputs_extended.json');bm=read(a.recent/'benchmark_extended.json')
 # Both arms start flat at a common point with complete dated source contracts.
 factors=pd.read_csv(E/'bounded-us-inputs-r3-v3/source_features_selected.csv');prices=pd.read_csv(E/'bounded-us-inputs-r3-v3/prices_selected.csv');rk=read(E/'us-dated-signal-ranks.json');ranks={(r['date'],s['symbol']):s for r in rk for s in r['signals'] or []}
 events={(r['date'],s['symbol']):s for r in ext['US_A0']['events'] for s in r['signals']}
 c=prices.pivot(index='date',columns='symbol',values='close').sort_index();ret=c/c.shift(20)-1;sma=c['SPY'].rolling(20,min_periods=20).mean();sessions=[]
 for day,g in factors[factors.date.ge('2026-10-12')].groupby('date',sort=True):
  rows=[]
  for r in g.to_dict('records'):
   s=r['symbol'];h=ranks.get((day,s),{});ev=events.get((day,s),{})
   row={'date':day,'symbol':s,'name':r['name'],'market':r['market'],'sector':r['sector'],'currency':'USD','open':r['open'],'high':r['high'],'low':r['low'],'close':r['close'],'volume':r['volume'],'adv20Usd':r['adv20_usd'],'coreRank':h.get('coreRank'),'betaRank':h.get('betaRank'),'tkRank':h.get('tkRank'),'relvolRank':h.get('relvolRank'),'a0Entry':bool(ev.get('buy')),'a0Exit':bool(ev.get('sell')),'a0BetaExit':bool(h.get('a0BetaExit')),'eligibleBase':True,'betaWeakStreak':0,'a2Entry':False,'a2Exit':False,'b3Entry':False,'b3Exit':False}
   row['mom20']=bool(ret.loc[day,'SPY']>0);row['sma20']=bool(c.loc[day,'SPY']>sma.loc[day]);row['rs20']=bool(pd.notna(ret.loc[day,s]) and ret.loc[day,s]>ret.loc[day,'SPY']);rows.append(row)
  sessions.append({'date':day,'rows':rows})
 expected=[b['date'] for b in bm['US_A0'] if '2026-10-12'<=b['date']<='2026-11-06'];assert [s['date'] for s in sessions]==expected,'US complete source subwindow not contiguous'
 save(O/'us_account_input.json',{'start':'2026-10-12','end':'2026-11-06','initial_capital':20000,'sessions':sessions,'complete_source':True,'same_window_flat_start':True,'source':'dated source factors + stored ranks and signals; after fixed20, cost and signal-priority cutovers; no index membership condition'})
 # A KR sector map is accepted only when it exists in that day's stored entry.
 hist=read(E/'R2/inputs/krattr/source/kr-history.json');j=read(E/'journal-KR-2026-11-05.json');hist.append(j)
 snapshots=[];markets={};missing=[]
 for s in hist:
  if s['date']<'2026-10-14':continue
  entries=[]
  for e in s['entries']:
   if e.get('market')!='KOSDAQ':continue
   if not e.get('sectorCode'):missing.append((s['date'],e['symbol']));continue
   markets[e['symbol']]='KOSDAQ';entries.append(e)
  snapshots.append({k:v for k,v in dict(s,asOfDate=s['date'],entries=entries,totalCount=len(entries),passedCount=sum(e.get('hardFilterPassed',False) for e in entries)).items() if k not in ['topStocks','topEtfs']})
 assert not missing and snapshots and all(s['entries'] for s in snapshots),'KR dated classification not ready'
 # Keep the independently recovered preliminary exits, without promoting any
 # unconfirmed entries to a complete historical journal.
 orig=read(E/'R2/inputs/krzip/original-kr-20261026.json');source={r['instrument']['symbol']:r for r in orig['result']['rows']};recovered=[]
 for ev in ext['KOSDAQ']['events']:
  if ev['date']!='2026-10-26':continue
  for r in ev['signals']:
   z=source[r['symbol']];ins=z['instrument'];assert ins['market']=='KOSDAQ' and r['sell']==z['exitSignal']
   recovered.append(dict(symbol=r['symbol'],name=r['name'],market='KOSDAQ',instrumentType='STOCK',sectorCode=ins['sectorCode'],sectorName=ins['sectorName'],technicalPoints=r['score'],scoreDelta1d=None,kosdaq80Onset=False,exitSignal=r['sell'],hardFilterPassed=z['hardFilterPassed'],hardFilterStatus=z['hardFilterStatus'],pendingRules=z['pendingRules'],status='RECOVERED_PRELIMINARY_EXIT_ONLY',operationalSignalVersion=r['version']))
 snapshots.append(dict(date='2026-10-26',asOfDate='2026-10-26',savedAt=orig['run']['createdAt'],runId=orig['run']['id'],entries=recovered,totalCount=len(recovered),coverage='PARTIAL_PRELIMINARY_EXIT_ONLY'));snapshots.sort(key=lambda s:s['asOfDate'])
 kb=read(E/'R2/inputs/krattr/source/kr-bars.json')['bars'];df=pd.read_csv(E/'kr-outputs/kr-outputs/publish_prepared/publish_20260922_20261106_000.csv',dtype={'symbol':str},low_memory=False)
 bars={};liquid={}
 for s in markets:
  b={r['tradeDate']:r for r in kb[s]}
  for r in df[df.symbol.eq(s)&df.date.gt('2026-11-04')].to_dict('records'):b[r['date']]={'tradeDate':r['date'],'open':r['open'],'high':r['high'],'low':r['low'],'close':r['close'],'volume':r['volume']}
  bars[s]=sorted(b.values(),key=lambda x:x['tradeDate'])
 dates=[b['date'] for b in bm['KOSDAQ'] if '2026-10-14'<=b['date']<='2026-11-06']
 for d in dates:liquid[d]=sum(any(b['tradeDate']==d and b['volume']>0 for b in bs) for bs in bars.values())
 save(O/'kr_account_input.json',{'start':'2026-10-14','end':'2026-11-06','initial_capital':30000000,'snapshots':snapshots,'bars':bars,'markets':markets,'sessions':dates,'liquidCounts':liquid,'missing_signal_dates':['2026-11-06'],'partial_signal_dates':{'2026-10-26':'PRELIMINARY_EXIT_ONLY'},'same_window_flat_start':True,'classification':'date-local stored entries only; no current-sector fallback'})
 print('Complete-source subwindows prepared',len(sessions),'US sessions',len(dates),'KR price sessions',len(markets),'KR symbols')
if __name__=='__main__':main()
