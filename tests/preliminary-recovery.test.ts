import { beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  listScreeningArchive,
  readScreeningArchive,
  screeningArchiveQueryOptions,
} from "../src/lib/screeningArchiveQuery";
import {
  historyEntryStatus,
  isHistoryOperationalEntry,
} from "../src/components/historyEntryPresentation";
import { serializeScreeningRunArchive } from "../src/lib/screeningRunArchiveStorage";
import type { ScreeningSnapshot } from "../src/lib/screeningSnapshot";

interface RecoveryTestRow {
  run_id: string | undefined;
  date: string;
  market: string;
  strategy_version: string | undefined;
  calculated_at: string;
  created_at: string;
  snapshot: unknown;
  source_path: string;
  source_sha256: string;
  source_bytes: number;
  source_code_version: string;
}
const state = vi.hoisted(() => ({
  row: null as unknown as RecoveryTestRow,
  confirmed: [] as RecoveryTestRow[],
  error: null as { message: string } | null,
  calls: [] as unknown[],
}));
vi.mock("../src/lib/cloud", () => ({
  userId: async () => "bdfc8818-33a7-4030-9dbd-ecad39f223ac",
  supabase: {
    from(table: string) {
      state.calls.push(table);
      const q = {
        select: () => q,
        eq: (...v: unknown[]) => {
          state.calls.push(v);
          return q;
        },
        order: () => q,
        limit: async () => ({
          data:
            table === "screening_recovery_evidence"
              ? [state.row]
              : table === "screening_run_archive"
                ? state.confirmed
                : [],
          error: table === "screening_recovery_evidence" ? state.error : null,
        }),
        maybeSingle: async () => ({ data: state.row, error: state.error }),
      };
      return q;
    },
  },
}));
// CI uses a small synthetic fixture; the owner-only verification run may supply
// the approved private projection without committing source data to GitHub.
const fixturePath = process.env["CLOUDTREND_RECOVERY_SNAPSHOT"];
const snapshot = (
  fixturePath
    ? JSON.parse(readFileSync(fixturePath, "utf8"))
    : {
        runId: "original-run",
        date: "2026-10-26",
        asOfDate: "2026-10-26",
        market: "KR",
        strategyVersion: "frozen-vintage",
        savedAt: "2026-10-26T17:31:46.786Z",
        marketGateStatus: "RISK_OFF",
        totalCount: 3,
        passedCount: 0,
        gradeACount: 0,
        gradeBCount: 0,
        krPublication: {
          version: "kr-screening-publication-v1",
          phase: "PRELIMINARY",
          asOfDate: "2026-10-26",
          heldFields: ["market capitalization"],
          financialSideEffects: false,
          requestIds: ["original-request"],
        },
        recoveryEvidence: {
          version: 1,
          method: "ORIGINAL_STORED_RESULT",
          sourcePath: "bdfc8818-33a7-4030-9dbd-ecad39f223ac/results/screening/original-run.json",
          sourceSha256: "a".repeat(64),
          sourceBytes: 1234,
          sourceCodeVersion: "b".repeat(40),
        },
        entries: ["119850", "159010", "other"].map((symbol, index) => ({
          symbol,
          name: symbol,
          market: "KOSDAQ",
          instrumentType: "STOCK",
          sectorCode: "TEST",
          sectorName: "Test",
          grade: "C",
          status: "판단 보류",
          totalScore: 25,
          scoreDelta1d: -10,
          technicalPoints: 2.5,
          priorityPoints: 0,
          hardFilterPassed: false,
          hardFilterStatus: "PENDING",
          pendingRules: ["시가총액 미확인"],
          kosdaq80Onset: false,
          kospiEightPointEntry: false,
          kospi80Onset: false,
          ...(index < 2 ? { exitSignal: "DOWN30" } : {}),
        })),
      }
) as ScreeningSnapshot;
const identity = {
  market: "KR",
  strategyVersion: snapshot.strategyVersion,
  historySource: "KR_ORIGINAL_RECOVERY" as const,
};
beforeEach(() => {
  const proof = snapshot.recoveryEvidence!;
  state.row = {
    run_id: snapshot.runId,
    date: snapshot.asOfDate,
    market: "KR",
    strategy_version: snapshot.strategyVersion,
    calculated_at: snapshot.savedAt,
    created_at: "2026-11-06T22:00:00Z",
    snapshot: structuredClone(snapshot),
    source_path: proof.sourcePath,
    source_sha256: proof.sourceSha256,
    source_bytes: proof.sourceBytes,
    source_code_version: proof.sourceCodeVersion,
  };
  state.confirmed = [];
  state.error = null;
  state.calls = [];
});
it("reads original values with pending exits and zero operational entries", async () => {
  state.row.snapshot = await serializeScreeningRunArchive(snapshot);
  const s = await readScreeningArchive(
    snapshot.runId!,
    snapshot.asOfDate,
    snapshot.savedAt,
    identity,
  );
  expect(s.entries).toEqual(snapshot.entries);
  expect(s.entries).toHaveLength(fixturePath ? 1797 : 3);
  const exits = s.entries.filter((e) => e.exitSignal);
  expect(exits).toHaveLength(fixturePath ? 12 : 2);
  expect(exits.every((e) => historyEntryStatus(e).includes("판단 보류"))).toBe(true);
  expect(s.entries.filter((e) => isHistoryOperationalEntry(e, s.asOfDate))).toHaveLength(0);
  expect(exits.find((e) => e.symbol === "119850")?.exitSignal).toBe("DOWN30");
  expect(exits.find((e) => e.symbol === "159010")?.exitSignal).toBe("DOWN30");
  expect(s.krPublication?.phase).toBe("PRELIMINARY");
  expect(state.calls.filter((c) => typeof c === "string")).toEqual(["screening_recovery_evidence"]);
});
it.each(["phase", "hash", "version", "date", "path"])(
  "rejects changed %s evidence",
  async (change) => {
    if (change === "phase")
      (state.row.snapshot as ScreeningSnapshot).krPublication!.phase = "FINAL";
    if (change === "hash") state.row.source_sha256 = "0".repeat(64);
    if (change === "version") state.row.source_code_version = "0".repeat(40);
    if (change === "date") (state.row.snapshot as ScreeningSnapshot).asOfDate = "2026-10-27";
    if (change === "path") state.row.source_path = "other-owner/results/screening/run.json";
    await expect(
      readScreeningArchive(snapshot.runId!, snapshot.asOfDate, snapshot.savedAt, identity),
    ).rejects.toThrow("일치하지 않습니다");
  },
);
it("lists provisional evidence separately, preferring an already archived identical run", async () => {
  expect((await listScreeningArchive(snapshot.asOfDate))[0]?.historySource).toBe(
    "KR_ORIGINAL_RECOVERY",
  );
  state.confirmed = [state.row];
  const listed = await listScreeningArchive(snapshot.asOfDate);
  expect(listed).toHaveLength(1);
  expect(listed[0]?.historySource).toBeUndefined();
});
it("keeps confirmed and recovery detail caches separate", () => {
  expect(screeningArchiveQueryOptions({ ...snapshot, ...identity }).queryKey).not.toEqual(
    screeningArchiveQueryOptions(snapshot).queryKey,
  );
});
it("surfaces permission failures without a latest-result fallback", async () => {
  state.error = { message: "permission denied" };
  await expect(listScreeningArchive()).rejects.toThrow("permission denied");
});
