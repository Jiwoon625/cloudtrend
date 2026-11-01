/** Pure historical dependency proof. Never authorizes changed/new pending-date inputs or writes. */
import {
  canonicalSeriesJson,
  hashSeriesValue,
  type FrozenModelSeries,
  type SeriesHash,
} from "../../src/lib/ledger/modelSeries";
import {
  assertStoredOctoberRun,
  type OctoberRun,
} from "../../src/lib/ledger/octoberShadowPipeline";
import {
  integratedRegistry,
  type IntegratedDailyPublication,
} from "../../src/lib/integratedAllocationPublication";
import { verifyIntegratedAllocationLedger } from "../../src/lib/integratedAllocationShadow";
import {
  adaptIntegratedKrEvidence,
  type IntegratedKrEvidence,
} from "../../src/lib/integratedAllocationReplayAdapter";
import {
  octoberModelCalendar,
  OCTOBER_CALENDAR_EVIDENCE,
} from "../../src/lib/ledger/octoberShadowCalendar";
const HASH = /^sha256:[a-f0-9]{64}$/;
const KINDS = ["ETF_V02", "KR_KOSDAQ", "KR_KOSPI", "KR_KOSPI_CONFIRM1_BEAR", "KR_MIXED"];
function check(v: unknown, reason: string): asserts v {
  if (!v) throw Error(`Historical lineage: ${reason}`);
}
export interface HistoricalIntegratedRow {
  series_id: string;
  session_date: string;
  previous_session_date: string | null;
  state_hash: string;
  payload: IntegratedDailyPublication;
}
export interface HistoricalLineageInput {
  uid: string;
  date: string;
  stage: { hash: SeriesHash; payload: IntegratedKrEvidence };
  history: IntegratedKrEvidence[];
  models: Array<{ series: FrozenModelSeries; run: OctoberRun }>;
  chains: Record<"O1" | "S07", { checkpointHash: string; rows: HistoricalIntegratedRow[] }>;
  audits: Array<{ user_id: string; market: string; signal_date: string; details: unknown }>;
}
/** Current model authority is not reissued here: only its hash-verified stored retrospective marker
 * is validated; independent original integrated chain+input receipts establish the historical lineage.
 */
export async function validateHistoricalKrLineage(input: HistoricalLineageInput) {
  check(/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(input.uid), "verified owner required");
  const { date, stage } = input;
  check(
    stage.payload.version === "integrated-kr-daily-evidence-v1" &&
      stage.payload.date === date &&
      HASH.test(stage.hash) &&
      (await hashSeriesValue(stage.payload)) === stage.hash,
    "stage envelope mismatch",
  );
  check(
    HASH.test(stage.payload.clock.sourceHash) && HASH.test(stage.payload.clock.codeHash),
    "stage clock provenance",
  );
  check(
    input.models.length === 5 &&
      canonicalSeriesJson(input.models.map((m) => m.series.policy.kind).sort()) ===
        canonicalSeriesJson(KINDS),
    "all five model kinds required",
  );
  const sourceHashes = new Set<string>();
  const modelProof: Array<{ bookId: string; stateHash: string }> = [];
  for (const { series, run } of input.models) {
    await assertStoredOctoberRun(series, run);
    check(series.policy.market === "KR" && run.receipt.date === date, "model date/market mismatch");
    const p = run.publication.reviewedRetrospective;
    check(
      p &&
        p.version === "kr-reviewed-retrospective-publication-v1" &&
        p.historicalAvailabilityClaim === false &&
        p.derivedBasisSourceStatus === "NOT_REGISTERED_AT_PREPARATION",
      "reviewed retrospective marker required",
    );
    check(
      [
        p.registryHash,
        p.receiptHash,
        p.preparationHash,
        p.capsuleHash,
        p.originFinalPublicationHash,
        p.preparationRuntimeCodeHash,
        p.runtimeCodeHash,
      ].every((h) => HASH.test(h)),
      "retrospective hash references",
    );
    check(
      [
        p.captureFinishedAt,
        p.originFinalActivatedAt,
        p.evidenceStoredAt,
        p.modelAvailableAt,
        p.modelDecisionAt,
      ].every((t) => Number.isFinite(Date.parse(t))) &&
        p.modelAvailableAt === run.publication.availableAt &&
        p.modelDecisionAt === run.publication.decisionAt &&
        Date.parse(p.modelAvailableAt) <= Date.parse(p.modelDecisionAt),
      "retrospective clock references",
    );
    // This proves original consumption and lineage, not independent correctness of the source.
    check(HASH.test(run.publication.sourceHash), "invalid current market source hash");
    sourceHashes.add(run.publication.sourceHash);
    modelProof.push({ bookId: series.bookId, stateHash: run.stateHash });
  }
  check(sourceHashes.size === 1, "conflicting current market provenance");
  const matching = input.audits.filter((a) => {
    if (a.user_id !== input.uid || a.market !== "KR" || a.signal_date !== date) return false;
    const details = a.details as {
      integratedRuntimeAttempt?: {
        kind?: string;
        version?: string;
        subjectHash?: string;
        sourceHash?: string;
        frozenCodeHash?: string;
        runtimeCodeHash?: string;
        reviewId?: string;
      };
    };
    const attempt = details?.integratedRuntimeAttempt;
    return (
      attempt?.kind === "EVIDENCE_PREPARED" &&
      attempt.version === "integrated-allocation-runtime-attempt-v1" &&
      attempt.subjectHash === stage.hash &&
      attempt.sourceHash === stage.payload.clock.sourceHash &&
      attempt.frozenCodeHash === stage.payload.clock.codeHash &&
      typeof attempt.runtimeCodeHash === "string" &&
      HASH.test(attempt.runtimeCodeHash) &&
      typeof attempt.reviewId === "string" &&
      attempt.reviewId.length > 0
    );
  });
  check(matching.length === 1, "exact unambiguous prepared audit required");
  const calendars = {
    KR: await octoberModelCalendar("KR", OCTOBER_CALENDAR_EVIDENCE.coverageEnd),
    US: await octoberModelCalendar("US", OCTOBER_CALENDAR_EVIDENCE.coverageEnd),
  };
  const allDates = [...new Set([...calendars.KR.regularSessions, ...calendars.US.regularSessions])]
    .filter((d) => d >= "2026-10-12")
    .sort();
  const proofs: Array<{ kind: string; checkpointHash: string; inputHashes: string[] }> = [];
  for (const kind of ["O1", "S07"] as const) {
    const { rows, checkpointHash } = input.chains[kind];
    check(rows.length > 0 && HASH.test(checkpointHash), "checkpoint chain required");
    const final = rows.at(-1)!;
    check(
      final.state_hash === checkpointHash && final.session_date >= date,
      "pending date cannot use historical lineage",
    );
    const expectedDates = allDates.filter((d) => d <= final.session_date);
    check(rows.length === expectedDates.length, "complete checkpoint chain required");
    const registry = await integratedRegistry(kind, stage.payload.clock.codeHash);
    let previous: IntegratedDailyPublication | null = null;
    const inputHashes: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i],
        p = row.payload;
      const { stateHash, canonicalPayload, ...body } = p;
      const { runHash, ...receipt } = p.receipt;
      check(
        row.series_id === registry.bookId &&
          row.session_date === expectedDates[i] &&
          row.session_date === p.receipt.date &&
          row.previous_session_date === (previous?.receipt.date ?? null) &&
          p.previousStateHash === (previous?.stateHash ?? null),
        "checkpoint chain sequence mismatch",
      );
      check(
        canonicalSeriesJson(p.registry) === canonicalSeriesJson(registry) &&
          p.bookId === registry.bookId &&
          row.state_hash === stateHash &&
          (await hashSeriesValue(body)) === stateHash &&
          canonicalSeriesJson(body) === canonicalPayload &&
          (await hashSeriesValue(receipt)) === runHash,
        "checkpoint publication integrity mismatch",
      );
      await verifyIntegratedAllocationLedger(p.result);
      const { stateHash: innerHash, ...inner } = p.result;
      check(
        p.resultCanonicalPayload === canonicalSeriesJson(inner) &&
          (await hashSeriesValue(inner)) === innerHash,
        "checkpoint inner canonical payload mismatch",
      );
      if (row.session_date === date) {
        check(previous, "historical mismatch cannot precede checkpoint history");
        const history = input.history.filter((e) => e.date < date);
        for (const market of ["K", "E"] as const) {
          const adapted = adaptIntegratedKrEvidence(previous.result, {
            market,
            evidence: stage.payload,
            history,
          });
          const entries = p.result.receipts.filter((r) => r.id === `session:${market}:${date}`);
          check(
            entries.length === 1 && entries[0].record.sourceHash === stage.payload.clock.sourceHash,
            "original integrated source receipt mismatch",
          );
          const hash = await hashSeriesValue(adapted);
          check(hash === entries[0].inputHash, "original integrated adapted input mismatch");
          inputHashes.push(hash);
          const headReceipts = final.payload.result.receipts.filter((r) => r.id === entries[0].id);
          check(
            headReceipts.length === 1 &&
              canonicalSeriesJson(headReceipts[0]) === canonicalSeriesJson(entries[0]),
            "checkpoint did not retain original receipt",
          );
        }
      }
      previous = p;
    }
    check(inputHashes.length === 2, "historical date missing from checkpoint chain");
    proofs.push({ kind, checkpointHash, inputHashes });
  }
  return {
    date,
    stageHash: stage.hash,
    sourceHash: stage.payload.clock.sourceHash,
    checkpointHashes: { O1: input.chains.O1.checkpointHash, S07: input.chains.S07.checkpointHash },
    proofHash: await hashSeriesValue({
      date,
      stageHash: stage.hash,
      modelProof,
      preparedAudit: matching[0],
      proofs,
    }),
  };
}
