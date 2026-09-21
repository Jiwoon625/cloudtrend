#!/usr/bin/env python3
"""Fixed M0 onset study: executable fills, score exits and chronological selection.

Research only. Prices are source prices, not independently verified total returns.
All variants are specified before inspecting new results. Current-universe bias remains.
"""
import argparse
import json
import re
from pathlib import Path

import numpy as np
import pandas as pd

from research_etf_m0_exit_rules import load_and_score


MODELS = ['scoreM0', 'm0Ema3', 'm0Ema5', 'persistentM0', 'continuousM0', 'regimeM0']
COST = 0.0015  # each side; 30bp round trip


def asset_class(r):
    text = (str(r['name']) + ' ' + str(r['etfUnderlyingIndexName'])).upper()
    if re.search(r'레버리지|인버스|\b[23]X\b|LEVERAGED|INVERSE|\bSHORT\b', text):
        return 'leveraged_inverse'
    if re.search(r'혼합|MIXED|TDF|TRF|타겟데이트|자산배분|멀티에셋|MULTI.ASSET', text):
        return 'mixed'
    if re.search(r'채권|국고채|국채|미국채|회사채|단기채|장기채|KOFR|CD금리|CD 금리|머니마켓|BOND|TREASURY|SOFR|금리액티브|통안채', text):
        return 'bond_cash'
    if re.search(r'금현물|골드선물|GOLD|은선물|SILVER|원유|\bOIL\b|구리선물|COPPER|농산물|팔라듐|원자재|COMMOD|달러선물|엔선물|유로선물', text):
        return 'commodity_fx'
    if re.search(r'리츠|REIT|부동산|인프라|INFRA', text):
        return 'reit_infra'
    if re.search(r'커버드콜|COVERED|바이프리미엄|타겟프리미엄|버퍼|BUFFER|양매도|양매수|콜매도|PUTWRITE', text):
        return 'option_overlay'
    if str(r['sectorCode']) not in {'MARKET_IDX', 'ETC', 'nan', 'None'}:
        return 'equity'
    if re.search(r'코스피|KOSPI|코스닥|KOSDAQ|KRX|200|100|150|S&P|NASDAQ|나스닥|다우|MSCI|주식|EQUITY|배당|성장|가치|차이나|중국|항셍|인도|베트남|일본|NIKKEI|TOPIX|유로스탁스|EUROSTOXX|반도체|테크|바이오|헬스|은행|금융|로봇|자동차|전기차|게임|소비|에너지|클린|ESG|월드|WORLD|선진국|신흥국', text):
        return 'equity'
    return 'unclassified'


def enrich_scores(d):
    d = d.sort_values(['symbol', 'date']).reset_index(drop=True).copy()
    g = d.groupby('symbol', sort=False)
    for n in [3, 5]:
        d[f'm0Ema{n}'] = g['scoreM0'].transform(lambda s: s.ewm(span=n, adjust=False, min_periods=n).mean())
    # Remove event-only BB/volume features from the 55-point technical block.
    # 3 original persistent features plus price>MA20 and rising MA60.
    slope = d['ma60'] / g['ma60'].shift(5) - 1
    valid = d[['cloudAbove', 'maAligned', 'tenkanAbove', 'ma20', 'ma60', 'ma120']].notna().all(axis=1) & slope.notna()
    persistent = (d['cloudAbove'] + d['maAligned'] + d['tenkanAbove'] +
                  (d['close'] > d['ma20']).astype(float) + (slope > 0).astype(float)) * 20
    # Continuous price/MA gaps, scaled by trailing close volatility; no future scaling.
    vol = g['dayReturn'].transform(lambda s: s.rolling(20, min_periods=20).std()).clip(lower=.003)
    signals = [d['close']/d['cloudTop']-1, d['ma20']/d['ma60']-1,
               d['ma60']/d['ma120']-1, d['close']/d['ma20']-1, slope]
    continuous = sum((50 + 25 * z / vol).clip(0, 100) for z in signals) / 5
    rest = .15*d['priorityM0'] + .15*d['health'] + .15*d['marketSectorScore']
    d['persistentM0'] = (.55*persistent + rest).where(valid)
    d['continuousM0'] = (.55*continuous + rest).where(valid)
    # Same four-block architecture, 15 points of technical weight reassigned to regime.
    regime = (50*(d['etfUnderlyingIndexClose'] > d['uMa60']).astype(float) +
              50*(d['uMa20'] > d['uMa60']).astype(float))
    d['regimeM0'] = (.40*d['technical'] + .15*regime + rest).where(d['uMa60'].notna())
    # Do not compute onset across missing score rows.
    d['originalOnset'] = (d['scoreM0'] >= 80) & (g['scoreM0'].shift(1) < 80)
    for model in MODELS:
        d['onset_'+model] = (d[model] >= 80) & (d.groupby('symbol', sort=False)[model].shift(1) < 80)
    d['eligible'] = d[MODELS + ['technical','health','priorityM0','marketSectorScore','uMa60','ma120']].notna().all(axis=1)
    return d


def candidates():
    out = [dict(id='BASE_MA60_H60', model='scoreM0', rule='ma60', level=0, confirm=1, hold=60, entry='fixed')]
    for model in MODELS:
        for level in [45, 50, 55, 60, 65, 70]:
            for confirm in [1, 3]:
                out.append(dict(id=f'{model}_LT{level}_C{confirm}', model=model, rule='below', level=level, confirm=confirm, hold=60, entry='fixed'))
        for level in [10, 15, 20]:
            out.append(dict(id=f'{model}_PEAK{level}_C2', model=model, rule='peak', level=level, confirm=2, hold=60, entry='fixed'))
    # Distinct secondary experiment: modified score onset, threshold still 80.
    for model in MODELS[1:]:
        for level in [55, 60, 65]:
            out.append(dict(id=f'NEWENTRY_{model}_LT{level}_C3', model=model, rule='below', level=level, confirm=3, hold=60, entry='modified'))
        out.append(dict(id=f'NEWENTRY_{model}_MA60', model=model, rule='ma60', level=0, confirm=1, hold=60, entry='modified'))
    return out


def simulate_symbol(h, spec):
    """All matched onset events; execution overlap is removed separately.

    Entry at next valid row open (only the immediate next day is permitted).
    Exit signal at close, execute next open; no synthetic final liquidation.
    """
    n = len(h)
    score = h[spec['model']].to_numpy(float)
    dates = h['date'].to_numpy()
    op = h['open'].to_numpy(float)
    cl = h['close'].to_numpy(float)
    u = h['etfUnderlyingIndexClose'].to_numpy(float)
    uma = h['uMa60'].to_numpy(float)
    entry = h['originalOnset' if spec['entry'] == 'fixed' else 'onset_'+spec['model']].to_numpy(bool)
    eligible = h['eligible'].to_numpy(bool)
    rows = []
    for s in np.flatnonzero(entry & eligible & (dates >= '2018-01-01')):
        b = s+1
        if b >= n or not np.isfinite(op[b]) or op[b] <= 0:
            continue
        streak, peak = 0, score[s]
        exit_signal, reason = None, None
        for t in range(b, min(n-1, b+spec['hold'])):
            if np.isfinite(score[t]):
                peak = max(peak, score[t])
            if spec['rule'] == 'ma60':
                hit = np.isfinite(u[t]) and np.isfinite(uma[t]) and u[t] < uma[t]
            elif spec['rule'] == 'below':
                hit = np.isfinite(score[t]) and score[t] < spec['level']
            else:
                hit = np.isfinite(score[t]) and score[t] <= peak-spec['level']
            streak = streak+1 if hit else 0
            if streak >= spec['confirm']:
                exit_signal, reason = t, spec['rule']
                break
            if t == b+spec['hold']-1:
                exit_signal, reason = t, 'time_cap'
                break
        if exit_signal is None:
            # Censored; do not mislabel incomplete trades as 60-day exits.
            continue
        x = exit_signal+1
        if not np.isfinite(op[x]) or op[x] <= 0:
            continue
        gross = op[x]/op[b]-1
        net = (op[x]*(1-COST))/(op[b]*(1+COST))-1
        path = np.r_[op[b], cl[b:x], op[x]] / op[b]
        mdd = np.min(path/np.maximum.accumulate(path)-1)
        # Underlying only has close: explicitly separate from executable open returns.
        bench = u[exit_signal]/u[s]-1 if np.isfinite(u[s]) and u[s]>0 and np.isfinite(u[exit_signal]) else np.nan
        rows.append(dict(candidate=spec['id'], entryMode=spec['entry'], symbol=h['symbol'].iloc[0],
                         signalDate=dates[s], entryDate=dates[b], exitSignalDate=dates[exit_signal], exitDate=dates[x],
                         entryOpen=op[b], exitOpen=op[x], holdDays=x-b, grossReturn=gross, netReturn=net,
                         stressNetReturn=op[x]*(1-.003)/(op[b]*(1+.003))-1,
                         tradeMDD=mdd, mae=np.min(path)-1, signalBenchmarkReturn=bench,
                         signalExcess=cl[exit_signal]/cl[s]-1-bench, reason=reason))
    return rows


def nonoverlap(t):
    keep = []
    for _, g in t.sort_values(['symbol','entryDate']).groupby('symbol', sort=False):
        available = ''
        for i, row in g.iterrows():
            if row['signalDate'] >= available:
                keep.append(i)
                available = row['exitDate']
    return t.loc[keep].copy()


def stats(t):
    if not len(t):
        return dict(count=0)
    x = t['netReturn']
    losses = -x[x<0].sum()
    return dict(count=len(t), symbols=t.symbol.nunique(), meanNet=x.mean(), medianNet=x.median(),
                winRate=(x>0).mean(), meanHold=t.holdDays.mean(), meanTradeMDD=t.tradeMDD.mean(),
                p10Net=x.quantile(.1), profitFactor=x[x>0].sum()/losses if losses else None,
                stressMean=t.stressNetReturn.mean(), timeCapShare=(t.reason=='time_cap').mean(),
                meanSignalExcess=t.signalExcess.mean())


def portfolio(trades, prices, calendar, slots=10, cost=COST):
    """Ten equal initial allocations at entry; cash earns zero; no leverage.

    Fill all selected entry orders at open, mark at close. Tie-break symbol only,
    intentionally independent of the score being tested. Censored end positions
    handled by build_open_trades (terminal mark, not a fabricated exit).
    """
    by_entry = {k:g for k,g in trades.groupby('entryDate', sort=False)}
    held, cash, rows = {}, 1., []
    for date in calendar:
        def quote(symbol, field, fallback):
            return prices.get((symbol, date), {}).get(field, fallback)
        for symbol, p in list(held.items()):
            if p['exitDate'] == date:
                cash += p['units']*p['exitOpen']*(1-cost)
                del held[symbol]
        equity_open = cash + sum(p['units']*quote(s,'open',p['last']) for s,p in held.items())
        if date in by_entry:
            for r in by_entry[date].sort_values('symbol').itertuples(index=False):
                if len(held)>=slots or r.symbol in held:
                    continue
                amount = min(equity_open/slots, cash)
                if amount < 1e-10:
                    continue
                cash -= amount
                held[r.symbol] = dict(units=amount/(r.entryOpen*(1+cost)), exitDate=r.exitDate,
                                      exitOpen=r.exitOpen, last=r.entryOpen)
        for s,p in held.items():
            p['last'] = quote(s,'close',p['last'])
        value = cash + sum(p['units']*p['last'] for p in held.values())
        rows.append((date, value, (value-cash)/value, len(held)))
    return pd.DataFrame(rows, columns=['date','equity','exposure','positions'])


def curve_stats(c):
    if len(c)<2:
        return {}
    v = c['equity'].to_numpy()
    # Segment curves start from 1 and include first day's return.
    r = np.diff(np.r_[1.,v])/np.r_[1.,v[:-1]]
    cagr = v[-1]**(252/len(v))-1
    mdd = np.min(v/np.maximum.accumulate(np.r_[1.,v])[1:]-1)
    sd = r.std(ddof=1)
    return dict(cagr=cagr, mdd=mdd, sharpe=r.mean()/sd*np.sqrt(252) if sd>0 else 0.,
                totalReturn=v[-1]-1, exposure=c['exposure'].mean(), days=len(c))


def build_open_trades(hists, spec, end):
    """Build trades on a truncated history; add still-open positions for MTM.

    Complete-event records alone would select on future exit availability.
    Sentinel exits are not used in event summaries and stay open in portfolio.
    """
    all_rows = []
    for h in hists:
        h = h[h.date<=end].reset_index(drop=True)
        if len(h)<2:
            continue
        rr = simulate_symbol(h, spec)
        complete_signals = {r['signalDate'] for r in rr}
        onset = 'originalOnset' if spec['entry']=='fixed' else 'onset_'+spec['model']
        for s in np.flatnonzero((h[onset] & h.eligible & (h.date>='2018-01-01')).to_numpy()):
            if s+1>=len(h) or h.date.iloc[s] in complete_signals:
                continue
            b = s+1
            # Only near-terminal incomplete records are legitimately censored.
            if len(h)-1-b >= spec['hold']:
                continue
            op = h.open.iloc[b]
            if not np.isfinite(op) or op<=0:
                continue
            rr.append(dict(candidate=spec['id'], entryMode=spec['entry'], symbol=h.symbol.iloc[0],
                           signalDate=h.date.iloc[s], entryDate=h.date.iloc[b], exitDate='9999-12-31',
                           entryOpen=op, exitOpen=np.nan))
        all_rows.extend(rr)
    return pd.DataFrame(all_rows)


def main():
    p = argparse.ArgumentParser()
    for k in ['source-manifest','source-cache-dir','etf-parquet','sector-map','output-dir']:
        p.add_argument('--'+k, required=True)
    a = p.parse_args()
    out = Path(a.output_dir); out.mkdir(parents=True, exist_ok=True)
    d = enrich_scores(load_and_score(a))
    meta = d.sort_values('date').drop_duplicates('symbol', keep='last')[['symbol','name','sectorCode','etfUnderlyingIndexName']].copy()
    meta['assetClass'] = meta.apply(asset_class, axis=1)
    meta.to_csv(out/'classification.csv', index=False)
    symbols = set(meta.loc[meta.assetClass=='equity','symbol'])
    d = d[d.symbol.isin(symbols)].copy()
    if not len(d) or d.duplicated(['symbol','date']).any():
        raise RuntimeError('Empty equity universe or duplicate bars')
    hists = [h.reset_index(drop=True) for _,h in d.groupby('symbol', sort=False)]
    prices = {(r.symbol,r.date):dict(open=r.open,close=r.close) for r in d[['symbol','date','open','close']].itertuples(index=False) if r.open>0 and r.close>0}
    calendar = sorted(d.loc[d.date>='2018-01-01','date'].unique())
    specs = candidates()
    Path(out/'design.json').write_text(json.dumps(dict(candidates=specs, entry='fixed original M0 onset80 in primary experiment',
        fills='next session open, no same-day close execution', costs='15bp per side; stress 30bp per side',
        universe='current-list name/index/sector classification; excludes options, mixed, REIT, non-equity, leveraged, inverse',
        selection='2018-2022 train; 2023-2024 validation; 2025-2026 retrospective test, already explored in prior research',
        limitations=['survivorship bias', 'source price adjustment/dividend consistency not independently verified',
                    'underlying close benchmark is signal-aligned, not open-fill benchmark',
                    'current name/sector mapping; no point-in-time constituent membership',
                    'zero cash yield; no FX/tax modeling; alphabetical tie-break'],
        etfParquetHash=__import__('research_etf_m0_vs_m1').sha256(Path(a.etf_parquet))), ensure_ascii=False, indent=2))
    all_t, summaries, yearly, portfolio_rows, curves = [], [], [], [], []
    executable = {}
    spans = [('train','2018-01-01','2022-12-31'), ('validation','2023-01-01','2024-12-31'),
             ('test','2025-01-01',calendar[-1]), ('all','2018-01-01',calendar[-1])]
    for j,spec in enumerate(specs):
        t = pd.DataFrame([r for h in hists for r in simulate_symbol(h,spec)])
        if not len(t):
            continue
        all_t.append(t)
        for unit,tt in [('matched_events',t), ('nonoverlap',nonoverlap(t))]:
            for split,start,end in spans:
                # Closed trades entirely within each segment: no label leakage.
                q=tt[(tt.entryDate>=start)&(tt.exitDate<=end)]
                summaries.append(dict(candidate=spec['id'],entryMode=spec['entry'],unit=unit,split=split,**stats(q)))
            for year,q in tt.groupby(tt.entryDate.str[:4]):
                yearly.append(dict(candidate=spec['id'],unit=unit,year=year,**stats(q)))
        # Continuous executable portfolios include terminal open positions.
        pt = build_open_trades(hists,spec,calendar[-1])
        executable[spec['id']] = pt
        for split,start,end in spans:
            segment=pt[(pt.signalDate>=start)&(pt.entryDate<=end)]
            c=portfolio(segment,prices,[dt for dt in calendar if start<=dt<=end])
            portfolio_rows.append(dict(candidate=spec['id'],entryMode=spec['entry'],split=split,**curve_stats(c)))
            if split=='all':
                c['candidate']=spec['id']; curves.append(c)
        print(json.dumps(dict(progress=j+1,total=len(specs),candidate=spec['id'],events=len(t))),flush=True)
    summary=pd.DataFrame(summaries); ports=pd.DataFrame(portfolio_rows)
    summary.to_csv(out/'trade-summary.csv',index=False)
    pd.DataFrame(yearly).to_csv(out/'yearly-trades.csv',index=False)
    ports.to_csv(out/'portfolio-summary.csv',index=False)
    pd.concat(all_t,ignore_index=True).to_csv(out/'matched-trades.csv.gz',index=False)
    curve=pd.concat(curves,ignore_index=True)
    curve.to_csv(out/'portfolio-curves.csv.gz',index=False)
    # Freeze shortlist on train only; select on validation, never on test.
    tr=ports[(ports.split=='train')&(ports.entryMode=='fixed')].copy()
    tr=tr[tr.candidate!='BASE_MA60_H60'].sort_values(['sharpe','cagr'],ascending=False)
    shortlist=tr.head(10).candidate.tolist()
    val=ports[(ports.split=='validation')&ports.candidate.isin(shortlist)].sort_values(['sharpe','cagr'],ascending=False)
    selected=val.iloc[0].candidate
    # Calendar-year performance from continuous curves (includes carry positions).
    annual=[]
    for candidate,c in curve.groupby('candidate',sort=False):
        c=c.sort_values('date').copy(); c['daily']=c.equity.pct_change().fillna(c.equity.iloc[0]-1)
        for year,q in c.groupby(c.date.str[:4]):
            qc=q.copy(); qc['equity']=(1+q.daily).cumprod()
            annual.append(dict(candidate=candidate,year=year,**curve_stats(qc)))
    ann=pd.DataFrame(annual);ann.to_csv(out/'annual-portfolios.csv',index=False)
    # Expanding chronological selection: annual rule frozen using only past returns.
    wf=[]
    fixed_ids={s['id'] for s in specs if s['entry']=='fixed' and s['rule']!='ma60'}
    for year in range(2021,int(calendar[-1][:4])+1):
        history=ann[(ann.year.astype(int)<year)&ann.candidate.isin(fixed_ids)]
        rank=history.groupby('candidate').agg(sharpe=('sharpe','mean'),cagr=('cagr','mean'))
        pick=rank.sort_values(['sharpe','cagr'],ascending=False).index[0]
        for cid in ['BASE_MA60_H60',pick]:
            pt=executable[cid]
            start=f'{year}-01-01';end=f'{year}-12-31'
            c=portfolio(pt[(pt.signalDate>=start)&(pt.entryDate<=end)],prices,[dt for dt in calendar if start<=dt<=end])
            wf.append(dict(year=year,candidate=cid,role='baseline' if cid=='BASE_MA60_H60' else 'past_only_selected',**curve_stats(c)))
    pd.DataFrame(wf).to_csv(out/'walk-forward.csv',index=False)
    # Paired original onset events isolate exits; bootstrap entry-month clusters.
    events=pd.concat(all_t,ignore_index=True)
    b=events[events.candidate=='BASE_MA60_H60']
    s=events[events.candidate==selected]
    paired=b.merge(s,on=['symbol','signalDate'],suffixes=('_base','_selected'))
    paired['netLift']=paired.netReturn_selected-paired.netReturn_base
    paired.to_csv(out/'paired-selected.csv',index=False)
    paired_stats=[]
    rng=np.random.default_rng(20260921)
    for split,start,end in spans:
        q=paired[(paired.entryDate_base>=start)&(paired.exitDate_base<=end)&(paired.exitDate_selected<=end)]
        months=q.groupby(q.signalDate.str[:7]).netLift.agg(['sum','count'])
        if not len(months):
            continue
        draws=rng.integers(0,len(months),size=(2000,len(months)))
        arr=months.to_numpy();boot=arr[draws,0].sum(axis=1)/arr[draws,1].sum(axis=1)
        paired_stats.append(dict(split=split,count=len(q),meanNetLift=q.netLift.mean(),
            betterTradeShare=(q.netLift>0).mean(),monthClusterCI95=np.quantile(boot,[.025,.975]).tolist()))
    selected_spec=next(s for s in specs if s['id']==selected)
    # Bounded holding-cap and cost sensitivity, same selected rule, no re-selection.
    sens=[]
    for base in [specs[0],selected_spec]:
        for cap in [40,60,120,9999]:
            ss=dict(base,hold=cap)
            pt=build_open_trades(hists,ss,calendar[-1])
            for cost in [COST,.003]:
                for split,start,end in spans:
                    c=portfolio(pt[(pt.signalDate>=start)&(pt.entryDate<=end)],prices,[dt for dt in calendar if start<=dt<=end],cost=cost)
                    sens.append(dict(candidate=ss['id'],holdCap=cap,costRoundTrip=cost*2,split=split,**curve_stats(c)))
    pd.DataFrame(sens).to_csv(out/'sensitivity.csv',index=False)
    result=dict(selected=selected,shortlist=shortlist,candidates=len(specs),equitySymbols=len(symbols),
                classification=meta.assetClass.value_counts().to_dict(),eligibleRows=int(d.eligible.sum()),
                start=calendar[0],end=calendar[-1],
                comparison=ports[ports.candidate.isin(['BASE_MA60_H60',selected])].to_dict('records'),
                annual=ann[ann.candidate.isin(['BASE_MA60_H60',selected])].to_dict('records'),
                paired=paired_stats,walkForward=wf,
                productionChange=False)
    Path(out/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2,default=lambda x:x.item() if hasattr(x,'item') else str(x)))
    print('RESULT '+json.dumps(result,ensure_ascii=False),flush=True)


if __name__=='__main__':
    main()
