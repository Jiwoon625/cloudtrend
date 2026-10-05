"""Dated cash-merger accounting in adjusted comparison units.

Extends the immutable v9 registry with eight documented cash mergers. This remains
an exploratory comparison ledger: approved T+2 timing and 15bp sale-side cost
are retained. No ordinary distribution or contingent right is manufactured.
"""
from dataclasses import asdict
from decimal import Decimal
from cm06.accounting import dec, utc
from cm06_cash_merger_registry_v1 import CashMerger, REGISTRY as V9_REGISTRY, TWO_US_SESSIONS, EXCLUDED_UNRESOLVED

REGISTRY = V9_REGISTRY + (
    CashMerger('TSRO', '2019-01-22', '2019-01-18', '75.00',
        'https://www.sec.gov/Archives/edgar/data/1491576/000110465919002640/a19-1062_68k.htm'),
    CashMerger('ESIO', '2019-02-01', '2019-02-01', '30.00',
        'https://www.sec.gov/Archives/edgar/data/726514/000114036119002246/s002644x1_8k.htm',
        'cash only; final trading session 2019-02-01, first unavailable session 2019-02-04'),
    CashMerger('LOXO', '2019-02-15', '2019-02-14', '235.00',
        'https://www.sec.gov/Archives/edgar/data/1581720/000119312519042505/d664418d8k.htm',
        'cash only; trading ceased before 2019-02-15 open despite vendor repeated quote'),
)
# Additional simple-cash events found in the failed run's current holdings.
# The launcher verifies vendor identity and exact raw-share reference prices
# before any calculation; no earlier-date universe exclusion uses this list.
REGISTRY += (
    CashMerger('ARRY1', '2019-07-30', '2019-07-29', '48.00',
        'https://www.sec.gov/Archives/edgar/data/1100412/000119312519206255/d733992d8k.htm'),
    CashMerger('GNMK', '2021-04-22', '2021-04-21', '24.05',
        'https://www.nasdaqtrader.com/TraderNews.aspx?id=ECA2021-63'),
    CashMerger('ARNA', '2022-03-11', '2022-03-10', '100.00',
        'https://www.nasdaqtrader.com/TraderNews.aspx?id=ECA2022-45'),
    CashMerger('RETA', '2023-09-26', '2023-09-25', '172.50',
        'https://www.nasdaqtrader.com/TraderNews.aspx?id=ECA2023-540'),
    CashMerger('SGEN', '2023-12-14', '2023-12-13', '229.00',
        'https://www.nasdaqtrader.com/TraderNews.aspx?id=ECA2023-721'),
)
IDENTITY_NAME_TOKENS = {
    'TSRO': ('tesaro',), 'ESIO': ('electro', 'scientific'), 'LOXO': ('loxo',),
    'ARRY1': ('array', 'biopharma'), 'GNMK': ('genmark',),
    'ARNA': ('arena', 'pharma'), 'RETA': ('reata',), 'SGEN': ('seagen',),
}
BY_SYMBOL = {e.symbol:e for e in REGISTRY}
if len(BY_SYMBOL) != len(REGISTRY):
    raise ValueError('Duplicate cash-merger symbol')


def positive(value, name):
    if isinstance(value, bool):
        raise ValueError(name + ': boolean is not a price')
    try:
        out = dec(value)
    except Exception as exc:
        raise ValueError(name + ': missing or invalid number') from exc
    if not out.is_finite() or out <= 0:
        raise ValueError(name + ': expected finite positive number')
    return out


def unit_conversion(event, prior_row, at):
    """Use only the exact, completed last trading quote, not future prices.

    One comparison unit represents comparison_close / closeunadj actual-share
    equivalents. The raw legal consideration must use that SAME price scaling.
    close alone is split-adjusted and therefore is not the raw-share denominator.
    """
    if prior_row.get('symbol') != event.symbol or prior_row.get('session_date') != event.last_trade_date:
        raise ValueError(event.symbol + ': exact last-trade identity/date required')
    observed = prior_row.get('source_observed')
    if not (observed is True or (type(observed).__name__ == 'bool_' and bool(observed))):
        raise ValueError(event.symbol + ': last-trade source observation missing')
    if not prior_row.get('available_at') or utc(prior_row['available_at']) > utc(at):
        raise ValueError(event.symbol + ': last-trade quote is not yet available')
    comparison = positive(prior_row.get('comparison_close'), 'comparison_close')
    raw = positive(prior_row.get('closeunadj'), 'closeunadj')
    split_adjusted = positive(prior_row.get('close'), 'close')
    closeadj = positive(prior_row.get('closeadj'), 'closeadj')
    declared_ratio = positive(prior_row.get('comparison_ratio'), 'comparison_ratio')
    def agrees(a,b):
        return abs(a-b) <= max(abs(a),abs(b))*Decimal('1e-10')
    if not agrees(comparison, closeadj) or not agrees(declared_ratio, comparison/split_adjusted):
        raise ValueError(event.symbol + ': inconsistent comparison-price scaling')
    factor = comparison/raw
    return dict(raw_cash_per_share=str(positive(event.cash_per_share, 'cash_per_share')),
        raw_to_comparison_factor=str(factor),
        comparison_cash_per_unit=str(event.cash()*factor),
        last_trade_date=event.last_trade_date,
        last_trade_closeunadj=str(raw), last_trade_comparison_close=str(comparison),
        last_trade_quote_available_at=utc(prior_row['available_at']).isoformat(),
        unit_policy='LEGAL_CASH_TIMES_LAST_TRADE_COMPARISON_CLOSE_DIV_CLOSEUNADJ')


def convert_cash_merger(ledger, event, quantity, payment_at, prior_row):
    key=('U',event.symbol)
    p=ledger.positions.get(key)
    if p is None:
        return False
    if quantity != p.quantity or quantity <= 0:
        raise ValueError(event.symbol + ': merger quantity must equal held quantity')
    if ledger.at.date().isoformat() < event.effective_date or ledger.at.date().isoformat() <= event.last_trade_date:
        raise ValueError(event.symbol + ': merger conversion precedes the first unavailable session')
    payment_at=utc(payment_at)
    if payment_at <= ledger.at:
        raise ValueError(event.symbol + ': payment must be future')
    units=unit_conversion(event, prior_row, ledger.at)
    event_id=f'cash-merger:{event.symbol}:{event.effective_date}:U'
    ledger.sell(event_id, 'U', event.symbol, quantity, dec(units['comparison_cash_per_unit']), ledger.at, payment_at)
    ledger.events[-1].update(kind='CASH_MERGER', market_trade=False,
        effective_date=event.effective_date, payment_assumption=event.payment_assumption,
        consideration_note=event.consideration_note,source_url=event.source_url,
        contingent_value_excluded=(event.symbol=='SHLM'),
        fee_policy='RETAINED_0.0015_COMPARISON_SELL_COST_NOT_ACTUAL_MERGER_FEE', **units)
    ledger.receivables[event_id].source='CASH_MERGER'
    ledger.assert_invariants()
    return True


def registry_json():
    return dict(status='DOCUMENTED_CASH_MERGER_REGISTRY_V2',
        payment_assumption=TWO_US_SESSIONS,
        unit_policy='LEGAL_CASH_TIMES_LAST_TRADE_COMPARISON_CLOSE_DIV_CLOSEUNADJ',
        event_policy='FIRST_US_OPEN_AFTER_LAST_TRADE_NOT_BEFORE_LEGAL_EFFECTIVE_DATE',
        preexisting_SHLM_CVR_exclusion_retained=True,
        new_unmodeled_contingent_rights='FAIL_CLOSED_IF_ACTUALLY_HELD', excluded=EXCLUDED_UNRESOLVED,
        events=[asdict(e) for e in REGISTRY], unresolved_dated_events=list(UNRESOLVED_EVENTS))


# Stop only if a right is actually held at its dated event; never exclude a
# stock earlier using knowledge of a future takeover or bankruptcy. These
# entries are not zero-valued, and cannot produce ranked completed results.
UNRESOLVED_EVENTS = (
    dict(symbol='PDLI', date='2020-05-14', kind='EVFM_SPINOFF_ENTITLEMENT', terminal=False,
         source_url='https://www.miaxglobal.com/sites/default/files/alert-files/PDLI_Distribution_46985.pdf'),
    dict(symbol='PDLI', date='2020-10-02', kind='LENSAR_SPINOFF_ENTITLEMENT', terminal=False,
         source_url='https://www.nasdaqtrader.com/TraderNews.aspx?id=ECA2020-162'),
    dict(symbol='PDLI', date='2020-12-31', kind='LIQUIDATION_RESIDUAL_RIGHT', terminal=True,
         source_url='https://www.sec.gov/Archives/edgar/data/882104/000088210421000035/pdli-20201231.htm'),
    dict(symbol='MRTX', date='2024-01-23', kind='CASH_PLUS_NONTRANSFERABLE_CVR', terminal=True,
         source_url='https://www.nasdaqtrader.com/TraderNews.aspx?id=ECA2024-28'),
    dict(symbol='IRBTQ', date='2026-01-23', kind='DOCUMENTED_ZERO_RECOVERY_CANCELLATION_NEEDS_ADAPTER', terminal=True,
         source_url='https://www.sec.gov/Archives/edgar/data/1159167/000115916726000006/irbt-20260122.htm'),
)
