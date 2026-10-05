"""Documented cash-merger registry and reusable comparison-ledger conversion.

This module intentionally excludes NMTRQ: delisting/bankruptcy evidence is not a
cash-merger consideration. Payment timing is an explicit user-approved T+2 US
session comparison assumption, not a verified broker payment date.
"""
from __future__ import annotations
from dataclasses import dataclass, asdict
from decimal import Decimal
from cm06.accounting import dec, utc

TWO_US_SESSIONS = "USER_APPROVED_US_T_PLUS_2_COMPARISON_ASSUMPTION"

@dataclass(frozen=True)
class CashMerger:
    symbol: str
    effective_date: str
    last_trade_date: str
    cash_per_share: str
    source_url: str
    consideration_note: str = "cash only; no additional distributions"
    payment_assumption: str = TWO_US_SESSIONS
    confidence: str = "DOCUMENTED_CASH_MERGER"

    def cash(self):
        return dec(self.cash_per_share)


REGISTRY = (
    CashMerger("EXA", "2017-11-17", "2017-11-16", "24.25",
               "https://www.sec.gov/Archives/edgar/data/890264/000110465917069319/a17-26438_38k.htm"),
    CashMerger("CSRA1", "2018-04-03", "2018-04-03", "41.25",
               "https://www.sec.gov/Archives/edgar/data/1646383/000119312518106369/d562306d8k.htm"),
    CashMerger("SHLM", "2018-08-21", "2018-08-20", "42.00",
               "https://www.sec.gov/Archives/edgar/data/1489393/000119312518254058/d598622d8k.htm",
               "cash plus one CVR; CVR excluded because amount is contingent and unobserved"),
    CashMerger("CARB", "2019-12-24", "2019-12-23", "23.00",
               "https://www.sec.gov/Archives/edgar/data/1002638/000119312519322997/d822477d8k.htm"),
    CashMerger("CY", "2020-04-16", "2020-04-16", "23.85",
               "https://www.sec.gov/Archives/edgar/data/791915/000110465920047540/tm2015973d1_8k.htm"),
    CashMerger("FNJN", "2020-07-24", "2020-07-23", "1.55",
               "https://www.sec.gov/Archives/edgar/data/1366340/000110465920086228/tm2025414d2_ex99-1.htm"),
    CashMerger("MNTA", "2020-10-01", "2020-09-30", "52.50",
               "https://www.sec.gov/Archives/edgar/data/1235010/000119312520260641/d56603dex99a5o.htm"),
    CashMerger("XLRN", "2021-11-19", "2021-11-19", "180.00",
               "https://www.merck.com/news/merck-completes-tender-offer-to-acquire-acceleron-pharma-inc/"),
    CashMerger("CCXI1", "2022-10-20", "2022-10-19", "52.00",
               "https://www.sec.gov/Archives/edgar/data/1340652/000119312522265762/d414697d8k.htm"),
    CashMerger("COUP", "2023-02-28", "2023-02-27", "81.00",
               "https://www.thomabravo.com/press-releases/thoma-bravo-completes-acquisition-of-coupa-software"),
    CashMerger("IMGN", "2024-02-12", "2024-02-09", "31.26",
               "https://news.abbvie.com/2024-02-12-abbvie-completes-acquisition-of-immunogen/"),
    CashMerger("KALV", "2026-06-11", "2026-06-10", "27.00",
               "https://nasdaqtrader.com/TraderNews.aspx?id=ECA2026-390"),
)

BY_SYMBOL = {e.symbol: e for e in REGISTRY}
EXCLUDED_UNRESOLVED = {
    "NMTRQ": "delisting/OTC evidence; no cash-merger consideration established",
}

def registry_json():
    return {
        "status": "DOCUMENTED_CASH_MERGER_REGISTRY",
        "payment_assumption": TWO_US_SESSIONS,
        "cvrs_and_contingent_non_cash_ignored": True,
        "excluded": EXCLUDED_UNRESOLVED,
        "events": [asdict(e) for e in REGISTRY],
    }

def convert_cash_merger(ledger, event: CashMerger, quantity: int, payment_at):
    """Convert a held position to a USD receivable using exact Ledger sale accounting."""
    payment_at = utc(payment_at)
    key = ("U", event.symbol)
    p = ledger.positions.get(key)
    if p is None:
        return False
    if quantity != p.quantity or quantity <= 0:
        raise ValueError(f"{event.symbol}: registry quantity must equal held quantity")
    # A source may still provide a valid quote on the effective date (CSRA1),
    # with the first missing close arriving on the following session. The
    # conversion is therefore allowed at the first post-effective missing
    # quote, but never before the documented effective date.
    if ledger.at.date().isoformat() < event.effective_date:
        raise ValueError(f"{event.symbol}: effective-date mismatch")
    if payment_at <= ledger.at:
        raise ValueError(f"{event.symbol}: payment must be future")
    event_id = f"cash-merger:{event.symbol}:{event.effective_date}:U"
    ledger.sell(event_id, "U", event.symbol, quantity, event.cash(), ledger.at, payment_at)
    row = ledger.events[-1]
    row.update(kind="CASH_MERGER", market_trade=False,
               payment_assumption=event.payment_assumption,
               consideration_note=event.consideration_note,
               source_url=event.source_url,
               contingent_value_excluded=(event.symbol == "SHLM"))
    ledger.receivables[event_id].source = "CASH_MERGER"
    ledger.assert_invariants()
    return True
