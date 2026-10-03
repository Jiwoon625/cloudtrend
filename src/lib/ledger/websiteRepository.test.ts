import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { ActualExecution } from "../portfolioLedgers";
import { correctEvent, normalizeLegacyExecution } from "./migration";
import type { Security } from "./types";
import { projectExecutionMemo, savedExecutionMemo } from "./executionMemo";
import { readWebsiteDocument } from "./websiteRepository.server";

const uid = "00000000-0000-4000-8000-000000000001";
const security: Security = {
  id: "KR:0123A0",
  symbol: "0123A0",
  name: "Synthetic ETF",
  market: "KOSPI",
  assetType: "ETF",
  currency: "KRW",
  notionPageId: null,
};
const execution: ActualExecution<string> = {
  id: "synthetic-1",
  symbol: security.symbol,
  name: security.name,
  market: "ETF",
  side: "BUY",
  date: "2026-09-02",
  price: 100 / 3,
  shares: 3,
  fee: 0,
  note: "Preserve synthetic multiline\nnote and exact aggregate price",
  order: 4,
  signalKey: null,
};
function fixture() {
  const fills = [execution, { ...execution, id: "synthetic-2", order: 2, price: 0.1 }];
  const events = fills.map((fill) =>
    normalizeLegacyExecution({
      execution: fill,
      security,
      accountId: "UNASSIGNED:portfolio_ledgers",
      source: {
        system: "portfolio_ledgers",
        recordId: fill.id,
        revision: "4",
        contentHash: `sha256:${"a".repeat(64)}`,
      },
      recordedAt: "2026-10-03T00:00:00Z",
    }),
  );
  const payload = {
    version: 3,
    executions: fills,
    settings: { initialCapital: 123, maxPositions: 7 },
    actualCapital: 400,
    etfCapital: 600,
    excluded: { "synthetic|signal": "Deliberately excluded" },
    strategy: { synthetic: true, cached: [3, 1, 2] },
    taxEvidence: { policy: "quarterly broker review" },
    unknownFutureField: { keep: true },
    migratedAt: "2026-10-02T00:00:00Z",
  };
  return {
    revision: 4,
    integrityValid: true,
    payload,
    events,
    securities: [security],
    sourceIdentities: events.map((event) => ({
      sourceRecordId: event.source.recordId,
      eventId: event.id,
    })),
  };
}
function clientWith(data: unknown, error: { message: string } | null = null) {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  const from = vi.fn(() => {
    throw new Error("Direct table fallback is forbidden");
  });
  return { rpc, from, client: { rpc, from } as unknown as SupabaseClient };
}

describe("canonical website repository", () => {
  it("reads one invoker snapshot scoped to user/source and preserves exact payload and execution order", async () => {
    const snapshot = fixture();
    const before = structuredClone(snapshot);
    const { rpc, from, client } = clientWith(snapshot);
    const result = await readWebsiteDocument<typeof snapshot.payload>(
      client,
      uid,
      "portfolio_ledgers",
    );
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("ledger_read_website_document", {
      p_user_id: uid,
      p_source_system: "portfolio_ledgers",
    });
    expect(from).not.toHaveBeenCalled();
    expect(result).toEqual({ revision: 4, payload: before.payload });
    expect(result!.payload.executions.map((e) => e.id)).toEqual(["synthetic-1", "synthetic-2"]);
    expect(result!.payload.executions[0]).not.toBe(snapshot.payload.executions[0]);
    expect(snapshot).toEqual(before);
  });

  it("keeps raw Notion memo integrity on read, then accepts a source-separated append-only correction", async () => {
    const snapshot = fixture();
    const url = "https://notion.so/synthetic-original";
    snapshot.payload.executions[0]!.note = `원본 메모\n${url}`;
    snapshot.events[0]!.legacyExecution!.note = snapshot.payload.executions[0]!.note;
    const original = structuredClone(snapshot.events[0]!);
    const first = await readWebsiteDocument(clientWith(snapshot).client, uid, "portfolio_ledgers");
    expect(first!.payload.executions[0]!.note).toContain(url);
    const edited = {
      ...projectExecutionMemo(first!.payload.executions[0]!),
      ...savedExecutionMemo({ note: "메모 정정" }, first!.payload.executions[0]!),
    };
    const correction = correctEvent(
      original,
      { ...original, appExecution: edited, sourceLinks: edited.sourceLinks },
      "Separate source from memo",
    );
    snapshot.events.push(correction);
    snapshot.payload.executions[0] = edited;
    const second = await readWebsiteDocument(clientWith(snapshot).client, uid, "portfolio_ledgers");
    expect(second!.payload.executions[0]!.note).toBe("메모 정정");
    expect(second!.payload.executions[0]!.sourceLinks).toEqual([{ system: "notion", url }]);
    expect(snapshot.events[0]).toEqual(original);
    expect(correction.legacyExecution).toEqual(original.legacyExecution);
    for (const field of ["tax", "settlementDate", "cashLegs", "positionLegs"] as const)
      expect(correction[field]).toEqual(original[field]);
  });

  it("accepts reordered JSON keys semantically and does not round a retained average", async () => {
    const snapshot = fixture();
    snapshot.payload.executions = snapshot.payload.executions.map(
      (e) => Object.fromEntries(Object.entries(e).reverse()) as unknown as ActualExecution<string>,
    );
    const { client } = clientWith(snapshot);
    const result = await readWebsiteDocument(client, uid, "portfolio_ledgers");
    expect(result!.payload.executions[0]!.price).toBe(100 / 3);
    expect(result!.payload.executions[0]!.note).toBe(execution.note);
  });

  it("returns null only when the RPC positively reports no document", async () => {
    const { client, from } = clientWith(null);
    expect(await readWebsiteDocument(client, uid, "portfolio_ledgers")).toBeNull();
    expect(from).not.toHaveBeenCalled();
    const missing = clientWith(undefined);
    await expect(readWebsiteDocument(missing.client, uid, "portfolio_ledgers")).rejects.toThrow(
      /snapshot response/i,
    );
  });

  it("accepts an empty document only with no live canonical executions", async () => {
    const snapshot = fixture();
    snapshot.payload.executions = [];
    snapshot.events = [];
    snapshot.sourceIdentities = [];
    expect(
      await readWebsiteDocument(clientWith(snapshot).client, uid, "portfolio_ledgers"),
    ).toEqual({ revision: snapshot.revision, payload: snapshot.payload });
  });

  it("uses corrected snapshots and removes only explicitly voided executions", async () => {
    const snapshot = fixture();
    const original = snapshot.events[0]!;
    const updated = { ...execution, note: "Edited note", fee: 1 };
    const next = correctEvent(
      original,
      { ...original, fee: "1", appExecution: updated },
      "Website edit",
    );
    const removed = snapshot.events[1]!;
    const voided = correctEvent(removed, { ...removed, voided: true }, "Website remove");
    snapshot.events.push(next, voided);
    snapshot.payload.executions = [updated];
    const result = await readWebsiteDocument(clientWith(snapshot).client, uid, "portfolio_ledgers");
    expect(result!.payload.executions).toEqual([updated]);
  });

  it.each(["missing", "extra", "duplicate", "stale", "note", "price", "unknown field"])(
    "rejects %s source/canonical divergence without legacy fallback",
    async (mode) => {
      const snapshot = fixture();
      if (mode === "missing") snapshot.events = [];
      if (mode === "extra") snapshot.payload.executions.pop();
      if (mode === "duplicate") snapshot.payload.executions.push({ ...execution });
      if (mode === "stale") {
        const original = snapshot.events[0]!;
        snapshot.events.push(correctEvent(original, { ...original, voided: true }, "Removed"));
      }
      if (mode === "note") snapshot.payload.executions[0] = { ...execution, note: "Changed" };
      if (mode === "price") snapshot.payload.executions[0] = { ...execution, price: 33.33333333 };
      if (mode === "unknown field")
        snapshot.payload.executions[0] = { ...execution, extra: true } as ActualExecution<string>;
      const { client, from } = clientWith(snapshot);
      await expect(readWebsiteDocument(client, uid, "portfolio_ledgers")).rejects.toThrow(
        /diverged/i,
      );
      expect(from).not.toHaveBeenCalled();
    },
  );

  it("rejects foreign source/model contamination even when the compatibility payload matches", async () => {
    const snapshot = fixture();
    for (const foreign of [
      {
        ...snapshot.events[0]!,
        source: { ...snapshot.events[0]!.source, system: "us_actual_portfolio_ledgers" },
      },
      { ...snapshot.events[0]!, book: "MODEL", bookId: "MODEL:SYNTHETIC" },
    ]) {
      const { client, from } = clientWith({ ...snapshot, events: [foreign] });
      await expect(readWebsiteDocument(client, uid, "portfolio_ledgers")).rejects.toThrow(/scope/i);
      expect(from).not.toHaveBeenCalled();
    }
  });

  it.each(["orphan", "missing", "wrong identity", "duplicate"])(
    "rejects %s permanent source registrations",
    async (mode) => {
      const snapshot = fixture();
      if (mode === "orphan")
        snapshot.sourceIdentities.push({ sourceRecordId: "orphan", eventId: "orphan-event" });
      if (mode === "missing") snapshot.sourceIdentities.pop();
      if (mode === "wrong identity") snapshot.sourceIdentities[0]!.eventId = "wrong";
      if (mode === "duplicate")
        snapshot.sourceIdentities.push({ ...snapshot.sourceIdentities[0]! });
      await expect(
        readWebsiteDocument(clientWith(snapshot).client, uid, "portfolio_ledgers"),
      ).rejects.toThrow(/registry diverged/);
    },
  );

  it("rejects indexed provenance mismatch and nonempty orphan-only sources", async () => {
    const snapshot = fixture();
    await expect(
      readWebsiteDocument(
        clientWith({ ...snapshot, integrityValid: false }).client,
        uid,
        "portfolio_ledgers",
      ),
    ).rejects.toThrow(/snapshot/);
    await expect(
      readWebsiteDocument(
        clientWith({
          ...snapshot,
          revision: null,
          payload: null,
          events: [],
          integrityValid: false,
        }).client,
        uid,
        "portfolio_ledgers",
      ),
    ).rejects.toThrow(/snapshot/);
  });

  it("propagates owner access/read errors without table fallback", async () => {
    const { client, rpc, from } = clientWith(fixture(), {
      message: "Requested owner does not match auth.uid()",
    });
    await expect(readWebsiteDocument(client, uid, "portfolio_ledgers")).rejects.toThrow(/owner/i);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(from).not.toHaveBeenCalled();
  });

  it("validates user and source before requesting any data", async () => {
    const { client, rpc } = clientWith(fixture());
    for (const invalid of ["", "other-owner", "-".repeat(36)]) {
      await expect(readWebsiteDocument(client, invalid, "portfolio_ledgers")).rejects.toThrow(
        /owner/i,
      );
    }
    await expect(readWebsiteDocument(client, uid, "broker" as "portfolio_ledgers")).rejects.toThrow(
      /source/i,
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    [],
    {},
    { ...fixture(), revision: "4" },
    { ...fixture(), revision: -1 },
    { ...fixture(), revision: 0 },
    { ...fixture(), revision: 1.5 },
    { ...fixture(), revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...fixture(), payload: null },
    { ...fixture(), payload: { executions: null } },
    { ...fixture(), events: null },
    { ...fixture(), securities: null },
  ])("rejects malformed RPC snapshot %#", async (snapshot) => {
    await expect(
      readWebsiteDocument(clientWith(snapshot).client, uid, "portfolio_ledgers"),
    ).rejects.toThrow(/snapshot response/i);
  });
});
