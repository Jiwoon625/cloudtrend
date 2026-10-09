"""Completed-position, fee-net arithmetic returns from an already verified ledger.

No strategy replay, quote reads, network, credentials, or source writes. A cycle
starts with a BUY while flat and closes only when all shares have been sold.
"""
from collections import Counter, defaultdict
from decimal import Decimal, ROUND_CEILING, localcontext
import json
from pathlib import Path
from audit_us_math import dec, money, iso_date, QUANTUM

class RoundtripError(ValueError): pass

def require(ok,code):
    if not ok: raise RoundtripError(code)

def stats(values):
    values=sorted(values);n=len(values)
    return {'sampleCount':n,'meanNetReturn':float(sum(values)/n) if n else None,
            'medianNetReturn':float(values[n//2] if n%2 else (values[n//2-1]+values[n//2])/2) if n else None,
            'minimumNetReturn':float(values[0]) if n else None,'maximumNetReturn':float(values[-1]) if n else None,
            'winningCount':sum(v>0 for v in values),'losingCount':sum(v<0 for v in values),'flatCount':sum(v==0 for v in values)}

def aggregate(trades,final_state,prior_audit,summary):
    with localcontext() as ctx:
        ctx.prec=50
        require(prior_audit.get('status')=='PASS' and prior_audit.get('arithmeticAndLedgerChecksPassed') is True,'SOURCE_MATH_AUDIT_NOT_PASSED')
        book=summary['US_A0'];start=iso_date(book['startDate']);end=iso_date(book['endDate'])
        require(book['status']=='COMPLETE' and not book['missingValuationCount'] and not book['staleValuationCount'],'SOURCE_SUMMARY_INCOMPLETE')
        require(abs(float(book['mdd'])-float(prior_audit['performance']['mdd']))<=1e-12,'SOURCE_MDD_MISMATCH')
        active={};closed=[];seen=set();last=start;counts=Counter();fee_total=Decimal(0);cash=dec(prior_audit['ledger']['initialCashExact']);pending=0
        for t in trades:
            if t.get('executionDate') is None:
                require(t.get('status')=='PENDING','NONEXECUTED_STATUS_INVALID');pending+=1;continue
            require(t.get('status') in ('EXECUTED','PARTIAL') and t.get('side') in ('BUY','SELL'),'FILL_STATUS_OR_SIDE_INVALID')
            when=iso_date(t['executionDate']);require(last<=when<=end,'FILL_CHRONOLOGY_INVALID');last=when
            key=t['tradeKey'];require(isinstance(key,str) and key and key not in seen,'DUPLICATE_EXECUTED_FILL');seen.add(key)
            symbol=t['symbol'];require(isinstance(symbol,str) and bool(symbol),'INVALID_FILL_SYMBOL')
            q=dec(t['modelShares']);p=dec(t['modelPrice'])
            require(q>0 and q==q.to_integral_value() and q<=2**53-1 and p>0,'INVALID_FILL_QUANTITY_OR_PRICE')
            q=int(q);gross=p*q;fee=(gross*Decimal('.0015')).quantize(QUANTUM,rounding=ROUND_CEILING)
            require(abs(dec(t['modelNotional'])-gross)<=QUANTUM and abs(dec(t['feeUsd'])-fee)<=QUANTUM,'FILL_CASHFLOW_MISMATCH')
            fee_total+=fee;side=t['side'];counts[side]+=1
            if side=='BUY':
                cash-=gross+fee
                if symbol not in active:
                    active[symbol]={'symbol':symbol,'entryDate':when,'shares':0,'buyGross':Decimal(0),'buyFees':Decimal(0),'sellGross':Decimal(0),'sellFees':Decimal(0),'buyFills':0,'sellFills':0,'proxyExit':False}
                c=active[symbol];c['shares']+=q;c['buyGross']+=gross;c['buyFees']+=fee;c['buyFills']+=1
            else:
                require(symbol in active,'SELL_WITHOUT_OPEN_POSITION');c=active[symbol]
                require(c['shares']>=q,'OVERSELL');cash+=gross-fee;c['shares']-=q;c['sellGross']+=gross;c['sellFees']+=fee;c['sellFills']+=1
                c['proxyExit']|=t.get('reason')=='US_A0_ALL_HELD_LAST_VALID_CLOSE_EXIT_V1'
                if c['shares']==0:
                    basis=c['buyGross']+c['buyFees'];pnl=c['sellGross']-c['sellFees']-basis
                    c.update(exitDate=when,buyCost=basis,netProfit=pnl,netReturn=pnl/basis)
                    closed.append(c);del active[symbol]
            require(cash>=0,'NEGATIVE_RECONSTRUCTED_CASH')
        positions=final_state['positions']
        require(set(active)==set(positions) and all(c['shares']==dec(positions[s]['shares']) for s,c in active.items()),'FINAL_POSITION_QUANTITY_MISMATCH')
        require(cash==dec(prior_audit['ledger']['finalCashExact'])==dec(final_state['modelCashExact']),'FINAL_CASH_MISMATCH')
        require(fee_total==dec(prior_audit['ledger']['totalFeesExact'])==dec(final_state['modelFeesExact']),'TOTAL_FEE_MISMATCH')
        require(all(counts[side]==prior_audit['tradeCounts']['allFills'][side] for side in ('BUY','SELL')),'SOURCE_FILL_COUNT_MISMATCH')
        require(len(closed)==prior_audit['ledger']['completedPositionLifecycles'],'SOURCE_COMPLETED_CYCLE_COUNT_MISMATCH')
        require(sum(c['proxyExit'] for c in closed)==prior_audit['ledger']['retrospectiveProxyExitFills'],'SOURCE_PROXY_COUNT_MISMATCH')
        byyear=defaultdict(list)
        for c in closed:byyear[c['exitDate'][:4]].append(c['netReturn'])
        result={'schema':'us-a0-roundtrip-summary-v1','status':'VERIFIED','startDate':start,'endDate':end,
                'returnUnit':'COMPLETED_ZERO_TO_ZERO_POSITION','returnBasis':'NET_PROFIT_DIV_BUY_GROSS_PLUS_BUY_FEES','weighting':'EQUAL_WEIGHT_NOT_ANNUALIZED',
                **stats([c['netReturn'] for c in closed]),'excludedOpenPositions':len(active),'proxyClosedPositions':sum(c['proxyExit'] for c in closed),
                'buyFills':counts['BUY'],'sellFills':counts['SELL'],'ignoredPendingRows':pending,'totalFeesUsd':money(fee_total),
                'portfolioMdd':float(book['mdd']),'byExitYear':[{'year':int(y),**stats(v)} for y,v in sorted(byyear.items())],
                'sourceLedgerChecksPassed':True}
        serial=[{k:money(v) if isinstance(v,Decimal) else v for k,v in c.items()} for c in closed]
        return result,serial

def audit_directory(directory):
    p=Path(directory)
    def read(name):return json.loads((p/name).read_text(),parse_float=Decimal)
    def rows():
        with (p/'US_A0.trades.jsonl').open() as f:
            for line in f:
                if line.strip():yield json.loads(line,parse_float=Decimal)
    try:return aggregate(rows(),read('US_A0.final-state.json'),read('math-audit.json'),read('summary.json'))
    except RoundtripError:raise
    except Exception:raise RoundtripError('ROUNDTRIP_INPUT_INVALID') from None
