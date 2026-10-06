"""Research-only ports of frozen CloudTrend signals; no I/O or production writes.

Source: a844945f62fa7ea60f4b497b4e66e408d891ebfd. These functions do not rebuild
raw price features. Feature provenance/eligibility must be supplied by the caller.
Historical current-policy replays explicitly opt out of prospective adoption dates.
"""
from __future__ import annotations
from decimal import Decimal, ROUND_CEILING, ROUND_DOWN
from math import isfinite, floor
from typing import Any, Mapping
from cm06_shared_us_ranking_v1 import maybe_shared_us_cross_section

FROZEN_SHA = 'a844945f62fa7ea60f4b497b4e66e408d891ebfd'
KOSPI_VERSION = 'kospi-e8-confirm1-rsaccel-bear-v3'
ETF_VERSION = 'etf-v02-confirm1-liquidity-no-replacement'
US_VERSION = 'us-prospective-1.1.0-a0-anchor'
ONE_WAY_COST = Decimal('0.0015')
QUANTUM = Decimal('0.00000001')

def finite(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and isfinite(x)

def positive(x):
    return finite(x) and x > 0

def percentile_rank(pairs):
    ordered = sorted(pairs, key=lambda x: (x[1], x[0]))
    if len(ordered) == 1:
        return {ordered[0][0]: 1.0}
    out = {}
    i = 0
    while i < len(ordered):
        j = i + 1
        while j < len(ordered) and ordered[j][1] == ordered[i][1]: j += 1
        value = ((i + j - 1) / 2) / (len(ordered) - 1)
        for k in range(i, j): out[ordered[k][0]] = value
        i = j
    return out

def us_cross_section_ranks(input_rows):
    """Exact candidate-independent current-session US ranks.

    Previous rank state, beta streaks, holdings, cash, orders and fills are
    deliberately excluded so only the immutable market cross-section is shared.
    """
    tradable = [r for r in input_rows if r['symbol'] != 'SPY' and r['researchCommonSnapshot'] and r['researchExchangeEligible']
                and (r.get('status') is None or r['status'].upper() == 'ACTIVE')
                and positive(r.get('close')) and r.get('ret120') is not None and r.get('ret252') is not None]
    def rank(field, inverse=False):
        return percentile_rank([(r['symbol'], (-1 if inverse else 1) * r[field]) for r in tradable if finite(r.get(field))])
    r120, r252 = rank('ret120'), rank('ret252')
    beta, tk, rv, liq, ami = rank('beta60Spy'), rank('ichimokuTkGap'), rank('relvol1_20'), rank('adv20Usd'), rank('amihud20', True)
    core_scores = {r['symbol']: 0.5*r120[r['symbol']] + 0.5*r252[r['symbol']] for r in tradable if r['symbol'] in r120 and r['symbol'] in r252}
    core_rank = percentile_rank(list(core_scores.items()))
    return dict(r120=r120,r252=r252,beta=beta,tk=tk,rv=rv,liq=liq,ami=ami,
                core_scores=core_scores,core_rank=core_rank)

def us_analysis(input_rows, previous=None):
    """Frozen ranking formulas with explicitly named research-universe inputs; not broker/PIT certification."""
    previous = previous or {}
    if not input_rows: raise ValueError('US screening input is empty')
    date = max(r['date'] for r in input_rows)
    if any(r['date'] != date for r in input_rows) or len({r['symbol'] for r in input_rows}) != len(input_rows):
        raise ValueError('US input must contain one date and unique symbols')
    if previous.get('lastDate', '') >= date: raise ValueError('Rank state requires a later trading date')
    cross = maybe_shared_us_cross_section(input_rows)
    if cross is None:
        cross = us_cross_section_ranks(input_rows)
    r120, r252 = cross['r120'], cross['r252']
    beta, tk, rv, liq, ami = cross['beta'], cross['tk'], cross['rv'], cross['liq'], cross['ami']
    core_scores, core_rank = cross['core_scores'], cross['core_rank']
    prev_core, prev_streak = previous.get('coreRanks', {}), previous.get('betaWeakStreak', {})
    bootstrap = not prev_core
    next_core, next_streak, out = {}, {}, []
    for row in input_rows:
        s = row['symbol']; c, b, t, v, l, a = core_rank.get(s), beta.get(s), tk.get(s), rv.get(s), liq.get(s), ami.get(s)
        if c is not None: next_core[s] = c
        prior = prev_core.get(s)
        onset = not bootstrap and c is not None and c >= .8 and finite(prior) and prior < .8
        eligible = c is not None and b is not None and l is not None and a is not None and bool(row['active20']) and (row.get('adv20Usd') or 0) >= 500000 and b >= .9 and l >= .1 and a >= .1
        aggressive, balanced = t is not None and t >= .8, v is not None and v >= .8
        streak = prev_streak.get(s, 0) + 1 if b is not None and b < .6 else 0
        next_streak[s] = streak
        a0entry, a0beta = eligible and onset and aggressive, streak >= 3
        a0exit = s != 'SPY' and (c is None or c < .7 or a0beta)
        a2exit = s != 'SPY' and (c is None or c < .7)
        b3entry, b3base = eligible and onset and balanced, s != 'SPY' and (c is None or c < .5)
        out.append(dict(row, ret120Rank=r120.get(s),ret252Rank=r252.get(s),coreScore=core_scores.get(s),coreRank=c,betaRank=b,tkRank=t,relvolRank=v,liquidityRank=l,amihudRank=a,
                        eligibleBase=eligible,onset80=onset,aggressiveConfirm=aggressive,balancedConfirm=balanced,a0Entry=a0entry,a0Exit=a0exit,a0BetaExit=a0beta,a2Entry=a0entry,a2Exit=a2exit,
                        b3Entry=b3entry,b3BaseExit=b3base,betaWeakStreak=streak,b3BetaExit=a0beta,b3Exit=b3base or a0beta,
                        primarySignal='ENTRY' if a0entry else 'EXIT' if a0exit else 'WATCH' if c is not None and c >= .7 else 'NONE'))
    out.sort(key=lambda r: (-(r['coreRank'] if r['coreRank'] is not None else -1), -(r['betaRank'] if r['betaRank'] is not None else -1), r['symbol']))
    return dict(date=date,ruleVersion=US_VERSION,rows=out,state=dict(lastDate=date,coreRanks=next_core,betaWeakStreak=next_streak),summary=dict(inputRows=len(out),rankedRows=len(core_rank),a0Entries=sum(r['a0Entry'] for r in out),a0Exits=sum(r['a0Exit'] for r in out),a2Entries=sum(r['a2Entry'] for r in out),a2Exits=sum(r['a2Exit'] for r in out),b3Entries=sum(r['b3Entry'] for r in out),b3Exits=sum(r['b3Exit'] for r in out),spyClose=next((r.get('close') for r in out if r['symbol']=='SPY'),None)))

def kr_operational_signals(market, previous, current, eligible, held=False):
    ok = finite(previous) and finite(current)
    onset = bool(eligible and ok and previous < 8 and current >= 8)
    ex = None
    if ok and (held or not onset):
        if market == 'KOSPI' and previous < 9.5 <= current: ex = 'UP95'
        if market == 'KOSDAQ':
            if previous < 9 <= current: ex = 'UP90'
            elif previous > 3 >= current: ex = 'DOWN30'
    return dict(kospi80Onset=market=='KOSPI' and onset,kosdaq80Onset=market=='KOSDAQ' and onset,kospiEightPointEntry=False,exitSignal=ex,operationalSignalVersion=KOSPI_VERSION)

def kospi_confirmation(current, previous=None, before_previous=None, historical_policy=False):
    """Strict adjacent KOSPI-session observations. historical_policy applies v3 timelessly."""
    def cross(a,b):
        return bool(a and b and a['observed'] and b['observed'] and b['eligible'] and finite(a.get('score')) and finite(b.get('score')) and a['date'] < b['date'] and a['score'] < 8 <= b['score'])
    pending = cross(previous,current)
    awaiting = bool(previous and previous['date'] < current['date'] and cross(before_previous,previous))
    r = dict(version=KOSPI_VERSION,date=current['date'],originDate=previous['date'] if awaiting else current['date'] if pending else None,confirmationDate=current['date'] if awaiting else None,state='none',issues=[],rsAccel=current.get('rsAccel') if finite(current.get('rsAccel')) else None,score=current.get('score') if finite(current.get('score')) else None,originScore=previous.get('score') if awaiting else current.get('score') if pending else None,eligible=False,marketGate=dict(origin=(previous if awaiting else current if pending else {}).get('marketGate'),confirmation=current.get('marketGate') if awaiting else None))
    issues=r['issues']
    if awaiting:
        if current['observed'] and not current['eligible']: issues.append('확인일 대상 부적격')
        if finite(current.get('score')) and current['score'] < 8: issues.append('확인일 V8 8점 미만')
        if finite(previous.get('score')) and finite(current.get('score')) and previous['score'] < 9.5 <= current['score']: issues.append('확인일 U9.5 청산신호')
        if finite(current.get('rsAccel')) and current['rsAccel'] <= 0: issues.append('확인일 RSAccel 0 이하')
        if issues: r['state']='rejected'
        elif not current['observed'] or not finite(current.get('score')) or not finite(current.get('rsAccel')):
            r['state']='unobservable';issues.append('확인일 종목·지수·점수·RS 자료 미확인 · 지연 진입 불가')
        else:
            r['state']='confirmed';r['eligible']=historical_policy or current['date'] >= '2026-10-02'
            if not r['eligible']: issues.append('도입일 이전 재구성 · 과거 참고만, 운영 진입 제외')
    elif pending: r['state']='pending'
    elif not current['observed'] or not previous or not previous['observed'] or not finite(current.get('score')) or not finite(previous.get('score')):
        r['state']='unobservable';issues.append('연속 거래일 관측 부족 · 신규 돌파/확인 여부 미확인')
    if (awaiting or pending) and (historical_policy or current['date'] >= '2026-10-02'):
        checks=[('발생일',r['originDate'],r['marketGate']['origin'])]
        if awaiting: checks.append(('확인일',current['date'],r['marketGate']['confirmation']))
        unknown=bear=False
        for label,date,g in checks:
            if not g or g['date'] != date or g['status']=='UNKNOWN' or g['incomplete'] or g['evaluatedCount'] != 4 or g['issues']:
                unknown=True;issues.append(f'{label} 시장국면 미확인 · 신규매수 제한'+(' ('+', '.join(g['issues'])+')' if g and g['issues'] else ''))
            elif g['status']=='RISK_OFF':
                bear=True;issues.append(f'{label} 불황(RISK_OFF) · 신규매수 제한 · 새 Onset 필요')
        if bear or unknown:
            r['eligible']=False;r['state']='rejected' if bear or r['state']=='rejected' else 'unobservable'
    return r

def etf_confirmation(current, previous=None, before_previous=None):
    def cross(a,b):
        return bool(a and b and a['eligible'] and b['eligible'] and finite(a.get('score')) and finite(b.get('score')) and a['score'] < 80 <= b['score'])
    raw=cross(previous,current);awaiting=cross(before_previous,previous);issues=[]
    if awaiting:
        if not current['eligible']: issues.append('확인일 데이터·대상 부적격')
        if not finite(current.get('score')) or current['score'] < 80: issues.append('확인일 M0 80 미만 또는 결측')
        if not positive(current.get('underlyingClose')) or not positive(current.get('underlyingMa60')): issues.append('확인일 기초지수·MA60 결측')
        elif current['underlyingClose'] < current['underlyingMa60']: issues.append('확인일 기초지수 MA60 하회')
    state=('rejected' if issues else 'confirmed') if awaiting else 'pending' if raw else 'none'
    return dict(rawOnset=raw,entryState=state,onset=state=='confirmed',originDate=previous['date'] if awaiting else current['date'] if raw else None,confirmationDate=current['date'] if awaiting else None,confirmationIssues=issues)

def etf_entry_weight(annual_volatility):
    if not finite(annual_volatility) or annual_volatility < 0: return None
    return .1 if annual_volatility == 0 else .1*min(1,.15/annual_volatility)

def etf_m0(technical, priority, health, environment):
    return .625*technical + .075*priority + .15*health + .15*environment if all(finite(x) for x in [technical,priority,health,environment]) else None

def exact_fee(gross, rate='0.0015'):
    return (Decimal(str(gross))*Decimal(str(rate))).quantize(QUANTUM,rounding=ROUND_CEILING)

def budget_quantity(budget,cash,price,rate='0.0015',fee_inclusive=True):
    b,c,p,f=map(lambda v:Decimal(str(v)),[budget,cash,price,rate])
    if min(b,c) < 0 or p <= 0 or not 0 <= f < 1: raise ValueError('Invalid model budget')
    target=int(b/(p*(1+f))) if fee_inclusive else int(b/p)
    return min(target,int(c/(p*(1+f))))

US_COLUMNS={'session_date':'date','raw_open':'open','raw_high':'high','raw_low':'low','raw_close':'close','signal_close':'close','raw_volume':'volume','dollar_volume':'dollarVolume','market_cap':'marketCap','beta60_spy':'beta60Spy','ichimoku_tk_gap':'ichimokuTkGap','relvol1_20':'relvol1_20','adv20_usd':'adv20Usd','research_common_snapshot':'researchCommonSnapshot','research_exchange_eligible':'researchExchangeEligible','security_type':'securityType','fx_usdkrw':'fxUsdKrw','shares_outstanding':'sharesOutstanding'}
def normalized_us_row(row):
    out={US_COLUMNS.get(k,k):v for k,v in row.items()}
    # Preserve executable raw prices separately; this module only analyzes closes/features.
    out['date']=row['session_date'];out['close']=row.get('signal_close',row.get('raw_close'))
    defaults={'name':row['symbol'],'market':'US','sector':None,'securityType':None,'status':None,'currency':'USD','open':None,'high':None,'low':None,'volume':None,'dollarVolume':None,'sharesOutstanding':None,'marketCap':None,'fxUsdKrw':None}
    for k,v in defaults.items(): out.setdefault(k,v)
    return out

class FrozenIntentAdapter:
    """Close-event signal state. The caller owns fills, settlement, marks, and holdings.

    Required rows: session_date,symbol,available_at plus documented feature columns.
    on_close takes the entire one-market session, never a holdings-only subset.
    Pending IDs must be reconciled with pending_intents() after each close; removed
    IDs are cancelled/expired. Call on_execution_open before filling a US entry.
    """
    def __init__(self, sleeve, historical_policy=True):
        if sleeve not in ('KR_MIXED','ETF_V02','US_A0'): raise ValueError(sleeve)
        self.sleeve=sleeve;self.historical_policy=historical_policy
        self.history={};self.last_date=None;self.us_state={};self.pending={};self.blocked_origins=set()
        self.latest_gate=None;self.sequence=0;self.research_start_date=None;self.holding_spans=[]

    def _intent(self,row,side,known_at,next_open_at,reason,origin,budget=None,inclusive=True,priority=(),expiry=None):
        sid=f'{self.sleeve}|{row["symbol"]}|{origin}|{side}|{reason}'
        self.sequence+=1
        return dict(signal_id=sid,sleeve=self.sleeve,symbol=row['symbol'],side=side,market=row.get('market'),currency=row.get('currency','USD' if self.sleeve=='US_A0' else 'KRW'),sector=row.get('sector'),known_at=known_at,earliest_execution_at=next_open_at,signal_date=row['session_date'],origin_date=origin,target_budget=budget,budget_fee_inclusive=inclusive,priority=list(priority),reason=reason,expiry=expiry,sequence=self.sequence,source_commit=FROZEN_SHA)

    def set_research_start(self,start_date):
        # Warm-up features/rank states remain; pre-start origin intents cannot leak.
        self.research_start_date=start_date

    def record_holding_span(self,symbol,entry_date,exit_date):
        # Engine calls before removing a fully closed position, including H60.
        span=(symbol,entry_date,exit_date)
        if span not in self.holding_spans:self.holding_spans.append(span)

    def kospi_entry_window_blocked(self,intent,execution_date):
        return any(s==intent['symbol'] and entered<=execution_date and exited>=intent['origin_date'] for s,entered,exited in self.holding_spans)

    def pending_intents(self):
        return [dict(v) for v in self.pending.values()]

    def on_close(self,frame,holdings,available_cash,initial_sleeve_capital,sleeve_nav,next_open_at,decision_at=None,nav_complete=True):
        rows=frame.to_dict('records') if hasattr(frame,'to_dict') else list(frame)
        if not rows: raise ValueError('Entire session input required')
        dates={r['session_date'] for r in rows}
        if len(dates)!=1 or len({r['symbol'] for r in rows})!=len(rows): raise ValueError('One session and unique symbols required')
        date=next(iter(dates))
        if self.last_date and date<=self.last_date: raise ValueError('Session must increase')
        known_at=max(r['available_at'] for r in rows)
        if decision_at and known_at>decision_at: raise ValueError('Input unavailable at decision time')
        if next_open_at<=known_at: raise ValueError('Next open must be after available input')
        current={r['symbol']:r for r in rows}
        # One-session ETF/KOSDAQ intents expire even when not filled; KR confirmed
        # suspension intents and US orders remain pending under their explicit rules.
        self.pending={k:v for k,v in self.pending.items() if v['expiry']!='NEXT_MARKET_OPEN_ONLY'}
        emitted=[]
        if self.sleeve=='US_A0':
            a=us_analysis([normalized_us_row(r) for r in rows],self.us_state);self.us_state=a['state']
            analyzed={r['symbol']:r for r in a['rows']}
            for symbol,h in holdings.items():
                r=analyzed.get(symbol)
                if r is None or r['a0Exit']:
                    source=current.get(symbol,dict(symbol=symbol,session_date=date,market='US',currency='USD',sector=h.get('sector')))
                    reason='UNIVERSE_OR_DATA_EXIT' if r is None or r['coreRank'] is None else 'A0_BETA_ANCHOR_3D' if r['betaWeakStreak']>=3 else 'CORE_BELOW_0.70'
                    if not any(v['symbol']==symbol and v['side']=='SELL' for v in self.pending.values()):
                        it=self._intent(source,'SELL',known_at,next_open_at,reason,date,priority=(0,symbol),expiry='UNTIL_FILLED')
                        self.pending[it['signal_id']]=it;emitted.append(it)
                    self.pending={k:v for k,v in self.pending.items() if not(v['symbol']==symbol and v['side']=='BUY')}
            # Unfilled entry intent is cancelled when an exit condition appears.
            self.pending={k:v for k,v in self.pending.items() if not(v['side']=='BUY' and (v['symbol'] not in analyzed or analyzed[v['symbol']]['a0Exit']))}
            exiting={v['symbol'] for v in self.pending.values() if v['side']=='SELL'}
            retained=set(holdings)-exiting
            reserved={v['symbol'] for v in self.pending.values() if v['side']=='BUY'}-set(holdings)-exiting
            chosen=retained|reserved
            candidates=sorted([r for r in a['rows'] if r['a0Entry']],key=lambda r:(-r['coreRank'],-r['betaRank'],-r['tkRank'],r['symbol']))
            budget=float((Decimal(str(initial_sleeve_capital))/20).quantize(QUANTUM,rounding=ROUND_DOWN))
            for r in candidates:
                s=r['symbol']
                if s=='SPY' or s in chosen or s in exiting:continue
                if len(chosen)>=20:break
                it=self._intent(current[s],'BUY',known_at,next_open_at,'ENTRY_ONSET80',date,budget,False,(-r['coreRank'],-r['betaRank'],-r['tkRank'],s),'UNTIL_FILLED_OR_EXIT_SIGNAL')
                it.update(remaining_budget=budget,target_positions=20,participation_rate=.01,participation_basis='PREVIOUS_SESSION_ADV20_USD',execution_sort='ASCENDING_REMAINING_TARGET_SHARES_THEN_INSERTION_ORDER',sizing_contract='INITIAL_USD_CAPITAL_DIV_20_GROSS_FIXED')
                self.pending[it['signal_id']]=it;emitted.append(it);chosen.add(s)
        else:
            # Insert a missing observation for previously seen symbols so gaps cannot
            # be treated as adjacent available bars or delayed confirmations.
            for s in set(self.history)-set(current):
                current[s]=dict(symbol=s,session_date=date,available_at=known_at,score=None,eligible=False,observed=False,market=self.history[s][-1].get('market'),sector=self.history[s][-1].get('sector'))
            for s,row in current.items():
                hist=self.history.get(s,[])
                p=hist[-1] if hist else None;b=hist[-2] if len(hist)>1 else None
                if self.sleeve=='KR_MIXED':
                    market=row['market'];score=row.get('score');eligible=bool(row.get('eligible',False))
                    prevscore=p.get('score') if p else None
                    sig=kr_operational_signals(market,prevscore,score,eligible,held=s in holdings)
                    if s in holdings and sig['exitSignal']:
                        if not any(v['symbol']==s and v['side']=='SELL' for v in self.pending.values()):
                            it=self._intent(row,'SELL',known_at,next_open_at,sig['exitSignal'],date,priority=(0,s),expiry='UNTIL_EXECUTABLE_OPEN')
                            self.pending[it['signal_id']]=it;emitted.append(it)
                    if market=='KOSPI':
                        def obs(x):
                            if not x:return None
                            return dict(date=x['session_date'],score=x.get('score'),eligible=bool(x.get('eligible',False)),observed=bool(x.get('observed',False)),rsAccel=x.get('rs_accel'),marketGate=x.get('market_gate'))
                        c=kospi_confirmation(obs(row),obs(p),obs(b),self.historical_policy)
                        if c['state']=='pending' and s in holdings:self.blocked_origins.add((s,c['originDate']))
                        entry=c['eligible'] and c['state']=='confirmed' and (s,c['originDate']) not in self.blocked_origins
                        if entry and self.research_start_date and c['originDate']<self.research_start_date:entry=False
                        if entry and any(sym==s and entered<=date and exited>=c['originDate'] for sym,entered,exited in self.holding_spans):entry=False
                        origin=c['originDate'];expiry='NEXT_TRADABLE_OPEN_HALT_ONLY_RECHECK_ORIGIN_AND_PRIOR_GATE'
                        self.latest_gate=row.get('market_gate') or self.latest_gate
                    else:entry=sig['kosdaq80Onset'];origin=date;expiry='NEXT_MARKET_OPEN_ONLY'
                    if entry and s not in holdings:
                        it=self._intent(row,'BUY',known_at,next_open_at,'CONFIRM1_RS_BEAR' if market=='KOSPI' else 'ONSET80',origin,float((Decimal(str(initial_sleeve_capital))/30).quantize(QUANTUM,rounding=ROUND_DOWN)),True,(-(score if finite(score) else -1e20),-(row.get('priority') if finite(row.get('priority')) else -1e20),s),expiry)
                        it.update(target_positions=30,sector_max_positions=3 if market=='KOSPI' else 6,sizing_contract='INITIAL_KR_SLEEVE_CAPITAL_DIV_30_FEE_INCLUSIVE')
                        self.pending[it['signal_id']]=it;emitted.append(it)
                else:
                    def obs(x):
                        return None if not x else dict(date=x['session_date'],score=x.get('score'),eligible=bool(x.get('eligible',False)),underlyingClose=x.get('underlying_close'),underlyingMa60=x.get('underlying_ma60'))
                    c=etf_confirmation(obs(row),obs(p),obs(b))
                    # An Onset observed while held is not a fresh entry after
                    # that position is sold during its confirmation window.
                    if c['rawOnset'] and s in holdings:self.blocked_origins.add((s,c['originDate']))
                    origin_blocked=bool(c['originDate'] and ((s,c['originDate']) in self.blocked_origins or
                        any(sym==s and entered<=date and exited>=c['originDate'] for sym,entered,exited in self.holding_spans)))
                    # A batch-pending flag cannot create exits or actionable entries.
                    ready=not row.get('krx_batch_pending',False)
                    if s in holdings and ready and positive(row.get('underlying_close')) and positive(row.get('underlying_ma60')) and row['underlying_close']<row['underlying_ma60']:
                        if not any(v['symbol']==s and v['side']=='SELL' for v in self.pending.values()):
                            it=self._intent(row,'SELL',known_at,next_open_at,'MA60',date,priority=(0,s),expiry='UNTIL_EXECUTABLE_OPEN');self.pending[it['signal_id']]=it;emitted.append(it)
                    volweight=etf_entry_weight(row.get('annual_volatility'))
                    adv=row.get('average_trading_value20')
                    if ready and c['onset'] and not origin_blocked and (not self.research_start_date or c['originDate']>=self.research_start_date) and s not in holdings and volweight is not None and finite(adv) and adv>=0 and nav_complete:
                        # Frozen exact ETF executor stores weight to eight decimals.
                        weight=Decimal(str(floor(volweight*1e8)/1e8))
                        budget=float((Decimal(str(sleeve_nav))*weight).quantize(QUANTUM,rounding=ROUND_DOWN))
                        it=self._intent(row,'BUY',known_at,next_open_at,'CONFIRM1',c['originDate'],budget,True,(-adv,s),'NEXT_MARKET_OPEN_ONLY')
                        it.update(target_positions=10,entry_weight=float(weight),sizing_contract='PRIOR_CLOSE_SLEEVE_NAV_TIMES_VOL20_WEIGHT',replacement=False,requires_complete_prior_nav=True)
                        self.pending[it['signal_id']]=it;emitted.append(it)
                self.history[s]=(hist+[row])[-2:]
        self.last_date=date
        return sorted(emitted,key=lambda i:(0 if i['side']=='SELL' else 1,i['priority']))

    def on_execution_open(self,signal_id,price,current_shares=0):
        """US first eligible open locks a quantity even if cash permits no fill."""
        it=self.pending[signal_id]
        if self.sleeve=='US_A0' and it['side']=='BUY':
            if 'fixed_target_shares' not in it:
                it['fixed_target_shares']=max(current_shares,int(Decimal(str(it['target_budget']))/Decimal(str(price))))
                it['remaining_budget']=float(max(Decimal(0),Decimal(str(it['target_budget']))-Decimal(str(price))*current_shares))
            return max(0,it['fixed_target_shares']-current_shares)
        return None

    def on_fill(self,signal_id,quantity,price,remaining_position_shares=0):
        """Notify actual fills; does not update cash, holdings, or accounting."""
        it=self.pending.get(signal_id)
        if not it:return
        if it['side']=='SELL':
            if remaining_position_shares==0:self.pending.pop(signal_id,None)
        elif self.sleeve=='US_A0':
            if 'fixed_target_shares' not in it:raise ValueError('Call on_execution_open before US fill')
            it['remaining_budget']=float(Decimal(str(it['remaining_budget']))-Decimal(str(price))*quantity)
            it['filled_shares']=it.get('filled_shares',0)+quantity
            if it['filled_shares']>=it['fixed_target_shares'] or it['remaining_budget']<=0:self.pending.pop(signal_id,None)
        else:self.pending.pop(signal_id,None)

    def cancel(self,signal_id):
        self.pending.pop(signal_id,None)
