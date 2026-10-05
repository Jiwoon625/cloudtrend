"""Immutable, explicitly admitted event boundary contracts; no registry auto-load.

Dates describe legal facts. Recognition timestamps describe a separately proven
OPEN boundary. Date-only legal evidence is never turned into an invented time.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import date, datetime
from zoneinfo import ZoneInfo
import hashlib
import json
import re

from cm06_us_cash_t5_policy_v1 import (USSession, USSessionCalendar, us_t_plus_five,
                                          utc, PAYMENT_POLICY, POLICY_ID)

VERSION = 'CM06_DATED_ACTION_DISPATCHER_20261005_V1'
MODEL_CONTRACT_ID = 'CM06_APPROVED_COMPARISON_20261005_V1'
QUANTITY_POLICY = 'EXACT_PRO_RATA_COMPARISON_EXPOSURE_V1'
APPROVAL_AT = '2026-10-05T00:41:46Z'
ADMITTED = ('SYNTHETIC_VALIDATED', 'RUNTIME_PREFLIGHT_APPROVED')
KINDS = ('CASH_MERGER', 'LINEAR_EXCHANGE', 'ZERO_RECOVERY', 'UNRESOLVED_RIGHT')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False,
                      allow_nan=False).encode()


def sha256(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def require_sha(value, name):
    if not isinstance(value, str) or not re.fullmatch('[0-9a-f]{64}', value):
        raise ValueError(name + ': explicit SHA-256 receipt required')


def valid_date(value, name):
    if not isinstance(value, str) or date.fromisoformat(value).isoformat() != value:
        raise ValueError(name + ': ISO date required')
    return value


@dataclass(frozen=True)
class StableInstrumentIdentityMap:
    """Pinned input preflight: exactly one permaticker per symbol for this trial.

    The old ledger has symbol-only keys. Dated/ticker-changing histories require
    a separate identity-aware ledger migration, not an assertion of this gate.
    """
    entries: tuple[tuple[str, str], ...]
    input_sha256: str
    receipt_sha256: str
    verified_stable_per_symbol: bool

    def __post_init__(self):
        require_sha(self.input_sha256, 'Input identity map')
        require_sha(self.receipt_sha256, 'Stable-per-symbol preflight')
        if self.verified_stable_per_symbol is not True or type(self.entries) is not tuple:
            raise ValueError('Verified stable-per-symbol input invariant required')
        if any(type(k) is not tuple or len(k) != 2 or not all(type(v) is str and v for v in k) for k in self.entries):
            raise ValueError('Immutable symbol/permaticker pairs required')
        if len({s for s,p in self.entries}) != len(self.entries):
            raise ValueError('Ticker-changing source needs explicit identity-aware ledger migration')

    @property
    def fingerprint(self):
        return sha256(asdict(self))

    def identity(self, symbol):
        for name, identity in self.entries:
            if name == symbol:
                return identity
        raise ValueError('PINNED_INPUT_IDENTITY_MISSING: ' + symbol)


@dataclass(frozen=True)
class DatedAction:
    event_id: str
    kind: str
    predecessor: str
    predecessor_identity: str
    legal_effective_date: str
    recognition_session_date: str
    recognition_at: str
    boundary_evidence: str
    source_available_at: str
    source_url: str
    source_sha256: str
    identity_receipt_sha256: str
    admission: str
    last_trade_date: str | None = None
    successor: str | None = None
    successor_identity: str | None = None
    legal_effective_at: str | None = None
    legal_effective_timezone: str | None = None
    terminal: bool = True
    payload_json: bytes = b'{}'
    model_contract_id: str = MODEL_CONTRACT_ID
    policy_id: str = POLICY_ID

    def __post_init__(self):
        for name in ('event_id', 'predecessor', 'predecessor_identity', 'boundary_evidence', 'source_url'):
            if not isinstance(getattr(self, name), str) or not getattr(self, name).strip():
                raise ValueError(name + ': explicit nonempty value required')
        if self.kind not in KINDS or self.admission not in ADMITTED:
            raise ValueError('Candidate/provider record is not an admitted runtime event')
        if (self.model_contract_id, self.policy_id) != (MODEL_CONTRACT_ID, POLICY_ID):
            raise ValueError('Unapproved comparison policy')
        require_sha(self.source_sha256, 'Source')
        require_sha(self.identity_receipt_sha256, 'Identity')
        valid_date(self.legal_effective_date, 'legal_effective_date')
        valid_date(self.recognition_session_date, 'recognition_session_date')
        at = utc(self.recognition_at)
        if at.date().isoformat() != self.recognition_session_date or self.recognition_session_date < self.legal_effective_date:
            raise ValueError('Recognition precedes legal date or mismatches session')
        if utc(self.source_available_at) > at:
            raise ValueError('Corporate-action evidence unavailable at recognition')
        if self.legal_effective_at is not None:
            legal = utc(self.legal_effective_at)
            if not self.legal_effective_timezone:
                raise ValueError('Exact legal time requires explicitly declared civil timezone')
            if legal.astimezone(ZoneInfo(self.legal_effective_timezone)).date().isoformat() != self.legal_effective_date or legal > at:
                raise ValueError('Explicit legal time does not precede recognition')
        if self.last_trade_date is not None:
            valid_date(self.last_trade_date, 'last_trade_date')
            if self.recognition_session_date <= self.last_trade_date:
                raise ValueError('OPEN recognition must follow final trading session')
        if self.kind in ('CASH_MERGER', 'LINEAR_EXCHANGE') and self.last_trade_date is None:
            raise ValueError('Merger requires documented final trading date')
        if self.kind == 'LINEAR_EXCHANGE' and (not self.successor or not self.successor_identity or self.successor == self.predecessor):
            raise ValueError('Distinct verified successor identity required')
        if type(self.terminal) is not bool or type(self.payload_json) is not bytes:
            raise ValueError('Immutable canonical event payload required')
        payload = json.loads(self.payload_json)
        if type(payload) is not dict or canonical(payload) != self.payload_json:
            raise ValueError('Immutable canonical object payload required')

    @property
    def payload(self):
        return json.loads(self.payload_json)

    @property
    def fingerprint(self):
        value = asdict(self)
        value['payload_json'] = self.payload_json.decode()
        return sha256(value)

    @property
    def receipt_id(self):
        return 'dated-action:' + self.event_id

    def validate_boundary(self, calendar):
        s = calendar.session(self.recognition_session_date)
        if utc(s.open_at) != utc(self.recognition_at):
            raise ValueError('Recognition must match explicit US OPEN boundary')
        if self.last_trade_date is not None:
            calendar.session(self.last_trade_date)
            first = calendar.after(self.last_trade_date, 1)
            if first.session_date != self.recognition_session_date:
                raise ValueError('First unavailable US OPEN must be explicitly recognized')
        if not calendar.sessions[0].session_date <= self.legal_effective_date <= calendar.sessions[-1].session_date:
            raise ValueError('Legal date outside verified US calendar coverage')


@dataclass(frozen=True)
class ActionRegistry:
    events: tuple[DatedAction, ...]
    calendar: USSessionCalendar
    source_bundle_sha256: str
    new_trial_id: str
    policy_id: str = POLICY_ID

    def __post_init__(self):
        if type(self.events) is not tuple or any(type(e) is not DatedAction for e in self.events):
            raise ValueError('Explicit immutable admitted event tuple required')
        if type(self.calendar) is not USSessionCalendar or self.policy_id != POLICY_ID:
            raise ValueError('Explicit US calendar and approved policy required')
        require_sha(self.source_bundle_sha256, 'Fresh source bundle')
        if not self.new_trial_id or self.binding_sha256[:16] not in self.new_trial_id:
            raise ValueError('Fresh trial ID must include source/policy/registry binding prefix')
        if len({e.event_id for e in self.events}) != len(self.events):
            raise ValueError('Duplicate event identity')
        terminal = [(e.predecessor_identity, e.recognition_at) for e in self.events if e.terminal]
        if len(terminal) != len(set(terminal)):
            raise ValueError('Conflicting terminal event identities')
        for event in self.events:
            event.validate_boundary(self.calendar)

    @property
    def binding_sha256(self):
        return sha256({'version': VERSION, 'policy_id': self.policy_id,
                       'source_bundle_sha256': self.source_bundle_sha256,
                       'calendar_sha256': self.calendar.fingerprint,
                       'events': [e.fingerprint for e in self.events]})

    @classmethod
    def bind(cls, events, calendar, source_bundle_sha256, *, trial_prefix='cm06-ca-20261005'):
        # Use the same complete payload as binding_sha256 before construction.
        receipt = sha256({'version': VERSION, 'policy_id': POLICY_ID,
                         'source_bundle_sha256': source_bundle_sha256,
                         'calendar_sha256': calendar.fingerprint,
                         'events': [e.fingerprint for e in events]})
        return cls(tuple(events), calendar, source_bundle_sha256, trial_prefix + ':' + receipt[:16])

    def inactive_symbols(self, day):
        """Only admitted terminal events, never unknown-right hindsight bans."""
        valid_date(day, 'panel_date')
        return {e.predecessor for e in self.events if e.terminal and e.kind != 'UNRESOLVED_RIGHT'
                and day >= e.recognition_session_date}
