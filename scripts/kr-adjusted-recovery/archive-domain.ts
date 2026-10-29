/* eslint-disable @typescript-eslint/no-explicit-any */
/** Inert observation inventory. Never a source-vintage approval or replacement execution input. */
import {
  canonicalSeriesJson,
  hashSeriesValue,
  verifyFrozenSeries,
  RESTART_SERIES_VERSION,
} from "../../src/lib/ledger/modelSeries";
import { assertStoredOctoberRun } from "../../src/lib/ledger/octoberShadowPipeline";
import { resolveKrInputArchive, krExecutionBar } from "../../src/lib/ledger/octoberShadowArchive";
import { nextKrRegularSession } from "../../src/lib/ledger/krShadowDecision";
import { requireCheck } from "../kr-vintage-preflight/transport";
const same = (a: unknown, b: unknown) => canonicalSeriesJson(a) === canonicalSeriesJson(b);
const H = /^sha256:[a-f0-9]{64}$/;
const KINDS = ["ETF_V02", "KR_KOSDAQ", "KR_KOSPI", "KR_KOSPI_CONFIRM1_BEAR", "KR_MIXED"];
const KR_KINDS = ["KR_MIXED", "KR_KOSPI", "KR_KOSDAQ"];
export const OBSERVATION_ONLY = "PRE_EXISTING_UNREFERENCED_NOT_APPROVED" as const;
export async function verifyArchiveDomainModels(
  models: any[],
  expectedPins: any[],
  archiveReferences: any[],
) {
  requireCheck(
    Array.isArray(models) &&
      models.length === 5 &&
      expectedPins.length === 5 &&
      same(
        models.map((m) => m.pin.seriesId).sort(),
        KINDS.map((k) => RESTART_SERIES_VERSION + ":" + k),
      ),
  );
  const prefixes: any[] = [];
  for (const model of models) {
    const { pin, series, run } = model;
    requireCheck(expectedPins.filter((p) => same(p, pin)).length === 1);
    await verifyFrozenSeries(series);
    await assertStoredOctoberRun(series, run);
    requireCheck(
      series.version === RESTART_SERIES_VERSION &&
        series.bookId === pin.seriesId &&
        run.bookId === pin.seriesId &&
        run.stateHash === pin.stateHash &&
        run.receipt.date === pin.sessionDate &&
        (await hashSeriesValue(run)) === pin.payloadHash,
    );
    const archive = run.frozenInputArchive;
    if (!KR_KINDS.includes(series.policy.kind)) {
      requireCheck(archive === undefined);
      continue;
    }
    requireCheck(
      archive?.version === "kr-daily-inputs-v1" &&
        H.test(archive.prefixHash) &&
        Array.isArray(archive.days) &&
        archive.days.length > 0,
    );
    let expected = series.accountingStartDate as string;
    for (const day of archive.days) {
      requireCheck(day.date === expected && H.test(day.hash));
      const matches = archiveReferences.filter(
        (a) =>
          a.date === day.date &&
          a.sourceHash === day.hash &&
          a.sourceId === `october-input:KR:${day.date}:${day.hash.slice(7)}`,
      );
      requireCheck(matches.length === 1);
      prefixes.push({
        bookId: series.bookId,
        date: day.date,
        hash: day.hash,
        sourceId: matches[0].sourceId,
      });
      expected = nextKrRegularSession(expected)!;
    }
    requireCheck(archive.days.at(-1).date === run.receipt.date);
  }
  return prefixes;
}
export async function verifyArchivePrefixBodies(
  models: any[],
  archives: Array<{ reference: any; payload: any }>,
) {
  const references = archives.map((a) => a.reference);
  const prefixes = await verifyArchiveDomainModels(
    models,
    models.map((m) => m.pin),
    references,
  );
  for (const model of models)
    if (KR_KINDS.includes(model.series.policy.kind))
      await resolveKrInputArchive(model.run, async (date, hash) => {
        const matches = archives.filter(
          (a) => a.reference.date === date && a.reference.sourceHash === hash,
        );
        requireCheck(matches.length === 1);
        return matches[0].payload;
      });
  return prefixes;
}
/** Keep every other input, including instruments, indices and market context, byte-canonically equal. */
export async function nonTargetDatasetIdentity(baseline: any, candidate: any, symbol: string) {
  const project = (dataset: any) => {
    requireCheck(dataset.bars?.[symbol] && dataset.observedBars?.[symbol]);
    return {
      ...dataset,
      bars: Object.fromEntries(Object.entries(dataset.bars).filter(([key]) => key !== symbol)),
      observedBars: Object.fromEntries(
        Object.entries(dataset.observedBars).filter(([key]) => key !== symbol),
      ),
    };
  };
  const baselineNonTargetHash = await hashSeriesValue(project(baseline));
  const candidateNonTargetHash = await hashSeriesValue(project(candidate));
  requireCheck(baselineNonTargetHash === candidateNonTargetHash);
  return {
    baselineDatasetHash: await hashSeriesValue(baseline),
    candidateDatasetHash: await hashSeriesValue(candidate),
    baselineNonTargetHash,
    candidateNonTargetHash,
    excludedTargetSymbol: symbol,
  };
}
export async function classifyPreExistingObservation(
  pair: any,
  baselineBar: any,
  models: any[],
  prefixes: any[],
) {
  requireCheck(
    baselineBar &&
      models.length === 5 &&
      models.every((m) => pair.date < m.series.accountingStartDate),
  );
  requireCheck(
    !prefixes.some(
      (p) =>
        p.date === pair.date || p.hash === pair.archiveHash || p.sourceId === pair.archiveSourceId,
    ),
  );
  const baselineIncoming = krExecutionBar(baselineBar);
  requireCheck(
    same(baselineIncoming, pair.incoming) &&
      (await hashSeriesValue(baselineIncoming)) === pair.incomingHash,
  );
  return {
    ...pair,
    classification: OBSERVATION_ONLY,
    operationalApproval: false,
    baselineIncoming,
    baselineIncomingHash: pair.incomingHash,
    executionPrefixReferenced: false,
  };
}
export async function verifyArchiveObservationInventory(p: any) {
  const v = p.archiveObservationInventory;
  requireCheck(
    v?.version === "kr-preexisting-archive-observation-inventory-v1" &&
      v.operationalApproval === false &&
      v.classificationPolicy === OBSERVATION_ONLY &&
      v.targetSymbol === p.scope.symbol &&
      v.datasetIdentity.excludedTargetSymbol === p.scope.symbol &&
      v.datasetIdentity.candidateDatasetHash === p.candidate.datasetHash &&
      H.test(v.datasetIdentity.baselineDatasetHash) &&
      v.datasetIdentity.baselineDatasetHash === p.candidate.overlay.baseDatasetHash &&
      H.test(v.datasetIdentity.baselineNonTargetHash) &&
      v.datasetIdentity.baselineNonTargetHash === v.datasetIdentity.candidateNonTargetHash,
  );
  const prefixes = await verifyArchiveDomainModels(v.models, p.modelPins, p.archiveReferences);
  requireCheck(same(prefixes, v.executionPrefixReferences));
  const seen = new Set<string>();
  const rows: any[] = [];
  for (const [kind, pairs] of [
    ["targetChanged", p.archivePairs],
    ["v1Retained", p.retainedPairs],
    ["preExistingUnreferenced", v.preExistingUnreferenced],
  ] as const) {
    requireCheck(Array.isArray(pairs));
    for (const pair of pairs) {
      requireCheck(
        pair.archived.tradeDate === pair.date &&
          pair.incoming.tradeDate === pair.date &&
          (await hashSeriesValue(pair.archived)) === pair.archivedHash &&
          (await hashSeriesValue(pair.incoming)) === pair.incomingHash &&
          pair.archivedHash !== pair.incomingHash,
      );
      requireCheck(
        p.archiveReferences.some(
          (a: any) =>
            a.date === pair.date &&
            a.sourceId === pair.archiveSourceId &&
            a.sourceHash === pair.archiveHash,
        ),
      );
      const key = pair.archiveSourceId + ":" + pair.symbol + ":" + pair.date;
      requireCheck(!seen.has(key));
      seen.add(key);
      rows.push({ kind, sourceId: pair.archiveSourceId });
      if (kind === "targetChanged") requireCheck(pair.symbol === p.scope.symbol);
      else {
        requireCheck(pair.symbol !== p.scope.symbol);
        const matches = p.vintageV1.receipt.reviews.filter(
          (r: any) =>
            r.symbol === pair.symbol &&
            r.date === pair.date &&
            r.archivedHash === pair.archivedHash &&
            r.incomingHash === pair.incomingHash,
        );
        if (kind === "v1Retained") requireCheck(matches.length === 1);
        else {
          requireCheck(
            matches.length === 0 &&
              pair.classification === OBSERVATION_ONLY &&
              pair.operationalApproval === false &&
              pair.executionPrefixReferenced === false &&
              pair.baselineIncomingHash === pair.incomingHash,
          );
          const {
            classification,
            operationalApproval,
            baselineIncoming,
            baselineIncomingHash,
            executionPrefixReferenced,
            ...raw
          } = pair;
          void classification;
          void operationalApproval;
          void baselineIncomingHash;
          void executionPrefixReferenced;
          requireCheck(
            same(
              await classifyPreExistingObservation(raw, baselineIncoming, v.models, prefixes),
              pair,
            ),
          );
          requireCheck(
            !p.vintageReviewProposal.reviews.some(
              (r: any) => r.symbol === pair.symbol && r.date === pair.date,
            ),
          );
        }
      }
    }
  }
  for (const row of p.historicalCoverage.missingOtherRows) {
    const key = row.archiveSourceId + ":" + row.symbol + ":" + row.date;
    requireCheck(
      row.symbol !== p.scope.symbol &&
        !seen.has(key) &&
        row.classification === "PRE_EXISTING_ABSENCE_NOT_APPROVED" &&
        row.baselineAndCandidateAbsent === true &&
        row.operationalApproval === false,
    );
    seen.add(key);
    requireCheck(
      p.archiveReferences.some(
        (a: any) => a.sourceId === row.archiveSourceId && a.date === row.date,
      ),
    );
    rows.push({ kind: "missing", sourceId: row.archiveSourceId });
  }
  requireCheck(
    v.scannedArchives.length === p.archiveReferences.length &&
      same(
        v.scannedArchives.map((s: any) => s.sourceId),
        p.archiveReferences.map((a: any) => a.sourceId),
      ),
  );
  for (const scan of v.scannedArchives) {
    const counts = [
      "total",
      "unchanged",
      "targetChanged",
      "v1Retained",
      "preExistingUnreferenced",
      "missing",
    ];
    requireCheck(counts.every((k) => Number.isSafeInteger(scan[k]) && scan[k] >= 0));
    requireCheck(scan.total === counts.slice(1).reduce((sum, k) => sum + scan[k], 0));
    for (const kind of counts.slice(2))
      requireCheck(
        scan[kind] === rows.filter((r) => r.sourceId === scan.sourceId && r.kind === kind).length,
      );
  }
  requireCheck(v.coverageComplete === (p.historicalCoverage.missingOtherRows.length === 0));
}
