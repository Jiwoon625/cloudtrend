import {
  hydrateFinalCapture,
  captureCanonicalProof,
} from "../kr-final-retrospective/capture-codec";
import {
  analyzeKrReplayDataset,
  sliceKrDatasetForReplay,
} from "../../src/lib/shadowReplayCalculation";
import { currentDateEvidence } from "../kr-vintage-preflight-dated-evidence";
import { buildSnapshot } from "../../src/lib/screeningSnapshot";
import {
  prepareIntegratedKrEvidence,
  adaptIntegratedKrEvidence,
  adaptIntegratedUsSession,
} from "../../src/lib/integratedAllocationReplayAdapter";
import {
  octoberModelCalendar,
  OCTOBER_CALENDAR_EVIDENCE,
  regularOpenAt,
  regularCloseAt,
} from "../../src/lib/ledger/octoberShadowCalendar";
import {
  INTEGRATED_ALLOCATION_FROZEN_CODE_HASH,
  reviewedIntegratedRuntime,
} from "../../src/lib/integratedAllocationRuntimeAdmission";
import runtime from "../../src/lib/integratedAllocationRuntime.generated.json";
import {
  integratedRegistry,
  prepareIntegratedDailyPublication,
} from "../../src/lib/integratedAllocationPublication";
import { verifyIntegratedAllocationLedger } from "../../src/lib/integratedAllocationShadow";
import { canonicalSeriesJson as C, hashSeriesValue as H } from "../../src/lib/ledger/modelSeries";
export const PRIOR_PLAN = "sha256:2964685f4dcf1ea6d237c4101525458dae110260d85dea73185b45f7e12f02d9";
export const PRIOR_CAPTURE =
  "sha256:d0accd921401676ccd51fe35b344fb1b2c2cc50c0698b9e957a8d926922721ce";
export const DATE = "2026-10-29",
  PREDECESSOR = "2026-10-28";
const HASH = /^sha256:[a-f0-9]{64}$/;
export function check(ok: unknown, message = "Integrated gap invariant failed"): asserts ok {
  if (!ok) throw Error(message);
}
export const canonicalHash = (value: unknown) => captureCanonicalProof(value).hash;
export interface GapRequest {
  version: string;
  owner: string;
  codeCommit: string;
  preparedAt: string;
  operationalApproval: false;
  historicalAvailabilityClaim: false;
  targetDate: string;
  predecessorDate: string;
  priorCaptureHash: string;
  priorPlanHash: string;
  expectedRuntimeHash: string;
  expected: Record<string, string>;
  storage: Array<{ path: string; rawHash: string; payloadHash: string; generation: any }>;
  targetAbsent: true;
}
export interface GapCapture {
  version: string;
  owner: string;
  codeCommit: string;
  requestHash: string;
  capturedAt: string;
  request: GapRequest;
  baseline: { sources: any[]; models: any[]; registries: any[]; actual: Record<string, any[]> };
  objects: Array<{
    path: string;
    rawHash: string;
    payloadHash: string;
    generation: any;
    payload: any;
  }>;
  priorCaptureHash: string;
  priorPlanHash: string;
}
export interface GapPlan {
  version: string;
  owner: string;
  codeCommit: string;
  requestHash: string;
  captureHash: string;
  historicalAvailabilityClaim: false;
  operationalApproval: false;
  targetDate: string;
  predecessorDate: string;
  priorCaptureHash: string;
  priorPlanHash: string;
  runtimeAdmission: any;
  baselineHashes: Record<string, string>;
  krEvidence: any;
  krEvidenceHash: string;
  publications: any[];
  sourceProof: any;
}
export async function validateGapRequest(r: GapRequest, hash: string, owner: string, code: string) {
  check(HASH.test(hash) && canonicalHash(r) === hash, "Request hash mismatch");
  check(
    r.version === "integrated-gap-request-v1" &&
      r.owner === owner &&
      r.codeCommit === code &&
      /^[a-f0-9]{40}$/.test(code),
    "Request identity mismatch",
  );
  check(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(owner));
  check(
    r.operationalApproval === false &&
      r.historicalAvailabilityClaim === false &&
      r.targetAbsent === true,
  );
  check(
    r.targetDate === DATE &&
      r.predecessorDate === PREDECESSOR &&
      Number.isFinite(Date.parse(r.preparedAt)),
  );
  check(r.priorCaptureHash === PRIOR_CAPTURE && r.priorPlanHash === PRIOR_PLAN);
  check(r.expectedRuntimeHash === runtime.codeHash, "Unexpected executable");
  reviewedIntegratedRuntime(runtime.codeHash, INTEGRATED_ALLOCATION_FROZEN_CODE_HASH);
  check(
    C(Object.keys(r.expected).sort()) === C(["actual", "models", "registries", "sources"]) &&
      Object.values(r.expected).every((h) => HASH.test(h)),
  );
  const calendar = await octoberModelCalendar("KR", OCTOBER_CALENDAR_EVIDENCE.coverageEnd);
  const dates = calendar.regularSessions.filter((d) => d >= "2026-10-12" && d <= PREDECESSOR);
  const prefix = `${owner}/staging/integrated-allocation-inputs/v1/`;
  const paths = [
    ...dates.map((d) => `${prefix}KR/${d}.json`),
    `${prefix}US/${PREDECESSOR}.json`,
    `${prefix}US/${DATE}.json`,
  ].sort();
  check(C(r.storage.map((s) => s.path).sort()) === C(paths), "Evidence path inventory mismatch");
  for (const s of r.storage)
    check(
      HASH.test(s.rawHash) &&
        HASH.test(s.payloadHash) &&
        s.generation &&
        typeof s.generation.id === "string",
      "Invalid storage pin",
    );
}
export async function prepareGapPlan(
  c: GapCapture,
  priorCapture: any,
  priorPlan: any,
): Promise<GapPlan> {
  const r = c.request;
  await validateGapRequest(r, c.requestHash, c.owner, c.codeCommit);
  check(
    c.version === "integrated-gap-capture-v1" &&
      c.priorCaptureHash === PRIOR_CAPTURE &&
      c.priorPlanHash === PRIOR_PLAN &&
      Number.isFinite(Date.parse(c.capturedAt)),
  );
  const baselineHashes = Object.fromEntries(
    Object.entries(c.baseline).map(([k, v]) => [k, canonicalHash(v)]),
  );
  check(C(baselineHashes) === C(r.expected), "Stale baseline");
  check(
    canonicalHash(priorCapture) === PRIOR_CAPTURE && canonicalHash(priorPlan) === PRIOR_PLAN,
    "Prior proof identity mismatch",
  );
  check(
    priorPlan.captureHash === PRIOR_CAPTURE && priorPlan.integratedMutation === false,
    "Prior repair scope mismatch",
  );
  check(
    c.objects.length === r.storage.length &&
      new Set(c.objects.map((o) => o.path)).size === c.objects.length,
  );
  for (const pin of r.storage) {
    const o = c.objects.find((o) => o.path === pin.path);
    check(
      o &&
        o.rawHash === pin.rawHash &&
        o.payloadHash === pin.payloadHash &&
        C(o.generation) === C(pin.generation) &&
        canonicalHash(o.payload) === pin.payloadHash,
      "Captured object mismatch",
    );
  }
  const datasetCapture = await hydrateFinalCapture(priorCapture);
  check(datasetCapture.owner === c.owner, "Prior capture owner mismatch");
  check(canonicalHash(datasetCapture) === priorPlan.preparation.decodedCaptureHash);
  check(
    canonicalHash(datasetCapture.dataset) === priorPlan.preparation.basis.datasetHash &&
      (await H(datasetCapture.config)) === priorPlan.preparation.basis.configHash,
  );
  const { dataset, analysis } = analyzeKrReplayDataset(
    sliceKrDatasetForReplay(datasetCapture.dataset, DATE),
    datasetCapture.config,
  );
  const modeled = {
    availableAt: "2026-10-30T08:00:00+09:00",
    decisionAt: "2026-10-30T08:10:00+09:00",
  };
  const snapshot = { ...buildSnapshot(analysis), savedAt: modeled.availableAt };
  const sourceHash = await H(currentDateEvidence(dataset, snapshot));
  const proof = priorPlan.retrospectiveAuthorityCandidate.receipt.dates.find(
    (d: any) => d.date === DATE,
  );
  check(
    proof && proof.sourceHash === sourceHash && proof.datasetHash === canonicalHash(dataset),
    "Historical recomputation drift",
  );
  const calendar = await octoberModelCalendar("KR", OCTOBER_CALENDAR_EVIDENCE.coverageEnd);
  const admission = reviewedIntegratedRuntime(
    runtime.codeHash,
    INTEGRATED_ALLOCATION_FROZEN_CODE_HASH,
  );
  const krEvidence = prepareIntegratedKrEvidence(dataset, analysis, {
    ...modeled,
    openAt: regularOpenAt("KR", DATE),
    closeAt: regularCloseAt("KR", DATE),
    sourceHash,
    codeHash: admission.frozenCodeHash,
    calendar: { sourceHash: calendar.sourceHash, sessions: calendar.regularSessions },
  });
  const get = (market: string, date: string) => {
    const o = c.objects.find(
      (o) => o.path === `${c.owner}/staging/integrated-allocation-inputs/v1/${market}/${date}.json`,
    );
    check(o, `Missing ${market} ${date}`);
    return o.payload;
  };
  const publications = [];
  for (const kind of ["O1", "S07"] as const) {
    const registry = await integratedRegistry(kind, admission.frozenCodeHash),
      id = registry.bookId;
    const regs = c.baseline.registries.filter((x) => x.series_id === id);
    check(regs.length === 1 && C(regs[0].payload) === C(registry), "Registry drift");
    const rows = c.baseline.models
      .filter((x) => x.series_id === id)
      .sort((a, b) => a.session_date.localeCompare(b.session_date));
    check(rows.length > 0 && rows.at(-1).session_date === PREDECESSOR, "Head is not predecessor");
    const previous = rows.at(-1).payload;
    const { stateHash, canonicalPayload, ...body } = previous;
    check(
      C(body) === canonicalPayload &&
        (await H(body)) === stateHash &&
        stateHash === rows.at(-1).state_hash &&
        C(previous.registry) === C(registry),
      "Previous publication integrity",
    );
    await verifyIntegratedAllocationLedger(previous.result);
    const { stateHash: innerHash, ...inner } = previous.result;
    check(C(inner) === previous.resultCanonicalPayload && (await H(inner)) === innerHash);
    const history = previous.result.markets.K.sessions.map((d: string) => get("KR", d));
    const ue = get("US", DATE),
      priorUs = get("US", previous.result.markets.U.lastSessionDate);
    const sessions = [
      adaptIntegratedKrEvidence(previous.result, { market: "K", evidence: krEvidence, history }),
      adaptIntegratedKrEvidence(previous.result, { market: "E", evidence: krEvidence, history }),
      adaptIntegratedUsSession(previous.result, {
        analysis: ue.analysis,
        previousAnalysis: priorUs.analysis,
        clock: ue.clock,
      }),
    ];
    const publication = await prepareIntegratedDailyPublication({
      registry,
      previous,
      date: DATE,
      sessions,
      now: c.capturedAt,
    });
    check(
      publication.receipt.date === DATE &&
        publication.previousStateHash === previous.stateHash &&
        publication.bookId === id,
    );
    publications.push(publication);
  }
  return {
    version: "integrated-gap-plan-v1",
    owner: c.owner,
    codeCommit: c.codeCommit,
    requestHash: c.requestHash,
    captureHash: canonicalHash(c),
    historicalAvailabilityClaim: false,
    operationalApproval: false,
    targetDate: DATE,
    predecessorDate: PREDECESSOR,
    priorCaptureHash: PRIOR_CAPTURE,
    priorPlanHash: PRIOR_PLAN,
    runtimeAdmission: admission,
    baselineHashes,
    krEvidence,
    krEvidenceHash: await H(krEvidence),
    publications,
    sourceProof: {
      sourceHash,
      datasetHash: proof.datasetHash,
      decodedCaptureHash: priorPlan.preparation.decodedCaptureHash,
      clockInterpretation: "MODELED_DECISION_ONLY_NOT_HISTORICAL_AVAILABILITY",
    },
  };
}
