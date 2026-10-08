import { nextScheduledUsSession } from "../src/lib/engine/usProspectiveOrderPreview";
import { createHash } from "node:crypto";
import { parseUsProspectiveCsv, type UsProspectiveInputRow } from "../src/lib/engine/usProspective";
import {
  octoberModelCalendar,
  regularCloseAt,
  regularOpenAt,
} from "../src/lib/ledger/octoberShadowCalendar";

export type UsReplayPitKind =
  "ATOMIC_DATED_SNAPSHOT" | "DATED_ROSTER_RECONSTRUCTION" | "REVIEWED_ATOMIC_QUARANTINE";
export interface UsReplaySessionSource {
  date: string;
  previousSessionDate: string;
  storagePath: string;
  dataHash: string;
  rowCount: number;
  symbolCount: number;
  sourceCapturedAt: string;
  confirmedRegularClose: boolean;
  failedSymbols: number;
  sourceCoverageComplete: boolean;
  quarantinedSymbols: string[];
  originalSource?: { storagePath: string; dataHash: string; sourceCapturedAt: string };
  lifecycleQuarantines?: Array<{ symbol: string; effectiveDate: string; evidenceUrls: string[] }>;
  pit: {
    kind: UsReplayPitKind;
    asOfDate: string;
    rosterCapturedAt: string;
    rosterStoragePath: string;
    rosterHash: string;
  };
}
export interface UsReplayManifest {
  version: "us-dated-replay-v1";
  baseDate: string;
  throughDate: string;
  sessions: UsReplaySessionSource[];
}
export interface UsReplayRoster {
  version: "us-dated-roster-v1";
  asOfDate: string;
  capturedAt: string;
  rows: Array<
    Pick<
      UsProspectiveInputRow,
      | "symbol"
      | "name"
      | "market"
      | "sector"
      | "securityType"
      | "status"
      | "currency"
      | "sharesOutstanding"
      | "tossTradable"
      | "isCommonShare"
    >
  >;
}
export interface VerifiedUsReplaySession {
  source: UsReplaySessionSource;
  rows: UsProspectiveInputRow[];
}
export const bytesHash = (value: string | Uint8Array) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const hash = (value: unknown): value is string =>
  typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const date = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const instant = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
export function assertOwnerReplayPath(path: unknown, userId: string) {
  if (
    typeof path !== "string" ||
    !path.startsWith(`${userId}/`) ||
    /[\\?#%]/.test(path) ||
    [...path].some((character) => character.charCodeAt(0) <= 32) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Replay artifacts require an exact owner-private storage path");
}
export async function validateUsReplayManifest(
  value: unknown,
  userId: string,
): Promise<UsReplayManifest> {
  const m = value as UsReplayManifest;
  if (
    !m ||
    m.version !== "us-dated-replay-v1" ||
    !date(m.baseDate) ||
    !date(m.throughDate) ||
    !Array.isArray(m.sessions) ||
    !m.sessions.length ||
    m.sessions.length > 31 ||
    m.baseDate >= m.throughDate
  )
    throw new Error("Invalid bounded US replay manifest");
  const calendar = await octoberModelCalendar("US", m.throughDate);
  if (
    !calendar.regularSessions.includes(m.baseDate) ||
    !calendar.regularSessions.includes(m.throughDate)
  )
    throw new Error("Replay bounds are outside the reviewed regular-session calendar");
  const expected = calendar.regularSessions.filter((d) => d > m.baseDate && d <= m.throughDate);
  if (JSON.stringify(m.sessions.map((s) => s.date)) !== JSON.stringify(expected))
    throw new Error("US replay requires every missing regular session in chronological order");
  let previous = m.baseDate;
  for (const s of m.sessions) {
    assertOwnerReplayPath(s.storagePath, userId);
    assertOwnerReplayPath(s.pit?.rosterStoragePath, userId);
    if (
      !hash(s.dataHash) ||
      !hash(s.pit?.rosterHash) ||
      s.previousSessionDate !== previous ||
      !Number.isSafeInteger(s.rowCount) ||
      s.rowCount < 1 ||
      s.rowCount > 20000 ||
      s.symbolCount !== s.rowCount ||
      !instant(s.sourceCapturedAt) ||
      s.confirmedRegularClose !== true ||
      s.failedSymbols !== 0 ||
      typeof s.sourceCoverageComplete !== "boolean" ||
      !Array.isArray(s.quarantinedSymbols) ||
      new Set(s.quarantinedSymbols).size !== s.quarantinedSymbols.length ||
      s.quarantinedSymbols.some((symbol) => typeof symbol !== "string" || !symbol) ||
      !s.pit ||
      ![
        "ATOMIC_DATED_SNAPSHOT",
        "DATED_ROSTER_RECONSTRUCTION",
        "REVIEWED_ATOMIC_QUARANTINE",
      ].includes(s.pit.kind) ||
      !date(s.pit.asOfDate) ||
      !instant(s.pit.rosterCapturedAt) ||
      s.pit.asOfDate > s.date
    )
      throw new Error(`Invalid US replay source evidence: ${s.date}`);
    if (Date.parse(s.pit.rosterCapturedAt) > Date.parse(s.sourceCapturedAt))
      throw new Error("US replay roster was captured after its claimed source");
    if (Date.parse(s.sourceCapturedAt) < Date.parse(regularCloseAt("US", s.date)))
      throw new Error(`US replay source was captured before the confirmed close: ${s.date}`);
    if (
      s.pit.kind === "ATOMIC_DATED_SNAPSHOT" &&
      (s.pit.asOfDate !== s.date ||
        Date.parse(s.sourceCapturedAt) >=
          Date.parse(regularOpenAt("US", nextScheduledUsSession(s.date))))
    )
      throw new Error(
        "An atomic snapshot must retain its original date and pre-next-open capture; later reconstruction needs dated prior evidence",
      );
    if (s.pit.kind === "REVIEWED_ATOMIC_QUARANTINE") {
      assertOwnerReplayPath(s.originalSource?.storagePath, userId);
      if (
        !s.originalSource ||
        !hash(s.originalSource.dataHash) ||
        !instant(s.originalSource.sourceCapturedAt) ||
        s.pit.asOfDate !== s.date ||
        Date.parse(s.originalSource.sourceCapturedAt) < Date.parse(regularCloseAt("US", s.date)) ||
        Date.parse(s.originalSource.sourceCapturedAt) >=
          Date.parse(regularOpenAt("US", nextScheduledUsSession(s.date))) ||
        Date.parse(s.pit.rosterCapturedAt) > Date.parse(s.originalSource.sourceCapturedAt) ||
        !Array.isArray(s.lifecycleQuarantines) ||
        !s.lifecycleQuarantines.length ||
        new Set(s.lifecycleQuarantines.map((e) => e.symbol)).size !==
          s.lifecycleQuarantines.length ||
        s.lifecycleQuarantines.some(
          (e) =>
            !s.quarantinedSymbols.includes(e.symbol) ||
            !date(e.effectiveDate) ||
            e.effectiveDate > s.date ||
            !Array.isArray(e.evidenceUrls) ||
            !e.evidenceUrls.length ||
            e.evidenceUrls.some(
              (url) => typeof url !== "string" || !/^https:\/\/[^\s]+$/.test(url),
            ),
        )
      )
        throw new Error(
          "Reviewed US quarantine requires original atomic identity and dated lifecycle evidence",
        );
    }
    if (s.sourceCoverageComplete && s.quarantinedSymbols.length)
      throw new Error("US source cannot claim complete coverage with quarantined securities");
    if (
      s.pit.kind === "DATED_ROSTER_RECONSTRUCTION" &&
      Date.parse(s.pit.rosterCapturedAt) > Date.parse(regularCloseAt("US", s.date))
    )
      throw new Error("Future metadata cannot reconstruct an earlier US session");
    previous = s.date;
  }
  return m;
}

/** All source files are read and admitted before planning or persisting any session. */
export async function loadVerifiedUsReplaySessions(
  manifest: UsReplayManifest,
  read: (path: string) => Promise<string>,
): Promise<VerifiedUsReplaySession[]> {
  const verified: VerifiedUsReplaySession[] = [];
  for (const source of manifest.sessions) {
    const csv = await read(source.storagePath);
    if (bytesHash(csv) !== source.dataHash)
      throw new Error(`US replay source hash mismatch: ${source.date}`);
    const rosterText = await read(source.pit.rosterStoragePath);
    if (bytesHash(rosterText) !== source.pit.rosterHash)
      throw new Error(`US replay roster hash mismatch: ${source.date}`);
    const roster = JSON.parse(rosterText) as UsReplayRoster;
    const rows = parseUsProspectiveCsv(csv);
    if (
      rows.length !== source.rowCount ||
      new Set(rows.map((r) => r.symbol)).size !== source.symbolCount ||
      rows.some((r) => r.date !== source.date)
    )
      throw new Error(`US replay date, duplicate symbol or row-count mismatch: ${source.date}`);
    if (
      roster.version !== "us-dated-roster-v1" ||
      roster.asOfDate !== source.pit.asOfDate ||
      roster.capturedAt !== source.pit.rosterCapturedAt ||
      !Array.isArray(roster.rows) ||
      roster.rows.length !== rows.length ||
      new Set(roster.rows.map((r) => r.symbol)).size !== rows.length
    )
      throw new Error(`US replay point-in-time roster mismatch: ${source.date}`);
    if (source.pit.kind === "REVIEWED_ATOMIC_QUARANTINE") {
      const original = await read(source.originalSource!.storagePath);
      if (bytesHash(original) !== source.originalSource!.dataHash)
        throw new Error("Original US atomic source hash mismatch");
      const originalRows = parseUsProspectiveCsv(original);
      if (
        originalRows.length !== rows.length ||
        originalRows.some((r) => r.date !== source.date) ||
        new Set(originalRows.map((r) => r.symbol)).size !== rows.length
      )
        throw new Error("Reviewed quarantine cannot change the original universe or date");
      const originals = new Map(originalRows.map((r) => [r.symbol, r]));
      const changed = new Set(source.lifecycleQuarantines!.map((e) => e.symbol));
      const nullable = new Set([
        "open",
        "high",
        "low",
        "close",
        "volume",
        "dollarVolume",
        "marketCap",
        "ret120",
        "ret252",
        "beta60Spy",
        "ichimokuTkGap",
        "relvol1_20",
        "adv20Usd",
        "amihud20",
      ]);
      for (const row of rows) {
        const before = originals.get(row.symbol);
        if (!before) throw new Error("Reviewed quarantine cannot add a security");
        for (const key of Object.keys(row) as Array<keyof UsProspectiveInputRow>) {
          if (row[key] === before[key]) continue;
          if (
            !changed.has(row.symbol) ||
            !(
              (nullable.has(key) && row[key] === null) ||
              (key === "status" && row[key] === "SUSPENDED") ||
              (["tossTradable", "active20"].includes(key) && row[key] === false)
            )
          )
            throw new Error("Reviewed quarantine changes unrelated original data");
        }
      }
      for (const symbol of changed) {
        const row = rows.find((r) => r.symbol === symbol);
        if (
          !row ||
          row.tossTradable ||
          row.status !== "SUSPENDED" ||
          row.open !== null ||
          row.close !== null ||
          row.ret120 !== null ||
          row.ret252 !== null
        )
          throw new Error("Reviewed lifecycle quarantine is not safely excluded");
      }
    }
    const identities = new Map(roster.rows.map((r) => [r.symbol, r]));
    const quarantine = new Set(source.quarantinedSymbols);
    if (!source.sourceCoverageComplete && !quarantine.size)
      throw new Error("Incomplete US coverage requires explicit quarantined symbols");
    for (const row of rows) {
      const identity = identities.get(row.symbol);
      if (!identity) throw new Error(`US replay symbol absent from dated roster: ${row.symbol}`);
      for (const key of [
        "name",
        "market",
        "sector",
        "securityType",
        "currency",
        "sharesOutstanding",
        "isCommonShare",
      ] as const)
        if (row[key] !== identity[key])
          throw new Error(`US replay uses unmatched dated metadata: ${row.symbol} ${key}`);
      // Verified lifecycle/provider exclusions can only make the dated security less tradable.
      if (row.tossTradable && !identity.tossTradable)
        throw new Error(
          `US replay enables a security absent from the dated tradable roster: ${row.symbol}`,
        );
      if (!quarantine.has(row.symbol) && row.status !== identity.status)
        throw new Error(`US replay changes a dated status without quarantine: ${row.symbol}`);
      if (quarantine.has(row.symbol)) {
        if (row.open !== null || row.close !== null || row.ret120 !== null || row.ret252 !== null)
          throw new Error(`Quarantined US security is not safely blanked: ${row.symbol}`);
      } else if (row.tossTradable && (!(Number(row.open) > 0) || !(Number(row.close) > 0))) {
        throw new Error(`Tradable US security lacks current prices: ${row.symbol}`);
      }
    }
    for (const symbol of quarantine)
      if (!identities.has(symbol)) throw new Error(`Unknown quarantined security: ${symbol}`);
    const spy = rows.find((r) => r.symbol === "SPY");
    if (!spy || !(Number(spy.open) > 0) || !(Number(spy.close) > 0))
      throw new Error("US replay requires current SPY benchmark prices");
    verified.push({ source, rows });
  }
  return verified;
}

/** Legacy collectors may retain tradable=true on null-priced quarantines. The
 * frozen scorer already excludes them; require exact explanatory coverage and
 * never call an incomplete source a complete universe. */
export function assertUsScreeningCoverage(
  metadata: Record<string, unknown>,
  rows: UsProspectiveInputRow[],
) {
  if (metadata["confirmedRegularClose"] !== true || metadata["failedSymbols"] !== 0)
    throw new Error("US source is not a confirmed session with zero unhandled failures");
  if (metadata["sourceCoverageComplete"] !== false) return;
  const list = (key: string) => {
    const value = metadata[key];
    if (value === undefined) return [] as string[];
    if (!Array.isArray(value) || value.some((s) => typeof s !== "string" || !s))
      throw new Error(`Invalid US coverage evidence: ${key}`);
    return value as string[];
  };
  const objectKeys = (key: string) => {
    const value = metadata[key];
    if (value === undefined) return [] as string[];
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`Invalid US coverage evidence: ${key}`);
    return Object.keys(value);
  };
  const blanked = new Set([
    ...list("providerGapSymbols"),
    ...list("lifecycleExcludedSymbols"),
    ...objectKeys("guardedCandidateQuarantine"),
  ]);
  const held = new Set(objectKeys("guardedCandidateScoringHolds"));
  if (!blanked.size && !held.size)
    throw new Error("Incomplete US coverage has no explicit exclusion evidence");
  const bySymbol = new Map(rows.map((r) => [r.symbol, r]));
  for (const symbol of blanked) {
    const row = bySymbol.get(symbol);
    if (
      !row ||
      row.open !== null ||
      row.close !== null ||
      row.ret120 !== null ||
      row.ret252 !== null
    )
      throw new Error(`Unsafe US coverage quarantine: ${symbol}`);
  }
  for (const symbol of held) {
    const row = bySymbol.get(symbol);
    if (!row || row.ret120 !== null || row.ret252 !== null)
      throw new Error(`Unsafe US history-length hold: ${symbol}`);
  }
}
