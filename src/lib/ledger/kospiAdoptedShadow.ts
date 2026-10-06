import {
  KOSPI_SHADOW_POLICY,
  stepKospiShadow,
  type KospiModelExecutionPolicy,
  type KospiShadowSession,
  type KospiShadowSnapshot,
} from "../engine/kospiShadow";
import type { ModelJournalRun } from "./modelJournal";
import {
  KR_FIXED_BUDGET_END_EXCLUSIVE,
  assertModelCalendarContinuation,
  assertModelSeriesIsolation,
  canonicalSeriesJson,
  firstModelSession,
  guardModelRun,
  hashSeriesValue,
  verifyFrozenSeries,
  type FrozenModelSeries,
  type ModelCalendar,
} from "./modelSeries";
import { validDate } from "./date";
import { isKrOfficialShadowDecision } from "./krShadowDecision";

export const ADOPTED_KOSPI_FIRST_SESSION = "2026-10-06";
export interface AdoptedKospiShadowRun extends ModelJournalRun {
  firstValidSessionDate: typeof ADOPTED_KOSPI_FIRST_SESSION;
  calendar: ModelCalendar;
  result: KospiShadowSnapshot;
}
export interface AdoptedKospiShadowInput {
  session: KospiShadowSession;
  calendar: ModelCalendar;
  decisionAt: string;
  codeHash: string;
  configHash: string;
}
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
function time(value: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !validDate(value.slice(0, 10)) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error("Explicit KOSPI timestamp with timezone required");
  return Date.parse(value);
}
function marketDate(value: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(time(value)));
}
/** Pure wrapper: the existing confirm1/bear-only-RSAccel rules remain unchanged.
 * The optional execution policy creates a separate cash-only October model and never
 * consumes the legacy research history, pre-start candidates, actual holdings or orders.
 */
export async function stepAdoptedKospiShadowSeries(
  series: FrozenModelSeries,
  input: AdoptedKospiShadowInput,
  previous: AdoptedKospiShadowRun | null = null,
): Promise<{ status: "NEW" | "REUSE"; run: AdoptedKospiShadowRun }> {
  await verifyFrozenSeries(series);
  if (
    series.policy.kind !== "KR_KOSPI_CONFIRM1_BEAR" ||
    series.policy.currency !== "KRW" ||
    series.policy.market !== "KR" ||
    series.fx !== null ||
    series.policy.allocation !== "KR_INITIAL_CAPITAL_DIV_30_FIRST_YEAR" ||
    canonicalSeriesJson(series.policy.enginePolicy) !== canonicalSeriesJson(KOSPI_SHADOW_POLICY)
  )
    throw new Error(
      "KOSPI wrapper requires its unchanged isolated confirm1/bear-only Shadow series",
    );
  const { session } = input;
  const date = session.date;
  if (
    !validDate(date) ||
    date < series.accountingStartDate ||
    date >= KR_FIXED_BUDGET_END_EXCLUSIVE
  )
    throw new Error("KOSPI model requires a post-start session within its fixed-budget first year");
  if (!/^sha256:[a-f0-9]{64}$/.test(session.sourceHash))
    throw new Error("KOSPI source manifest requires a SHA-256 hash");
  if (
    !session.confirmedClose ||
    time(session.sourceCollectedAt) < Date.parse(`${date}T06:30:00Z`) ||
    time(session.sourceCollectedAt) > time(input.decisionAt) ||
    !isKrOfficialShadowDecision(date, session.sourceCollectedAt, input.decisionAt)
  )
    throw new Error(
      "KOSPI Shadow requires the full next-session-morning refresh before that session opens",
    );
  if (session.codeVersion !== input.codeHash || session.configHash !== input.configHash)
    throw new Error("KOSPI session code/config must match the frozen run provenance");
  const first = firstModelSession(series, input.calendar);
  const sessions = [...input.calendar.regularSessions].sort();
  if (first !== ADOPTED_KOSPI_FIRST_SESSION || !sessions.includes(date))
    throw new Error("KOSPI calendar must contain the verified first regular session on 2026-10-06");
  const preceding = sessions.filter((day) => day < date).at(-1) ?? null;
  if (session.previousSessionDate !== preceding)
    throw new Error("KOSPI source must identify the exact previous regular calendar session");
  if (previous) {
    assertModelSeriesIsolation(series, previous);
    assertModelCalendarContinuation(series, previous.calendar, input.calendar);
    const { stateHash, ...body } = previous;
    if (
      stateHash !== (await hashSeriesValue(body)) ||
      previous.firstValidSessionDate !== first ||
      previous.receipt.date !== previous.result.state.lastDate ||
      previous.receipt.date !== previous.result.daily.date ||
      previous.receipt.date !== previous.result.source.date ||
      previous.receipt.contractHash !== series.contractHash ||
      previous.result.state.executionPolicy?.bookId !== series.bookId ||
      previous.result.state.executionPolicy?.contractHash !== series.contractHash ||
      canonicalSeriesJson(previous.result.policy) !== canonicalSeriesJson(KOSPI_SHADOW_POLICY)
    )
      throw new Error("Prior KOSPI run/state provenance mismatch");
    await guardModelRun(series, previous.receipt, previous.receipt);
  }
  const sameDate = previous?.receipt.date === date;
  const previousStateHash = sameDate ? previous.previousStateHash : (previous?.stateHash ?? null);
  // Include the actual dated data and full calendar, not just a caller-declared source digest.
  const sourceHash = await hashSeriesValue({
    session,
    calendar: input.calendar,
    previousStateHash,
  });
  const guarded = await guardModelRun(
    series,
    { date, codeHash: input.codeHash, configHash: input.configHash, sourceHash },
    sameDate ? previous.receipt : undefined,
  );
  if (guarded.status === "REUSE" && previous) return { status: "REUSE", run: previous };
  const expected = previous ? sessions.find((day) => day > previous.receipt.date) : first;
  if (date !== expected)
    throw new Error(
      "KOSPI model requires consecutive regular sessions; missing sessions cannot be skipped",
    );
  const executionPolicy: KospiModelExecutionPolicy = {
    version: "isolated-kospi-model-v1",
    bookId: series.bookId,
    contractHash: series.contractHash,
    codeHash: series.codeHash,
    configHash: series.configHash,
    accountingStartDate: series.accountingStartDate,
    fixedBudgetEndExclusive: KR_FIXED_BUDGET_END_EXCLUSIVE,
    initialCapitalKrw: series.initialKrw,
    oneWayCost: series.oneWayCost,
  };
  const result = stepKospiShadow(session, previous?.result.state ?? null, executionPolicy);
  const body = {
    book: "MODEL" as const,
    bookId: series.bookId,
    contractHash: series.contractHash,
    receipt: guarded.receipt,
    previousStateHash,
    firstValidSessionDate: ADOPTED_KOSPI_FIRST_SESSION as typeof ADOPTED_KOSPI_FIRST_SESSION,
    calendar: structuredClone(input.calendar),
    result: structuredClone(result),
  };
  return { status: "NEW", run: freeze({ ...body, stateHash: await hashSeriesValue(body) }) };
}
