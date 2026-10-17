# Actual nonpurchase decisions

Dashboard entry candidates offer **미매수 처리**. Reasons are 독립성 제한, 자금 부족,
판단 보류 and 기타. Independence defaults to **해제 전까지**, keyed by market and
symbol; future signals are projected as nonpurchase until explicitly released.
Other reasons default to **이번 원신호만**, keyed by the original signal date, so
morning/evening refresh and next-session confirmation do not reset a decision.

Actual Portfolio → **미매수·제한 관리** lists active decisions and append-only change
history. A release permits current/future entry consideration again; it does not
invent a signal, replay screening, cancel a broker order, or record a trade.
Existing actual reservation records require separate explicit cancellation.

## Boundaries

- `actual_entry_decisions` is a new owner-private document table; one row per owner.
- Authenticated, nonanonymous owners can select and append. No anonymous access,
  delete privilege, service-role path, or other owner's access.
- The SQL trigger preserves the event prefix and requires revision + 1. The server
  uses a revision predicate and stable request UUID for optimistic concurrency and
  lost-response retries, followed by a readback.
- Dashboard applies decisions after stored signal projection and before actual
  candidate budget previews. Raw strategy conditions remain available. Restricted
  candidates move to **미매수**, with no double count in the combined inbox.
- Screeners and instrument detail views apply actual-only presentation overrides.
- A failed decision read suppresses actual entry readiness, not actual holding exits.
- No fill, cash, holding, P&L, existing reservation, canonical ledger, source screening,
  or Shadow state is written. Shadow runtime manifests remain unchanged.
- Actual recorded fills remain factual records; this feature does not prohibit
  correcting/recording a fill that occurred despite a restriction.

## Verification

`npx vitest run --config vitest.dashboard.config.ts` includes domain, authenticated
API, UI submission and disposable PGlite RLS/concurrency tests. New-actual and UI
regression suites plus production build verify accounting and Shadow isolation.
Production verification uses read-only empty-table checks and opening/canceling the
new form. No synthetic decisions are saved to a real user's account.
