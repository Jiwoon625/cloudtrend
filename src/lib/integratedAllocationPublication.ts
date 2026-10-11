import {
  createIntegratedAllocationShadow,
  stepIntegratedAllocationSession,
  reviewIntegratedAllocationMonth,
  verifyIntegratedAllocationLedger,
  type AllocationShadowKind,
  type IntegratedAllocationLedger,
  type IntegratedAllocationSessionInput,
  type IntegratedAllocationMonthReview,
} from "./integratedAllocationShadow";
import { canonicalSeriesJson, hashSeriesValue, type SeriesHash } from "./ledger/modelSeries";
import { OCTOBER_CALENDAR_EVIDENCE, octoberModelCalendar } from "./ledger/octoberShadowCalendar";
export interface IntegratedRegistry {
  book: "MODEL";
  bookId: string;
  version: "integrated-allocation-shadow-2026-10-12-v1";
  accountingStartDate: "2026-10-12";
  policy: { kind: AllocationShadowKind; market: "GLOBAL" };
  contract: IntegratedAllocationLedger["contract"];
  contractHash: SeriesHash;
  configHash: SeriesHash;
  codeHash: SeriesHash;
  sourceHash: SeriesHash;
}
export interface IntegratedDailyPublication {
  book: "MODEL";
  bookId: string;
  contractHash: SeriesHash;
  registry: IntegratedRegistry;
  result: IntegratedAllocationLedger;
  previousStateHash: SeriesHash | null;
  receipt: {
    book: "MODEL";
    bookId: string;
    date: string;
    contractHash: SeriesHash;
    configHash: SeriesHash;
    codeHash: SeriesHash;
    sourceHash: SeriesHash;
    runHash: SeriesHash;
  };
  publication: {
    version: "integrated-allocation-publication-v1";
    batchHash: SeriesHash;
    markets: Array<"K" | "E" | "U">;
    availableAt: string;
    decisionAt: string;
  };
  calendar: { version: string; sourceHash: SeriesHash; coverageStart: string; coverageEnd: string };
  stateHash: SeriesHash;
  canonicalPayload: string;
  resultCanonicalPayload: string;
}
async function seal<T extends { result: IntegratedAllocationLedger }>(value: T) {
  const { stateHash: innerHash, ...inner } = value.result;
  if (innerHash !== (await hashSeriesValue(inner)))
    throw new Error("Integrated inner state mismatch");
  const body = { ...value, resultCanonicalPayload: canonicalSeriesJson(inner) };
  return {
    ...body,
    stateHash: await hashSeriesValue(body),
    canonicalPayload: canonicalSeriesJson(body),
  };
}
export async function integratedRegistry(
  kind: AllocationShadowKind,
  codeHash: SeriesHash,
): Promise<IntegratedRegistry> {
  const initial = await createIntegratedAllocationShadow(kind, { codeHash });
  return {
    book: "MODEL",
    bookId: initial.bookId,
    version: initial.contract.version,
    accountingStartDate: initial.contract.startDate,
    policy: { kind, market: "GLOBAL" },
    contract: initial.contract,
    contractHash: initial.contractHash,
    configHash: initial.contractHash,
    codeHash,
    sourceHash: await hashSeriesValue({
      initialTarget: initial.target,
      initialReference: initial.contract.initialReference,
    }),
  };
}
export async function prepareIntegratedInitialization(
  kind: AllocationShadowKind,
  codeHash: SeriesHash,
) {
  const registry = await integratedRegistry(kind, codeHash);
  const result = await createIntegratedAllocationShadow(kind, { codeHash });
  return seal({
    book: "MODEL" as const,
    bookId: registry.bookId,
    contractHash: registry.contractHash,
    action: "INITIALIZE" as const,
    registry,
    result,
  });
}
export async function integratedMarketsDue(date: string) {
  if (date < "2026-10-12" || date > OCTOBER_CALENDAR_EVIDENCE.coverageEnd)
    throw new Error("Reviewed allocation calendar does not cover date");
  if (OCTOBER_CALENDAR_EVIDENCE.KR.pendingHoursDates.includes(date))
    throw new Error("Verified exchange hours required");
  const [kr, us] = await Promise.all([
    octoberModelCalendar("KR", OCTOBER_CALENDAR_EVIDENCE.coverageEnd),
    octoberModelCalendar("US", OCTOBER_CALENDAR_EVIDENCE.coverageEnd),
  ]);
  const markets: Array<"K" | "E" | "U"> = [];
  if (kr.regularSessions.includes(date)) markets.push("K", "E");
  if (us.regularSessions.includes(date)) markets.push("U");
  return markets;
}
/** The only persistent head is a complete global day. Partial market uploads are inputs, never NAV publications. */
export async function prepareIntegratedDailyPublication(input: {
  registry: IntegratedRegistry;
  previous: IntegratedDailyPublication | null;
  date: string;
  sessions: IntegratedAllocationSessionInput[];
  monthReview?: IntegratedAllocationMonthReview;
  now: string;
}): Promise<IntegratedDailyPublication> {
  const { registry, previous } = input;
  if (!Number.isFinite(Date.parse(input.now)))
    throw new Error("Verified publication time required");
  if (
    canonicalSeriesJson(registry) !==
    canonicalSeriesJson(await integratedRegistry(registry.policy.kind, registry.codeHash))
  )
    throw new Error("Unsupported integrated registry");
  if (
    input.monthReview &&
    (input.monthReview.month !== input.date.slice(0, 7) ||
      Date.parse(input.monthReview.decisionAt) > Date.parse(input.now))
  )
    throw new Error("Current completed month review required");
  if (previous) {
    const { stateHash, canonicalPayload, ...body } = previous;
    if (
      canonicalPayload !== canonicalSeriesJson(body) ||
      stateHash !== (await hashSeriesValue(body)) ||
      canonicalSeriesJson(previous.registry) !== canonicalSeriesJson(registry) ||
      previous.receipt.date >= input.date
    )
      throw new Error("Integrated predecessor integrity/date mismatch");
  }
  const due = await integratedMarketsDue(input.date);
  if (
    !due.length ||
    input.sessions.length !== due.length ||
    input.sessions.some(
      (s, i) => s.market !== due[i] || s.date !== input.date || s.codeHash !== registry.codeHash,
    )
  )
    throw new Error("Complete ordered market day required");
  const allDates = (await octoberModelCalendar("KR", OCTOBER_CALENDAR_EVIDENCE.coverageEnd))
    .regularSessions;
  const usDates = (await octoberModelCalendar("US", OCTOBER_CALENDAR_EVIDENCE.coverageEnd))
    .regularSessions;
  const isMonthEnd = ![...allDates, ...usDates].some(
    (day) => day > input.date && day.slice(0, 7) === input.date.slice(0, 7),
  );
  if (registry.policy.kind === "O1" && isMonthEnd !== Boolean(input.monthReview))
    throw new Error("O1 completed month review is mandatory only at month end");
  if (registry.policy.kind === "S07" && input.monthReview)
    throw new Error("Static allocation has no monthly optimization");
  const predecessor =
    [...new Set([...allDates, ...usDates])]
      .filter((d) => d >= registry.accountingStartDate && d < input.date)
      .sort()
      .at(-1) ?? null;
  if ((previous?.receipt.date ?? null) !== predecessor)
    throw new Error("Sequential global allocation replay required");
  let result =
    previous?.result ??
    (await createIntegratedAllocationShadow(registry.policy.kind, { codeHash: registry.codeHash }));
  await verifyIntegratedAllocationLedger(result);
  for (const session of input.sessions) {
    if (
      Date.parse(session.decisionAt) > Date.parse(input.now) ||
      Date.parse(session.availableAt) > Date.parse(session.decisionAt)
    )
      throw new Error("Future allocation evidence");
    result = (await stepIntegratedAllocationSession(result, session)).ledger;
  }
  if (input.monthReview)
    result = (await reviewIntegratedAllocationMonth(result, input.monthReview)).ledger;
  const sourceHash = await hashSeriesValue({
    sessions: input.sessions,
    monthReview: input.monthReview ?? null,
  });
  const receipt = {
    book: "MODEL" as const,
    bookId: registry.bookId,
    date: input.date,
    contractHash: registry.contractHash,
    configHash: registry.configHash,
    codeHash: registry.codeHash,
    sourceHash,
  };
  const availableAt = input.sessions
    .map((s) => s.availableAt)
    .sort((a, b) => Date.parse(a) - Date.parse(b))
    .at(-1)!;
  const decisionAt = [
    ...input.sessions.map((s) => s.decisionAt),
    ...(input.monthReview ? [input.monthReview.decisionAt] : []),
  ]
    .sort((a, b) => Date.parse(a) - Date.parse(b))
    .at(-1)!;
  return seal({
    book: "MODEL" as const,
    bookId: registry.bookId,
    contractHash: registry.contractHash,
    registry,
    result,
    previousStateHash: previous?.stateHash ?? null,
    receipt: { ...receipt, runHash: await hashSeriesValue(receipt) },
    publication: {
      version: "integrated-allocation-publication-v1" as const,
      batchHash: sourceHash,
      markets: due,
      availableAt,
      decisionAt,
    },
    calendar: {
      version: OCTOBER_CALENDAR_EVIDENCE.version,
      sourceHash: await hashSeriesValue(OCTOBER_CALENDAR_EVIDENCE),
      coverageStart: OCTOBER_CALENDAR_EVIDENCE.coverageStart,
      coverageEnd: OCTOBER_CALENDAR_EVIDENCE.coverageEnd,
    },
  });
}
