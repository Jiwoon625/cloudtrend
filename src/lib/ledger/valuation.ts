import { decimal, format, multiply } from "./decimal";
import { currentEvents, validDate, validateSecurity, validateSource } from "./validation";
import type { Currency, FxMark, LedgerEvent, OpeningBalance, PriceMark, Security } from "./types";
export interface AccountValuation {
  accountId: string;
  currency: Currency;
  cash: string | null;
  knownCashDelta: string;
  unsettledCash: string | null;
  positions: {
    securityId: string;
    quantity: string | null;
    knownQuantityDelta: string;
    costBasis: string | null;
    marketValue: string | null;
    priceDate: string | null;
  }[];
  equity: string | null;
  issues: string[];
}
/** Unknown openings, taxes, marks, FX or settlement stay unknown. No fabricated zero NAV. */
export function valueBook(input: {
  book: "ACTUAL" | "MODEL";
  bookId: string;
  asOfDate: string;
  events: LedgerEvent[];
  openings: OpeningBalance[];
  securities: Security[];
  marks: PriceMark[];
  fx: FxMark[];
  baseCurrency: Currency;
  /** Omit for an explicitly restated valuation. Historical frozen outputs must pass knowledge time. */
  knownAt?: string;
}) {
  if (!validDate(input.asOfDate)) throw new Error("Invalid valuation date");
  if (input.knownAt && !Number.isFinite(Date.parse(input.knownAt)))
    throw new Error("Invalid knowledge cutoff");
  const knownByCutoff = (at?: string) =>
    !input.knownAt ||
    (!!at && Number.isFinite(Date.parse(at)) && Date.parse(at) <= Date.parse(input.knownAt));
  const events = currentEvents(input.events.filter((e) => knownByCutoff(e.recordedAt))).filter(
    (e) => e.book === input.book && e.bookId === input.bookId && e.effectiveDate <= input.asOfDate,
  );
  const openings = input.openings.filter(
    (o) =>
      knownByCutoff(o.recordedAt) &&
      o.book === input.book &&
      o.bookId === input.bookId &&
      o.date <= input.asOfDate,
  );
  input.securities.forEach(validateSecurity);
  if (new Set(input.securities.map((s) => s.id)).size !== input.securities.length)
    throw new Error("Duplicate security registry identity");
  const securities = new Map(input.securities.map((s) => [s.id, s]));
  type Account = {
    accountId: string;
    currency: Currency;
    cash: bigint;
    delta: bigint;
    pending: bigint;
    knownCash: boolean;
    knownPending: boolean;
    opening: OpeningBalance | null;
    positions: Map<string, { quantity: bigint; basis: bigint | null }>;
    issues: Set<string>;
  };
  const accounts = new Map<string, Account>();
  const account = (id: string, currency: Currency) => {
    const key = `${id}:${currency}`;
    if (!accounts.has(key))
      accounts.set(key, {
        accountId: id,
        currency,
        cash: 0n,
        delta: 0n,
        pending: 0n,
        knownCash: false,
        knownPending: true,
        opening: null,
        positions: new Map(),
        issues: new Set(["opening_balance_unknown"]),
      });
    return accounts.get(key)!;
  };
  for (const o of openings) {
    validateSource(o.source);
    if (!validDate(o.date) || !o.accountId || decimal(o.cash) < 0n)
      throw new Error("Invalid opening balance");
    const a = account(o.accountId, o.currency);
    if (a.opening) throw new Error("Select one audited opening per account/currency");
    a.opening = o;
    a.cash = decimal(o.cash);
    a.knownCash = o.complete;
    if (o.complete) a.issues.delete("opening_balance_unknown");
    for (const p of o.positions) {
      const security = securities.get(p.securityId);
      if (
        !security ||
        security.currency !== o.currency ||
        a.positions.has(p.securityId) ||
        decimal(p.quantity) < 0n ||
        (p.costBasis !== null && decimal(p.costBasis) < 0n)
      )
        throw new Error("Invalid opening security/currency");
      a.positions.set(p.securityId, {
        quantity: decimal(p.quantity),
        basis: p.costBasis === null ? null : decimal(p.costBasis),
      });
    }
  }
  for (const e of events) {
    if (["BUY", "SELL"].includes(e.kind) && securities.get(e.securityId!)?.currency !== e.currency)
      throw new Error("Fill currency disagrees with listing security");
    for (const l of e.cashLegs) {
      const a = account(l.accountId, l.currency);
      if (
        a.opening &&
        e.effectiveDate < a.opening.date &&
        e.settlementDate !== null &&
        e.settlementDate < a.opening.date
      )
        continue;
      e.issues.forEach((issue) => a.issues.add(issue));
      if (l.amount === null) {
        a.knownCash = false;
        a.knownPending = false;
        a.issues.add("cash_movement_unknown");
        continue;
      }
      const amount = decimal(l.amount);
      a.delta += amount;
      if (e.settlementDate === null) {
        a.knownCash = false;
        a.knownPending = false;
        a.issues.add("settlement_date_unknown");
      } else if (e.settlementDate > input.asOfDate) a.pending += amount;
      else a.cash += amount;
    }
    for (const l of e.positionLegs) {
      const security = securities.get(l.securityId);
      if (!security) throw new Error("Missing security registry mapping");
      const a = account(l.accountId, security.currency);
      if (a.opening && e.effectiveDate < a.opening.date) continue;
      const p = a.positions.get(l.securityId) ?? {
        quantity: 0n,
        basis: a.opening?.complete ? 0n : null,
      };
      const delta = decimal(l.quantity),
        oldQuantity = p.quantity;
      if (!a.opening?.complete) {
        a.issues.add("position_opening_unknown");
        p.basis = null;
      }
      if (e.kind === "BUY") {
        if (p.basis !== null && e.gross !== null && e.fee !== null && e.tax !== null)
          p.basis += decimal(e.gross) + decimal(e.fee) + decimal(e.tax);
        else p.basis = null;
      } else if (e.kind === "SELL") {
        if (oldQuantity <= 0n || oldQuantity + delta < 0n) {
          a.issues.add("unreconciled_short_position");
          p.basis = null;
        } else if (p.basis !== null) p.basis -= (p.basis * -delta) / oldQuantity;
      } else if (l.basisAdjustment !== null && p.basis !== null)
        p.basis += decimal(l.basisAdjustment);
      else {
        p.basis = null;
        a.issues.add("corporate_action_basis_unknown");
      }
      p.quantity += delta;
      if (p.quantity === 0n && p.basis !== null) p.basis = 0n;
      a.positions.set(l.securityId, p);
    }
  }
  const result: AccountValuation[] = [...accounts.values()].map((a) => {
    let marketValue = 0n,
      marksKnown = true;
    const positions = [...a.positions.entries()]
      .filter(([, p]) => p.quantity !== 0n)
      .map(([securityId, p]) => {
        const marks = input.marks.filter(
          (m) =>
            m.securityId === securityId &&
            m.currency === a.currency &&
            m.date <= input.asOfDate &&
            validDate(m.date) &&
            knownByCutoff(m.availableAt),
        );
        marks.sort((x, y) => y.date.localeCompare(x.date));
        const newest = marks[0];
        const conflicting =
          newest &&
          new Set(marks.filter((m) => m.date === newest.date).map((m) => format(decimal(m.price))))
            .size > 1;
        const mark = conflicting ? undefined : newest;
        if (conflicting) a.issues.add("conflicting_same_date_prices");
        if (mark && (!mark.sourceHash || decimal(mark.price) <= 0n))
          throw new Error("Invalid price mark provenance");
        const value =
          mark && a.opening?.complete ? multiply(p.quantity, decimal(mark.price)) : null;
        if (p.quantity < 0n) {
          marksKnown = false;
          a.issues.add("unreconciled_short_position");
        }
        if (value === null) {
          marksKnown = false;
          a.issues.add("price_missing");
        } else marketValue += value;
        if (mark && mark.date !== input.asOfDate) a.issues.add("stale_price");
        return {
          securityId,
          quantity: a.opening?.complete ? format(p.quantity) : null,
          knownQuantityDelta: format(
            p.quantity -
              decimal(
                a.opening?.positions.find((o) => o.securityId === securityId)?.quantity ?? "0",
              ),
          ),
          costBasis: p.basis === null ? null : format(p.basis),
          marketValue: value === null ? null : format(value),
          priceDate: mark?.date ?? null,
        };
      });
    return {
      accountId: a.accountId,
      currency: a.currency,
      cash: a.knownCash ? format(a.cash) : null,
      knownCashDelta: format(a.delta),
      unsettledCash: a.knownPending ? format(a.pending) : null,
      positions,
      equity:
        a.knownCash && a.knownPending && marksKnown
          ? format(a.cash + a.pending + marketValue)
          : null,
      issues: [...a.issues].sort(),
    };
  });
  let baseEquity = 0n;
  const issues = new Set<string>();
  if (!result.length) issues.add("no_account_coverage");
  for (const a of result) {
    if (a.equity === null) {
      issues.add("incomplete_account_equity");
      continue;
    }
    if (a.currency === input.baseCurrency) {
      baseEquity += decimal(a.equity);
      continue;
    }
    const rates = input.fx.filter(
      (f) =>
        knownByCutoff(f.availableAt) &&
        f.base === a.currency &&
        f.quote === input.baseCurrency &&
        f.date === input.asOfDate &&
        f.verified &&
        !!f.source,
    );
    if (new Set(rates.map((f) => format(decimal(f.rate)))).size > 1) {
      issues.add("conflicting_same_date_fx");
      continue;
    }
    const fx = rates[0];
    if (!fx || decimal(fx.rate) <= 0n) {
      issues.add("verified_same_date_fx_missing");
      continue;
    }
    baseEquity += multiply(decimal(a.equity), decimal(fx.rate));
  }
  return {
    asOfDate: input.asOfDate,
    knownAt: input.knownAt ?? null,
    revisionMode: input.knownAt ? ("AS_KNOWN" as const) : ("RESTATED" as const),
    book: input.book,
    bookId: input.bookId,
    accounts: result,
    baseCurrency: input.baseCurrency,
    baseEquity: issues.size ? null : format(baseEquity),
    issues: [...issues].sort(),
    performanceStatus: "NOT_COMPUTED_REQUIRES_COMPLETE_FLOWS" as const,
  };
}
