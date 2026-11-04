import { expect, it, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const fake = vi.hoisted(() => ({
  phase: "FINAL",
  date: "2026-11-03",
  pending: false,
  paths: [] as string[],
  reads: vi.fn(),
}));
vi.mock("../../src/lib/krScreeningPublication", () => ({
  classifyKrScreeningPublication: () => ({ phase: fake.phase, asOfDate: fake.date }),
  unresolvedKrPendingSources: () => (fake.pending ? [{}] : []),
}));
vi.mock("../kr-final-retrospective/transport", () => ({
  snapshot: async () => ({ sources: [{}] }),
  reader: () => ({ rows: async () => [] }),
  legacyInventory: async () => fake.paths,
  readEvidence: fake.reads,
}));
import { captureNov3 } from "./capture";
const owner = "00000000-0000-0000-0000-000000000001",
  root = owner + "/shadow/kospi-confirm1-bear-rsaccel-v1/revisions/october14-retrospective-v1";
beforeEach(() => {
  fake.phase = "FINAL";
  fake.date = "2026-11-03";
  fake.pending = false;
  fake.paths = [root + "/sessions/2026-11-02.json"];
  fake.reads.mockClear();
});
it.each(["preliminary", "wrong-date", "pending", "already-completed", "missing-predecessor"])(
  "capture fails before evidence/source reads: %s",
  async (kind) => {
    if (kind === "preliminary") fake.phase = "PRELIMINARY";
    if (kind === "wrong-date") fake.date = "2026-11-04";
    if (kind === "pending") fake.pending = true;
    if (kind === "already-completed") fake.paths.push(root + "/sessions/2026-11-03.json");
    if (kind === "missing-predecessor") fake.paths = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nov3-capture-guard-"));
    try {
      const o = { origin: "https://example.supabase.co", owner, key: "test" };
      await expect(captureNov3(o, dir, "a".repeat(40), () => o)).rejects.toThrow(
        "NOV3_CAPTURE_REJECTED",
      );
      expect(fake.reads).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(dir, "capture.json"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
