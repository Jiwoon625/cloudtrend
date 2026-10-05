"""Mandatory stock/cash exchanges in explicit comparison units.

No market sale/buy, fee, inferred unit factor, or invented payment date for
mandatory stock exchanges. Legal whole-share/fraction rules apply only when
predecessor actual-share equivalents are exact integers. Noninteger comparison
units retain exact rational audit plus an explicitly bounded Decimal projection.
This is comparison accounting, not a tax-basis certification.
"""
from dataclasses import dataclass, asdict
from decimal import Decimal
from fractions import Fraction
import re

from cm06.accounting import Position, Receivable, ZERO, dec, utc
from cm06_cash_merger_registry_v1 import CashMerger
from cm06_cash_merger_registry_v2 import unit_conversion, positive
from cm06_fractional_accounting_v1 import (
    FractionalComparisonLedger, ComparisonEntitlementPosition,
    comparison_units, assert_projection_value_error,
)

T_PLUS_5_CASH_POLICY = 'USER_APPROVED_US_T_PLUS_5_COMPARISON_ASSUMPTION_NOT_ACTUAL_PAYMENT_DATE'
# Latest explicit user approval, 2026-10-04: receive new merger cash at the
# fifth subsequent US session open, exclusive of the legal effective date.
# This research assumption supersedes the earlier indefinite-cash restriction.
STOCK_CASH_PAYMENT_POLICY = T_PLUS_5_CASH_POLICY
CONFIRMED_PAYMENT_AT = {}


@dataclass(frozen=True)
class StockMerger:
    symbol: str
    successor: str
    effective_date: str
    last_trade_date: str
    share_ratio: str
    cash_per_actual_share: str
    source_url: str
    old_permaticker: str | None
    new_permaticker: str | None
    old_name_tokens: tuple
    new_name_tokens: tuple
    fractional_cash_method: str
    fractional_cash_reference: str | None = None
    fractional_reference_dates: tuple = ()


REGISTRY = (
    StockMerger('TLRA', 'MGNI', '2020-04-01', '2020-03-31', '1.082', '0',
        'https://www.sec.gov/Archives/edgar/data/1375796/000110465919075228/tm1926615d4_ex2-1.htm',
        '194309', '187421', ('telaria',), (), 'TEN_PRIOR_RAW_CLOSE_MEAN',
        fractional_reference_dates=tuple('2020-03-'+d for d in ('18','19','20','23','24','25','26','27','30','31'))),
    StockMerger('EBTC', 'INDB', '2025-07-01', '2025-06-30', '0.6', '2.00',
        'https://www.sec.gov/Archives/edgar/data/776901/000077690125000237/exhibit991-ebtcdealclosepr.htm',
        '197030', '198554', ('enterprise','bancorp'), ('independent','bank'), 'PUBLISHED_RAW_PRICE', '61.61'),
)
BY_SYMBOL = {e.symbol:e for e in REGISTRY}
ADDITIONAL_CASH_EVENTS = (
    CashMerger('TRIL1', '2021-11-17', '2021-11-16', '18.50',
        'https://www.pfizer.com/news/press-release/press-release-detail/pfizer-completes-acquisition-trillium-therapeutics',
        payment_assumption=T_PLUS_5_CASH_POLICY),
)


def validate_identity(row, symbol, permaticker=None, tokens=()):
    if row.get('symbol') != symbol:
        raise ValueError('CORPORATE_ACTION_IDENTITY_MISMATCH: '+symbol)
    name=row.get('name')
    if not isinstance(name,str) or not name.strip():
        raise ValueError('CORPORATE_ACTION_IDENTITY_MISSING_NAME: '+symbol)
    norm=''.join(c.lower() for c in name if c.isalnum())
    if any(token not in norm for token in tokens):
        raise ValueError('CORPORATE_ACTION_IDENTITY_MISMATCH: '+symbol+' '+name)
    pid=str(row.get('permaticker')).strip()
    if not re.fullmatch(r'[0-9]+(?:\.0)?',pid):
        raise ValueError('CORPORATE_ACTION_IDENTITY_MISSING_PERMATICKER: '+symbol)
    pid=pid.removesuffix('.0')
    if permaticker is not None and pid != str(permaticker):
        raise ValueError('CORPORATE_ACTION_IDENTITY_MISMATCH: '+symbol+' permanent identifier')
    return pid


def reference(row, symbol, day, at, *, permaticker=None, tokens=()):
    pid=validate_identity(row,symbol,permaticker,tokens)
    # Reuse the current cash adapter's exact-row, observed, causal and price
    # coherence checks. A unit legal cash amount is used only for validation.
    probe=CashMerger(symbol,day,day,'1','comparison-unit-validation')
    facts=unit_conversion(probe,row,at)
    # The synthetic unit-cash probe validates scaling only. Its cash fields
    # are not legal consideration and must never enter stock reference audits.
    facts.pop('raw_cash_per_share',None)
    facts.pop('comparison_cash_per_unit',None)
    facts['unit_policy']='COMPARISON_PRICE_DIV_RAW_PRICE_REFERENCE_ONLY_NOT_CASH_CONSIDERATION'
    ratio=Fraction(dec(row['comparison_close']))/Fraction(dec(row['closeunadj']))
    return ratio, dict(facts,permaticker=pid,vendor_name=row['name'])


def _round_cent(value):
    """Exact positive rational half-up rounding, not binary-float rounding."""
    if value < 0: raise ValueError('Negative fractional cash')
    cents=(value.numerator*200+value.denominator)//(value.denominator*2)
    return Decimal(cents)/100


def _decimal(value):
    return Decimal(value.numerator)/Decimal(value.denominator)


def fractional_cash_reference(event, history, at):
    if event.fractional_cash_method=='PUBLISHED_RAW_PRICE':
        return Fraction(positive(event.fractional_cash_reference,'published fractional cash reference')), []
    if event.fractional_cash_method!='TEN_PRIOR_RAW_CLOSE_MEAN':
        raise ValueError('UNSUPPORTED_FRACTIONAL_CASH_METHOD: '+event.symbol)
    rows=list(history or [])
    if len(rows)!=len(event.fractional_reference_dates) or sorted(r.get('session_date','') for r in rows)!=list(event.fractional_reference_dates):
        raise ValueError('MISSING_EXACT_FRACTIONAL_CASH_HISTORY: '+event.symbol)
    prices=[];audit=[]
    for row in sorted(rows,key=lambda r:r['session_date']):
        _,facts=reference(row,event.successor,row['session_date'],at,
            permaticker=event.new_permaticker,tokens=event.new_name_tokens)
        prices.append(Fraction(positive(row.get('closeunadj'),'fractional cash raw close')))
        audit.append(dict(session_date=row['session_date'],raw_close=str(row['closeunadj']),
            available_at=facts['last_trade_quote_available_at'],permaticker=facts['permaticker']))
    return sum(prices,Fraction(0))/len(prices),audit


def _cash_due(at, end_at, payment_at, cash_policy):
    if payment_at is None:
        raise ValueError('CASH_PAYMENT_POLICY_REQUIRED: no verified cash payment date')
    due=utc(payment_at)
    if cash_policy is None:
        if due < utc(at):raise ValueError('Confirmed payment precedes conversion')
        return due,'EXPLICIT_CONFIRMED_PAYMENT_TIMESTAMP'
    if cash_policy!=T_PLUS_5_CASH_POLICY:
        raise ValueError('CASH_PAYMENT_POLICY_REQUIRED: unsupported settlement policy')
    if due<=utc(at):raise ValueError('T+5 assumption requires a future calendar-derived payment timestamp')
    return due,T_PLUS_5_CASH_POLICY


def convert_stock_merger(ledger,event,old_row,new_row,*,history=None,payment_at=None,
                         cash_policy=None,end_at=None):
    """Atomically plan, then exchange an entire held predecessor position.

    TLRA share-only basis is divided by legal whole/fractional share entitlement.
    A mixed stock/cash exchange uses prior-completed-close consideration values
    to apportion native and KRW basis. This is explicitly a comparison PnL
    convention, not US/Korean tax treatment or verified broker lot accounting.
    """
    old_key=('U',event.symbol);new_key=('U',event.successor)
    old=ledger.positions.get(old_key)
    if old is None:return False
    event_id=f'stock-merger:{event.symbol}:{event.effective_date}:U'
    if event_id in ledger.seen:
        raise ValueError('DUPLICATE_STOCK_EXCHANGE: '+event.symbol)
    if event.symbol==event.successor or old.currency!='USD':
        raise ValueError('Invalid stock exchange identity or currency')
    if ledger.at.date().isoformat()!=event.effective_date or event.effective_date<=event.last_trade_date:
        raise ValueError('MISSED_OR_PREMATURE_STOCK_EXCHANGE: '+event.symbol)
    old_factor,old_facts=reference(old_row,event.symbol,event.last_trade_date,ledger.at,
        permaticker=event.old_permaticker,tokens=event.old_name_tokens)
    new_factor,new_facts=reference(new_row,event.successor,event.last_trade_date,ledger.at,
        permaticker=event.new_permaticker,tokens=event.new_name_tokens)
    raw_old=Fraction(old.quantity)*old_factor
    if raw_old.denominator!=1:
        raise ValueError('UNREPRESENTABLE_STOCK_EXCHANGE_UNITS: '+event.symbol+' predecessor actual-share quantity is fractional')
    entitlement=raw_old*Fraction(positive(event.share_ratio,'share ratio'))
    whole=entitlement.numerator//entitlement.denominator
    fraction=entitlement-whole
    new_units=Fraction(whole)/new_factor
    fractional_ledger=isinstance(ledger,FractionalComparisonLedger)
    if new_units.denominator!=1 and not fractional_ledger:
        raise ValueError('UNREPRESENTABLE_STOCK_EXCHANGE_UNITS: '+event.symbol+' whole successor shares cannot be represented by integer comparison units')
    new_quantity,unit_audit=comparison_units(new_units.numerator,new_units.denominator)
    if not fractional_ledger:new_quantity=int(new_units)
    raw_cash=dec(event.cash_per_actual_share)
    if raw_cash<0:raise ValueError('Negative legal cash consideration')
    # Evidence is required even for a zero fraction: no hidden fallback price.
    cil_ref,cil_history=fractional_cash_reference(event,history,ledger.at)
    cil_cash=_round_cent(fraction*cil_ref)
    boot_cash=dec(raw_old.numerator)*raw_cash
    cash=cil_cash+boot_cash
    due=policy=None
    if cash>0:due,policy=_cash_due(ledger.at,end_at,payment_at,cash_policy)
    elif payment_at is not None or cash_policy is not None:
        # Explicit configuration must be valid even when this particular lot
        # has no payable fraction. No zero receivable is manufactured.
        _,policy=_cash_due(ledger.at,end_at,payment_at,cash_policy)
    successor=ledger.positions.get(new_key)
    if successor is not None and successor.currency!='USD':
        raise ValueError('Successor currency mismatch')
    price=positive(new_row['comparison_close'],'successor comparison close')
    price_at=utc(new_row['available_at'])
    if new_key in ledger.prices and ledger.prices[new_key][1]>price_at:
        raise ValueError('Newer successor mark cannot be overwritten with old reference')
    if event.cash_per_actual_share in ('0','0.00') or raw_cash==0:
        cash_basis_fraction=fraction/entitlement
        basis_policy='LEGAL_FRACTIONAL_SHARE_PROPORTION_CARRYOVER_COMPARISON_NOT_TAX'
    else:
        stock_value=Fraction(whole)*Fraction(dec(new_row['closeunadj']))
        cash_basis_fraction=Fraction(cash)/(stock_value+Fraction(cash))
        basis_policy='PRIOR_CLOSE_CONSIDERATION_VALUE_BASIS_ALLOCATION_COMPARISON_NOT_TAX'
    cash_basis_native=old.cost_native*_decimal(cash_basis_fraction)
    cash_basis_krw=old.cost_krw*_decimal(cash_basis_fraction)
    carry_native=old.cost_native-cash_basis_native
    carry_krw=old.cost_krw-cash_basis_krw
    fx=ledger.rate('USD')
    assert_projection_value_error(unit_audit,price,fx)
    if not new_quantity and (carry_native!=0 or carry_krw!=0):
        raise ValueError('Zero-share exchange cannot retain a stock basis')
    merged_quantity=new_quantity
    merged_audit=dict(unit_audit,raw_legal_shares=whole,
        predecessor_symbol=event.symbol,successor_symbol=event.successor,
        raw_per_comparison_unit_numerator=new_factor.numerator,
        raw_per_comparison_unit_denominator=new_factor.denominator,
        incoming_entitlement_unit_audit=dict(unit_audit))
    if fractional_ledger and successor is not None:
        combined=Fraction(successor.quantity)+new_units
        merged_quantity,combined_audit=comparison_units(combined.numerator,combined.denominator)
        merged_audit.update(combined_audit)
        merged_audit['pre_existing_comparison_quantity']=str(successor.quantity)
        merged_audit['entitlement_history']=([successor.entitlement_audit]
            if isinstance(successor,ComparisonEntitlementPosition) else [])
        assert_projection_value_error(merged_audit,price,fx)
    # Validate the existing bridge before touching the ledger. All external
    # evidence, representability, identity, timing and policy checks precede it.
    ledger.assert_invariants()
    ledger.unique(event_id)
    del ledger.positions[old_key]
    ledger.prices.pop(old_key,None)
    if new_quantity:
        if fractional_ledger:
            ledger.positions[new_key]=ComparisonEntitlementPosition('U',event.successor,'USD',merged_quantity,
                carry_native+(successor.cost_native if successor else ZERO),
                carry_krw+(successor.cost_krw if successor else ZERO),
                (successor.sector if successor else new_row.get('sector',old.sector)),
                mandatory_event_id=event_id,entitlement_audit=merged_audit)
        elif successor is not None:
            successor.quantity+=new_quantity
            successor.cost_native+=carry_native
            successor.cost_krw+=carry_krw
        else:
            ledger.positions[new_key]=Position('U',event.successor,'USD',new_quantity,
                carry_native,carry_krw,new_row.get('sector',old.sector))
        ledger.prices[new_key]=(price,price_at)
    if cash>0:
        ledger.receivables[event_id]=Receivable(event_id,'U','USD',cash,due,
            'MANDATORY_STOCK_EXCHANGE_CASH:'+policy)
    ledger.pnl['realized_gross']+=cash*fx-cash_basis_krw
    ledger.record('STOCK_MERGER',id=event_id,sleeve='U',symbol=event.symbol,
        successor=event.successor,quantity_before=old.quantity,actual_old_shares=raw_old.numerator,
        successor_actual_entitlement=str(_decimal(entitlement)),successor_whole_actual_shares=whole,
        successor_fractional_actual_shares=str(_decimal(fraction)),successor_comparison_units=new_quantity,
        successor_unit_projection_audit=unit_audit,
        comparison_price=price,fee=ZERO,market_trade=False,mandatory_exchange=True,
        cash_boot_usd=boot_cash,cash_in_lieu_usd=cil_cash,cash_receivable_usd=cash,
        fractional_cash_reference_raw=str(_decimal(cil_ref)),fractional_cash_history=cil_history,
        cash_in_lieu_valuation_status=('CONTRACT_FORMULA_COMPARISON_ESTIMATE_NOT_TRANSFER_AGENT_VERIFIED'
            if event.symbol=='TLRA' else 'PUBLISHED_CASH_IN_LIEU_REFERENCE_NOT_PAYMENT_DATE'),
        cash_payment_policy=policy,payment_at=(due.isoformat() if due else None),
        payment_timestamp_is_actual=(policy=='EXPLICIT_CONFIRMED_PAYMENT_TIMESTAMP'),
        cash_available_from=(due.isoformat() if due else None),
        predecessor_unit_reference=old_facts,successor_unit_reference=new_facts,
        basis_policy=basis_policy,predecessor_basis_native=old.cost_native,predecessor_basis_krw=old.cost_krw,
        carried_basis_native=carry_native,carried_basis_krw=carry_krw,
        cash_disposed_basis_native=cash_basis_native,cash_disposed_basis_krw=cash_basis_krw,
        realized_gross_krw=cash*fx-cash_basis_krw,source_url=event.source_url)
    ledger.assert_invariants()
    if cash>0 and due<=ledger.at:ledger.settle()
    return True


def stock_registry_json():
    return dict(status='MANDATORY_STOCK_EXCHANGE_COMPARISON_V1',events=[asdict(e) for e in REGISTRY],
        additional_cash_events=[asdict(e) for e in ADDITIONAL_CASH_EVENTS],
        cash_payment_policy=STOCK_CASH_PAYMENT_POLICY,confirmed_payment_at=dict(CONFIRMED_PAYMENT_AT),
        no_mandatory_exchange_market_fee=True,integer_new_buy_units_only=True,
        mandatory_comparison_unit_policy='EXACT_RATIONAL_AUDIT_DECIMAL36_PROJECTION_WITH_VALUE_ERROR_BOUND',
        additional_cash_events_use_existing_cash_v2_unit_and_cost_contract=True,
        additional_cash_events_payment_policy=STOCK_CASH_PAYMENT_POLICY,tax_basis_certified=False)


def corporate_action_summary(ledger):
    """Pure derived report; never changes accounting or checkpoint state.

    Include original cash-v2 events with their own settlement provenance rather
    than relabeling old T+2 assumptions with the new conservative policy.
    """
    fx=ledger.fx.get('USD')
    reports=[];nonspendable=ZERO;pending_by_policy={}
    for event in ledger.events:
        if event.get('kind') not in ('STOCK_MERGER','CASH_MERGER'):continue
        event_id=event.get('id');rec=ledger.receivables.get(event_id)
        policy=event.get('cash_payment_policy',event.get('payment_assumption'))
        if rec is not None:
            nonspendable+=rec.amount
            pending_by_policy[policy]=pending_by_policy.get(policy,ZERO)+rec.amount
        if event['kind']=='STOCK_MERGER':
            cash=dec(event['cash_receivable_usd']);fee=ZERO;gross=cash
            valuation=event['cash_in_lieu_valuation_status']
        else:
            gross=dec(event['quantity'])*dec(event['price']);fee=dec(event['fee']);cash=gross-fee
            valuation='DOCUMENTED_CASH_CONSIDERATION_COMPARISON_UNITS'
        reports.append(dict(event_id=event_id,at=event['at'],kind=event['kind'],symbol=event['symbol'],
            successor=event.get('successor'),actual_old_shares=event.get('actual_old_shares'),
            predecessor_comparison_units=event.get('quantity_before',event.get('quantity')),
            successor_whole_actual_shares=event.get('successor_whole_actual_shares'),
            successor_comparison_units=event.get('successor_comparison_units'),
            cash_boot_usd=event.get('cash_boot_usd'),cash_in_lieu_usd=event.get('cash_in_lieu_usd'),
            gross_cash_entitlement_usd=str(gross),comparison_cost_usd=str(fee),net_cash_entitlement_usd=str(cash),
            cash_valuation_status=valuation,cash_payment_policy=policy,
            payment_timestamp_is_actual=event.get('payment_timestamp_is_actual',False),
            payment_or_comparison_due_at=event.get('payment_at',event.get('settlement_at')),
            cash_available_from=event.get('cash_available_from',event.get('settlement_at')),
            outstanding_receivable_usd=str(rec.amount if rec else ZERO),
            outstanding_nonspendable=bool(rec is not None),
            fee_policy=event.get('fee_policy','NO_MANDATORY_STOCK_EXCHANGE_MARKET_FEE'),
            source_url=event.get('source_url')))
    available={}
    for sleeve,currency in ledger.claims:
        reserved=sum((x.amount for x in ledger.reservations.values()
            if x.sleeve==sleeve and x.currency==currency),ZERO)
        available[sleeve+':'+currency]=str(ledger.claims[(sleeve,currency)]-reserved-ledger.tax_reserve.get((sleeve,currency),ZERO))
    return dict(status='DERIVED_CORPORATE_ACTION_ENTITLEMENT_SUMMARY',at=ledger.at.isoformat(),events=reports,
        scope='CORPORATE_ACTION_RECEIVABLES_ONLY',
        outstanding_nonspendable_cash_usd=str(nonspendable),
        outstanding_cash_by_payment_policy_usd={k:str(v) for k,v in pending_by_policy.items()},
        outstanding_nonspendable_cash_krw_at_current_fx=(str(nonspendable*fx) if fx is not None else None),
        usdkrw_current=(str(fx) if fx is not None else None),
        usdkrw_available_at=(ledger.fx_at['USD'].isoformat() if 'USD' in ledger.fx_at else None),
        deployable_cash_by_sleeve_currency=available,
        actual_payment_dates_inferred=False,tax_basis_certified=False,
        policy_note='New merger cash is in NAV but unavailable until the assumed fifth subsequent US session open; old cash-v2 T+2 assumptions remain per event')
