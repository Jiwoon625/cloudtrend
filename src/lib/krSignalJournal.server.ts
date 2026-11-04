import type { SupabaseClient } from "@supabase/supabase-js";
import type { MarketDataset } from "./engine/dataset";
import type { ScoringConfig } from "./engine/scoring";
import type { ScreeningSnapshot } from "./screeningSnapshot";
import { buildSnapshot } from "./screeningSnapshot";
import { runFullMarketAnalysis } from "./engine/fullMarketAnalysis";
import { sliceKrDatasetForReplay } from "./shadowReplayCalculation";
import { screeningPublicationAnalysis } from "./screeningPublicationAnalysis";
import { appendEtfReportEvidence } from "./etfReportScore";
import { loadOperationalIndex } from "./operationalUnderlyingIndex.server";
import { octoberModelCalendar } from "./ledger/octoberShadowCalendar";
import { SIGNAL_JOURNAL_START, ruleAt } from "./signalJournal";
import {
  completedSignalKeys,
  signalRules,
  existingSignal,
  recordSignal,
  saveSignalCoverage,
  signalSessionCalendar,
} from "./signalJournal.server";
/** Signal-only catch-up. No positions, cash, execution simulation, NAV or return calculation. */
export async function publishKrSignalJournal(
  client: SupabaseClient,
  owner: string,
  input: {
    dataset: MarketDataset;
    config: ScoringConfig;
    snapshot: ScreeningSnapshot;
    sourceHash: string;
  },
) {
  const { dataset, config, snapshot, sourceHash } = input;
  const { rules, currentCodeHash, currentRuleId } = await signalRules(
    client,
    owner,
    "KR",
    snapshot.strategyVersion ?? "UNRECORDED",
    config,
  );
  const dates = await signalSessionCalendar("KR", snapshot.asOfDate);
  const pending: Array<{ date: string; reason: string }> = [];
  const completed = await completedSignalKeys(client, owner, "KR");
  let reconstructed = 0;
  for (const date of dates) {
    const rule = ruleAt(rules, date);
    if (!rule) {
      pending.push({ date, reason: "당시 전략 버전 미확정" });
      continue;
    }
    if (completed.has(`${date}-${rule.id}`)) continue;
    const saved = await existingSignal(client, owner, "KR", date, rule.id);
    if (saved) {
      await recordSignal(
        client,
        owner,
        "KR",
        saved,
        rule,
        saved.signalJournal.sourceHash,
        saved.signalJournal.kind,
        saved.signalJournal.issues,
      );
      continue;
    }
    if (rule.codeHash !== currentCodeHash) {
      pending.push({ date, reason: "당시 전략 실행 코드로 복원 필요" });
      continue;
    }
    if (date > snapshot.asOfDate || !dataset.tradeDates.includes(date)) {
      pending.push({ date, reason: "해당 거래일 자료 없음" });
      continue;
    }
    if (date === snapshot.asOfDate && rule.id === currentRuleId) {
      await recordSignal(client, owner, "KR", snapshot, rule, sourceHash, "OBSERVED");
      continue;
    }
    if (reconstructed >= 5) {
      pending.push({ date, reason: "복원 대기 · 다음 실행에서 이어서 처리" });
      continue;
    }
    reconstructed++;
    // Slice dated inputs before analysis; never copy a later day's score/signals backward.
    const sliced = sliceKrDatasetForReplay(dataset, date);
    if (sliced.krxReviewObservations) sliced.krxReviewObservations = {};
    const oldConfig = rule.config as ScoringConfig;
    const { analysis, dataset: prepared } = runFullMarketAnalysis(sliced, oldConfig);
    const provider = await loadOperationalIndex(client, owner, prepared, new Date().toISOString());
    const projected = screeningPublicationAnalysis(analysis, prepared, oldConfig, provider);
    const result = appendEtfReportEvidence(
      buildSnapshot(projected, undefined, `signal-KR-${date}-${rule.id.slice(0, 16)}`),
      projected,
    );
    await recordSignal(client, owner, "KR", result, rule, sourceHash, "RECONSTRUCTED", [
      "후일 수집자료로 복원: 당시 데이터 제공 범위·수정 전 가격·종목 구성의 완전한 재현은 아님",
    ]);
  }
  await saveSignalCoverage(client, owner, "KR", snapshot.asOfDate, pending);
  return { pending };
}
