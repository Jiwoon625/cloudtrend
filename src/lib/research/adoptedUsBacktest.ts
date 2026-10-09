/** Offline historical replay of the current A0 rules. No database or publication access. */
import { CURRENT_RULES_RESEARCH } from "../engine/operatingPolicyContext";
import {
  runUsProspectiveAnalysis,
  US_PROSPECTIVE_RULE_VERSION,
  type UsProspectiveInputRow,
  type UsProspectivePreviousState,
} from "../engine/usProspective";
import {
  stepUsProspectivePortfolio,
  usFixedSlotAllocationPolicy,
  US_PROSPECTIVE_STRATEGIES,
  type UsModelExecutionPolicy,
  type UsPortfolioStepResult,
} from "../engine/usProspectivePortfolio";
import { hashSeriesValue, type SeriesHash } from "../ledger/modelSeries";
import { validDate } from "../ledger/date";
import {
  validateUsLastValidClosePolicy,
  validateUsResearchCloseContext,
  type UsLastValidClosePolicy,
  type UsResearchCloseContext,
} from "./usLastValidClosePolicy";
import {
  validateUsAnnualEntryBudgetPolicy,
  type UsAnnualEntryBudgetPolicy,
} from "./usAnnualEntryBudget";
import {
  validateUsResearchTradePricePolicy,
  type UsResearchTradePricePolicy,
} from "./usResearchTradePrice";

export const US_BACKTEST_INITIAL_CAPITAL = "74671.44";
export const US_BACKTEST_ONE_WAY_COST = "0.0015";
const VERSION = "adopted-us-current-rules-research-v1" as const;
const STRATEGY = US_PROSPECTIVE_STRATEGIES.find((s) => s.id === "A0_QUARTER_PRIMARY")!;

export interface AdoptedUsBacktestContract {
  version: typeof VERSION;
  bookId: string;
  startDate: string;
  endDate: string;
  /** Authoritative supplied regular sessions; no weekday-based calendar inference. */
  sessions: string[];
  calendarSourceHash: SeriesHash;
  sourceManifestHash: SeriesHash;
  codeHash: SeriesHash;
  ruleVersion: typeof US_PROSPECTIVE_RULE_VERSION;
  initialCapitalUsd: typeof US_BACKTEST_INITIAL_CAPITAL;
  oneWayCost: typeof US_BACKTEST_ONE_WAY_COST;
  researchGrade: "RETROSPECTIVE_CURRENT_RULES_NOT_INDEPENDENT_OOS";
  /** Optional fresh-run-only all-held proxy; omitted contracts keep historical defaults. */
  missingClosePolicy?: UsLastValidClosePolicy;
  annualBudgetPolicy?: UsAnnualEntryBudgetPolicy;
  tradePricePolicy?: UsResearchTradePricePolicy;
  configHash: SeriesHash;
  contractHash: SeriesHash;
}

export interface AdoptedUsBacktestSession {
  date: string;
  sourceHash: SeriesHash;
  rows: UsProspectiveInputRow[];
  /** Verified by the source driver, never inferred from one observed ticker. */
  marketDataComplete?: boolean;
}

export interface AdoptedUsBacktestRun {
  date: string;
  bookId: string;
  contractHash: SeriesHash;
  previousStateHash: SeriesHash | null;
  sourceHash: SeriesHash;
  inputHash: SeriesHash;
  rankState: Required<UsProspectivePreviousState>;
  result: UsPortfolioStepResult;
  /** Existing US valuation carries its last price. The replay makes that visible. */
  staleMarkSymbols: string[];
  stateHash: SeriesHash;
}

function assertHash(value: string) {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error("SHA-256 provenance required");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export async function initializeAdoptedUsBacktest(input: {
  sessions: string[];
  calendarSourceHash: SeriesHash;
  sourceManifestHash: SeriesHash;
  codeHash: SeriesHash;
  missingClosePolicy?: UsLastValidClosePolicy;
  annualBudgetPolicy?: UsAnnualEntryBudgetPolicy;
  tradePricePolicy?: UsResearchTradePricePolicy;
}): Promise<AdoptedUsBacktestContract> {
  const sessions = [...input.sessions];
  if (
    !sessions.length ||
    sessions.some((d, i) => !validDate(d) || (i > 0 && d <= sessions[i - 1]!))
  )
    throw new Error("A nonempty, strictly increasing historical session calendar is required");
  [input.calendarSourceHash, input.sourceManifestHash, input.codeHash].forEach(assertHash);
  if (input.annualBudgetPolicy) validateUsAnnualEntryBudgetPolicy(input.annualBudgetPolicy);
  const annualBudgetPolicy = input.annualBudgetPolicy
    ? { policyId: input.annualBudgetPolicy.policyId }
    : undefined;
  if (input.tradePricePolicy) validateUsResearchTradePricePolicy(input.tradePricePolicy);
  const tradePricePolicy = input.tradePricePolicy
    ? { policyId: input.tradePricePolicy.policyId }
    : undefined;
  if (input.missingClosePolicy) validateUsLastValidClosePolicy(input.missingClosePolicy, sessions);
  const missingClosePolicy = input.missingClosePolicy
    ? {
        policyId: input.missingClosePolicy.policyId,
        sourceCoverageEndDate: input.missingClosePolicy.sourceCoverageEndDate,
        sessionClocks: input.missingClosePolicy.sessionClocks.map((clock) => ({ ...clock })),
      }
    : undefined;
  const configHash = await hashSeriesValue({
    strategy: STRATEGY,
    allocation: usFixedSlotAllocationPolicy(US_BACKTEST_INITIAL_CAPITAL),
    oneWayCost: US_BACKTEST_ONE_WAY_COST,
    context: CURRENT_RULES_RESEARCH,
    ...(missingClosePolicy ? { missingClosePolicy } : {}),
    ...(annualBudgetPolicy ? { annualBudgetPolicy } : {}),
    ...(tradePricePolicy ? { tradePricePolicy } : {}),
  });
  const body: Omit<AdoptedUsBacktestContract, "contractHash"> = {
    version: VERSION,
    bookId: `current-rules-research-${sessions[0]}-v1:US_A0`,
    startDate: sessions[0]!,
    endDate: sessions.at(-1)!,
    sessions,
    calendarSourceHash: input.calendarSourceHash,
    sourceManifestHash: input.sourceManifestHash,
    codeHash: input.codeHash,
    ruleVersion: US_PROSPECTIVE_RULE_VERSION,
    initialCapitalUsd: US_BACKTEST_INITIAL_CAPITAL,
    oneWayCost: US_BACKTEST_ONE_WAY_COST,
    researchGrade: "RETROSPECTIVE_CURRENT_RULES_NOT_INDEPENDENT_OOS" as const,
    ...(missingClosePolicy ? { missingClosePolicy } : {}),
    ...(annualBudgetPolicy ? { annualBudgetPolicy } : {}),
    ...(tradePricePolicy ? { tradePricePolicy } : {}),
    configHash,
  };
  return freeze({ ...body, contractHash: await hashSeriesValue(body) });
}

export async function stepAdoptedUsBacktest(
  contract: AdoptedUsBacktestContract,
  input: AdoptedUsBacktestSession,
  previous: AdoptedUsBacktestRun | null = null,
): Promise<AdoptedUsBacktestRun> {
  const { contractHash, ...body } = contract;
  if (contractHash !== (await hashSeriesValue(body)))
    throw new Error("Historical US contract changed");
  const expected = await initializeAdoptedUsBacktest({
    sessions: contract.sessions,
    calendarSourceHash: contract.calendarSourceHash,
    sourceManifestHash: contract.sourceManifestHash,
    codeHash: contract.codeHash,
    ...(contract.missingClosePolicy ? { missingClosePolicy: contract.missingClosePolicy } : {}),
    ...(contract.annualBudgetPolicy ? { annualBudgetPolicy: contract.annualBudgetPolicy } : {}),
    ...(contract.tradePricePolicy ? { tradePricePolicy: contract.tradePricePolicy } : {}),
  });
  if (contractHash !== expected.contractHash) throw new Error("Historical US policy changed");
  assertHash(input.sourceHash);
  if (previous) {
    const { stateHash, ...priorBody } = previous;
    if (
      previous.contractHash !== contractHash ||
      previous.bookId !== contract.bookId ||
      stateHash !== (await hashSeriesValue(priorBody)) ||
      previous.result.state.lastDate !== previous.date ||
      previous.rankState.lastDate !== previous.date
    )
      throw new Error("Historical US predecessor mismatch");
  }
  const previousIndex = previous ? contract.sessions.indexOf(previous.date) : -1;
  if ((previous && previousIndex < 0) || contract.sessions[previousIndex + 1] !== input.date)
    throw new Error("Historical US replay requires the next declared session");
  let researchCloseContext: UsResearchCloseContext | undefined;
  if (contract.missingClosePolicy) {
    if (input.marketDataComplete !== true)
      throw new Error("Incomplete market source cannot trigger research disappearance exits");
    researchCloseContext = {
      ...contract.missingClosePolicy.sessionClocks[previousIndex + 1]!,
      policyId: contract.missingClosePolicy.policyId,
      marketDataComplete: true,
    };
    validateUsResearchCloseContext(researchCloseContext, input.date, input.rows);
  }
  if (
    !input.rows.length ||
    input.rows.some((r) => r.date !== input.date) ||
    !input.rows.some((r) => r.symbol === "SPY" && r.close !== null && r.close > 0)
  )
    throw new Error("Historical US requires same-session rows and a current SPY close");
  const analysis = runUsProspectiveAnalysis(input.rows, previous?.rankState);
  const policy: UsModelExecutionPolicy = {
    version: "isolated-us-model-v1",
    bookId: contract.bookId,
    contractHash,
    accountingStartDate: contract.startDate,
    initialCapital: contract.initialCapitalUsd,
    oneWayCost: contract.oneWayCost,
  };
  const result = stepUsProspectivePortfolio(
    STRATEGY,
    analysis,
    previous?.result.state ?? null,
    previous?.result.nav ?? null,
    policy,
    usFixedSlotAllocationPolicy(contract.initialCapitalUsd),
    0.0015,
    CURRENT_RULES_RESEARCH,
    researchCloseContext,
    contract.annualBudgetPolicy,
    contract.tradePricePolicy,
  );
  const quotes = new Map(input.rows.map((r) => [r.symbol, r]));
  const staleMarkSymbols = Object.keys(result.state.positions)
    .filter((symbol) => {
      const close = quotes.get(symbol)?.close;
      return close === null || close === undefined || !Number.isFinite(close) || close <= 0;
    })
    .sort();
  const run = {
    date: input.date,
    bookId: contract.bookId,
    contractHash,
    previousStateHash: previous?.stateHash ?? null,
    sourceHash: input.sourceHash,
    inputHash: await hashSeriesValue({
      rows: input.rows,
      sourceHash: input.sourceHash,
      ...(researchCloseContext ? { researchCloseContext } : {}),
    }),
    rankState: analysis.state,
    result,
    staleMarkSymbols,
  };
  return freeze({ ...run, stateHash: await hashSeriesValue(run) });
}

/** Convenience for small fixtures. Large drivers should stream into stepAdoptedUsBacktest. */
export async function replayAdoptedUsBacktest(
  contract: AdoptedUsBacktestContract,
  sessions: Iterable<AdoptedUsBacktestSession> | AsyncIterable<AdoptedUsBacktestSession>,
): Promise<AdoptedUsBacktestRun[]> {
  const runs: AdoptedUsBacktestRun[] = [];
  for await (const session of sessions)
    runs.push(await stepAdoptedUsBacktest(contract, session, runs.at(-1) ?? null));
  if (runs.at(-1)?.date !== contract.endDate) throw new Error("Historical US replay is incomplete");
  return runs;
}
