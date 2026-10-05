"""Only the explicitly approved IPXL/SGY delayed stock-valuation bridge.

The non-tradable ledger asset retains the last verified predecessor mark and
basis. It is not cash, a broker share claim, or a future-price valuation. Exact
successor comparison units are recognized at the first legal observed close
under the unchanged source-bound close+15 research clock.
"""
from __future__ import annotations
from copy import copy, deepcopy
from dataclasses import asdict, dataclass
from decimal import localcontext
from fractions import Fraction
import hashlib

from cm06.accounting import ZERO, dec, utc
from cm06_dated_action_contract_v1 import DatedAction, StableInstrumentIdentityMap
from cm06_exact_units_accounting_v1 import (
    ExactComparisonEntitlementPosition, LIVE_UNIT_POLICY, exact_quantity,
    project_units, promote_ledger)
from cm06_fractional_signals_v1 import promote_us_adapter
from cm06_us_cash_t5_policy_v1 import USSessionCalendar
from cm06_verified_reference_adapter_v1 import (
    ExactReference, QuoteRule, SourceBoundComparisonAvailability,
    VerifiedEvidenceStore, bind_comparison_availability, canonical, digest,
    fraction_record, runtime_reference)

VERSION = 'CM06_IPXL_SGY_NONTRADABLE_STOCK_ENTITLEMENT_BRIDGE_V1'
APPROVAL_AT = '2026-10-05T03:17:13Z'
VALUATION_POLICY = 'LAST_VERIFIED_PREDECESSOR_MARK_UNTIL_FIRST_LEGAL_OBSERVED_SUCCESSOR_CLOSE'
BOUNDARY_POLICY = 'FIRST_US_OPEN_AFTER_DOCUMENTED_FINAL_TRADE_AND_LEGAL_CONVERSION'
# Deliberately not a general rights admission or a symbol-level exception.
APPROVED = (
    ('MASTER:M002132', 'IPXL', '197157', 'AMRX', '116533', '2018-05-04', '2018-05-04', '2018-05-07'),
    ('MASTER:M003572', 'SGY', '197630', 'TALO', '119276', '2018-05-10', '2018-05-09', '2018-05-10'),
)


def _identity(event):
    return (event.event_id, event.predecessor, event.predecessor_identity,
            event.successor, event.successor_identity, event.legal_effective_date,
            event.last_trade_date, event.payload.get('successor_reference_date'))


def _state_digest(value):
    from cm06_exact_units_resume_state_v1 import encode, canonical as state_canonical
    return hashlib.sha256(state_canonical(encode(value))).hexdigest()


@dataclass(frozen=True)
class BridgeSpec:
    event: DatedAction
    old_reference: ExactReference
    new_reference: ExactReference
    old_rule: QuoteRule
    new_rule: QuoteRule
    old_clock: SourceBoundComparisonAvailability
    new_clock: SourceBoundComparisonAvailability
    recipe_sha256: str

    def __post_init__(self):
        if type(self.event) is not DatedAction or _identity(self.event) not in APPROVED:
            raise ValueError('UNAPPROVED_STOCK_ENTITLEMENT_EVENT_IDENTITY')
        p = self.event.payload
        if (self.event.kind != 'LINEAR_EXCHANGE' or p.get('bridge_policy') != VERSION
                or p.get('bridge_approval_at') != APPROVAL_AT or p.get('share_ratio') != '1'
                or p.get('cash_per_raw_equivalent') != '0' or not self.event.terminal):
            raise ValueError('UNAPPROVED_STOCK_ENTITLEMENT_TERMS')
        for ref, rule, clock, symbol, identity, day in (
            (self.old_reference, self.old_rule, self.old_clock, self.event.predecessor,
             self.event.predecessor_identity, self.event.last_trade_date),
            (self.new_reference, self.new_rule, self.new_clock, self.event.successor,
             self.event.successor_identity, p['successor_reference_date'])):
            if (type(ref) is not ExactReference or type(rule) is not QuoteRule
                    or type(clock) is not SourceBoundComparisonAvailability
                    or (rule.symbol, rule.permaticker) != (symbol, identity)
                    or rule.failures(ref.values) or ref.values['session_date'] != day
                    or ref.values.get('source_observed') is not True
                    or clock.reference_binding_sha256 != ref.binding_sha256
                    or utc(clock.available_at) != utc(ref.values['available_at'])):
                raise ValueError('STOCK_ENTITLEMENT_BOUND_REFERENCE_MISMATCH')
        if (self.old_rule.last_legal_trade_date != self.event.last_trade_date
                or self.new_rule.first_legal_trade_date != p['successor_reference_date']
                or utc(self.old_clock.available_at) >= utc(self.event.recognition_at)
                or utc(self.new_clock.available_at) <= utc(self.event.recognition_at)):
            raise ValueError('STOCK_ENTITLEMENT_CAUSAL_BOUNDARY_MISMATCH')
        if self.event.predecessor == 'SGY' and p.get('legal_effective_time_qualifier') != 'BEFORE_MARKET_OPEN':
            raise ValueError('SGY_DOCUMENTED_PREOPEN_CONVERSION_REQUIRED')

    @property
    def pending_symbol(self):
        return '__NONTRADABLE_STOCK_ENTITLEMENT__:' + self.event.event_id

    @property
    def create_id(self): return 'stock-entitlement-create:' + self.event.event_id

    @property
    def resolve_id(self): return 'stock-entitlement-resolve:' + self.event.event_id

    @property
    def binding(self):
        return dict(event_sha256=self.event.fingerprint, recipe_sha256=self.recipe_sha256,
            old_reference_sha256=self.old_reference.binding_sha256,
            new_reference_sha256=self.new_reference.binding_sha256,
            old_clock=asdict(self.old_clock), new_clock=asdict(self.new_clock),
            old_rule=asdict(self.old_rule), new_rule=asdict(self.new_rule))

    def reference(self, which, at):
        old = which == 'old'
        ref, rule, clock = ((self.old_reference, self.old_rule, self.old_clock) if old
                           else (self.new_reference, self.new_rule, self.new_clock))
        return runtime_reference(ref, rule, ref.values['session_date'], utc(at).isoformat(),
            clock, reference_use='MANDATORY_CORPORATE_ACTION_VALUATION')


@dataclass(frozen=True)
class StockEntitlementBridge:
    specs: tuple[BridgeSpec, ...]
    coverages: tuple
    calendar: USSessionCalendar
    instrument_identity_sha256: str
    source_sha256: str
    recipes_sha256: str

    def __post_init__(self):
        if type(self.specs) is not tuple or any(type(s) is not BridgeSpec for s in self.specs):
            raise TypeError('Immutable approved bridge specs required')
        if len({s.event.event_id for s in self.specs}) != len(self.specs):
            raise ValueError('Duplicate bridge event')
        if type(self.calendar) is not USSessionCalendar or type(self.coverages) is not tuple:
            raise TypeError('Immutable calendar and candidate coverages required')
        for spec in self.specs:
            spec.event.validate_boundary(self.calendar)
            for ref, clock in ((spec.old_reference, spec.old_clock), (spec.new_reference, spec.new_clock)):
                if (clock.calendar_sha256 != self.calendar.fingerprint or
                    utc(clock.available_at) != utc(self.calendar.session(ref.values['session_date']).close_available_at)):
                    raise ValueError('BRIDGE_REFERENCE_CALENDAR_MISMATCH')

    @property
    def events(self): return tuple(s.event for s in self.specs)

    @property
    def binding(self):
        return dict(schema=VERSION, approval_at=APPROVAL_AT, valuation_policy=VALUATION_POLICY,
            calendar_sha256=self.calendar.fingerprint, source_sha256=self.source_sha256,
            instrument_identity_sha256=self.instrument_identity_sha256,
            recipes_sha256=self.recipes_sha256, specs=[s.binding for s in self.specs],
            coverages=[asdict(c) for c in self.coverages], creates_spendable_cash=False,
            recorded_vendor_arrival_verified=False, historical_point_in_time_certified=False)

    def nontradable_symbols(self, replay):
        return frozenset(symbol for spec in self.specs
            if replay.ledger.at >= utc(spec.event.recognition_at)
            for symbol in (spec.pending_symbol, spec.event.predecessor))

    def _validate(self, replay):
        identities = replay.corporate_action_instrument_identities
        if type(identities) is not StableInstrumentIdentityMap or identities.fingerprint != self.instrument_identity_sha256:
            raise ValueError('STOCK_ENTITLEMENT_INPUT_IDENTITY_CHANGED')
        allowed = {s.event.event_id: s for s in self.specs}
        if type(replay.bridge_pending) is not dict or set(replay.bridge_pending) - set(allowed):
            raise ValueError('UNAPPROVED_PENDING_STOCK_ENTITLEMENT')
        for event_id, item in replay.bridge_pending.items():
            spec = allowed[event_id]
            receipts = [r for r in replay.ledger.events if r.get('id') == spec.create_id]
            if (len(receipts) != 1 or spec.create_id not in replay.ledger.seen
                    or item.get('binding_sha256') != digest(spec.binding)
                    or item.get('capture_sha256') != _state_digest(item.get('capture'))
                    or receipts[0].get('capture_sha256') != item['capture_sha256']
                    or receipts[0].get('binding_sha256') != item['binding_sha256']):
                raise ValueError('PENDING_STOCK_ENTITLEMENT_EVIDENCE_CHANGED')
            status = item.get('status')
            key = ('U', spec.pending_symbol)
            if ('U', spec.event.predecessor) in replay.ledger.positions:
                raise ValueError('RETIRED_BRIDGE_PREDECESSOR_REAPPEARED')
            resolutions = [r for r in replay.ledger.events if r.get('id') == spec.resolve_id]
            resolved = spec.resolve_id in replay.ledger.seen
            if status == 'PENDING':
                p = replay.ledger.positions.get(key); cap = item['capture']
                if (resolved or resolutions or type(p) is not ExactComparisonEntitlementPosition
                        or exact_quantity(p) != cap['old_exact_units']
                        or p.cost_native != cap['cost_native'] or p.cost_krw != cap['cost_krw']
                        or replay.ledger.prices.get(key) != (cap['carry_price'], cap['carry_price_at'])):
                    raise ValueError('PENDING_STOCK_ENTITLEMENT_CARRY_CHANGED')
            elif status in ('RESOLVED', 'NO_HOLDING'):
                if key in replay.ledger.positions or (status == 'RESOLVED' and (not resolved or len(resolutions) != 1)):
                    raise ValueError('STOCK_ENTITLEMENT_RESOLUTION_STATE_CHANGED')
                if status == 'NO_HOLDING' and (resolved or resolutions or item['capture']['held']):
                    raise ValueError('UNHELD_STOCK_ENTITLEMENT_WAS_CREATED')
            else:
                raise ValueError('UNKNOWN_STOCK_ENTITLEMENT_STATUS')
        for spec in self.specs:
            if spec.event.event_id not in replay.bridge_pending and (
                    spec.create_id in replay.ledger.seen or spec.resolve_id in replay.ledger.seen
                    or ('U', spec.pending_symbol) in replay.ledger.positions):
                raise ValueError('STOCK_ENTITLEMENT_STATE_MISSING')

    @staticmethod
    def _stage(replay):
        staged = copy(replay); staged.__dict__ = dict(replay.__dict__)
        staged.ledger = deepcopy(replay.ledger)
        staged.adapters = dict(replay.adapters); staged.adapters['U'] = deepcopy(replay.adapters['U'])
        for name in ('bridge_pending', 'entry_meta', 'holding_spans'):
            setattr(staged, name, deepcopy(getattr(replay, name)))
        return staged

    @staticmethod
    def _publish(replay, staged):
        published = dict(replay.__dict__)
        for name in ('ledger', 'adapters', 'bridge_pending', 'entry_meta', 'holding_spans'):
            published[name] = getattr(staged, name)
        replay.__dict__ = published

    def create_open(self, replay, session):
        at = utc(session['open_at']); day = session['session_date']
        if replay.ledger.at != at or at != utc(self.calendar.session(day).open_at):
            raise ValueError('STOCK_ENTITLEMENT_REQUIRES_CURRENT_US_OPEN')
        self._validate(replay)
        due = [s for s in self.specs if at >= utc(s.event.recognition_at)]
        if not due:return ()
        live_intents = replay.adapters['U'].pending_intents()
        for spec in due:
            if spec.event.event_id in replay.bridge_pending and any(
                    i['symbol'] in (spec.event.predecessor, spec.pending_symbol) for i in live_intents):
                raise ValueError('NONTRADABLE_BRIDGE_INTENT_REAPPEARED')
        due = [s for s in due if s.event.event_id not in replay.bridge_pending and
               (('U', s.event.predecessor) in replay.ledger.positions or any(
                   i['symbol'] in (s.event.predecessor, s.pending_symbol) for i in live_intents))]
        if not due:return ()
        staged = self._stage(replay); actions = []; cancelled = []
        for spec in due:
            e = spec.event; key = ('U', e.predecessor)
            intents = [i for i in staged.adapters['U'].pending_intents()
                       if i['symbol'] in (e.predecessor, spec.pending_symbol)]
            if e.event_id in staged.bridge_pending:
                if intents:raise ValueError('NONTRADABLE_BRIDGE_INTENT_REAPPEARED')
                continue
            held = key in staged.ledger.positions
            if not held and not intents:
                continue
            if at != utc(e.recognition_at):
                raise ValueError('MISSED_STOCK_ENTITLEMENT_CREATION_BOUNDARY')
            if (staged.corporate_action_instrument_identities.identity(e.predecessor) != e.predecessor_identity
                    or staged.corporate_action_instrument_identities.identity(e.successor) != e.successor_identity):
                raise ValueError('APPROVED_BRIDGE_ISSUER_IDENTITY_CHANGED')
            for intent in intents:
                staged.adapters['U'].cancel(intent['signal_id']); cancelled.append(intent['signal_id'])
            cap = {'held': held}
            if held:
                old_row = spec.reference('old', at)
                old = staged.ledger.positions[key]
                price = dec(old_row['comparison_close']); price_at = utc(old_row['available_at'])
                if old.currency != 'USD' or staged.ledger.prices.get(key) != (price, price_at):
                    raise ValueError('BRIDGE_REQUIRES_LAST_VERIFIED_PREDECESSOR_MARK')
                staged.ledger = promote_ledger(staged.ledger)
                units = exact_quantity(old)
                cap.update(old_exact_units=units, old_raw_equivalents=units * spec.old_reference.factor,
                    cost_native=old.cost_native, cost_krw=old.cost_krw, sector=old.sector,
                    carry_price=price, carry_price_at=price_at,
                    prior_entry_meta=deepcopy(staged.entry_meta.get(key, {})),
                    old_reference_audit=old_row['cm06_exact_reference_audit'])
            capture_sha = _state_digest(cap)
            staged.bridge_pending[e.event_id] = dict(status='PENDING' if held else 'NO_HOLDING',
                binding_sha256=digest(spec.binding), capture_sha256=capture_sha, capture=cap)
            staged.ledger.unique(spec.create_id)
            if held:
                units, audit = project_units(cap['old_exact_units'], price, staged.ledger.rate('USD'))
                staged.ledger.positions[('U', spec.pending_symbol)] = ExactComparisonEntitlementPosition(
                    'U', spec.pending_symbol, 'USD', units, old.cost_native, old.cost_krw, old.sector,
                    spec.create_id, {'unit_policy': LIVE_UNIT_POLICY, 'bridge_policy': VERSION,
                    'nontradable': True, 'event_id': e.event_id, 'capture_sha256': capture_sha},
                    cap['old_exact_units'], audit)
                staged.ledger.prices[('U', spec.pending_symbol)] = (price, price_at)
                del staged.ledger.positions[key]; staged.ledger.prices.pop(key)
                meta = staged.entry_meta.pop(key, {})
                entry = meta.get('entry_date', e.legal_effective_date)
                staged.holding_spans.append(dict(engine='U', symbol=e.predecessor,
                    entry_date=entry, exit_date=e.legal_effective_date))
                staged.adapters['U'].record_holding_span(e.predecessor, entry, e.legal_effective_date)
                staged.adapters['U'] = promote_us_adapter(staged.adapters['U'])
            staged.ledger.record('STOCK_ENTITLEMENT_CREATE', id=spec.create_id,
                event_id=e.event_id, event_fingerprint=e.fingerprint, held=held,
                predecessor=e.predecessor, successor=e.successor, pending_symbol=spec.pending_symbol if held else None,
                binding_sha256=digest(spec.binding), capture_sha256=capture_sha,
                legal_effective_date=e.legal_effective_date, recognition_at=e.recognition_at,
                legal_effective_time_qualifier=e.payload.get('legal_effective_time_qualifier'),
                valuation_policy=VALUATION_POLICY, approval_at=APPROVAL_AT,
                carried_value_native=(cap['old_exact_units'] * Fraction(cap['carry_price']) if held else Fraction(0)),
                old_reference_audit=cap.get('old_reference_audit'),
                cancelled_predecessor_intents=tuple(i['signal_id'] for i in intents),
                source_url=e.source_url, source_sha256=e.source_sha256,
                market_trade=False, fee=ZERO, cash_created=ZERO,
                successor_price_used=False, historical_point_in_time_certified=False)
            actions.append(e.event_id)
        if actions or cancelled:
            staged._reserve_pending_cash('U')
            staged.ledger.assert_invariants(); self._validate(staged)
            self._publish(replay, staged)
        return tuple(actions)

    def resolve_close(self, replay, session):
        at = utc(session['close_available_at']); day = session['session_date']
        if replay.ledger.at != at or at != utc(self.calendar.session(day).close_available_at):
            raise ValueError('STOCK_ENTITLEMENT_REQUIRES_CURRENT_AVAILABLE_US_CLOSE')
        self._validate(replay)
        due = [s for s in self.specs if replay.bridge_pending.get(s.event.event_id, {}).get('status') == 'PENDING'
               and at >= utc(s.new_clock.available_at)]
        if not due:return ()
        staged = self._stage(replay); actions = []
        for spec in due:
            if at != utc(spec.new_clock.available_at):
                raise ValueError('MISSED_STOCK_ENTITLEMENT_FIRST_AVAILABLE_CLOSE')
            e = spec.event; item = staged.bridge_pending[e.event_id]; cap = item['capture']
            new_row = spec.reference('new', at)
            new_key = ('U', e.successor); pending_key = ('U', spec.pending_symbol)
            successor = staged.ledger.positions.get(new_key)
            if successor and successor.currency != 'USD':raise ValueError('Successor currency mismatch')
            price, price_at = dec(new_row['comparison_close']), utc(new_row['available_at'])
            if new_key in staged.ledger.prices and staged.ledger.prices[new_key][1] > price_at:
                raise ValueError('Newer successor mark cannot be overwritten')
            incoming = cap['old_raw_equivalents'] / spec.new_reference.factor
            combined = incoming + (exact_quantity(successor) if successor else Fraction(0))
            quantity, audit = project_units(combined, price, staged.ledger.rate('USD'))
            with localcontext() as context:
                context.prec = 36
                native = cap['cost_native'] + (successor.cost_native if successor else ZERO)
                krw = cap['cost_krw'] + (successor.cost_krw if successor else ZERO)
            staged.ledger.unique(spec.resolve_id)
            staged.ledger.positions[new_key] = ExactComparisonEntitlementPosition(
                'U', e.successor, 'USD', quantity, native, krw,
                successor.sector if successor else new_row.get('sector', cap['sector']),
                spec.resolve_id, {'unit_policy': LIVE_UNIT_POLICY, 'bridge_policy': VERSION,
                    'event_id': e.event_id, 'capture_sha256': item['capture_sha256'],
                    'incoming_exact_units': fraction_record(incoming),
                    'raw_equivalents_not_physical_broker_shares': True,
                    'actual_fractional_settlement_reproduced': False}, combined, audit)
            staged.ledger.prices[new_key] = (price, price_at)
            del staged.ledger.positions[pending_key]; staged.ledger.prices.pop(pending_key)
            staged.entry_meta.setdefault(new_key, dict(entry_date=e.legal_effective_date,
                valid_bar_count=0, market='US'))
            staged.adapters['U'] = promote_us_adapter(staged.adapters['U'])
            item['status'] = 'RESOLVED'
            staged.ledger.record('STOCK_ENTITLEMENT_RESOLVE', id=spec.resolve_id,
                event_id=e.event_id, event_fingerprint=e.fingerprint,
                predecessor=e.predecessor, successor=e.successor,
                binding_sha256=digest(spec.binding), capture_sha256=item['capture_sha256'],
                successor_exact_units=fraction_record(incoming), merged_exact_units=fraction_record(combined),
                predecessor_raw_equivalents=fraction_record(cap['old_raw_equivalents']), share_ratio='1',
                prior_carried_value_native=fraction_record(cap['old_exact_units'] * Fraction(cap['carry_price'])),
                successor_comparison_price=price, successor_available_at=price_at.isoformat(),
                successor_reference_audit=new_row['cm06_exact_reference_audit'],
                carried_basis_native=cap['cost_native'], carried_basis_krw=cap['cost_krw'],
                market_trade=False, fee=ZERO, cash_created=ZERO, ordinary_positive_volume_guard_unchanged=True,
                source_url=e.source_url, approval_at=APPROVAL_AT, valuation_policy=VALUATION_POLICY,
                historical_point_in_time_certified=False)
            actions.append(e.event_id)
        staged.ledger.assert_invariants(); self._validate(staged)
        self._publish(replay, staged)
        return tuple(actions)


def build_stock_entitlement_bridge(*, calendar, instrument_identities, candidate_records,
                                  hazards, evidence_parts, evidence_receipt, source_sha256):
    """Build only the two named, newly approved bridge events from pinned recipes."""
    from cm06_known_action_profile_v1 import recipe_document, RECIPES_SHA256
    from cm06_fresh_host_v1 import CandidateCoverage, validate_coverages
    from cm06_dated_action_contract_v1 import ActionRegistry
    if type(calendar) is not USSessionCalendar or type(instrument_identities) is not StableInstrumentIdentityMap:
        raise ValueError('Verified source calendar and instrument identities required')
    document = recipe_document(); recipes = document['blocked_recipes']
    if {r['event_id'] for r in recipes} != {r[0] for r in APPROVED} or len(recipes) != 2:
        raise ValueError('APPROVED_TWO_EVENT_BRIDGE_RECIPE_SCOPE_CHANGED')
    store = VerifiedEvidenceStore(evidence_parts, evidence_receipt)
    if store.receipt_sha256 != document['evidence_receipt_sha256']:
        raise ValueError('BRIDGE_EXTRACTION_RECEIPT_CHANGED')
    candidate_by_id = {r['event_id']:r for r in candidate_records}
    hazard_by_id = {h.event_id:h for h in hazards}
    if len(candidate_by_id) != len(candidate_records) or len(hazard_by_id) != len(hazards):
        raise ValueError('Duplicate bridge candidate or hazard')
    specs = []; coverages = []
    for recipe in recipes:
        old_info, new_info = recipe['predecessor'], recipe['successor']
        symbol, pid = old_info['symbol'], old_info['permaticker']
        try: actual = instrument_identities.identity(symbol)
        except ValueError: continue
        if actual != pid or instrument_identities.identity(new_info['symbol']) != new_info['permaticker']:
            raise ValueError('BRIDGE_RESTORED_INPUT_ISSUER_IDENTITY_CHANGED')
        boundary = calendar.after(recipe['last_trade_date'], 1)
        future = recipe['first_legal_successor_close_not_available_at_same_day_open']
        if len(future) != 1:raise ValueError('Unique documented first legal successor close required')
        old = store.load(recipe['old_locator']); new = store.load(future[0]['locator'])
        old_clock = bind_comparison_availability(old, store, calendar)
        new_clock = bind_comparison_availability(new, store, calendar)
        proof = digest(dict(recipe=recipe, approval_at=APPROVAL_AT, policy=VERSION,
            calendar_sha256=calendar.fingerprint, identities_sha256=instrument_identities.fingerprint,
            source_sha256=source_sha256, evidence_receipt_sha256=store.receipt_sha256))
        payload = dict(bridge_policy=VERSION, bridge_approval_at=APPROVAL_AT,
            share_ratio=recipe['share_ratio'], cash_per_raw_equivalent=recipe['cash_per_raw_equivalent'],
            successor_reference_date=new.values['session_date'], valuation_policy=VALUATION_POLICY,
            legal_effective_time_qualifier=recipe.get('legal_effective_time_qualifier'),
            historical_point_in_time_certified=False, recorded_notice_arrival_verified=False)
        event = DatedAction(recipe['event_id'], 'LINEAR_EXCHANGE', symbol, pid,
            recipe['legal_effective_date'], boundary.session_date, boundary.open_at,
            BOUNDARY_POLICY, boundary.open_at, recipe['source_url'], proof,
            instrument_identities.receipt_sha256, 'RUNTIME_PREFLIGHT_APPROVED',
            last_trade_date=recipe['last_trade_date'], successor=new_info['symbol'],
            successor_identity=new_info['permaticker'], payload_json=canonical(payload))
        spec = BridgeSpec(event, old, new, QuoteRule(**recipe['predecessor_quote_rule']),
            QuoteRule(**recipe['successor_quote_rule']), old_clock, new_clock, digest(recipe))
        covered = []
        for candidate in recipe['covered_candidate_records']:
            cid = candidate['event_id']; actual = candidate_by_id.get(cid)
            if actual is None or digest(actual) != candidate['canonical_record_sha256']:
                raise ValueError('BRIDGE_CANDIDATE_COVERAGE_SOURCE_CHANGED: ' + cid)
            covered.append(cid)
        ids = set(covered) | {'QUOTE_CUTOFF:' + event.event_id} | {'QUOTE_CUTOFF:' + cid for cid in covered}
        for cid in sorted(ids):
            hazard = hazard_by_id.get(cid)
            if hazard is None: continue
            coverages.append(CandidateCoverage(event.event_id, cid, hazard.source_record_sha256, pid,
                hazard.boundary_date, event.recognition_at, proof,
                proof if hazard.boundary_date != event.recognition_session_date else None))
        specs.append(spec)
    bridge = StockEntitlementBridge(tuple(specs), tuple(coverages), calendar,
        instrument_identities.fingerprint, source_sha256, RECIPES_SHA256)
    validate_coverages(ActionRegistry.bind((), calendar, source_sha256), hazards, bridge.coverages, bridge.events)
    return bridge
