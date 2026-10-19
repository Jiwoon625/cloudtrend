/** Latest reference-only revisions. No original source/history, portfolio, or Shadow writes. */
import { sha256, stableJson } from "./analysis-run-store";
import {
  parseUsProspectiveCsv,
  runUsProspectiveAnalysis,
  US_PROSPECTIVE_RULE_VERSION,
  type UsProspectivePreviousState,
} from "../src/lib/engine/usProspective";
import { compactRow } from "./us-screening-publication";
import { assertUsScreeningCoverage } from "./us-replay-source";
import { usBrowserViews } from "../src/lib/usBrowserViews";
import type { UsProspectiveCache } from "../src/lib/usProspectiveCloud";

export const revisionHash = (text: string) => `sha256:${sha256(text)}`;
const isHash = (v: unknown): v is string =>
  typeof v === "string" && /^sha256:[a-f0-9]{64}$/.test(v);
export interface RevisionSource {
  version: "us-same-session-source-v1";
  userId: string;
  date: string;
  originalDataHash: string;
  revisionDataHash: string;
  collectedAt: string;
  rowCount: number;
  symbolCount: number;
  metadata: Record<string, unknown>;
}
export interface RevisionPointer {
  version: "us-same-session-pointer-v1";
  userId: string;
  date: string;
  originalDataHash: string;
  revisionDataHash: string;
  collectedAt: string;
  bundlePath: string;
  bundleHash: string;
}
export interface RevisionOriginal {
  date: string;
  dataHash: string;
  ruleVersion: string;
  csv: string;
  result: UsProspectiveCache;
  previousState: UsProspectivePreviousState;
}
export interface RevisionIO {
  read(path: string): Promise<string | null>;
  /** Must insert with upsert:false, or compare exact existing bytes; never replace. */
  immutable(path: string, bytes: string): Promise<void>;
  /** Only mutable write permitted. Caller serializes with ordinary US workflow. */
  pointer(path: string, bytes: string): Promise<void>;
  original(): Promise<RevisionOriginal>;
}
export function revisionPaths(s: RevisionSource) {
  const hex = s.revisionDataHash.slice(7);
  return {
    source: `${s.userId}/us-screening-revisions/${s.date}/${hex}/source.json`,
    csv: `${s.userId}/us-screening-revisions/${s.date}/${hex}/input.csv`,
    bundle: `${s.userId}/results/us-screening-revisions/${s.date}/${hex}/bundle.json`,
    pointer: `${s.userId}/cache/us-screening-revisions/latest.json`,
  };
}
export function validateRevisionSource(value: unknown, uid: string): RevisionSource {
  const s = value as RevisionSource;
  if (
    !s ||
    s.version !== "us-same-session-source-v1" ||
    s.userId !== uid ||
    !/^[a-f0-9-]{36}$/.test(uid) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(s.date) ||
    new Date(`${s.date}T00:00:00Z`).toISOString().slice(0, 10) !== s.date ||
    !isHash(s.originalDataHash) ||
    !isHash(s.revisionDataHash) ||
    s.originalDataHash === s.revisionDataHash ||
    !Number.isFinite(Date.parse(s.collectedAt)) ||
    !Number.isInteger(s.rowCount) ||
    s.rowCount < 1 ||
    !Number.isInteger(s.symbolCount) ||
    s.symbolCount !== s.rowCount ||
    !s.metadata ||
    s.metadata["confirmedRegularClose"] !== true ||
    s.metadata["failedSymbols"] !== 0 ||
    typeof s.metadata["sourceCoverageComplete"] !== "boolean"
  )
    throw new Error("Invalid same-session revision source");
  let exclusions = 0;
  for (const key of ["providerGapSymbols", "lifecycleExcludedSymbols"]) {
    const values = s.metadata[key] ?? [];
    if (
      !Array.isArray(values) ||
      values.some((v) => typeof v !== "string" || !/^[A-Z0-9.^-]+$/.test(v)) ||
      new Set(values).size !== values.length
    )
      throw new Error(`Invalid revision exclusion evidence: ${key}`);
    exclusions += values.length;
  }
  for (const key of ["guardedCandidateQuarantine", "guardedCandidateScoringHolds"]) {
    const values = s.metadata[key] ?? {};
    if (!values || typeof values !== "object" || Array.isArray(values))
      throw new Error(`Invalid revision hold evidence: ${key}`);
    exclusions += Object.keys(values).length;
  }
  if (exclusions && s.metadata["sourceCoverageComplete"] !== false)
    throw new Error("Revision coverage contradicts exclusions/holds");
  return s;
}
function assertOriginal(s: RevisionSource, o: RevisionOriginal) {
  if (
    o.date !== s.date ||
    o.dataHash !== s.originalDataHash ||
    revisionHash(o.csv) !== o.dataHash ||
    o.ruleVersion !== US_PROSPECTIVE_RULE_VERSION ||
    o.result.dataHash !== o.dataHash ||
    o.result.analysis.date !== s.date ||
    o.result.analysis.ruleVersion !== o.ruleVersion
  )
    throw new Error("Revision requires the current completed immutable original");
  if (Date.parse(s.collectedAt) <= Date.parse(o.result.source.collectedAt))
    throw new Error("Revision collection predates original");
  if (
    o.previousState.lastDate &&
    (o.previousState.lastDate >= s.date ||
      o.previousState.lastDate !== s.metadata["previousSessionDate"])
  )
    throw new Error("Revision predecessor must be strict original prior session");
}
function csvCells(line: string): string[] {
  const cells: string[] = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') {
      if (quoted && line[i + 1] === '"') {
        value += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === "," && !quoted) {
      cells.push(value);
      value = "";
    } else value += c;
  }
  if (quoted) throw new Error("Invalid revision CSV quoting");
  cells.push(value);
  return cells;
}
function assertRawCsv(csv: string, original: string) {
  const lines = csv
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim());
  const header = csvCells(lines[0]!);
  if (
    stableJson(header) !== stableJson(csvCells(original.trim().split(/\r?\n/)[0]!)) ||
    new Set(header).size !== header.length
  )
    throw new Error("Revision CSV schema differs from original");
  const required = [
    "open",
    "high",
    "low",
    "close",
    "volume",
    "dollar_volume",
    "ret120",
    "ret252",
    "beta60_spy",
    "ichimoku_tk_gap",
    "relvol1_20",
    "adv20_usd",
    "amihud20",
  ];
  if (required.some((key) => !header.includes(key)))
    throw new Error("Revision numeric columns missing");
  for (const line of lines.slice(1)) {
    const values = csvCells(line);
    if (values.length !== header.length) throw new Error("Revision CSV field count mismatch");
    for (const key of required) {
      const value = values[header.indexOf(key)]!.trim();
      if (value && !Number.isFinite(Number(value)))
        throw new Error(`Invalid revision number: ${key}`);
    }
    for (const key of ["active20", "toss_tradable", "is_common_share"]) {
      const value = values[header.indexOf(key)]?.trim() ?? "";
      if (!/^(true|false|1|0|y|n|yes|no|t|f)$/i.test(value))
        throw new Error(`Invalid revision boolean: ${key}`);
    }
  }
}
export async function publishSameSessionRevision(
  io: RevisionIO,
  uid: string,
  manifestPath: string,
  manifestHash: string,
) {
  // Check owner/path before reading. No externally supplied arbitrary path is accepted.
  if (
    !manifestPath.startsWith(`${uid}/us-screening-revisions/`) ||
    !isHash(manifestHash) ||
    /[\\%?#]/.test(manifestPath) ||
    manifestPath.includes("..")
  )
    throw new Error("Invalid revision manifest address");
  const raw = await io.read(manifestPath);
  if (!raw || revisionHash(raw) !== manifestHash)
    throw new Error("Revision source manifest hash mismatch");
  const source = validateRevisionSource(JSON.parse(raw), uid);
  const paths = revisionPaths(source);
  if (manifestPath !== paths.source)
    throw new Error("Revision manifest is not at its exact content-addressed path");
  const csv = await io.read(paths.csv);
  if (!csv || revisionHash(csv) !== source.revisionDataHash)
    throw new Error("Revision CSV hash mismatch");
  const original = await io.original();
  assertOriginal(source, original);
  assertRawCsv(csv, original.csv);
  const rows = parseUsProspectiveCsv(csv);
  if (
    csv
      .trim()
      .split(/\r?\n/)
      .filter((line) => line.trim()).length -
      1 !==
      source.rowCount ||
    rows.length !== source.rowCount ||
    new Set(rows.map((r) => r.symbol)).size !== source.symbolCount ||
    rows.some((r) => r.date !== source.date)
  )
    throw new Error("Revision date/count/duplicate symbol mismatch");
  const base = parseUsProspectiveCsv(original.csv);
  const oldSymbols = new Set(base.map((r) => r.symbol));
  const symbols = new Set(rows.map((r) => r.symbol));
  const excludedList = source.metadata["lifecycleExcludedSymbols"] ?? [];
  if (!Array.isArray(excludedList) || excludedList.some((v) => typeof v !== "string"))
    throw new Error("Invalid lifecycle exclusions");
  const excluded = new Set(excludedList as string[]);
  const originalExcluded = new Set(
    (original.result.source.metadata["lifecycleExcludedSymbols"] ?? []) as string[],
  );
  if (
    [...excluded].some((symbol) => !originalExcluded.has(symbol)) ||
    [...originalExcluded].some((symbol) => !excluded.has(symbol))
  )
    throw new Error("Revision cannot introduce unreviewed lifecycle exclusions");
  if (
    rows.some((r) => !oldSymbols.has(r.symbol)) ||
    base.some((r) => !symbols.has(r.symbol) && !excluded.has(r.symbol))
  )
    throw new Error("Revision cannot silently change original universe");
  const mutable = new Set([
    "open",
    "high",
    "low",
    "close",
    "volume",
    "dollarVolume",
    "ret120",
    "ret252",
    "beta60Spy",
    "ichimokuTkGap",
    "relvol1_20",
    "adv20Usd",
    "amihud20",
    "active20",
  ]);
  const byOriginalSymbol = new Map(base.map((row) => [row.symbol, row]));
  for (const row of rows) {
    const old = byOriginalSymbol.get(row.symbol)!;
    for (const key of Object.keys(row) as (keyof typeof row)[]) {
      if (
        key === "marketCap" &&
        row.marketCap !== old.marketCap &&
        old.sharesOutstanding !== null &&
        row.close !== null &&
        old.sharesOutstanding > 0 &&
        row.marketCap !== null &&
        Math.abs(row.marketCap - row.close * old.sharesOutstanding) <=
          Math.max(1e-8, Math.abs(row.close * old.sharesOutstanding) * 1e-10)
      )
        continue;
      if (!mutable.has(key) && row[key] !== old[key])
        throw new Error(
          `Revision cannot change original identity/roster field: ${row.symbol}/${key}`,
        );
    }
  }
  if (!rows.some((r) => r.symbol === "SPY" && r.close !== null && r.close > 0))
    throw new Error("Revision SPY missing");
  // Reviewed lifecycle exclusions may be absent from the active-only CSV. Other quarantines/holds must retain blank rows.
  assertUsScreeningCoverage(source.metadata, [
    ...rows,
    ...base.filter((row) => excluded.has(row.symbol) && !symbols.has(row.symbol)),
  ]);
  const blanked = new Set([
    ...((source.metadata["providerGapSymbols"] as string[]) ?? []),
    ...excluded,
    ...Object.keys((source.metadata["guardedCandidateQuarantine"] as object) ?? {}),
  ]);
  for (const row of rows) {
    if (blanked.has(row.symbol)) continue;
    const { open, high, low, close, volume } = row;
    if (
      open === null ||
      high === null ||
      low === null ||
      close === null ||
      volume === null ||
      open <= 0 ||
      high <= 0 ||
      low <= 0 ||
      close <= 0 ||
      volume < 0 ||
      high < Math.max(open, close, low) ||
      low > Math.min(open, close, high)
    )
      throw new Error(`Invalid active revision OHLCV: ${row.symbol}`);
  }
  const analysis = runUsProspectiveAnalysis(rows, original.previousState);
  if (analysis.date !== source.date) throw new Error("Revision analysis date mismatch");
  const view: UsProspectiveCache = {
    generatedAt: source.collectedAt,
    dataHash: source.revisionDataHash,
    source: {
      provider: original.result.source.provider,
      collectedAt: source.collectedAt,
      schemaVersion: original.result.source.schemaVersion,
      metadata: {
        ...source.metadata,
        sameSessionRevision: true,
        originalDataHash: source.originalDataHash,
        referenceOnly: true,
      },
    },
    analysis: {
      date: analysis.date,
      ruleVersion: analysis.ruleVersion,
      summary: analysis.summary,
      rows: analysis.rows.map(compactRow),
    },
  };
  const bundle = {
    version: "us-same-session-bundle-v1",
    userId: uid,
    date: source.date,
    originalDataHash: source.originalDataHash,
    revisionDataHash: source.revisionDataHash,
    collectedAt: source.collectedAt,
    view,
    ...usBrowserViews(view),
  };
  const bytes = stableJson(bundle);
  const pointer: RevisionPointer = {
    version: "us-same-session-pointer-v1",
    userId: uid,
    date: source.date,
    originalDataHash: source.originalDataHash,
    revisionDataHash: source.revisionDataHash,
    collectedAt: source.collectedAt,
    bundlePath: paths.bundle,
    bundleHash: revisionHash(bytes),
  };
  const priorRaw = await io.read(paths.pointer);
  const prior = priorRaw ? (JSON.parse(priorRaw) as RevisionPointer) : null;
  if (prior) {
    if (
      prior.version !== pointer.version ||
      prior.userId !== uid ||
      !isHash(prior.revisionDataHash) ||
      !Number.isFinite(Date.parse(prior.collectedAt))
    )
      throw new Error("Existing revision pointer invalid");
    if (
      prior.date > source.date ||
      (prior.date === source.date && Date.parse(prior.collectedAt) > Date.parse(source.collectedAt))
    )
      throw new Error("Stale revision cannot replace newer pointer");
    if (prior.date === source.date && prior.revisionDataHash === source.revisionDataHash) {
      if (stableJson(prior) !== stableJson(pointer) || (await io.read(paths.bundle)) !== bytes)
        throw new Error("Existing revision identity conflict");
      return { status: "already_published", pointer };
    }
    if (prior.date === source.date && prior.collectedAt === source.collectedAt)
      throw new Error("Conflicting revision at identical collection instant");
  }
  await io.immutable(paths.bundle, bytes);
  if ((await io.read(paths.bundle)) !== bytes) throw new Error("Revision bundle readback failed");
  // Recheck both dependencies immediately before the sole commit. Workflow concurrency is shared with ordinary daily processing.
  assertOriginal(source, await io.original());
  if ((await io.read(paths.pointer)) !== priorRaw)
    throw new Error("Revision pointer changed concurrently");
  await io.pointer(paths.pointer, stableJson(pointer));
  if ((await io.read(paths.pointer)) !== stableJson(pointer))
    throw new Error("Revision publication outcome uncertain: inspect pointer before retry");
  return { status: "published", pointer };
}
