"""Hash-bound exact price references, separate from event admission.

This adapter consumes locally verified extraction evidence. It cannot make that
evidence causal, turn a provider candidate into a released event, or replace full
historical panels. Frozen accounting/dispatcher modules are never patched.
"""
from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import re

VERSION = 'CM06_VERIFIED_EXACT_REFERENCE_ADAPTER_V1'
QUOTE_RULE_CATALOG_SHA256 = '9cd5d8f3a0a64b94191d0eddbc69129222c7d1275b268b6f9ee7e9c056714dae'
COMPARISON_PREPARATION_SHA256 = 'e1f8f647bdf70719183090b0ac873383cfcabdff56b884d4afad9f34ad2cb2e5'


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def fraction_record(value):
    return {'numerator': value.numerator, 'denominator': value.denominator}


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError('Explicit timezone-aware timestamp required')
    out = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if out.tzinfo is None:
        raise ValueError('Explicit timezone-aware timestamp required')
    return out.astimezone(timezone.utc)


def sha_required(value):
    if not isinstance(value, str) or re.fullmatch(r'[0-9a-f]{64}', value) is None:
        raise ValueError('Explicit SHA-256 evidence required')


def rational(value, field):
    # This is deliberately Fraction(str(value)), not Fraction(float) or a
    # rounded factor string supplied by a producer.
    if isinstance(value, bool) or value is None:
        raise ValueError(field + ': finite positive source number required')
    try:
        number = Decimal(str(value))
        if not number.is_finite() or number <= 0:
            raise ValueError()
        return Fraction(str(value))
    except (ValueError, ArithmeticError, TypeError) as exc:
        raise ValueError(field + ': finite positive source number required') from exc


def exact_factor(values):
    """Raw-share equivalents per comparison unit from the two actual closes."""
    comparison = rational(values.get('comparison_close'), 'comparison_close')
    raw = rational(values.get('closeunadj'), 'closeunadj')
    close = rational(values.get('close'), 'close')
    closeadj = rational(values.get('closeadj'), 'closeadj')
    ratio = rational(values.get('comparison_ratio'), 'comparison_ratio')
    tolerance = Fraction(1, 10**10)
    agrees = lambda a, b: abs(a - b) <= max(abs(a), abs(b)) * tolerance
    if not agrees(comparison, closeadj) or not agrees(ratio, comparison / close):
        raise ValueError('INCOHERENT_SOURCE_PRICE_SCALING')
    return comparison / raw


def incoming_comparison_units(old_units, old_factor, legal_ratio, new_factor):
    """No whole-share floor, cash-in-lieu proxy or adjusted-ratio double count."""
    q = Fraction(str(old_units)) if type(old_units) is not Fraction else old_units
    if q < 0:
        raise ValueError('Negative predecessor quantity')
    vals = [v if type(v) is Fraction else Fraction(str(v))
            for v in (old_factor, legal_ratio, new_factor)]
    if any(v <= 0 for v in vals):
        raise ValueError('Positive exact exchange factors required')
    return q * vals[0] * vals[1] / vals[2]


@dataclass(frozen=True)
class QuoteRule:
    symbol: str
    permaticker: str
    first_legal_trade_date: str | None = None
    last_legal_trade_date: str | None = None
    source_url: str = ''

    def __post_init__(self):
        if not self.symbol or re.fullmatch(r'[0-9]+', self.permaticker) is None:
            raise ValueError('Exact symbol and permanent identity required')
        for day in (self.first_legal_trade_date, self.last_legal_trade_date):
            if day is not None and date.fromisoformat(day).isoformat() != day:
                raise ValueError('ISO legal cutoff required')
        if (self.first_legal_trade_date and self.last_legal_trade_date
                and self.first_legal_trade_date > self.last_legal_trade_date):
            raise ValueError('Reversed legal quote interval')

    def failures(self, values):
        errors = []
        if (values.get('symbol'), str(values.get('permaticker'))) != (self.symbol, self.permaticker):
            errors.append('EXACT_PERMANENT_IDENTITY_MISMATCH')
        day = values.get('session_date')
        try:
            if date.fromisoformat(day).isoformat() != day:
                raise ValueError()
        except (TypeError, ValueError):
            return errors + ['INVALID_REFERENCE_SESSION']
        if self.first_legal_trade_date and day < self.first_legal_trade_date:
            errors.append('PRE_LEGAL_SUCCESSOR_TRADING_HISTORY')
        if self.last_legal_trade_date and day > self.last_legal_trade_date:
            errors.append('POST_LEGAL_PREDECESSOR_LAST_TRADE')
        return errors


@dataclass(frozen=True)
class ExactReference:
    # JSON stores source numeric values as decimal strings, preserving their
    # decimal lexemes. A mutable dictionary cannot alter a validated reference.
    payload_json: bytes
    evidence_file: str
    evidence_file_sha256: str
    jsonl_line: int

    @property
    def record(self):
        return json.loads(self.payload_json)

    @property
    def values(self):
        return self.record['values']

    @property
    def row_id(self):
        return self.record['row_id']

    @property
    def factor(self):
        return exact_factor(self.values)

    @property
    def binding_sha256(self):
        return digest(dict(payload_sha256=hashlib.sha256(self.payload_json).hexdigest(),
                           evidence_file=self.evidence_file,
                           evidence_file_sha256=self.evidence_file_sha256,
                           jsonl_line=self.jsonl_line))

    def locator(self):
        r = self.record
        return dict(evidence_file=self.evidence_file, evidence_file_sha256=self.evidence_file_sha256,
                    jsonl_line=self.jsonl_line, row_id=self.row_id,
                    source_partition=r['source_partition'], source_row_index=r['source_row_index'],
                    symbol=self.values['symbol'], permaticker=str(self.values['permaticker']),
                    session_date=self.values['session_date'])


def _normalize(value):
    if type(value) is Decimal:
        return str(value)
    if type(value) is dict:
        return {k: _normalize(v) for k, v in value.items()}
    if type(value) is list:
        return [_normalize(v) for v in value]
    return value


class VerifiedEvidenceStore:
    """Verify exact file bytes before reading each pinned row locator."""
    def __init__(self, parts, receipt):
        self.parts = Path(parts).resolve()
        self.receipt_path = Path(receipt)
        receipt_bytes = self.receipt_path.read_bytes()
        self.receipt = json.loads(receipt_bytes)
        r = self.receipt
        if r.get('status') != 'VERIFIED_REFERENCE_EVIDENCE_ONLY' or r.get('errors'):
            raise ValueError('Independent evidence verification receipt failed')
        self.files = {item['file']: item for item in r['file_receipts']}
        if len(self.files) != r['file_count'] or any(x.get('matches') is not True for x in self.files.values()):
            raise ValueError('Incomplete or mismatching verification receipt')
        self.receipt_sha256 = hashlib.sha256(receipt_bytes).hexdigest()

    def checked_bytes(self, name):
        if Path(name).name != name or name not in self.files:
            raise ValueError('Evidence path absent from approved file receipt')
        path = self.parts / name
        if not path.is_file() or path.resolve().parent != self.parts:
            raise ValueError('Evidence file missing or escaped source directory')
        expected = self.files[name]
        raw = path.read_bytes()
        if len(raw) != expected['size'] or hashlib.sha256(raw).hexdigest() != expected['sha256']:
            raise ValueError('Evidence file byte hash mismatch: ' + name)
        return raw

    def checked_path(self, name):
        # Convenience path inspection only; readers must parse checked_bytes.
        self.checked_bytes(name)
        return self.parts / name

    def iter_references(self):
        for name in sorted(self.files):
            if not name.startswith('reference_rows.'):
                continue
            raw = self.checked_bytes(name)
            for line_number, line in enumerate(raw.splitlines(), 1):
                payload = _normalize(json.loads(line, parse_float=Decimal))
                yield ExactReference(canonical(payload), name, self.files[name]['sha256'], line_number)

    def load(self, locator):
        name = locator['evidence_file']
        raw = self.checked_bytes(name)
        if locator['evidence_file_sha256'] != self.files[name]['sha256']:
            raise ValueError('Locator and verified file receipt differ')
        n = locator['jsonl_line']
        if type(n) is not int or n < 1:
            raise ValueError('Positive exact JSONL line required')
        line = next((line for i, line in enumerate(raw.splitlines(), 1) if i == n), None)
        if line is None:
            raise ValueError('Reference locator out of bounds')
        record = _normalize(json.loads(line, parse_float=Decimal))
        out = ExactReference(canonical(record), name, self.files[name]['sha256'], n)
        for key, value in out.locator().items():
            if key in locator and locator[key] != value:
                raise ValueError('Exact locator mismatch: ' + key)
        if locator.get('row_id') != out.row_id:
            raise ValueError('Explicit matching row identity required')
        return out


@dataclass(frozen=True)
class CausalReferenceApproval:
    """External preflight attestation, never generated from extraction flags.

    The upstream reviewer owns verification of the proof contents. A well-formed
    hash alone is not certification. No approval is included for current real
    events; tests use clearly synthetic receipts.
    """
    reference_binding_sha256: str
    available_at: str
    proof_sha256: str
    evidence_basis: str
    causal_use_verified: bool

    def __post_init__(self):
        sha_required(self.reference_binding_sha256)
        sha_required(self.proof_sha256)
        timestamp(self.available_at)
        if self.causal_use_verified is not True or not self.evidence_basis.strip():
            raise ValueError('Independent causal-use approval required')
        if self.evidence_basis == 'RESEARCH_CLOSE_PLUS_15_MINUTES_NOT_RECORDED_ARRIVAL':
            raise ValueError('Research availability assumption is not causal approval')


@dataclass(frozen=True)
class SourceBoundComparisonAvailability:
    """Existing research clock convention, explicitly not actual vendor arrival."""
    reference_binding_sha256: str
    available_at: str
    proof_sha256: str
    preparation_source_sha256: str
    calendar_sha256: str
    calendar_close_available_at: str
    evidence_parts: str
    verification_receipt_path: str
    evidence_basis: str = 'EXISTING_SOURCE_BOUND_COMPARISON_AVAILABILITY_ASSUMPTION'
    recorded_vendor_arrival_verified: bool = False
    historical_point_in_time_certified: bool = False

    def __post_init__(self):
        for value in (self.reference_binding_sha256, self.proof_sha256, self.preparation_source_sha256,
                      self.calendar_sha256):
            sha_required(value)
        timestamp(self.available_at)
        if not self.evidence_parts or not self.verification_receipt_path:
            raise ValueError('Exact extraction receipt and evidence paths required')
        if timestamp(self.available_at) != timestamp(self.calendar_close_available_at):
            raise ValueError('Comparison quote availability must match bound US calendar close')
        if (self.evidence_basis != 'EXISTING_SOURCE_BOUND_COMPARISON_AVAILABILITY_ASSUMPTION'
                or self.recorded_vendor_arrival_verified is not False
                or self.historical_point_in_time_certified is not False):
            raise ValueError('Comparison convention must not claim actual vendor-arrival/PIT proof')


def comparison_convention_source():
    path = Path(__file__).resolve().parents[3] / 'resumable_allocation/runtime/cm06_prepare_comparison.py'
    source = path.read_bytes()
    if hashlib.sha256(source).hexdigest() != COMPARISON_PREPARATION_SHA256:
        raise ValueError('FROZEN_COMPARISON_PREPARATION_SOURCE_CHANGED')
    if b'RESEARCH_CLOSE_PLUS_15_MINUTES_NOT_RECORDED_ARRIVAL' not in source:
        raise ValueError('Existing comparison preparation convention not found')
    return {'path': str(path), 'sha256': hashlib.sha256(source).hexdigest(),
            'availability_basis': 'RESEARCH_CLOSE_PLUS_15_MINUTES_NOT_RECORDED_ARRIVAL',
            'recorded_vendor_arrival_verified': False, 'historical_point_in_time_certified': False}


def bind_comparison_availability(reference, store, calendar):
    """Bind actual checked extraction bytes and unchanged model convention.

    This is not a fresh user approval or fabricated notice/arrival timestamp.
    The source's available_at stays unchanged; runtime ordering remains strict.
    """
    if type(store) is not VerifiedEvidenceStore or type(reference) is not ExactReference:
        raise TypeError('Verified evidence store and exact reference required')
    from cm06_us_cash_t5_policy_v1 import USSessionCalendar
    if type(calendar) is not USSessionCalendar:
        raise ValueError('Explicit bound US calendar required for comparison availability')
    checked = store.load(reference.locator())
    if checked.binding_sha256 != reference.binding_sha256:
        raise ValueError('Source-bound reference differs from checked extraction bytes')
    source = comparison_convention_source()
    if reference.values.get('availability_basis') != source['availability_basis']:
        raise ValueError('Reference uses another comparison availability convention')
    close = calendar.session(reference.values['session_date']).close_available_at
    if timestamp(reference.values['available_at']) != timestamp(close):
        raise ValueError('EXTRACTION_AVAILABLE_AT_DIFFERS_FROM_BOUND_US_CALENDAR_CLOSE')
    return SourceBoundComparisonAvailability(reference.binding_sha256,
        reference.values['available_at'], store.receipt_sha256, source['sha256'],
        calendar.fingerprint, close, str(store.parts), str(store.receipt_path.resolve()))


def runtime_reference(reference, rule, session_date, activation_at, approval, *, reference_use='MARKET_EXECUTION'):
    """Prepare an existing-handler row only after all explicit guards pass."""
    if type(reference) is not ExactReference or type(rule) is not QuoteRule:
        raise TypeError('Explicit bound reference and dated quote rule required')
    values = reference.values
    if reference_use not in ('MARKET_EXECUTION', 'MANDATORY_CORPORATE_ACTION_VALUATION'):
        raise ValueError('Explicit supported reference use required')
    validate_known_quote_rule(rule)
    failures = rule.failures(values)
    if values.get('session_date') != session_date:
        failures.append('EXACT_REFERENCE_SESSION_MISMATCH')
    if values.get('source_observed') is not True:
        failures.append('SOURCE_NOT_OBSERVED')
    if reference_use == 'MARKET_EXECUTION':
        try:
            rational(values.get('volume'), 'volume')
        except ValueError:
            failures.append('NONPOSITIVE_VOLUME_EXECUTION_GUARD')
    factor = reference.factor
    if type(approval) not in (CausalReferenceApproval, SourceBoundComparisonAvailability):
        failures.append('BOUND_COMPARISON_AVAILABILITY_OR_INDEPENDENT_CAUSAL_REFERENCE_APPROVAL_MISSING')
    else:
        if type(approval) is SourceBoundComparisonAvailability:
            source_convention = comparison_convention_source()
            if approval.preparation_source_sha256 != source_convention['sha256']:
                failures.append('COMPARISON_AVAILABILITY_SOURCE_CHANGED')
            if values.get('availability_basis') != source_convention['availability_basis']:
                failures.append('COMPARISON_REFERENCE_AVAILABILITY_BASIS_CHANGED')
            if timestamp(values['available_at']) != timestamp(approval.available_at):
                failures.append('COMPARISON_REFERENCE_AVAILABILITY_DIFFERS_FROM_SOURCE')
            # Construction is not a capability. Verify the bound extraction
            # receipt and row again, including at the actual consumer boundary.
            checked_store = VerifiedEvidenceStore(approval.evidence_parts, approval.verification_receipt_path)
            if checked_store.receipt_sha256 != approval.proof_sha256:
                failures.append('COMPARISON_EXTRACTION_VERIFICATION_RECEIPT_CHANGED')
            if checked_store.load(reference.locator()).binding_sha256 != reference.binding_sha256:
                failures.append('COMPARISON_REFERENCE_DIFFERS_FROM_VERIFIED_EXTRACTION')
        if approval.reference_binding_sha256 != reference.binding_sha256:
            failures.append('CAUSAL_APPROVAL_REFERENCE_BINDING_MISMATCH')
        if (timestamp(approval.available_at) > timestamp(activation_at)
                or timestamp(values['available_at']) > timestamp(activation_at)):
            failures.append('REFERENCE_NOT_AVAILABLE_AT_RECOGNITION')
        if timestamp(approval.available_at) < timestamp(values['available_at']):
            failures.append('APPROVAL_CANNOT_BACKDATE_SOURCE_AVAILABILITY')
    if failures:
        raise ValueError(';'.join(failures))
    values['available_at'] = approval.available_at
    values['cm06_exact_reference_audit'] = dict(
        version=VERSION, reference_binding_sha256=reference.binding_sha256,
        reference_use=reference_use,
        zero_volume_reference=(Decimal(str(values.get('volume'))) == 0),
        ordinary_market_execution_eligible=(Decimal(str(values.get('volume'))) > 0),
        handler_values_sha256=digest(values),
        locator=reference.locator(), factor=fraction_record(factor),
        availability_evidence_sha256=approval.proof_sha256, evidence_basis=approval.evidence_basis,
        availability_is_comparison_assumption=type(approval) is SourceBoundComparisonAvailability,
        recorded_vendor_arrival_verified=False,
        historical_point_in_time_certified=False,
        preparation_source_sha256=(approval.preparation_source_sha256
            if type(approval) is SourceBoundComparisonAvailability else None),
        calendar_sha256=(approval.calendar_sha256
            if type(approval) is SourceBoundComparisonAvailability else None),
        quote_rule=dict(rule.__dict__), approval_is_event_admission=False)
    return values


def build_linear_context(event, terms, old_reference, new_reference, old_rule, new_rule,
                         old_approval, new_approval):
    """Compose with the frozen dispatcher; never create/admit a DatedAction."""
    from cm06_dated_action_contract_v1 import DatedAction
    from cm06_exact_units_exchange_v1 import LinearExchangeTerms
    if type(event) is not DatedAction or event.kind != 'LINEAR_EXCHANGE':
        raise ValueError('Separately admitted linear DatedAction required')
    if type(terms) is not LinearExchangeTerms or terms.event_id != event.event_id:
        raise ValueError('Exact matching LinearExchangeTerms required')
    if ((old_rule.symbol, old_rule.permaticker) != (event.predecessor, event.predecessor_identity)
            or (new_rule.symbol, new_rule.permaticker) != (event.successor, event.successor_identity)):
        raise ValueError('Dated rules do not match admitted permanent identities')
    validate_documented_event(event, old_rule, new_rule, terms=terms)
    old = runtime_reference(old_reference, old_rule, terms.last_trade_date,
                            event.recognition_at, old_approval, reference_use='MANDATORY_CORPORATE_ACTION_VALUATION')
    new = runtime_reference(new_reference, new_rule, terms.successor_reference_date,
                            event.recognition_at, new_approval, reference_use='MANDATORY_CORPORATE_ACTION_VALUATION')
    return dict(identity_receipt_sha256=event.identity_receipt_sha256,
                predecessor_identity=event.predecessor_identity,
                successor_identity=event.successor_identity,
                terms=terms, old_row=old, new_row=new,
                _bound_event_fingerprint=event.fingerprint,
                _bound_reference_inputs=((old_reference, old_rule, old_approval),
                                         (new_reference, new_rule, new_approval)),
                reference_adapter_binding_sha256=digest({
                    'old': old['cm06_exact_reference_audit'],
                    'new': new['cm06_exact_reference_audit']}))


def build_cash_context(event, cash_event, reference, rule, approval):
    """Retain existing pure-cash sale-side fee and dispatcher T+5 policy."""
    from cm06_dated_action_contract_v1 import DatedAction
    from cm06_cash_merger_registry_v1 import CashMerger
    if type(event) is not DatedAction or event.kind != 'CASH_MERGER':
        raise ValueError('Separately admitted cash DatedAction required')
    if type(cash_event) is not CashMerger:
        raise ValueError('Explicit documented CashMerger required')
    if (rule.symbol, rule.permaticker) != (event.predecessor, event.predecessor_identity):
        raise ValueError('Dated rule does not match admitted permanent identity')
    validate_documented_event(event, rule, cash_event=cash_event)
    prior = runtime_reference(reference, rule, event.last_trade_date,
                              event.recognition_at, approval, reference_use='MANDATORY_CORPORATE_ACTION_VALUATION')
    return dict(identity_receipt_sha256=event.identity_receipt_sha256,
                predecessor_identity=event.predecessor_identity,
                cash_event=cash_event, prior_row=prior,
                _bound_event_fingerprint=event.fingerprint,
                _bound_reference_inputs=((reference, rule, approval),),
                reference_adapter_binding_sha256=digest(prior['cm06_exact_reference_audit']))


def documented_quote_rule(event_id, role):
    """Read a reviewed quote rule; this performs no event admission."""
    document = documented_rule_catalog()
    matches = [item for item in document['events'] if item['event_id'] == event_id]
    if len(matches) != 1 or role not in ('predecessor', 'successor'):
        raise ValueError('Exact documented event and quote role required')
    return QuoteRule(**matches[0][role + '_quote_rule'])


def validate_documented_event(event, old_rule, new_rule=None, *, terms=None, cash_event=None):
    """Known identities cannot evade reviewed bounds via a changed event ID.

    Unknown real events need a separately implemented/reviewed rule supplement.
    Synthetic-only event contracts may use synthetic quote rules in tests.
    """
    document = documented_rule_catalog()
    matches = [item for item in document['events']
               if item['predecessor'] == dict(symbol=event.predecessor,
                                              permaticker=event.predecessor_identity)
               and 'predecessor_quote_rule' in item]
    if not matches:
        matches = [item for item in supplemental_documented_rules()
                   if item['predecessor'] == dict(symbol=event.predecessor,
                                                  permaticker=event.predecessor_identity)]
    if not matches:
        if event.admission != 'SYNTHETIC_VALIDATED':
            raise ValueError('REVIEWED_DATED_QUOTE_RULE_SUPPLEMENT_REQUIRED')
        return
    if len(matches) != 1:
        raise ValueError('Ambiguous documented predecessor event')
    item = matches[0]
    if old_rule != QuoteRule(**item['predecessor_quote_rule']):
        raise ValueError('DOCUMENTED_PREDECESSOR_QUOTE_CUTOFF_CHANGED')
    if (event.legal_effective_date != item['legal_effective_date']
            or event.last_trade_date != item['last_trade_date']):
        raise ValueError('DOCUMENTED_LEGAL_AND_LAST_TRADE_DATES_CHANGED')
    if terms is not None:
        successor = item.get('successor')
        if (successor != dict(symbol=event.successor, permaticker=event.successor_identity)
                or new_rule != QuoteRule(**item['successor_quote_rule'])
                or Fraction(terms.share_ratio) != Fraction(item['share_ratio'])):
            raise ValueError('DOCUMENTED_SUCCESSOR_IDENTITY_OR_STOCK_TERMS_CHANGED')
        if (item.get('cash_per_raw_equivalent') is not None
                and Fraction(terms.cash_per_raw_equivalent) != Fraction(item['cash_per_raw_equivalent'])):
            raise ValueError('DOCUMENTED_LINEAR_CASH_TERMS_CHANGED')
    if cash_event is not None:
        if item.get('successor') is not None or Fraction(cash_event.cash_per_share) != Fraction(item['cash_per_raw_equivalent']):
            raise ValueError('DOCUMENTED_CASH_TERMS_CHANGED')


def documented_rule_catalog():
    path = Path(__file__).parent / 'DOCUMENTED_QUOTE_RULES.json'
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != QUOTE_RULE_CATALOG_SHA256:
        raise ValueError('DOCUMENTED_QUOTE_CATALOG_SOURCE_HASH_CHANGED')
    document = json.loads(raw)
    if document.get('rules_are_not_event_admissions') is not True or document.get('runtime_admissions') != 0:
        raise ValueError('Documented quote rules were changed into event admissions')
    root = Path(__file__).resolve().parents[3]
    for name, expected in document['source_bindings'].items():
        if hashlib.sha256((root / name).read_bytes()).hexdigest() != expected:
            raise ValueError('DOCUMENTED_QUOTE_CATALOG_UPSTREAM_SOURCE_CHANGED')
    return document


def validate_known_quote_rule(rule):
    document = documented_rule_catalog()
    known = [QuoteRule(**item[key]) for item in document['events'] + supplemental_documented_rules()
             for key in ('predecessor_quote_rule', 'successor_quote_rule') if key in item
             and (item[key]['symbol'], item[key]['permaticker']) == (rule.symbol, rule.permaticker)]
    if known and rule not in known:
        raise ValueError('DOCUMENTED_QUOTE_CUTOFF_OR_SOURCE_BINDING_CHANGED')


def supplemental_documented_rules():
    path = Path(__file__).parent / 'known_profile/KNOWN_EVENT_REFERENCE_RECIPES.json'
    if not path.exists():
        return []
    from cm06_known_action_profile_v1 import documented_profile_rules
    return documented_profile_rules()


def require_fresh_warmup(start_mode, prior_checkpoint=None):
    if start_mode != 'FRESH_SOURCE_BOUND_WARMUP' or prior_checkpoint is not None:
        raise ValueError('FRESH_WARMUP_REQUIRED: seq8 state predates IPXL/TIME corrections and uniform T+5')


def validate_context_binding(context, event=None, calendar=None):
    """Revalidate mutable handler input immediately before the dispatch plan."""
    if not isinstance(context, dict):
        raise ValueError('Exact-reference context required')
    bound = context.get('_bound_reference_inputs')
    if type(bound) is not tuple or not bound or any(type(x) is not tuple or len(x) != 3 for x in bound):
        raise ValueError('IMMUTABLE_REFERENCE_CONTEXT_INPUTS_REQUIRED')
    if 'terms' in context:
        selected = {'old': context.get('old_row'), 'new': context.get('new_row')}
    elif 'cash_event' in context:
        selected = {'prior': context.get('prior_row')}
    else:
        raise ValueError('Cash or linear context required')
    if len(bound) != len(selected):
        raise ValueError('BOUND_REFERENCE_CONTEXT_ARITY_CHANGED')
    if event is not None:
        if context.get('_bound_event_fingerprint') != event.fingerprint:
            raise ValueError('BOUND_REFERENCE_EVENT_CHANGED')
        if event.admission != 'SYNTHETIC_VALIDATED' and any(
                type(approval) is not SourceBoundComparisonAvailability for _, _, approval in bound):
            raise ValueError('REAL_EVENT_REQUIRES_SOURCE_BOUND_COMPARISON_REFERENCE')
        if 'terms' in context:
            validate_documented_event(event, bound[0][1], bound[1][1], terms=context['terms'])
            days = (context['terms'].last_trade_date, context['terms'].successor_reference_date)
        else:
            validate_documented_event(event, bound[0][1], cash_event=context['cash_event'])
            days = (event.last_trade_date,)
        for (label, row), (reference, rule, approval), day in zip(selected.items(), bound, days):
            if type(approval) is SourceBoundComparisonAvailability:
                if calendar is None or approval.calendar_sha256 != calendar.fingerprint:
                    raise ValueError('REFERENCE_AVAILABILITY_CALENDAR_DIFFERS_FROM_REGISTRY')
                if timestamp(approval.available_at) != timestamp(calendar.session(day).close_available_at):
                    raise ValueError('REFERENCE_AVAILABILITY_DIFFERS_FROM_REGISTRY_CLOSE')
            rebuilt = runtime_reference(reference, rule, day, event.recognition_at, approval,
                                        reference_use='MANDATORY_CORPORATE_ACTION_VALUATION')
            if canonical(row) != canonical(rebuilt):
                raise ValueError('REFERENCE_VALUES_OR_AUDIT_CHANGED_AFTER_BINDING')
    audits = {}
    for label, row in selected.items():
        if not isinstance(row, dict):
            raise ValueError('Bound reference row missing')
        audit = row.get('cm06_exact_reference_audit')
        if not isinstance(audit, dict) or audit.get('version') != VERSION:
            raise ValueError('Bound reference audit missing')
        plain = {k: v for k, v in row.items() if k != 'cm06_exact_reference_audit'}
        if digest(plain) != audit.get('handler_values_sha256'):
            raise ValueError('REFERENCE_VALUES_CHANGED_AFTER_BINDING')
        if fraction_record(exact_factor(plain)) != audit.get('factor'):
            raise ValueError('REFERENCE_EXACT_FACTOR_AUDIT_CHANGED')
        rule = QuoteRule(**audit['quote_rule'])
        validate_known_quote_rule(rule)
        if rule.failures(plain) or plain.get('source_observed') is not True:
            raise ValueError('REFERENCE_IDENTITY_OR_LEGAL_CUTOFF_FAILED')
        if audit.get('reference_use') == 'MARKET_EXECUTION':
            rational(plain.get('volume'), 'volume')
        audits[label] = deepcopy(audit)
    expected = digest(audits['prior']) if 'prior' in audits else digest(audits)
    if expected != context.get('reference_adapter_binding_sha256'):
        raise ValueError('REFERENCE_CONTEXT_BINDING_CHANGED')
    return dict(version=VERSION, reference_adapter_binding_sha256=expected, references=audits)


def plan_verified_open(replay, registry, session, *, contexts, pending_entitlements=frozenset()):
    """Isolated verified-input consumer; preserves the frozen atomic seam."""
    from dataclasses import replace
    from cm06_dated_action_dispatcher_v1 import plan_open, _state, _state_bytes
    copied = deepcopy(contexts)
    # Reference prerequisites apply only to the actual held action being
    # consumed. A candidate elsewhere in the universe is never a global gate.
    evidence = {}
    for event in registry.events:
        if (event.kind in ('CASH_MERGER', 'LINEAR_EXCHANGE')
                and event.recognition_session_date <= session['session_date']
                and ('U', event.predecessor) in replay.ledger.positions
                and replay.corporate_action_instrument_identities.identity(event.predecessor)
                    == event.predecessor_identity):
            evidence[event.event_id] = validate_context_binding(
                copied.get(event.event_id), event, registry.calendar)
    plan = plan_open(replay, registry, session, contexts=copied,
                     pending_entitlements=pending_entitlements)
    events = {event.event_id: event for event in registry.events}
    # A prior staged action can create a successor holding consumed by a later
    # action in this same OPEN. Validate those newly held actions too, while all
    # mutations are still confined to the disposable staged copy.
    for action in plan.actions:
        event = events[action['event_id']]
        if action['held'] and event.kind in ('CASH_MERGER', 'LINEAR_EXCHANGE'):
            evidence[event.event_id] = validate_context_binding(
                copied.get(event.event_id), event, registry.calendar)
    # Only staged receipts are extended. A failure never changes live state.
    for action in plan.actions:
        event_id = action['event_id']
        if action['held'] and event_id in evidence:
            receipts = [row for row in plan.staged.ledger.events
                        if row.get('id') == 'dated-action:' + event_id]
            if len(receipts) != 1:
                raise ValueError('Expected unique staged dated-action receipt')
            receipts[0]['exact_reference_adapter'] = evidence[event_id]
    after_hash = hashlib.sha256(_state_bytes(_state(plan.staged))).hexdigest()
    return replace(plan, after_sha256=after_hash)


def dispatch_verified_open(replay, registry, session, *, contexts, pending_entitlements=frozenset()):
    from cm06_dated_action_dispatcher_v1 import apply_open
    plan = plan_verified_open(replay, registry, session, contexts=contexts,
                              pending_entitlements=pending_entitlements)
    return apply_open(replay, registry, plan)
