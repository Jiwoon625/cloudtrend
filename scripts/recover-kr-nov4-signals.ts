/** Run only inside the pinned historical checkout; restore one journal, never a ledger. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { trustedSupabaseClient, downloadJson } from "./analysis-run-store";
import {
  loadSignalRules,
  recordSignal,
  existingSignal,
  signalHash,
} from "../src/lib/signalJournal.server";
import { ruleAt } from "../src/lib/signalJournal";
import engine from "../src/lib/signalEngineManifest.generated.json";
import { validateSourceBytes } from "../src/lib/sourceData";
import { parseManualMarketDataWithReferences } from "../src/lib/krxReviewReferenceParser";
import { sliceKrDatasetForReplay } from "../src/lib/shadowReplayCalculation";
import { runFullMarketAnalysis } from "../src/lib/engine/fullMarketAnalysis";
import { loadOperationalIndex } from "../src/lib/operationalUnderlyingIndex.server";
import { screeningPublicationAnalysis } from "../src/lib/screeningPublicationAnalysis";
import { appendEtfReportEvidence } from "../src/lib/etfReportScore";
import { buildSnapshot } from "../src/lib/screeningSnapshot";
import type { ScoringConfig } from "../src/lib/engine/scoring";

const DATE = "2026-11-04";
const COMMIT = "3434eed24a7eb67f3244e18b0a7cb80ed7be0e81";
const HASH = "fc52ddb2b129c84879a1c734f5bd60b5f716efa6b167da5539a3df037efee286";
const RULE = "513f2f15f8a031d8e52cc1ae01f30d9c72fea44f3a2621d28dabe0f55a3e412e";
const SOURCE_RUN = "20261105004702-a65a294d";
const sha = (v: Uint8Array | string) => "sha256:" + createHash("sha256").update(v).digest("hex");
function guard(input: {
  commit: string;
  hash: string;
  rule: string;
  date: string;
  sourceDate: string;
}) {
  assert.equal(input.commit, COMMIT, "Historical checkout mismatch");
  assert.equal(input.hash, HASH, "Historical engine mismatch");
  assert.equal(input.rule, RULE, "Historical rule mismatch");
  assert.equal(input.date, DATE, "Recovery date mismatch");
  assert.equal(input.sourceDate, DATE, "Source date mismatch");
}
if (process.argv.includes("--self-test")) {
  const valid = { commit: COMMIT, hash: HASH, rule: RULE, date: DATE, sourceDate: DATE };
  guard(valid);
  for (const key of Object.keys(valid)) assert.throws(() => guard({ ...valid, [key]: "wrong" }));
  console.log("Recovery identity guards: 6 checks passed");
} else {
  assert.ok(process.argv.includes("--apply"), "Explicit --apply required");
  const client = trustedSupabaseClient();
  const owner = process.env["SUPABASE_USER_ID"]!;
  assert.match(owner, /^[a-f0-9-]{36}$/);
  const rules = await loadSignalRules(client, owner, "KR");
  const rule = ruleAt(rules, DATE);
  assert.ok(rule);
  const bundle = await downloadJson<{
    run: { id: string };
    data: {
      asOfDate: string;
      sources: Array<{
        objectPath: string;
        fileName: string;
        fileHash: string;
        dataHash: string;
        schemaHash: string;
      }>;
    };
    summary: { strategyVersion: string };
    config: ScoringConfig;
  }>(client, `${owner}/results/screening/${SOURCE_RUN}.json`);
  guard({
    commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    hash: engine.codeHash,
    rule: rule.id,
    date: DATE,
    sourceDate: bundle.data.asOfDate,
  });
  assert.equal(rule.codeHash, HASH);
  assert.equal(
    signalHash({
      codeHash: rule.codeHash,
      strategyVersion: rule.strategyVersion,
      config: rule.config,
    }),
    RULE,
  );
  assert.equal(bundle.run.id, SOURCE_RUN);
  assert.equal(bundle.summary.strategyVersion, rule.strategyVersion);
  assert.equal(signalHash(bundle.config), signalHash(rule.config));
  const prior = await existingSignal(client, owner, "KR", DATE, RULE);
  let saved = prior;
  if (prior) {
    assert.equal(prior.signalJournal.kind, "RECONSTRUCTED");
    assert.ok(
      prior.signalJournal.issues.some((x) => x.includes(SOURCE_RUN)),
      "Unrelated existing record; do not overwrite",
    );
    saved = await recordSignal(
      client,
      owner,
      "KR",
      prior,
      rule,
      prior.signalJournal.sourceHash,
      prior.signalJournal.kind,
      prior.signalJournal.issues,
    );
  } else {
    assert.ok(Array.isArray(bundle.data.sources) && bundle.data.sources.length > 0);
    const texts: string[] = [];
    for (const source of bundle.data.sources) {
      assert.ok(source.objectPath.startsWith(`${owner}/source/screening/`));
      const { data, error } = await client.storage
        .from("cloudtrend-data")
        .download(source.objectPath);
      if (error || !data) throw new Error("Frozen source download failed");
      const bytes = new Uint8Array(await data.arrayBuffer());
      assert.equal(sha(bytes), source.fileHash, "Frozen source bytes changed");
      const validated = await validateSourceBytes({
        bytes,
        filename: source.fileName,
        streamingCsv: true,
      });
      assert.ok(validated.valid, "Invalid frozen source");
      assert.equal(validated.dataHash, source.dataHash);
      assert.equal(validated.schemaHash, source.schemaHash);
      texts.push(validated.canonicalCsv);
    }
    console.log(`Verified frozen source files: ${texts.length}`);
    const raw = parseManualMarketDataWithReferences(texts).dataset;
    texts.length = 0;
    assert.ok(raw.tradeDates.includes(DATE));
    const sliced = sliceKrDatasetForReplay(raw, DATE);
    if (sliced.krxReviewObservations) sliced.krxReviewObservations = {};
    const { analysis, dataset } = runFullMarketAnalysis(sliced, rule.config as ScoringConfig);
    assert.equal(analysis.asOfDate, DATE);
    const now = new Date().toISOString();
    const provider = await loadOperationalIndex(client, owner, dataset, now);
    const projected = screeningPublicationAnalysis(
      analysis,
      dataset,
      rule.config as ScoringConfig,
      provider,
    );
    const snapshot = appendEtfReportEvidence(
      buildSnapshot(projected, undefined, `signal-KR-${DATE}-${RULE.slice(0, 16)}`),
      projected,
    );
    const sourceHash = sha(JSON.stringify(bundle.data.sources));
    saved = await recordSignal(client, owner, "KR", snapshot, rule, sourceHash, "RECONSTRUCTED", [
      `당시 코드 ${COMMIT}로 복구 · 보존 원천 실행 ${SOURCE_RUN}`,
      "11월 5일 확보된 11월 4일 확정 원천자료로 후일 복원. 당일 실시간 관측 기록이 아니며 원천가격 수정·종목구성 차이는 남을 수 있음",
      `운영 기초지수 자료: ${provider?.artifactSha256 ?? "none"}`,
    ]);
  }
  assert.ok(saved);
  const verified = await existingSignal(client, owner, "KR", DATE, RULE);
  assert.equal(signalHash(verified), signalHash(saved), "Journal readback mismatch");
  const { data: done, error } = await client.storage
    .from("cloudtrend-data")
    .download(`${owner}/results/screening/signal-journal/KR/completed/${DATE}-${RULE}.json`);
  assert.ok(!error && done);
  assert.equal((await done!.text()).includes(RULE), true);
  const receipt = {
    version: 1,
    status: "VERIFIED",
    date: DATE,
    ruleId: RULE,
    engineCommit: COMMIT,
    engineHash: HASH,
    sourceRun: SOURCE_RUN,
    kind: saved.signalJournal.kind,
    entries: saved.entries.length,
    runId: saved.runId,
    journalHash: signalHash(saved),
    recordedAt: saved.signalJournal.recordedAt,
  };
  await mkdir("recovery-output", { recursive: true });
  await writeFile("recovery-output/receipt.json", JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
}
