"""Signal-only research replay. Never writes live holdings or the database.
Checkpoint is bound to processed input prefix: a historical backfill requires full replay.
Close signals execute at a subsequent observed positive-volume open; unresolved exits persist.
"""
import copy,hashlib,json,math,os,pathlib

def digest(x):return hashlib.sha256(json.dumps(x,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()
def positive(x):return isinstance(x,(int,float)) and math.isfinite(x) and x>0

def replay(events,bars,config,through,checkpoint=None,checkpoint_path=None):
    if len({e['date'] for e in events})!=len(events):raise ValueError('Duplicate signal dates')
    for e in events:
        if len({r['symbol'] for r in e['signals']})!=len(e['signals']):raise ValueError('Duplicate signal symbols')
    for bs in bars.values():
        if [b['date'] for b in bs]!=sorted({b['date'] for b in bs}):raise ValueError('Bars must be sorted and unique')
    by={s:{b['date']:b for b in bs} for s,bs in bars.items()}
    dates=sorted({b['date'] for bs in bars.values() for b in bs if b['date']<=through})
    em={e['date']:{r['symbol']:r for r in e['signals']} for e in events}
    def identity(end):
        return digest({'engine':hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),'config':config,'events':[e for e in events if e['date']<=end], 'bars':{s:[b for b in bs if b['date']<=end] for s,bs in bars.items()}})
    state=copy.deepcopy(checkpoint) if checkpoint else dict(version=1,last_date='',positions={},pending={},trades=[],last_exit={},rejected=[],issues=[])
    if checkpoint and (state['version']!=1 or state['input_hash']!=identity(state['last_date'])):raise ValueError('Processed inputs changed: restart replay from the beginning')
    if state['last_date']>through:raise ValueError('Cannot rewind checkpoint')
    fee=config.get('fee',0);ticket=config['ticket']
    state.setdefault('cash',config.get('capital',0));state.setdefault('nav',[])
    for day in dates:
        if day<=state['last_date']:continue
        for s,order in sorted(list(state['pending'].items()),key=lambda v: v[1]['side']!='SELL') if config.get('capital') else list(state['pending'].items()):
            if order['signal_date']>=day:continue
            b=by.get(s,{}).get(day)
            if not b or not positive(b.get('open')) or not positive(b.get('volume')):
                state['issues'].append(dict(date=day,symbol=s,side=order['side'],reason='MISSING_OR_INVALID' if not b or b.get('volume')!=0 else 'OBSERVED_ZERO_VOLUME'))
                continue
            if order['side']=='BUY':
                reference=next((by[s][d]['close'] for d in reversed(dates) if d<day and d in by[s] and positive(by[s][d].get('close'))),None)
                if config.get('gap_max') is not None and (config.get('gap_score_min') is None or order.get('score',-1)>=config['gap_score_min']) and (not reference or b['open']/reference-1>=config['gap_max']):
                    state['rejected'].append(dict(date=day,symbol=s,reason='OPEN_GAP'));del state['pending'][s];continue
                if config.get('capital') and state['cash']<ticket:
                    state['rejected'].append(dict(date=day,symbol=s,reason='CASH'));del state['pending'][s];continue
                q=ticket/(b['open']*(1+fee));q=math.floor(q) if config.get('integer') else q
                if q<=0:
                    state['rejected'].append(dict(date=day,symbol=s,reason='LOT'));del state['pending'][s];continue
                cost=q*b['open']*(1+fee)
                if config.get('capital'):state['cash']-=cost
                t=dict(cost=cost,symbol=s,name=order.get('name',s),market=order['market'],signal_date=order['signal_date'],entry_date=day,entry_price=b['open'],quantity=q,peak=b['open'],mark=b['open'],mark_date=day,exit_date=None,exit_price=None,exit_signal_date=None,exit_reason=None)
                state['trades'].append(t);state['positions'][s]=len(state['trades'])-1
            else:
                t=state['trades'][state['positions'].pop(s)]
                t.update(exit_date=day,exit_price=b['open'],exit_signal_date=order['signal_date'],exit_reason=order['reason'])
                state['last_exit'][s]=day
                if config.get('capital'):state['cash']+=t['quantity']*b['open']*(1-fee)
            del state['pending'][s]
        for s,i in state['positions'].items():
            t=state['trades'][i];b=by.get(s,{}).get(day);reason=em.get(day,{}).get(s,{}).get('sell')
            if b and positive(b.get('close')):
                t.update(mark=b['close'],mark_date=day,peak=max(t['peak'],b['close']))
                stop=config.get('stop')
                hit=stop is not None and b['close']<=t['entry_price']*(1-stop)
                t['stop_streak']=t.get('stop_streak',0)+1 if hit else 0
                if hit and t['stop_streak']>=config.get('confirm',1):reason=reason or 'PRICE_STOP'
                trail=config.get('trail')
                if trail is not None and t['peak']>=t['entry_price']*(1+config.get('activate',0)) and b['close']<=t['peak']*(1-trail):reason=reason or 'PROFIT_PROTECT'
                if day>='2026-10-15' and t['market']=='KOSPI' and b['close']<=t['entry_price']*.92:reason=reason or 'K4'
                if day>='2026-10-15' and t['market']=='ETF' and b['close']<=t['peak']*.9:reason=reason or 'E4'
            if not b or not positive(b.get('close')):t['stop_streak']=0
            if reason and s not in state['pending']:state['pending'][s]=dict(side='SELL',signal_date=day,reason=reason)
        for s,e in em.get(day,{}).items():
            if not e.get('buy'):continue
            reason=None
            if s in state['positions'] or s in state['pending']:reason='HELD_OR_PENDING'
            elif config.get('trend_key') and not e.get(config['trend_key'],False):reason='TREND_GATE'
            elif config.get('score_max') is not None and (e.get('score') is None or e['score']>=config['score_max']):reason='SCORE_JUMP'
            elif config.get('runup_max') is not None and (e.get('runup5') is None or e['runup5']>=config['runup_max']):reason='PRIOR_RUNUP'
            elif config.get('cooldown') and s in state['last_exit'] and sum(state['last_exit'][s]<d<=day for d in dates)<=config['cooldown']:reason='REENTRY_COOLDOWN'
            if reason:state['rejected'].append(dict(date=day,symbol=s,reason=reason));continue
            state['pending'][s]=dict(e,side='BUY',signal_date=day)
        if config.get('capital'):
            state['nav'].append(dict(date=day,cash=state['cash'],nav=state['cash']+sum(state['trades'][i]['quantity']*state['trades'][i]['mark'] for i in state['positions'].values()),positions=len(state['positions'])))
        state['last_date']=day
        if checkpoint_path:
            state['input_hash']=identity(day)
            save_checkpoint(checkpoint_path,state)
    state['input_hash']=identity(state['last_date'])
    state['partial_signal_dates']=[dict(date=e['date'],coverage=e['coverage']) for e in events if e.get('coverage') and e['date']<=through]
    state['missing_signal_dates']=[d for d in dates if events[0]['date']<=d<=through and d not in em]
    for t in state['trades']:
        t['pnl']=t['quantity']*(t['exit_price']*(1-fee) if t['exit_date'] else t['mark'])-t.get('cost',ticket)
    if checkpoint_path:save_checkpoint(checkpoint_path,state)
    return state

def save_checkpoint(path,state):
    path=pathlib.Path(path);tmp=path.with_suffix(path.suffix+'.tmp')
    with tmp.open('w') as f:json.dump(state,f,ensure_ascii=False,allow_nan=False);f.flush();os.fsync(f.fileno())
    os.replace(tmp,path)
