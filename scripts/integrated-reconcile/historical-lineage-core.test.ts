import { expect, it } from "vitest";
import { inspectCompletion, type Snapshot } from "./core";
const H = `sha256:${"a".repeat(64)}`,
  S = `sha256:${"b".repeat(64)}`;
function fixture() {
  const date = "2026-10-28";
  const state: Snapshot = {
    heads: { O1: "2026-10-29", S07: "2026-10-29" },
    models: {
      ["KR:" + date]: { complete: true, sourceHash: H },
      "KR:2026-10-30": { complete: false, sourceHash: null },
    },
    evidence: {
      ["KR:" + date]: {
        status: "STORED",
        hash: H,
        sourceHash: S,
        decisionAt: "2026-10-29T00:00:00Z",
        historicalLineage: {
          proofHash: H,
          date,
          checkpointThrough: "2026-10-29",
          stageHash: H,
          stageSourceHash: S,
          modelSourceHash: H,
        },
      },
      "KR:2026-10-30": { status: "MISSING", hash: null, sourceHash: null, decisionAt: null },
    },
    fingerprint: H,
  };
  const port = { dates: [date, "2026-10-30"], due: () => ["KR" as const] };
  return { state, port };
}
it("verified bound historical divergence permits ordinary incomplete KR30 WAITING", () => {
  const { state, port } = fixture();
  const r = inspectCompletion(port, state, "2026-11-01T12:00:00Z");
  expect(r.status).toBe("WAITING");
  expect(r.findings).toEqual([
    { date: "2026-10-30", market: "KR", reason: "WAITING_MARKET_PUBLICATION" },
  ]);
});
it.each([
  "proofHash",
  "date",
  "checkpointThrough",
  "stageHash",
  "stageSourceHash",
  "modelSourceHash",
] as const)("rejects tampered %s proof binding", (field) => {
  const { state, port } = fixture();
  state.evidence["KR:2026-10-28"].historicalLineage![field] = "tampered";
  expect(() => inspectCompletion(port, state, "2026-11-01T12:00:00Z")).toThrow("source conflict");
});
it("cannot reuse historic proof on a pending new date", () => {
  const { state } = fixture();
  state.models["KR:2026-10-30"] = { complete: true, sourceHash: H };
  state.evidence["KR:2026-10-30"] = {
    ...state.evidence["KR:2026-10-28"],
    historicalLineage: {
      ...state.evidence["KR:2026-10-28"].historicalLineage!,
      date: "2026-10-30",
    },
  };
  expect(() =>
    inspectCompletion({ dates: ["2026-10-30"], due: () => ["KR"] }, state, "2026-11-01T12:00:00Z"),
  ).toThrow("source conflict");
});
it("proof checkpoint must be reached by BOTH current heads", () => {
  const { state, port } = fixture();
  state.heads.S07 = "2026-10-28";
  expect(() => inspectCompletion(port, state, "2026-11-01T12:00:00Z")).toThrow("source conflict");
});
it("historical proof cannot authorize US source divergence", () => {
  const { state } = fixture();
  state.models["US:2026-10-28"] = state.models["KR:2026-10-28"];
  state.evidence["US:2026-10-28"] = state.evidence["KR:2026-10-28"];
  expect(() =>
    inspectCompletion({ dates: ["2026-10-28"], due: () => ["US"] }, state, "2026-11-01T12:00:00Z"),
  ).toThrow("source conflict");
});
it("historical proof cannot authorize an OUTBOX source divergence", () => {
  const { state, port } = fixture();
  state.evidence["KR:2026-10-28"].status = "OUTBOX";
  expect(() => inspectCompletion(port, state, "2026-11-01T12:00:00Z")).toThrow("source conflict");
});
it("incomplete KR model remains WAITING without using a historical exception", () => {
  const { state } = fixture();
  state.models["KR:2026-10-28"].complete = false;
  delete state.evidence["KR:2026-10-28"].historicalLineage;
  const r = inspectCompletion(
    { dates: ["2026-10-28"], due: () => ["KR"] },
    state,
    "2026-11-01T12:00:00Z",
  );
  expect(r.status).toBe("WAITING");
  expect(r.findings[0].reason).toBe("WAITING_MARKET_PUBLICATION");
});
