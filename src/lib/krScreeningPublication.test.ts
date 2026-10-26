import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { preliminarySource } from "../../tests/kr-preliminary-fixture";
import {
  applyKrScreeningPublication,
  parseKrPublicationRequest,
  classifyKrScreeningPublication,
} from "./krScreeningPublication";
import {
  buildKrSourcePublication,
  buildKrPendingSupersessions,
  verifyKrScreeningPublication,
} from "./krScreeningPublication.server";
import type { CanonicalSourceRow } from "./sourceData";
import type { AnalysisResult } from "./engine/pipeline";
import { sourceFingerprintRecords } from "./sourceFingerprintRecords";
const client = {} as SupabaseClient;
const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

describe("source-bound KR preliminary publication", () => {
  it("verifies saved manifest and actual source date; late clock cannot turn pending FINAL", async () => {
    const { source, text } = preliminarySource();
    const p = await verifyKrScreeningPublication(client, "owner", [source], [text]);
    expect(p).toMatchObject({
      phase: "PRELIMINARY",
      financialSideEffects: false,
      asOfDate: source.max_date,
    });
    expect(p.heldFields.length).toBeGreaterThan(0);
    expect(await verifyKrScreeningPublication(client, "owner", [source], [text])).toEqual(p);
  });
  it("fails closed on manifest byte/hash mismatch and source hash mismatch", async () => {
    const { source, text } = preliminarySource();
    source.validation_result.krPublication.manifestText += " ";
    await expect(verifyKrScreeningPublication(client, "owner", [source], [text])).rejects.toThrow(
      "SHA-256",
    );
    const fresh = preliminarySource().source;
    fresh.file_hash = hash("wrong");
    expect(() => classifyKrScreeningPublication([fresh])).toThrow("binding");
  });
  it("cannot relabel pending source FINAL or remove its manifest declaration", async () => {
    const { source, text } = preliminarySource();
    source.validation_result.krPublication.phase = "FINAL";
    expect(() => classifyKrScreeningPublication([source])).toThrow();
    await expect(verifyKrScreeningPublication(client, "owner", [], [text])).rejects.toThrow(
      "PRELIMINARY",
    );
  });
  it("requires actual latest source date to match evidence", async () => {
    const { source, text } = preliminarySource();
    await expect(
      verifyKrScreeningPublication(
        client,
        "owner",
        [source],
        [text.replaceAll("2026-10-06", "2026-10-07")],
      ),
    ).rejects.toThrow("latest-date");
  });
  it("rejects another collector request and incomplete manifest even with a matching digest", () => {
    const { source } = preliminarySource();
    const request = { ...source.validation_result.krPublication, requestId: "another-request" };
    expect(() => buildKrSourcePublication(request, source)).toThrow("collector run");
    request.requestId = "synthetic-request";
    const manifest = JSON.parse(request.manifestText);
    manifest.complete = false;
    request.manifestText = JSON.stringify(manifest);
    request.manifestSha256 = hash(request.manifestText);
    expect(() => buildKrSourcePublication(request, source)).toThrow("collector run");
  });
  it.each([
    '[{"symbol":"TEST","name":"Synthetic","market":"KOSPI","type":"STOCK","date":"2026-10-06","close":100,"volume":1000,"marketCapSource":"KRX_PENDING_PUBLICATION"}]',
    "종목코드,name,market,type,일자,close,volume,marketCapSource\nTEST,Synthetic,KOSPI,STOCK,20261006,100,1000,KRX_PENDING_PUBLICATION\n",
    "symbol,name,market,type,date,close,volume,marketCapSource\nTEST,Synthetic,KOSPI,STOCK,2026/10/06,100,1000,KRX_PENDING_PUBLICATION\n",
  ])("normalizes a supported raw source format before date verification", async (text) => {
    const { source } = preliminarySource();
    source.file_hash = hash(text);
    source.validation_result.krPublication = buildKrSourcePublication(
      source.validation_result.krPublication,
      source,
    );
    expect((await verifyKrScreeningPublication(client, "owner", [source], [text])).phase).toBe(
      "PRELIMINARY",
    );
  });
  it("allowlists ingestion fields and never forwards supplied repair proofs or URLs", () => {
    const p = preliminarySource().source.validation_result.krPublication;
    const parsed = parseKrPublicationRequest({
      ...p,
      supersedesPending: [{ sourceId: "forged" }],
      callbackUrl: "https://invalid.example",
    });
    expect(Object.keys(parsed).sort()).toEqual([
      "manifestSha256",
      "manifestText",
      "phase",
      "requestId",
      "version",
    ]);
    expect(() => parseKrPublicationRequest({ ...p, phase: "UNKNOWN" })).toThrow("Invalid");
  });
  it("keeps legacy FINAL output and identity unchanged", () => {
    const analysis = { asOfDate: "2026-10-06", notes: [] } as unknown as AnalysisResult;
    const phase = classifyKrScreeningPublication([]);
    expect(applyKrScreeningPublication(analysis, phase)).toBe(analysis);
    const source = { id: "old", data_hash: "data", schema_hash: "schema", activated_at: null };
    expect(sourceFingerprintRecords([source])).toEqual([
      { id: "old", dataHash: "data", schemaHash: "schema", activatedAt: null, createdAt: null },
    ]);
  });
  it("persists phase in full analysis, changes identity and never certifies journals", () => {
    const { source } = preliminarySource();
    const analysis = { asOfDate: source.max_date, notes: [] } as unknown as AnalysisResult;
    const result = applyKrScreeningPublication(analysis, classifyKrScreeningPublication([source]));
    expect(result.krPublication?.financialSideEffects).toBe(false);
    expect(result.notes.join()).toContain("PRELIMINARY");
    expect(sourceFingerprintRecords([source])[0]).toHaveProperty("krPublication");
  });
  it("requires explicit exact evidence to supersede pending; preserves retry request identity", async () => {
    const { source } = preliminarySource();
    const request = { ...source.validation_result.krPublication, phase: "FINAL" as const };
    const manifest = JSON.parse(request.manifestText);
    manifest.latestKrxPublicationPending = false;
    manifest.krxPublicationEvidence.phase = "FINAL";
    for (const m of Object.values(manifest.krxPublicationEvidence.markets) as Record<
      string,
      unknown
    >[]) {
      m["status"] = "EXACT_READY";
      m["lastPublishedDate"] = source.max_date;
      m["usableRows"] = 10;
    }
    request.manifestText = JSON.stringify(manifest);
    request.manifestSha256 = hash(request.manifestText);
    const final = {
      ...source,
      id: "exact-source",
      file_hash: hash("exact-source"),
      data_hash: hash("exact-data"),
    };
    final.validation_result = { krPublication: buildKrSourcePublication(request, final) };
    expect(classifyKrScreeningPublication([source, final]).phase).toBe("PRELIMINARY");
    expect(classifyKrScreeningPublication([final]).phase).toBe("FINAL");
    expect(classifyKrScreeningPublication([final, source]).phase).toBe("PRELIMINARY");
    const oldRow = {
      symbol: "TEST",
      date: source.max_date,
      type: "STOCK",
      marketCap: "",
      marketCapSource: "KRX_PENDING_PUBLICATION",
    } as unknown as CanonicalSourceRow;
    const exactRow = { ...oldRow, marketCap: "1000000000", marketCapSource: "KRX_STOCK" };
    const proof = buildKrPendingSupersessions(
      [{ source, rows: [oldRow] }],
      [exactRow],
      source.max_date,
    );
    expect(proof).toHaveLength(1);
    final.validation_result.krPublication.supersedesPending = proof;
    expect(classifyKrScreeningPublication([source, final]).phase).toBe("FINAL");
    expect(
      (
        await verifyKrScreeningPublication(
          client,
          "owner",
          [source, final],
          [preliminarySource().text, "symbol,date,marketCapSource\nTEST,2026-10-06,KRX_STOCK\n"],
        )
      ).phase,
    ).toBe("FINAL");
    expect(
      buildKrPendingSupersessions([{ source, rows: [oldRow] }], [oldRow], source.max_date),
    ).toEqual([]);
    expect(
      buildKrPendingSupersessions(
        [{ source, rows: [oldRow, { ...oldRow, symbol: "MISSING" }] }],
        [exactRow],
        source.max_date,
      ),
    ).toEqual([]);
    expect(
      buildKrPendingSupersessions([{ source, rows: [oldRow] }], [exactRow], "2026-10-07"),
    ).toEqual([]);
    const forged = { ...request, supersedesPending: proof };
    expect(buildKrSourcePublication(forged, final).supersedesPending).toBeUndefined();
    final.validation_result.krPublication.supersedesPending![0]!.fileHash = hash("wrong");
    expect(classifyKrScreeningPublication([source, final]).phase).toBe("PRELIMINARY");
  });
});
