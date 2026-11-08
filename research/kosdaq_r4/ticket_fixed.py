"""Fixed original 26 entry opportunities; no reinvestment/new-entry credit."""
import argparse,copy,json,pathlib
from metrics import save,table,trade_stats,sha
from recent import annotate
from replay import replay
def main():
 p=argparse.ArgumentParser();p.add_argument('--inputs',type=pathlib.Path,required=True);p.add_argument('--protocol',type=pathlib.Path,required=True);p.add_argument('--exploratory-protocol',type=pathlib.Path,required=True);p.add_argument('--output',type=pathlib.Path,required=True);a=p.parse_args();I=a.inputs;O=a.output;d=json.loads((I/'recent_input.json').read_text());specs=json.loads(a.protocol.read_text())['variants']+json.loads(a.exploratory_protocol.read_text())['variants'][1:];bars=d['bars'];events=d['events'];rows=[];summary=[]
 for fee in [.0015,.003]:
  base=replay(events,bars,dict(ticket=1e6,fee=fee),'2026-11-06')['trades'];assert len(base)==26
  for spec in specs:
   if spec.get('gateSlots') is not None:continue
   rr=[]
   for t in base:
    ev=copy.deepcopy(events)
    for e in ev:
     for s in e['signals']:s['buy']=bool(s.get('buy') and e['date']==t['signal_date'] and s['symbol']==t['symbol'])
    cfg=dict(ticket=1e6,fee=fee,**{k:v for k,v in spec.items() if k!='name'});st=replay(ev,bars,cfg,'2026-11-06');assert len(st['trades'])==1;z=annotate(st,bars,'2026-11-06')[0];assert z['entry_date']==t['entry_date'] and z['entry_price']==t['entry_price'];z.update(variant=spec['name'],fee_oneway=fee,base_pnl=t['pnl'],delta_pnl=z['pnl']-t['pnl']);rr.append(z)
   rows.extend(rr)
   for cohort in ['all','high9']:
    sub=rr if cohort=='all' else [r for r in rr if r.get('entry_score') is not None and r['entry_score']>=9];summary.append(dict(variant=spec['name'],fee_oneway=fee,cohort=cohort,**trade_stats(sub),delta_pnl=sum(r['delta_pnl'] for r in sub),fixed_original_entries=True))
 table(O/'fixed_ticket_entries.csv',rows);table(O/'fixed_ticket_summary.csv',summary);save(O/'COMPLETE.json',dict(status='PASS',original_opportunities=26,high9_opportunities=11,no_reentry_credit=True,files={str(p.relative_to(O)):sha(p) for p in O.rglob('*') if p.is_file() and p.name!='COMPLETE.json'}));print('Fixed original 26 ticket opportunities PASS')
if __name__=='__main__':main()
