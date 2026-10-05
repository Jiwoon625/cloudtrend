"""Standard-library-only canonical US merger cash T+5 comparison policy.

The legal anchor is an explicit ISO civil date, never a guessed UTC date.
Only supplied, source-bound US equity sessions count, strictly after that date.
"""
from bisect import bisect_right
from dataclasses import asdict, dataclass
from datetime import date, datetime, timezone
import hashlib
import json

POLICY_ID = 'CM06_COMPARISON_T5_EXACT_PROPORTIONAL_20261005_V1'
PAYMENT_POLICY = 'USER_APPROVED_UNIFORM_US_T_PLUS_5_AFTER_LEGAL_EFFECTIVE_COMPARISON_ASSUMPTION'


def utc(value):
    ts = datetime.fromisoformat(value.replace('Z', '+00:00')) if isinstance(value, str) else value
    if not isinstance(ts, datetime) or ts.tzinfo is None:
        raise ValueError('Explicit timezone-aware session timestamp required')
    return ts.astimezone(timezone.utc)


def sha256(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                   ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def valid_date(value, name):
    if type(value) is not str or date.fromisoformat(value).isoformat() != value:
        raise ValueError(name + ': explicit ISO civil date required')
    return value


@dataclass(frozen=True)
class USSession:
    session_date: str
    open_at: str
    close_available_at: str


@dataclass(frozen=True, init=False)
class USSessionCalendar:
    """Use only supplied, verified US sessions, including declared holidays.

    Never generates sessions from weekdays or borrows another market calendar.
    The caller binds the calendar's provenance with its fresh trial sources.
    """
    sessions: tuple[USSession, ...]
    calendar_id: str

    def __init__(self, sessions, *, calendar_id='US'):
        if calendar_id not in ('US', 'XNYS', 'XNAS', 'US_EQUITIES'):
            raise ValueError('Explicit US equity calendar required; never K/E calendar')
        rows = []
        for s in sessions:
            row = s if type(s) is USSession else USSession(
                s['session_date'], s['open_at'], s['close_available_at'])
            valid_date(row.session_date, 'session_date')
            opened, closed = utc(row.open_at), utc(row.close_available_at)
            if opened >= closed or opened.date().isoformat() != row.session_date:
                raise ValueError('Invalid explicit US session boundary')
            if date.fromisoformat(row.session_date).weekday() >= 5:
                raise ValueError('Weekend is not a US equity session')
            if rows and (row.session_date <= rows[-1].session_date or opened <= utc(rows[-1].close_available_at)):
                raise ValueError('US calendar must be complete, ordered and unique')
            rows.append(row)
        if not rows:
            raise ValueError('Empty US calendar')
        object.__setattr__(self, 'sessions', tuple(rows))
        object.__setattr__(self, 'calendar_id', calendar_id)

    @property
    def fingerprint(self):
        return sha256({'calendar_id': self.calendar_id, 'sessions': [asdict(s) for s in self.sessions]})

    def session(self, day):
        valid_date(day, 'session_date')
        for s in self.sessions:
            if s.session_date == day:
                return s
        raise ValueError('Documented boundary absent from US calendar: ' + day)

    def after(self, day, count):
        valid_date(day, 'legal_effective_date')
        if type(count) is not int or count < 1:
            raise ValueError('Positive integer US session count required')
        if not self.sessions[0].session_date <= day <= self.sessions[-1].session_date:
            raise ValueError('Legal date outside verified US calendar coverage')
        idx = bisect_right([s.session_date for s in self.sessions], day) + count - 1
        if idx >= len(self.sessions):
            raise ValueError('US calendar does not cover required subsequent sessions')
        return self.sessions[idx]

    def t_plus_five(self, legal_effective_date):
        return utc(self.after(legal_effective_date, 5).open_at)


def us_t_plus_five(sessions, legal_effective_date, *, calendar_id='US'):
    calendar = sessions if type(sessions) is USSessionCalendar else USSessionCalendar(sessions, calendar_id=calendar_id)
    if calendar_id not in ('US', 'XNYS', 'XNAS', 'US_EQUITIES'):
        raise ValueError('Explicit US equity calendar required')
    return calendar.t_plus_five(legal_effective_date)


