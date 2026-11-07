/** Derive recent chart results from verified runner-local inputs; never uploads source CSV. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseManualMarketDataWithReferences } from "../src/lib/krxReviewReferenceParser";
import { restoreChartContext, warmRecentCharts } from "../src/lib/instrumentChartStore.server";
import { loadOperationalIndex } from "../src/lib/operationalUnderlyingIndex.server";
import { savedOperationalIdentity } from "../src/lib/screeningInputIdentity";
import { trustedSupabaseClient, downloadJson } from "./analysis-run-store";
import type { AnalysisResult } from "../src/lib/engine/pipeline";
import type { ScoringConfig } from "../src/lib/engine/scoring";
export async function prepareDriveCharts(root: string) {
  const directory = path.resolve(root),
    owner = process.env["SUPABASE_USER_ID"];
  if (!owner) throw new Error("Missing owner");
  const receipt = JSON.parse(
    await readFile(path.join(directory, "execution-receipt.json"), "utf8"),
  );
  if (
    receipt.mode !== "publish" ||
    receipt.dashboardPublished !== true ||
    receipt.status !== "COMPLETED"
  )
    throw new Error("Result publication must complete before charts");
  const index = JSON.parse(
    await readFile(path.join(directory, "chart-inputs/index.json"), "utf8"),
  ) as Array<{ file: string; sha256: string }>;
  if (!Array.isArray(index) || !index.length || index.length > 2048)
    throw new Error("Invalid local chart inputs");
  const texts = [];
  for (const entry of index) {
    if (!/^\d{4}\.csv$/.test(entry.file)) throw new Error("Invalid local chart path");
    const text = await readFile(path.join(directory, "chart-inputs", entry.file), "utf8");
    if (createHash("sha256").update(text).digest("hex") !== entry.sha256)
      throw new Error("Chart input hash mismatch");
    texts.push(text);
  }
  const bundleFile = receipt.publication.resultPath.split("/").at(-1)!;
  const bundle = JSON.parse(
    await readFile(
      path.join(
        directory,
        "results",
        `screening-${bundleFile.replace(/\.json$/, "")}`,
        "screening-bundle.json",
      ),
      "utf8",
    ),
  ) as { result: AnalysisResult; config: ScoringConfig };
  const { dataset } = parseManualMarketDataWithReferences(texts);
  texts.length = 0;
  const client = trustedSupabaseClient(),
    meta = savedOperationalIdentity(bundle.result);
  const current = await downloadJson<{ inputFingerprint: string; resultDigest: string }>(
    client,
    `${owner}/cache/screening/latest.json`,
  );
  if (
    current.inputFingerprint !== receipt.publication.inputFingerprint ||
    current.resultDigest !== receipt.publication.resultDigest
  )
    throw new Error("더 최신 결과가 게시되어 이전 차트 준비를 중단했습니다.");
  const provider = meta
    ? await loadOperationalIndex(client, owner, dataset, new Date().toISOString(), false, meta)
    : undefined;
  if (
    meta &&
    (!provider ||
      provider.version !== meta.version ||
      provider.artifactSha256 !== meta.artifactSha256 ||
      provider.asOfDate !== meta.asOfDate)
  )
    throw new Error("게시 결과와 동일한 운영 지수 자료를 확인하지 못했습니다.");
  const ctx = restoreChartContext(
    dataset,
    bundle.result,
    bundle.config,
    receipt.publication.resultDigest,
    provider ?? undefined,
  );
  await warmRecentCharts(client, owner, receipt.publication, ctx);
  console.log(JSON.stringify({ recentChartsPrepared: true, asOfDate: bundle.result.asOfDate }));
}
