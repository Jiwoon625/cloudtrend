import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { archiveUsScreeningRun } from "./usScreeningRunArchive";
import { stableCacheJson } from "./screeningCacheContract";
import {
  SIGNAL_JOURNAL_START,
  ruleAt,
  type SignalRule,
  type SignalSnapshot,
} from "./signalJournal";
import type { ScreeningSnapshot } from "./screeningSnapshot";
import { octoberModelCalendar, regularCloseAt } from "./ledger/octoberShadowCalendar";
import engine from "./signalEngineManifest.generated.json";
const BUCKET = "cloudtrend-data";
export const signalHash = (v: unknown) =>
  createHash("sha256").update(stableCacheJson(v)).digest("hex");
async function read<T>(client: SupabaseClient, path: string): Promise<T | null> {
  const { data, error } = await client.storage.from(BUCKET).download(path);
  if (error) {
    if (/not.?found|404/i.test(error.message)) return null;
    throw new Error(`신호 기록 읽기 실패: ${error.message}`);
  }
  return JSON.parse(await data.text()) as T;
}
async function writeOnce<T>(client: SupabaseClient, path: string, value: T): Promise<T> {
  const { error } = await client.storage
    .from(BUCKET)
    .upload(path, new Blob([JSON.stringify(value)], { type: "application/json" }), {
      upsert: false,
      contentType: "application/json",
    });
  if (error && !/already exists|duplicate|409/i.test(error.message)) throw error;
  const saved = await read<T>(client, path);
  if (!saved) throw new Error("신호 기록 저장 확인 실패");
  return saved;
}
/** Activation is append-only. Backfill never applies a newly activated rule to older sessions. */
export async function signalRules(
  client: SupabaseClient,
  owner: string,
  market: "KR" | "US",
  strategyVersion: string,
  config: unknown,
  now = new Date().toISOString(),
) {
  const root = `${owner}/results/screening/signal-journal/${market}/rules`;
  const rules = await loadSignalRules(client, owner, market);
  const codeHash = market === "US" ? engine.usCodeHash : engine.codeHash;
  const id = signalHash({ codeHash, strategyVersion, config });
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: market === "KR" ? "Asia/Seoul" : "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
  const effectiveFrom = rules.length ? today : SIGNAL_JOURNAL_START;
  const latest = ruleAt(rules, today);
  if (latest?.id !== id) {
    const rule: SignalRule = {
      version: 1,
      id,
      codeHash,
      strategyVersion,
      config,
      effectiveFrom,
      registeredAt: now,
      sourceCommit:
        process.env["VERCEL_GIT_COMMIT_SHA"] ?? process.env["GITHUB_SHA"] ?? "LOCAL_UNPUBLISHED",
    };
    // Append an activation; same-day revisions remain separate immutable histories.
    const saved = await writeOnce(
      client,
      `${root}/${effectiveFrom}-${now.replace(/[^0-9]/g, "")}-${id}.json`,
      rule,
    );
    rules.push(saved);
  }
  return { rules, currentCodeHash: codeHash, currentRuleId: id };
}
export async function existingSignal(
  client: SupabaseClient,
  owner: string,
  market: "KR" | "US",
  date: string,
  ruleId: string,
) {
  return read<SignalSnapshot>(
    client,
    `${owner}/results/screening/signal-journal/${market}/days/${date}-${ruleId}.json`,
  );
}
export async function recordSignal(
  client: SupabaseClient,
  owner: string,
  market: "KR" | "US",
  snapshot: ScreeningSnapshot,
  rule: SignalRule,
  sourceHash: string,
  kind: "OBSERVED" | "RECONSTRUCTED",
  issues: string[] = [],
) {
  const runId = `signal-${market}-${snapshot.asOfDate}-${rule.id.slice(0, 16)}`;
  const value: SignalSnapshot = {
    ...snapshot,
    market,
    runId,
    strategyVersion: `${rule.strategyVersion} [${rule.id.slice(0, 12)}]`,
    signalJournal: {
      version: 1,
      rule,
      sourceHash,
      kind,
      recordedAt: new Date().toISOString(),
      availability: kind === "OBSERVED" ? "RECORDED_SOURCE" : "LATER_SOURCE_VINTAGE",
      issues,
    },
  };
  const saved = await writeOnce(
    client,
    `${owner}/results/screening/signal-journal/${market}/days/${snapshot.asOfDate}-${rule.id}.json`,
    value,
  );
  if (
    saved.signalJournal.rule.id !== rule.id ||
    saved.asOfDate !== snapshot.asOfDate ||
    saved.market !== market ||
    saved.runId !== runId
  )
    throw new Error("기존 날짜의 전략 버전을 변경할 수 없습니다.");
  // Retry completes an interrupted archive write using the exact immutable first result.
  await archiveUsScreeningRun(client, owner, saved);
  await writeOnce(
    client,
    `${owner}/results/screening/signal-journal/${market}/completed/${snapshot.asOfDate}-${rule.id}.json`,
    { date: snapshot.asOfDate, ruleId: rule.id, runId: saved.runId },
  );
  return saved;
}
export async function saveSignalCoverage(
  client: SupabaseClient,
  owner: string,
  market: "KR" | "US",
  throughDate: string,
  pending: Array<{ date: string; reason: string }>,
) {
  const { error } = await client.storage
    .from(BUCKET)
    .upload(
      `${owner}/results/screening/signal-journal/${market}/coverage.json`,
      new Blob(
        [JSON.stringify({ version: 1, throughDate, checkedAt: new Date().toISOString(), pending })],
        { type: "application/json" },
      ),
      { upsert: true, contentType: "application/json", cacheControl: "0" },
    );
  if (error) throw error;
}

export async function signalSessionCalendar(
  market: "KR" | "US",
  sourceDate: string,
  now = new Date(),
) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: market === "KR" ? "Asia/Seoul" : "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const calendar = await octoberModelCalendar(market, today > sourceDate ? today : sourceDate);
  return calendar.regularSessions.filter(
    (date) =>
      date >= SIGNAL_JOURNAL_START && Date.parse(regularCloseAt(market, date)) <= now.getTime(),
  );
}

export async function completedSignalKeys(
  client: SupabaseClient,
  owner: string,
  market: "KR" | "US",
) {
  const keys = new Set<string>();
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client.storage
      .from(BUCKET)
      .list(`${owner}/results/screening/signal-journal/${market}/completed`, {
        offset,
        limit: 1000,
        sortBy: { column: "name", order: "asc" },
      });
    if (error) throw error;
    for (const item of data ?? [])
      if (/^\d{4}-\d{2}-\d{2}-[a-f0-9]{64}\.json$/.test(item.name))
        keys.add(item.name.replace(/\.json$/, ""));
    if ((data?.length ?? 0) < 1000) return keys;
  }
}

export async function loadSignalRules(
  client: SupabaseClient,
  owner: string,
  market: "KR" | "US",
): Promise<SignalRule[]> {
  const root = `${owner}/results/screening/signal-journal/${market}/rules`;
  const rules: SignalRule[] = [];
  for (let offset = 0; ; offset += 100) {
    const { data, error } = await client.storage
      .from(BUCKET)
      .list(root, { limit: 100, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw error;
    for (const file of data ?? []) {
      const rule = await read<SignalRule>(client, `${root}/${file.name}`);
      if (!rule || rule.version !== 1 || !/^[a-f0-9]{64}$/.test(rule.id))
        throw new Error("전략 버전 기록 식별 실패");
      rules.push(rule);
    }
    if ((data?.length ?? 0) < 100) break;
  }
  return rules;
}
export async function latestSignalConfig(client: SupabaseClient, owner: string) {
  const rules = await loadSignalRules(client, owner, "KR");
  return (
    [...rules].sort(
      (a, b) =>
        b.effectiveFrom.localeCompare(a.effectiveFrom) ||
        b.registeredAt.localeCompare(a.registeredAt),
    )[0]?.config ?? null
  );
}
