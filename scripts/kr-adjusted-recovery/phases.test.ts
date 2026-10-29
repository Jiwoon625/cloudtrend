/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { COMPUTATION_PHASES, publicComputationPhase } from "../kr-vintage-preflight/phases";
import { traceIntegratedEquivalenceInputs, prepareRecovery } from "./prepare";
import { prepareKospiFinalRetrospective } from "../kospi-final-retrospective-preparation";
import { verifyPreparationPayload } from "./verify";
const fixture = () => {
  const context: any = {
    scope: { targetDate: "2026-10-26" },
    frozen: { date: "2026-10-26", provenance: "old" },
    candidateEvidence: { date: "2026-10-26", provenance: "new" },
    history: [{ date: "2026-10-22" }, { date: "2026-10-23" }],
    priorUs: { analysis: { date: "2026-10-23" } },
    us: { analysis: { date: "2026-10-26" } },
    report: {
      books: Object.fromEntries(
        ["O1", "S07"].map((kind) => [
          kind,
          {
            sessionInputsEqualExceptSourceHash: true,
            baselineReproduced: { equal: true },
          },
        ]),
      ),
    },
  };
  const plan = { preparedAt: "2026-10-28T13:00:00Z" };
  const books = ["O1", "S07"].map((kind) => ({
    kind,
    previous: {
      registry: { policy: { kind } },
      stateHash: "old-" + kind,
      result: {
        markets: {
          K: { sessions: ["2026-10-22", "2026-10-23"] },
          U: { lastSessionDate: "2026-10-23" },
        },
      },
    },
    completed: {
      registry: { policy: { kind } },
      receipt: { date: "2026-10-26" },
      previousStateHash: "old-" + kind,
    },
  }));
  return { context, plan, books };
};
describe("private preparation static phase boundary", () => {
  it("accepts only a finite code-selected vocabulary, never private diagnostic text", () => {
    expect(new Set(COMPUTATION_PHASES).size).toBe(COMPUTATION_PHASES.length);
    for (const phase of COMPUTATION_PHASES) {
      expect(phase).toMatch(/^[A-Z_]+$/);
      expect(publicComputationPhase(phase)).toBe(phase);
    }
    for (const value of [
      null,
      1,
      {},
      "secret/path",
      "INTEGRATED_COMPARISON\nprivate",
      "",
      "source-id:private",
    ])
      expect(publicComputationPhase(value)).toBe("CHILD_EXECUTION");
  });
  it("all phase call sites are string literals registered in the public sanitizer", () => {
    for (const file of [
      "scripts/kr-vintage-preflight-core.ts",
      "scripts/kr-adjusted-recovery/prepare.ts",
      "scripts/kospi-final-retrospective-preparation.ts",
      "scripts/kr-adjusted-recovery/verify.ts",
      "scripts/kospi-priority-admission.ts",
    ]) {
      const text = fs.readFileSync(file, "utf8");
      const calls = [...text.matchAll(/\bphase\(([^)]*)\)/g)].map((m) => m[1]);
      expect(calls.length).toBeGreaterThan(5);
      for (const call of calls) {
        expect(call).toMatch(/^"[A-Z_]+"$/);
        expect(publicComputationPhase(JSON.parse(call!))).not.toBe("CHILD_EXECUTION");
      }
    }
  });
  it("does not read or report raw child stdout/stderr or caught error values", () => {
    for (const file of [
      "scripts/kr-adjusted-recovery/entry.ts",
      "scripts/kr-adjusted-recovery/pure-entry.ts",
    ]) {
      const text = fs.readFileSync(file, "utf8");
      for (const value of ["child.stderr", "child.stdout", "error.message", "console.error"])
        expect(text).not.toContain(value);
    }
    expect(fs.readFileSync("scripts/kr-adjusted-recovery/entry.ts", "utf8")).toContain(
      "publicComputationPhase(v)",
    );
  });
  it("valid mirror invariants do not mutate inputs", () => {
    const f = fixture(),
      before = structuredClone(f),
      phases: string[] = [];
    traceIntegratedEquivalenceInputs(f.context, f.plan, f.books, (v) => phases.push(v));
    expect(f).toEqual(before);
    expect(phases.at(-1)).toBe("EQUIVALENCE_DISTINCT_EVIDENCE");
  });
  it.each([
    [
      "EQUIVALENCE_INPUT_DATES",
      (f: any) => {
        f.context.frozen.date = "2026-10-23";
      },
    ],
    [
      "EQUIVALENCE_BOOK_ORDER",
      (f: any) => {
        f.books.reverse();
      },
    ],
    [
      "EQUIVALENCE_HISTORY_ORDER",
      (f: any) => {
        f.context.history.reverse();
      },
    ],
    [
      "EQUIVALENCE_BOOK_CHAIN",
      (f: any) => {
        f.books[0].completed.previousStateHash = "wrong";
      },
    ],
    [
      "EQUIVALENCE_PREVIOUS_US_DATE",
      (f: any) => {
        f.context.priorUs.analysis.date = "2026-10-22";
      },
    ],
    [
      "EQUIVALENCE_EXACT_KR_HISTORY",
      (f: any) => {
        f.books[0].previous.result.markets.K.sessions.pop();
      },
    ],
    [
      "EQUIVALENCE_ECONOMIC_INPUTS",
      (f: any) => {
        f.context.report.books.O1.sessionInputsEqualExceptSourceHash = false;
      },
    ],
    [
      "EQUIVALENCE_COMPLETED_BASELINE",
      (f: any) => {
        f.context.report.books.O1.baselineReproduced.equal = false;
      },
    ],
    [
      "EQUIVALENCE_DISTINCT_EVIDENCE",
      (f: any) => {
        f.context.candidateEvidence = f.context.frozen;
      },
    ],
  ])("stops at the exact invariant %s, without continuing downstream", (expected, mutate) => {
    const f = fixture(),
      phases: string[] = [];
    (mutate as (value: any) => void)(f);
    expect(() =>
      traceIntegratedEquivalenceInputs(f.context, f.plan, f.books, (p) => phases.push(p)),
    ).toThrow();
    expect(phases.at(-1)).toBe(expected);
    expect(phases).not.toContain("INTEGRATED_EXACT_EQUIVALENCE_PROOF");
  });
  it("preparation callback errors cannot inherit the integrated comparison category", async () => {
    let phase = "INTEGRATED_COMPARISON";
    await expect(
      prepareRecovery({}, (p) => {
        phase = p;
      }),
    ).rejects.toThrow();
    expect(phase).toBe("PREPARATION_CONTEXT");
  });
  it("KOSPI and final receipt validation expose only their own fixed failing boundary", async () => {
    let phase = "PREPARATION_CALLBACK";
    await expect(
      prepareKospiFinalRetrospective({} as any, (p) => {
        phase = p;
      }),
    ).rejects.toThrow();
    expect(phase).toBe("KOSPI_AUTHORITY_SCOPE");
    await expect(
      verifyPreparationPayload({}, "hash", "hash", (p) => {
        phase = p;
      }),
    ).rejects.toThrow();
    expect(phase).toBe("RECEIPT_TYPE_AND_AUTHORITY");
  });
});
