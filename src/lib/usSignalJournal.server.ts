import type { SupabaseClient } from "@supabase/supabase-js";
import {
  runUsProspectiveAnalysis,
  US_PROSPECTIVE_RULE_VERSION,
  type UsProspectiveInputRow,
  type UsProspectivePreviousState,
} from "./engine/usProspective";
import { octoberModelCalendar } from "./ledger/octoberShadowCalendar";
import { SIGNAL_JOURNAL_START, ruleAt, type SignalSnapshot } from "./signalJournal";
import {
  completedSignalKeys,
  signalRules,
  existingSignal,
  recordSignal,
  saveSignalCoverage,
  signalSessionCalendar,
} from "./signalJournal.server";
import type { ScreeningSnapshot } from "./screeningSnapshot";
type StatefulSignal = SignalSnapshot & { signalState?: UsProspectivePreviousState };
export async function publishUsSignalJournal(
  client: SupabaseClient,
  owner: string,
  input: {
    rows: UsProspectiveInputRow[];
    throughDate: string;
    sourceHash: string;
    collectedAt: string;
    /** Each historical day needs its own validated collector metadata. */
    validatedDates?: readonly string[];
  },
) {
  const { rules, currentCodeHash } = await signalRules(
    client,
    owner,
    "US",
    US_PROSPECTIVE_RULE_VERSION,
    { ruleVersion: US_PROSPECTIVE_RULE_VERSION },
  );
  const expected = await signalSessionCalendar("US", input.throughDate);
  const calendar = await octoberModelCalendar("US", expected.at(-1) ?? input.throughDate);
  const pending: Array<{ date: string; reason: string }> = [];
  const completed = await completedSignalKeys(client, owner, "US");
  let previous: UsProspectivePreviousState | undefined;
  for (const [i, date] of calendar.regularSessions.entries()) {
    if (!expected.includes(date)) continue;
    const rule = ruleAt(rules, date);
    if (rule && completed.has(`${date}-${rule.id}`)) continue;
    if (!rule || rule.codeHash !== currentCodeHash) {
      pending.push({ date, reason: "당시 전략 실행 코드 확인 필요" });
      continue;
    }
    const saved = (await existingSignal(
      client,
      owner,
      "US",
      date,
      rule.id,
    )) as StatefulSignal | null;
    if (saved) {
      await recordSignal(
        client,
        owner,
        "US",
        saved,
        rule,
        saved.signalJournal.sourceHash,
        saved.signalJournal.kind,
        saved.signalJournal.issues,
      );
      previous = saved.signalState;
      continue;
    }
    const rows = input.rows.filter((r) => r.date === date);
    if (!rows.length || !(input.validatedDates ?? [input.throughDate]).includes(date)) {
      pending.push({ date, reason: "해당 거래일 전체 종목 자료 없음" });
      continue;
    }
    const predecessor = calendar.regularSessions[i - 1];
    if (predecessor && previous?.lastDate !== predecessor) {
      const priorRule = ruleAt(rules, predecessor);
      if (priorRule) {
        const prior = (await existingSignal(
          client,
          owner,
          "US",
          predecessor,
          priorRule.id,
        )) as StatefulSignal | null;
        if (prior?.signalState?.lastDate === predecessor) previous = prior.signalState;
      }
    }
    if (!previous && predecessor && predecessor < SIGNAL_JOURNAL_START) {
      const { data, error } = await client.storage
        .from("cloudtrend-data")
        .download(`${owner}/results/us-screening/${predecessor}.json`);
      if (error && !/not.?found|404/i.test(error.message)) throw error;
      if (data) {
        const old = JSON.parse(await data.text());
        if (
          old.analysis?.ruleVersion === US_PROSPECTIVE_RULE_VERSION &&
          old.analysis?.state?.lastDate === predecessor
        )
          previous = old.analysis.state;
      }
    }
    if (previous?.lastDate !== predecessor) {
      pending.push({ date, reason: "직전 거래일 순위·연속 조건 미확인" });
      continue;
    }
    const analysis = runUsProspectiveAnalysis(rows, previous);
    const snapshot: ScreeningSnapshot & { signalState: UsProspectivePreviousState } = {
      date,
      asOfDate: date,
      savedAt: new Date().toISOString(),
      sourceRegisteredAt: input.collectedAt,
      market: "US",
      strategyVersion: analysis.ruleVersion,
      marketGateStatus: "US_A0",
      totalCount: analysis.rows.length,
      passedCount: analysis.rows.filter((r) => r.a0Entry).length,
      gradeACount: 0,
      gradeBCount: 0,
      signalState: analysis.state,
      entries: analysis.rows.map((r) => ({
        symbol: r.symbol,
        name: r.name,
        market: "US",
        instrumentType: "STOCK",
        sectorCode: r.sector ?? "",
        sectorName: r.sector ?? "",
        grade: "",
        status: r.a0Entry ? "진입 신호" : r.a0Exit ? "청산 조건" : "관찰",
        totalScore: r.coreRank ?? 0,
        scoreDelta1d: null,
        technicalPoints: r.coreRank,
        priorityPoints: r.betaRank ?? 0,
        hardFilterPassed: r.eligibleBase,
        evidence: {
          a0Entry: r.a0Entry,
          a0Exit: r.a0Exit,
          a2Entry: r.a2Entry,
          a2Exit: r.a2Exit,
          b3Entry: r.b3Entry,
          b3Exit: r.b3Exit,
          onset80: r.onset80,
          rawOnset: r.onset80,
          previousCoreRank: r.previousCoreRank,
          previousCoreDate: r.previousCoreDate,
          betaWeakStreak: r.betaWeakStreak,
        },
      })),
    };
    const stored = await recordSignal(
      client,
      owner,
      "US",
      snapshot,
      rule,
      input.sourceHash,
      date === input.throughDate ? "OBSERVED" : "RECONSTRUCTED",
    );
    previous = (stored as StatefulSignal).signalState;
  }
  await saveSignalCoverage(client, owner, "US", input.throughDate, pending);
  return { pending };
}
