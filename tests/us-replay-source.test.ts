import { describe, expect, it } from "vitest";
import {
  bytesHash,
  loadVerifiedUsReplaySessions,
  validateUsReplayManifest,
  type UsReplayManifest,
  type UsReplayRoster,
} from "../scripts/us-replay-source";
import { parseUsProspectiveCsv } from "../src/lib/engine/usProspective";
const uid = "11111111-1111-4111-8111-111111111111";
import { sourceCsv } from "./us-replay-fixtures";
function fixture() {
  const files = new Map<string, string>();
  const sessions = ["2026-10-06", "2026-10-07"].map((date, i) => {
    const csv = sourceCsv(date);
    const rows = parseUsProspectiveCsv(csv);
    const roster: UsReplayRoster = {
      version: "us-dated-roster-v1",
      asOfDate: date,
      capturedAt: `${date}T21:00:00Z`,
      rows: rows.map(
        ({
          symbol,
          name,
          market,
          sector,
          securityType,
          status,
          currency,
          sharesOutstanding,
          tossTradable,
          isCommonShare,
        }) => ({
          symbol,
          name,
          market,
          sector,
          securityType,
          status,
          currency,
          sharesOutstanding,
          tossTradable,
          isCommonShare,
        }),
      ),
    };
    const r = JSON.stringify(roster);
    const storagePath = `${uid}/us-replay/${date}.csv`;
    const rosterStoragePath = `${uid}/us-replay/${date}.json`;
    files.set(storagePath, csv);
    files.set(rosterStoragePath, r);
    return {
      date,
      previousSessionDate: i ? "2026-10-06" : "2026-10-05",
      storagePath,
      dataHash: bytesHash(csv),
      rowCount: 2,
      symbolCount: 2,
      sourceCapturedAt: `${date}T21:00:00Z`,
      confirmedRegularClose: true,
      failedSymbols: 0,
      sourceCoverageComplete: true,
      quarantinedSymbols: [],
      pit: {
        kind: "ATOMIC_DATED_SNAPSHOT" as const,
        asOfDate: date,
        rosterCapturedAt: roster.capturedAt,
        rosterStoragePath,
        rosterHash: bytesHash(r),
      },
    };
  });
  const manifest: UsReplayManifest = {
    version: "us-dated-replay-v1",
    baseDate: "2026-10-05",
    throughDate: "2026-10-07",
    sessions,
  };
  return { files, manifest, read: async (p: string) => files.get(p)! };
}
describe("bounded dated US source preflight", () => {
  it("verifies exact bytes, full chronological sessions, and roster identities", async () => {
    const f = fixture();
    await validateUsReplayManifest(f.manifest, uid);
    expect(
      (await loadVerifiedUsReplaySessions(f.manifest, f.read)).map((s) => s.source.date),
    ).toEqual(["2026-10-06", "2026-10-07"]);
  });
  it.each(["gap", "order", "future-roster", "cross-owner", "unknown-calendar", "failed-source"])(
    "rejects %s before data use",
    async (kind) => {
      const f = fixture();
      if (kind === "gap") f.manifest.sessions.shift();
      if (kind === "order") f.manifest.sessions.reverse();
      if (kind === "future-roster")
        f.manifest.sessions[0]!.pit = {
          ...f.manifest.sessions[0]!.pit,
          kind: "DATED_ROSTER_RECONSTRUCTION",
          asOfDate: "2026-10-05",
          rosterCapturedAt: "2026-10-07T01:00:00Z",
        };
      if (kind === "cross-owner") f.manifest.sessions[0]!.storagePath = "other/private.csv";
      if (kind === "unknown-calendar") f.manifest.throughDate = "2026-12-31";
      if (kind === "failed-source") f.manifest.sessions[0]!.failedSymbols = 1;
      await expect(validateUsReplayManifest(f.manifest, uid)).rejects.toThrow();
    },
  );
  it("rejects revised bytes on the final day before returning any admitted batch", async () => {
    const f = fixture();
    f.files.set(
      f.manifest.sessions[1]!.storagePath,
      sourceCsv("2026-10-07").replace(",101,", ",102,"),
    );
    await expect(loadVerifiedUsReplaySessions(f.manifest, f.read)).rejects.toThrow("hash mismatch");
  });
  it("rejects a later reconstruction labeled as an original atomic snapshot", async () => {
    const f = fixture();
    const source = f.manifest.sessions[0]!;
    source.sourceCapturedAt = "2026-10-08T02:00:00Z";
    source.pit.rosterCapturedAt = source.sourceCapturedAt;
    await expect(validateUsReplayManifest(f.manifest, uid)).rejects.toThrow(
      "pre-next-open capture",
    );
  });
  it("rejects complete-coverage claims with explicit quarantines", async () => {
    const f = fixture();
    f.manifest.sessions[0]!.quarantinedSymbols = ["TEST"];
    await expect(validateUsReplayManifest(f.manifest, uid)).rejects.toThrow("complete coverage");
  });
  it("rejects missing explicit quarantine and unblanked quarantines", async () => {
    const f = fixture();
    f.manifest.sessions[0]!.sourceCoverageComplete = false;
    await expect(loadVerifiedUsReplaySessions(f.manifest, f.read)).rejects.toThrow(
      "explicit quarantined",
    );
    f.manifest.sessions[0]!.quarantinedSymbols = ["TEST"];
    await expect(loadVerifiedUsReplaySessions(f.manifest, f.read)).rejects.toThrow(
      "safely blanked",
    );
  });
  it("rejects same-hash input paired with a changed prior master", async () => {
    const f = fixture();
    const s = f.manifest.sessions[0]!;
    const r = JSON.parse(f.files.get(s.pit.rosterStoragePath)!);
    r.rows[1].sector = "Future sector";
    const body = JSON.stringify(r);
    s.pit.rosterHash = bytesHash(body);
    f.files.set(s.pit.rosterStoragePath, body);
    await expect(loadVerifiedUsReplaySessions(f.manifest, f.read)).rejects.toThrow(
      "dated metadata",
    );
  });
});

describe("reviewed lifecycle-only derivative of a frozen atomic source", () => {
  function derived() {
    const f = fixture(),
      s = f.manifest.sessions[0]!;
    const lines = f.files.get(s.storagePath)!.trim().split("\n");
    const original =
      lines.map((line, i) => line + "," + (i ? "ACTIVE" : "status")).join("\n") + "\n";
    const originalPath = `${uid}/source/original.csv`;
    f.files.set(originalPath, original);
    const roster = JSON.parse(f.files.get(s.pit.rosterStoragePath)!);
    roster.rows.forEach((r: { status: string }) => (r.status = "ACTIVE"));
    const rt = JSON.stringify(roster);
    f.files.set(s.pit.rosterStoragePath, rt);
    s.pit.rosterHash = bytesHash(rt);
    const cells = original
      .trim()
      .split("\n")
      .map((line) => line.split(","));
    const columns = cells[0]!;
    for (const key of [
      "open",
      "high",
      "low",
      "close",
      "volume",
      "ret120",
      "ret252",
      "beta60_spy",
      "ichimoku_tk_gap",
      "relvol1_20",
      "adv20_usd",
      "amihud20",
    ])
      cells[2]![columns.indexOf(key)] = "";
    cells[2]![columns.indexOf("status")] = "SUSPENDED";
    cells[2]![columns.indexOf("toss_tradable")] = "false";
    cells[2]![columns.indexOf("active20")] = "false";
    const after = cells.map((r) => r.join(",")).join("\n") + "\n";
    f.files.set(s.storagePath, after);
    s.dataHash = bytesHash(after);
    s.sourceCapturedAt = "2026-10-08T02:00:00Z";
    s.sourceCoverageComplete = false;
    s.quarantinedSymbols = ["TEST"];
    s.pit.kind = "REVIEWED_ATOMIC_QUARANTINE";
    s.originalSource = {
      storagePath: originalPath,
      dataHash: bytesHash(original),
      sourceCapturedAt: "2026-10-06T21:00:00Z",
    };
    s.lifecycleQuarantines = [
      {
        symbol: "TEST",
        effectiveDate: "2026-10-06",
        evidenceUrls: ["https://www.nasdaqtrader.com/official-fixture"],
      },
    ];
    return f;
  }
  it("keeps original bytes and admits only explicitly dated nulling/nontradability", async () => {
    const f = derived(),
      s = f.manifest.sessions[0]!;
    const original = f.files.get(s.originalSource!.storagePath);
    await validateUsReplayManifest(f.manifest, uid);
    const loaded = await loadVerifiedUsReplaySessions(f.manifest, f.read);
    expect(loaded[0]!.rows.find((r) => r.symbol === "TEST")).toMatchObject({
      status: "SUSPENDED",
      tossTradable: false,
      close: null,
    });
    expect(f.files.get(s.originalSource!.storagePath)).toBe(original);
  });
  it("rejects any unrelated historical data edit even with a new derived hash", async () => {
    const f = derived(),
      s = f.manifest.sessions[0]!;
    const altered = f.files.get(s.storagePath)!.replace(",SPY,SPY,100,", ",SPY,SPY,99,");
    f.files.set(s.storagePath, altered);
    s.dataHash = bytesHash(altered);
    await expect(loadVerifiedUsReplaySessions(f.manifest, f.read)).rejects.toThrow(
      "unrelated original data",
    );
  });
  it("rejects post-date effective events and revised original source hashes", async () => {
    const f = derived(),
      s = f.manifest.sessions[0]!;
    s.lifecycleQuarantines![0]!.effectiveDate = "2026-10-07";
    await expect(validateUsReplayManifest(f.manifest, uid)).rejects.toThrow(
      "dated lifecycle evidence",
    );
    s.lifecycleQuarantines![0]!.effectiveDate = "2026-10-06";
    s.originalSource!.dataHash = bytesHash("different");
    await expect(loadVerifiedUsReplaySessions(f.manifest, f.read)).rejects.toThrow(
      "Original US atomic source hash",
    );
  });
});
