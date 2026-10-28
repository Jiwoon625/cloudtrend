/* eslint-disable @typescript-eslint/no-explicit-any */
/** GENERIC FILE-ONLY diagnostic. No registration, approval, archive, database, or replay writes. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { parseManualMarketDataWithReferences } from "../src/lib/krxReviewReferenceParser";
import {
  sliceKrDatasetForReplay,
  analyzeKrReplayDataset,
} from "../src/lib/shadowReplayCalculation";
import { buildSnapshot } from "../src/lib/screeningSnapshot";
import { canonicalSeriesJson, hashSeriesValue } from "../src/lib/ledger/modelSeries";
import {
  prepareIntegratedKrEvidence,
  adaptIntegratedKrEvidence,
  adaptIntegratedUsSession,
} from "../src/lib/integratedAllocationReplayAdapter";
import { prepareIntegratedDailyPublication } from "../src/lib/integratedAllocationPublication";
import { verifyIntegratedAllocationLedger } from "../src/lib/integratedAllocationShadow";
import {
  octoberModelCalendar,
  OCTOBER_CALENDAR_EVIDENCE,
  regularOpenAt,
  regularCloseAt,
} from "../src/lib/ledger/octoberShadowCalendar";
import { currentDateEvidence } from "./kr-vintage-preflight-dated-evidence";
import { validateSourceBytes, visitDelimitedRows } from "../src/lib/sourceData";

export interface PreflightScope {
  symbol: string;
  targetDate: string;
  baselineAsOfDate: string;
  captureThroughDate: string;
  captureManifestHash: string;
  normalizedArtifactName: string;
  expectedRun: { id: string; codeVersion: string; dataVersion: string; sourceCount: number };
}
function verifyScope(scope: PreflightScope) {
  if (
    !scope ||
    !/^[A-Z0-9._-]{1,20}$/.test(scope.symbol) ||
    ![scope.targetDate, scope.baselineAsOfDate, scope.captureThroughDate].every(checkDate) ||
    scope.targetDate > scope.baselineAsOfDate ||
    scope.baselineAsOfDate > scope.captureThroughDate ||
    !/^sha256:[a-f0-9]{64}$/.test(scope.captureManifestHash) ||
    !/^[A-Za-z0-9_.-]+\.json$/.test(scope.normalizedArtifactName) ||
    !scope.expectedRun ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(scope.expectedRun.id) ||
    !/^[a-f0-9]{40}$/.test(scope.expectedRun.codeVersion) ||
    !/^sha256:[a-f0-9]{64}$/.test(scope.expectedRun.dataVersion) ||
    !Number.isInteger(scope.expectedRun.sourceCount) ||
    scope.expectedRun.sourceCount < 1 ||
    scope.expectedRun.sourceCount > 128
  )
    throw new Error("Invalid exact private preflight scope");
}
const sha = (raw: string | Buffer) => createHash("sha256").update(raw).digest("hex");
const hash = (value: any) => "sha256:" + sha(canonicalSeriesJson(value));
const equal = (a: any, b: any) => canonicalSeriesJson(a) === canonicalSeriesJson(b);
const inputHashes = new Map<string, string>();
type Ref = { path: string; sha256: string; pointer?: string };
function bytes(ref: Ref) {
  if (!ref || !path.isAbsolute(ref.path) || !/^(sha256:)?[a-f0-9]{64}$/.test(ref.sha256))
    throw new Error("Every input requires an absolute local path and exact byte SHA256");
  const raw = fs.readFileSync(ref.path);
  const digest = sha(raw);
  if (digest !== ref.sha256.replace(/^sha256:/, ""))
    throw new Error("Input byte hash mismatch: " + ref.path);
  if (inputHashes.has(ref.path) && inputHashes.get(ref.path) !== digest)
    throw new Error("Conflicting input identity");
  inputHashes.set(ref.path, digest);
  return raw;
}
function read(ref: Ref) {
  let result = JSON.parse(bytes(ref).toString("utf8"));
  if (ref.pointer) {
    if (!ref.pointer.startsWith("/")) throw new Error("Invalid input JSON pointer");
    for (const token of ref.pointer
      .slice(1)
      .split("/")
      .map((x) => x.replace(/~1/g, "/").replace(/~0/g, "~"))) {
      if (!Object.hasOwn(result, token)) throw new Error("Missing input JSON pointer");
      result = result[token];
    }
  }
  return result;
}
function evidence(ref: Ref) {
  const saved = read(ref);
  if (!saved || !saved.payload || saved.hash !== hash(saved.payload))
    throw new Error("Immutable evidence envelope/hash missing or invalid");
  return saved.payload;
}
function differences(a: any, b: any, prefix = "$", out: any[] = []) {
  if (equal(a ?? null, b ?? null) && (a === undefined) === (b === undefined)) return out;
  if (
    a &&
    b &&
    typeof a === "object" &&
    typeof b === "object" &&
    Array.isArray(a) === Array.isArray(b)
  ) {
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort())
      differences(a[key], b[key], `${prefix}/${key}`, out);
  } else
    out.push({
      path: prefix,
      before: a === undefined ? "__ABSENT__" : a,
      after: b === undefined ? "__ABSENT__" : b,
    });
  return out;
}
function comparison(a: any, b: any) {
  const diff = differences(a, b);
  return {
    equal: diff.length === 0,
    beforeHash: hash(a),
    afterHash: hash(b),
    changedLeafCount: diff.length,
    differences: diff,
  };
}
function checkDate(date: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(date + "T00:00:00Z")) &&
    new Date(date + "T00:00:00Z").toISOString().slice(0, 10) === date
  );
}
function numeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (
    typeof value !== "string" ||
    !value.trim() ||
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())
  )
    return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
type RawDatedEvidence = { fields: Record<string, string>; sourceByField: Record<string, string> };
function collectRawEvidence(
  text: string,
  symbol: string,
  sourceId: string,
  output: Map<string, RawDatedEvidence>,
) {
  let header: string[] = [];
  visitDelimitedRows(text, (values, index) => {
    if (index === 0) {
      header = values;
      return;
    }
    const row = Object.fromEntries(header.map((key, i) => [key, values[i] ?? ""]));
    if (row.symbol !== symbol || !checkDate(row.date)) return;
    const existing = output.get(row.date) ?? { fields: {}, sourceByField: {} };
    // This raw sidecar supplies operands/provenance only; normalized bars remain the parser's authority.
    for (const [key, value] of Object.entries(row))
      if (value.trim() && !/^(null|none|nan|na|-|--)$/i.test(value.trim())) {
        existing.fields[key] = value;
        existing.sourceByField[key] = sourceId + "#canonical-row-" + index;
      }
    output.set(row.date, existing);
  });
}
export function deriveCollectorOverlay(
  base: any,
  capture: Map<string, any>,
  raw: Map<string, RawDatedEvidence>,
  scope: PreflightScope,
) {
  const dates = [
    ...new Set(
      ["bars", "observedBars"].flatMap((field) =>
        (base[field]?.[scope.symbol] ?? []).map((b: any) => b.tradeDate),
      ),
    ),
  ].sort();
  const rows = dates.map((date) => {
    const analytical = (base.bars[scope.symbol] ?? []).find((b: any) => b.tradeDate === date);
    const observed = (base.observedBars?.[scope.symbol] ?? []).find(
      (b: any) => b.tradeDate === date,
    );
    const old = observed ?? analytical,
      newPrice = capture.get(date as string),
      original = raw.get(date as string);
    if (!old || !newPrice || !original)
      throw new Error("Overlay original observation/operand coverage incomplete");
    const fields = original.fields,
      bar = { ...old },
      fieldEvidence: Record<string, string> = {};
    const sameSourceRow = (keys: string[]) => {
      const origin = original.sourceByField[keys[0]];
      return (
        typeof origin === "string" &&
        origin.length > 0 &&
        keys.every((key) => original.sourceByField[key] === origin)
      );
    };
    for (const key of ["open", "high", "low", "close", "volume"]) {
      if (numeric(fields[key]) !== old[key])
        throw new Error("Raw price operand does not reproduce parsed baseline");
      bar[key] = newPrice[key];
      fieldEvidence[key] = "Exact hash-bound adjusted provider observation; no synthetic factor";
    }
    bar.openObserved = true;
    bar.volumeObserved = true;
    fieldEvidence.openObserved = fieldEvidence.volumeObserved =
      "Explicit provider OHLCV observation";
    if (
      numeric(fields.tradingValue) !== old.tradingValue ||
      !sameSourceRow(["tradingValue", "tradingValueSource"])
    )
      throw new Error("Raw trading-value operand/provenance mismatch");
    if (fields.tradingValueSource === "CLOSE_X_VOLUME_PROXY") {
      if (
        !sameSourceRow(["tradingValue", "tradingValueSource", "close", "volume"]) ||
        old.tradingValue !== old.close * old.volume
      )
        throw new Error("Original trading-value proxy formula/row lineage not established");
      bar.tradingValue = bar.close * bar.volume;
      fieldEvidence.tradingValue =
        "Counterfactual collector CLOSE_X_VOLUME_PROXY from exact new OHLCV; not observed cash turnover";
    } else if (fields.tradingValueSource !== "KRX_STOCK")
      throw new Error("Unknown trading-value provenance; no silent stale proxy retention");
    for (const [valueKey, quantityKey] of [
      ["foreignNetBuyValue", "foreignNetBuyVolume"],
      ["institutionNetBuyValue", "institutionNetBuyVolume"],
    ]) {
      if (old[valueKey] === null) {
        bar[valueKey] = null;
        continue;
      }
      if (
        numeric(fields[valueKey]) !== old[valueKey] ||
        !sameSourceRow([valueKey, "investorValueSource"])
      )
        throw new Error("Raw investor-value operand/provenance mismatch");
      if (fields.investorValueSource === "TOSS_NET_VOLUME_X_CLOSE_PROXY") {
        const quantity = numeric(fields[quantityKey]);
        if (
          quantity === null ||
          fields.investorVolumeSource !== "TOSS_KRX_NXT" ||
          !sameSourceRow([
            valueKey,
            "investorValueSource",
            quantityKey,
            "investorVolumeSource",
            "close",
          ]) ||
          old[valueKey] !== quantity * old.close
        )
          throw new Error("Original investor proxy tag/quantity/formula not established");
        bar[valueKey] = quantity * bar.close;
        fieldEvidence[valueKey] =
          "Counterfactual TOSS_NET_VOLUME_X_CLOSE_PROXY; unchanged native quantity from " +
          original.sourceByField[quantityKey] +
          "; not economic cash equivalence";
      } else if (fields.investorValueSource !== "KRX_STOCK")
        throw new Error("Unknown or partially mixed investor-value provenance");
    }
    // Market cap, actual monetary KRX values, independent short-rate/lending observations and raw share quantities are unchanged.
    for (const key of [
      "marketCap",
      "foreignNetBuyValue",
      "institutionNetBuyValue",
      "shortSellingVolumeRate",
      "lendingBalanceQuantity",
    ])
      if (!Object.hasOwn(bar, key)) bar[key] = null;
    for (const difference of differences(old, bar)) {
      const key = difference.path.slice(2);
      if (!fieldEvidence[key])
        fieldEvidence[key] = "Preserved explicit missing independent observation; no estimate";
    }
    return {
      date,
      oldAnalyticalHash: analytical ? hash(analytical) : null,
      oldObservedHash: observed ? hash(observed) : null,
      bar,
      fieldEvidence,
      retainedFieldVintage: {
        marketCapSource: fields.marketCapSource ?? null,
        shortUpdatedAt: fields.shortUpdatedAt ?? null,
        lendingUpdatedAt: fields.lendingUpdatedAt ?? null,
        investorUpdatedAt: fields.investorUpdatedAt ?? null,
      },
      untouchedRawQuantities: Object.fromEntries(
        ["foreignNetBuyVolume", "institutionNetBuyVolume", "listedShares", "krxListedShares"].map(
          (key) => [key, fields[key] ?? null],
        ),
      ),
    };
  });
  return {
    version: "reviewed-kr-analytical-overlay-preflight-v1",
    symbol: scope.symbol,
    baseDatasetHash: hash(base),
    captureManifestHash: scope.captureManifestHash,
    policy: "TAGGED_COLLECTOR_PROXY_V1_RETAIN_INDEPENDENT",
    counterfactual: true,
    economicCashEquivalenceClaim: false,
    unresolved: [],
    rows,
  };
}
export function verifyCapturePlan(
  base: any,
  plan: any,
  manifest: any,
  rows: any[],
  rawPages: Array<{ name: string; raw: Buffer }>,
  manifestByteHash: string,
  scope: PreflightScope,
) {
  const SYMBOL = scope.symbol;
  if (
    (plan && plan.captureManifestHash !== "sha256:" + manifestByteHash.replace(/^sha256:/, "")) ||
    manifest.status !== "CAPTURED_REVIEW_REQUIRED" ||
    manifest.symbol !== SYMBOL ||
    manifest.adjusted !== true ||
    manifest.rows !== 360 ||
    manifest.lastDate !== scope.captureThroughDate ||
    !Array.isArray(rows) ||
    rows.length !== 360 ||
    (plan && !Array.isArray(plan.rows))
  )
    throw new Error("Complete exact capture manifest/overlay binding required");
  const capture = new Map<string, any>();
  const expectedPages = Object.keys(manifest.artifacts)
    .filter((name) => /^provider-page-\d+\.json$/.test(name))
    .sort();
  if (!equal(rawPages.map((p) => p.name).sort(), expectedPages))
    throw new Error("All original provider pages required");
  for (const page of rawPages) {
    const proof = manifest.artifacts[page.name];
    if (sha(page.raw) !== proof.sha256 || page.raw.length !== proof.bytes)
      throw new Error("Provider page hash/size mismatch");
    const body = JSON.parse(page.raw.toString("utf8"));
    for (const envelope of [body, body.result])
      if (
        !envelope ||
        (envelope.symbol !== undefined && envelope.symbol !== SYMBOL) ||
        (envelope.currency !== undefined && envelope.currency !== "KRW")
      )
        throw new Error("Provider page identity mismatch");
    if (!Array.isArray(body.result.candles) || body.result.candles.length !== proof.responseCandles)
      throw new Error("Provider candle count mismatch");
    for (const raw of body.result.candles) {
      if (
        (raw.symbol !== undefined && raw.symbol !== SYMBOL) ||
        (raw.currency !== undefined && raw.currency !== "KRW") ||
        !/(Z|[+-]\d\d:\d\d)$/.test(raw.timestamp)
      )
        throw new Error("Provider candle identity/timezone mismatch");
      const instant = Date.parse(raw.timestamp);
      if (!Number.isFinite(instant)) throw new Error("Invalid provider timestamp");
      const date = new Date(instant + 9 * 3600 * 1000).toISOString().slice(0, 10);
      const row: any = { symbol: SYMBOL, date };
      for (const [field, provider] of [
        ["open", "openPrice"],
        ["high", "highPrice"],
        ["low", "lowPrice"],
        ["close", "closePrice"],
        ["volume", "volume"],
      ]) {
        row[field] = numeric(raw[provider]);
        if (row[field] === null) throw new Error("Invalid provider OHLCV");
      }
      if (
        date > manifest.lastDate ||
        row.volume < 0 ||
        Math.min(row.open, row.high, row.low, row.close) <= 0 ||
        row.low > Math.min(row.open, row.close) ||
        row.high < Math.max(row.open, row.close)
      )
        throw new Error("Invalid provider candle");
      if (capture.has(date) && !equal(capture.get(date), row))
        throw new Error("Conflicting provider duplicate");
      capture.set(date, row);
    }
  }
  const latest360 = [...capture.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-360);
  const numericRows = rows.map((r) =>
    Object.fromEntries(
      Object.entries(r).map(([k, v]) => [k, ["symbol", "date"].includes(k) ? v : Number(v)]),
    ),
  );
  if (
    !equal(latest360, numericRows) ||
    latest360[0]?.date !== manifest.firstDate ||
    latest360.at(-1)?.date !== manifest.lastDate
  )
    throw new Error("Original raw responses do not reproduce normalized capture360");
  if (!plan) return capture;
  const baselineDates = [
    ...new Set(
      ["bars", "observedBars"].flatMap((field) =>
        (base[field]?.[SYMBOL] ?? []).map((b: any) => b.tradeDate),
      ),
    ),
  ].sort();
  if (
    !equal(plan.rows.map((r: any) => r.date).sort(), baselineDates) ||
    baselineDates.some((d) => !capture.has(d as string))
  )
    throw new Error(
      "Every existing analytical date must be covered exactly; no implicit new history, truncation or mixed-basis tail",
    );
  const seen = new Set();
  for (const item of plan.rows) {
    const raw = capture.get(item.date);
    if (!raw || raw.symbol !== SYMBOL || seen.has(item.date))
      throw new Error("Overlay dates do not equal complete capture");
    seen.add(item.date);
    for (const field of ["open", "high", "low", "close", "volume"])
      if (!Number.isFinite(Number(raw[field])) || Number(raw[field]) !== item.bar?.[field])
        throw new Error("Overlay OHLCV differs from provider capture");
    if (item.bar.openObserved !== true || item.bar.volumeObserved !== true)
      throw new Error("Captured OHLCV must retain observed flags");
  }
  return capture;
}
export function overlayDataset(base: any, plan: any, scope: PreflightScope) {
  const SYMBOL = scope.symbol;
  if (
    plan?.version !== "reviewed-kr-analytical-overlay-preflight-v1" ||
    plan.symbol !== SYMBOL ||
    plan.baseDatasetHash !== hash(base) ||
    !Array.isArray(plan.rows) ||
    !plan.rows.length ||
    !Array.isArray(plan.unresolved) ||
    plan.unresolved.length ||
    !/^sha256:[a-f0-9]{64}$/.test(plan.captureManifestHash)
  )
    throw new Error("Unresolved/unbound analytical overlay plan");
  const copy = structuredClone(base);
  const seen = new Set();
  const known = new Set(base.instruments.map((x: any) => x.symbol));
  if (!known.has(SYMBOL) || !copy.observedBars?.[SYMBOL])
    throw new Error("Existing symbol/observed history required");
  for (const item of plan.rows) {
    if (
      !checkDate(item.date) ||
      item.date > scope.captureThroughDate ||
      seen.has(item.date) ||
      item.bar?.tradeDate !== item.date
    )
      throw new Error("Invalid/duplicate overlay date");
    seen.add(item.date);
    for (const key of ["open", "high", "low", "close", "volume", "tradingValue"])
      if (typeof item.bar[key] !== "number" || !Number.isFinite(item.bar[key]))
        throw new Error("Incomplete full canonical overlay bar");
    if (
      Math.min(item.bar.open, item.bar.high, item.bar.low, item.bar.close) <= 0 ||
      item.bar.volume < 0 ||
      item.bar.low > Math.min(item.bar.open, item.bar.close) ||
      item.bar.high < Math.max(item.bar.open, item.bar.close)
    )
      throw new Error("Invalid overlay OHLCV");
    for (const key of [
      "marketCap",
      "foreignNetBuyValue",
      "institutionNetBuyValue",
      "shortSellingVolumeRate",
      "lendingBalanceQuantity",
    ])
      if (
        !Object.hasOwn(item.bar, key) ||
        (item.bar[key] !== null && !Number.isFinite(item.bar[key]))
      )
        throw new Error("Non-price evidence must be explicit, never silently inherited");
    for (const [field, expectedKey] of [
      ["bars", "oldAnalyticalHash"],
      ["observedBars", "oldObservedHash"],
    ] as const) {
      const values = copy[field][SYMBOL];
      const old = values.filter((x: any) => x.tradeDate === item.date);
      if (old.length > 1 || (old[0] ? hash(old[0]) : null) !== item[expectedKey])
        throw new Error("Overlay predecessor does not match: " + field + "/" + item.date);
      const changed = differences(old[0] ?? {}, item.bar).map((x) => x.path.slice(2));
      if (changed.some((key) => !item.fieldEvidence?.[key]?.trim()))
        throw new Error("Every changed/new field requires explicit provenance");
      copy[field][SYMBOL] = [
        ...values.filter((x: any) => x.tradeDate !== item.date),
        structuredClone(item.bar),
      ].sort((a: any, b: any) => a.tradeDate.localeCompare(b.tradeDate));
    }
  }
  // Do not update unrelated universe, index, ETF, source times, capabilities, or old execution archives.
  return copy;
}
async function validatePublication(p: any, date: string) {
  const { stateHash, canonicalPayload, ...body } = p;
  if (
    p.receipt.date !== date ||
    hash(body) !== stateHash ||
    canonicalSeriesJson(body) !== canonicalPayload
  )
    throw new Error("Frozen integrated publication integrity/date mismatch");
  await verifyIntegratedAllocationLedger(p.result);
  const { stateHash: innerHash, ...inner } = p.result;
  if (hash(inner) !== innerHash || canonicalSeriesJson(inner) !== p.resultCanonicalPayload)
    throw new Error("Frozen integrated inner integrity mismatch");
}
async function buildEvidence(dataset: any, config: any, frozen: any, TARGET: string) {
  const sliced = sliceKrDatasetForReplay(dataset, TARGET);
  const analyzed = analyzeKrReplayDataset(sliced, config);
  if (analyzed.analysis.asOfDate !== TARGET) throw new Error("Wrong replay analysis date");
  const snapshot = { ...buildSnapshot(analyzed.analysis), savedAt: frozen.clock.availableAt };
  const dated = currentDateEvidence(analyzed.dataset, snapshot);
  const sourceHash = await hashSeriesValue(dated);
  const rebuilt = prepareIntegratedKrEvidence(analyzed.dataset, analyzed.analysis, {
    ...frozen.clock,
    sourceHash,
  });
  return { evidence: rebuilt, dated, snapshot, datasetHash: hash(analyzed.dataset) };
}
export type PreflightPhase =
  | "INPUT_VALIDATION"
  | "SOURCE_VALIDATION"
  | "BASELINE_REPRODUCTION"
  | "CAPTURE_VALIDATION"
  | "OVERLAY_DERIVATION"
  | "CANDIDATE_COMPARISON"
  | "INTEGRATED_COMPARISON"
  | "OUTPUT_VALIDATION";
export async function runKrVintagePreflight(
  inputPath: string,
  outputDir: string,
  phase: (value: PreflightPhase) => void = () => {},
  onPrepared?: (context: any) => Promise<void>,
) {
  phase("INPUT_VALIDATION");
  // This entrypoint runs only inside the isolated reader-free pure child process.
  globalThis.fetch = async () => {
    throw new Error("NETWORK_DISABLED_IN_FILE_ONLY_PREFLIGHT");
  };
  inputHashes.clear();
  if (!inputPath || !outputDir || !path.isAbsolute(outputDir))
    throw new Error("Absolute input manifest and new local output directory required");
  if (fs.existsSync(outputDir)) throw new Error("Output directory must be new; no overwrite");
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const scope: PreflightScope = input.scope;
  verifyScope(scope);
  const TARGET = scope.targetDate,
    SYMBOL = scope.symbol;
  if (input.version !== "kr-adjusted-replay-preflight-v1" || input.date !== TARGET)
    throw new Error("Unsupported preflight input scope");
  if (!Number.isFinite(Date.parse(input.calculatedAt)))
    throw new Error("Explicit calculation time required");
  inputHashes.set(path.resolve(inputPath), sha(fs.readFileSync(inputPath)));
  const frozen = evidence(input.krEvidence26);
  if (frozen.version !== "integrated-kr-daily-evidence-v1" || frozen.date !== TARGET)
    throw new Error("Wrong frozen KR evidence");
  const cal = await octoberModelCalendar("KR", OCTOBER_CALENDAR_EVIDENCE.coverageEnd);
  if (
    frozen.clock.openAt !== regularOpenAt("KR", TARGET) ||
    frozen.clock.closeAt !== regularCloseAt("KR", TARGET) ||
    !equal(frozen.clock.calendar, { sourceHash: cal.sourceHash, sessions: cal.regularSessions })
  )
    throw new Error("Frozen evidence calendar/hours mismatch");
  const run = read(input.frozenRun),
    roster = read(input.frozenSourceRoster);
  if (
    run.id !== scope.expectedRun.id ||
    run.code_version !== scope.expectedRun.codeVersion ||
    run.data_version !== scope.expectedRun.dataVersion ||
    !Array.isArray(roster) ||
    roster.length !== scope.expectedRun.sourceCount ||
    !run.config ||
    input.dataset
  )
    throw new Error(
      "Authoritative frozen run/source roster required; arbitrary dataset bypass prohibited",
    );
  if (
    !equal(
      input.sources?.map((s: any) => s.id),
      roster.map((s: any) => s.id),
    ) ||
    "sha256:" +
      sha(
        roster
          .map((s: any) => s.data_hash)
          .sort()
          .join("\n"),
      ) !==
      run.data_version
  )
    throw new Error("Frozen source order/aggregate data-version mismatch");
  const config = run.config;
  phase("SOURCE_VALIDATION");
  const values: string[] = [],
    rawOperands = new Map<string, RawDatedEvidence>();
  for (let i = 0; i < roster.length; i++) {
    const record = roster[i],
      ref = input.sources[i];
    if ("sha256:" + ref.sha256.replace(/^sha256:/, "") !== record.file_hash)
      throw new Error("Source bytes not bound by frozen registry");
    const stored = bytes(ref);
    if (
      !/^sha256:[a-f0-9]{64}$/.test(record.schema_hash) ||
      typeof record.canonical_format !== "string" ||
      typeof record.content_type !== "string"
    )
      throw new Error("Complete typed source schema/compression metadata required");
    const gzip =
      record.canonical_format.toLowerCase() === "csv.gz" ||
      record.storage_path.endsWith(".gz") ||
      /gzip/i.test(record.content_type);
    const logical = gzip ? gunzipSync(stored) : stored;
    const validation = await validateSourceBytes({
      bytes: logical,
      filename: record.original_filename,
      streamingCsv: true,
    });
    if (
      !validation.valid ||
      validation.dataHash !== record.data_hash ||
      validation.schemaHash !== record.schema_hash
    )
      throw new Error("Canonical source validation/data/schema hash mismatch");
    values.push(validation.canonicalCsv);
    collectRawEvidence(validation.canonicalCsv, scope.symbol, record.id, rawOperands);
  }
  const dataset = parseManualMarketDataWithReferences(values).dataset;
  if (dataset.asOfDate !== scope.baselineAsOfDate)
    throw new Error("Exact frozen FINAL dataset date required");
  phase("BASELINE_REPRODUCTION");
  const base = await buildEvidence(dataset, config, frozen, TARGET);
  const report: any = {
    version: "kr-adjusted-replay-preflight-result-v1",
    mode: "LOCAL_FILE_ONLY",
    date: TARGET,
    counterfactual: true,
    historicalAvailabilityClaim: false,
    createdAt: new Date().toISOString(),
    sourceDatasetHash: hash(dataset),
    operationalApproval: false,
    baselineEvidence: comparison(frozen, base.evidence),
    baselineSourceHashMatches: frozen.clock.sourceHash === hash(base.dated),
  };
  fs.mkdirSync(outputDir);
  function save(name: string, value: any) {
    fs.writeFileSync(path.join(outputDir, name), JSON.stringify(value, null, 2) + "\n", {
      flag: "wx",
    });
  }
  save("rebuilt-baseline-kr.json", { hash: hash(base.evidence), payload: base.evidence });
  save("baseline-current-date-evidence.json", base.dated);
  save("baseline-dataset-identity.json", {
    hash: hash(dataset),
    symbol: SYMBOL,
    analyticalBars: dataset.bars[SYMBOL],
    observedBars: dataset.observedBars?.[SYMBOL],
  });
  if (!report.baselineEvidence.equal || !report.baselineSourceHashMatches) {
    report.status = "BLOCKED_BASELINE_NOT_REPRODUCED";
  } else if (!input.fieldPolicy) {
    report.status = "BASELINE_REPRODUCED_OVERLAY_PENDING";
  } else {
    if (input.fieldPolicy !== "TAGGED_COLLECTOR_PROXY_V1_RETAIN_INDEPENDENT" || input.overlayPlan)
      throw new Error("Unsupported or caller-replaced normalization policy");
    phase("CAPTURE_VALIDATION");
    const captureManifest = read(input.captureManifest),
      captureRows = read(input.captureRows);
    const captureBytes = bytes(input.captureRows);
    if (captureManifest.artifacts?.[scope.normalizedArtifactName]?.sha256 !== sha(captureBytes))
      throw new Error("Normalized capture is not bound by provider capture manifest");
    if (
      scope.captureManifestHash !==
        "sha256:" + input.captureManifest.sha256.replace(/^sha256:/, "") ||
      !Number.isFinite(Date.parse(captureManifest.finishedAt)) ||
      Date.parse(input.calculatedAt) < Date.parse(captureManifest.finishedAt)
    )
      throw new Error("Capture scope/time binding mismatch");
    const rawPages = input.captureRawPages.map((ref: Ref & { name: string }) => ({
      name: ref.name,
      raw: bytes(ref),
    }));
    const capture = verifyCapturePlan(
      dataset,
      null,
      captureManifest,
      captureRows,
      rawPages,
      input.captureManifest.sha256,
      scope,
    );
    phase("OVERLAY_DERIVATION");
    const plan = deriveCollectorOverlay(dataset, capture, rawOperands, scope);
    verifyCapturePlan(
      dataset,
      plan,
      captureManifest,
      captureRows,
      rawPages,
      input.captureManifest.sha256,
      scope,
    );
    save("derived-overlay-plan.json", plan);
    const candidateDataset = overlayDataset(dataset, plan, scope);
    phase("CANDIDATE_COMPARISON");
    const candidate = await buildEvidence(candidateDataset, config, frozen, TARGET);
    report.candidateEvidence = comparison(frozen, candidate.evidence);
    report.currentDateEvidence = comparison(base.dated, candidate.dated);
    report.snapshotEntries = comparison(base.snapshot.entries, candidate.snapshot.entries);
    report.changedSymbols = [
      ...new Set(
        report.snapshotEntries.differences
          .map((d: any) => {
            const i = Number(d.path.split("/")[1]);
            return [base.snapshot.entries[i]?.symbol, candidate.snapshot.entries[i]?.symbol].filter(
              Boolean,
            );
          })
          .flat(),
      ),
    ];
    save("candidate-kr.json", { hash: hash(candidate.evidence), payload: candidate.evidence });
    save("candidate-current-date-evidence.json", candidate.dated);
    if (!input.integrated) report.status = "EVIDENCE_COMPARED_INTEGRATED_REPLAY_INPUTS_PENDING";
    else {
      phase("INTEGRATED_COMPARISON");
      const history = input.integrated.krHistory
        .map(evidence)
        .sort((a: any, b: any) => a.date.localeCompare(b.date));
      const priorUs = evidence(input.integrated.usPrevious),
        us = evidence(input.integrated.usCurrent);
      const previousDate = cal.regularSessions.filter((d) => d < TARGET).at(-1);
      if (!previousDate) throw new Error("Prior completed session required");
      if (priorUs.analysis.date !== previousDate || us.analysis.date !== TARGET)
        throw new Error("Wrong immutable US dates");
      report.books = {};
      for (const kind of ["O1", "S07"]) {
        const prior = read(input.integrated.books[kind].previous),
          completed = read(input.integrated.books[kind].completed);
        await validatePublication(prior, previousDate);
        await validatePublication(completed, TARGET);
        if (
          prior.registry.policy.kind !== kind ||
          completed.previousStateHash !== prior.stateHash ||
          !equal(prior.registry, completed.registry)
        )
          throw new Error("Frozen integrated parent/registry mismatch");
        const make = async (kr: any) => {
          const sessions = [
            adaptIntegratedKrEvidence(prior.result, { market: "K", evidence: kr, history }),
            adaptIntegratedKrEvidence(prior.result, { market: "E", evidence: kr, history }),
            adaptIntegratedUsSession(prior.result, {
              analysis: us.analysis,
              previousAnalysis: priorUs.analysis,
              clock: us.clock,
            }),
          ];
          const publication = await prepareIntegratedDailyPublication({
            registry: prior.registry,
            previous: prior,
            date: TARGET,
            sessions,
            now: input.calculatedAt,
          });
          return { sessions, publication };
        };
        const old = await make(frozen);
        const next = await make(candidate.evidence);
        const reproduced = comparison(completed, old.publication);
        const sessionsComparison = comparison(old.sessions, next.sessions);
        const withoutSourceHash = (s: any) => {
          const { sourceHash, ...rest } = s;
          return rest;
        };
        const sameEconomicSessionInputs = equal(
          old.sessions.map(withoutSourceHash),
          next.sessions.map(withoutSourceHash),
        );
        report.books[kind] = {
          baselineReproduced: reproduced,
          sessionInputs: sessionsComparison,
          sessionInputsEqualExceptSourceHash: sameEconomicSessionInputs,
          candidatePublication: comparison(completed, next.publication),
          note: "Source-hash-only equivalence is diagnostic, not permission to bypass immutable evidence or rewrite completed sessions.",
        };
        save(kind + "-baseline.json", old.publication);
        save(kind + "-candidate.json", next.publication);
        save(kind + "-session-inputs.json", { baseline: old.sessions, candidate: next.sessions });
      }
      report.status = Object.values(report.books).every((b: any) => b.baselineReproduced.equal)
        ? "PREFLIGHT_COMPARED_NO_OPERATIONAL_APPROVAL"
        : "BLOCKED_INTEGRATED_BASELINE_NOT_REPRODUCED";
      if (onPrepared) {
        if (report.status !== "PREFLIGHT_COMPARED_NO_OPERATIONAL_APPROVAL")
          throw new Error("Preparation requires exact baseline");
        await onPrepared({
          input,
          dataset,
          candidateDataset,
          config,
          scope,
          plan,
          rawOperands,
          frozen,
          candidateEvidence: candidate.evidence,
          captureManifest,
          values,
          history,
          priorUs,
          us,
          report,
          read,
          evidence,
        });
      }
    }
  }
  phase("OUTPUT_VALIDATION");
  for (const [file, digest] of inputHashes)
    if (sha(fs.readFileSync(file)) !== digest)
      throw new Error("Input mutated during preflight: " + file);
  report.inputs = [...inputHashes].map(([path, sha256]) => ({ path, sha256 }));
  save("report.json", report);
  return report;
}
