import type { IntegratedAllocationOutboxPayload } from "./integratedAllocationRecovery.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { downloadFreshObject } from "./freshStorage";
import type { MarketDataset } from "./engine/dataset";
import type { AnalysisResult } from "./engine/pipeline";
import type { UsProspectiveAnalysis } from "./engine/usProspective";
import {
  prepareIntegratedKrEvidence,
  adaptIntegratedKrEvidence,
  adaptIntegratedUsSession,
  type IntegratedKrEvidence,
  type AllocationAdapterClock,
} from "./integratedAllocationReplayAdapter";
import { hashSeriesValue, type SeriesHash } from "./ledger/modelSeries";
import {
  octoberModelCalendar,
  OCTOBER_CALENDAR_EVIDENCE,
  regularOpenAt,
  regularCloseAt,
} from "./ledger/octoberShadowCalendar";
import {
  integratedMarketsDue,
  prepareIntegratedDailyPublication,
} from "./integratedAllocationPublication";
import {
  appendIntegratedAllocationPublication,
  readIntegratedAllocationBook,
  integratedAllocationCodeHash,
  integratedAllocationRuntimeAdmission,
} from "./integratedAllocationStore.server";
import { recordIntegratedRuntimeAttempt } from "./integratedAllocationRuntimeAudit.server";
const bucket = "cloudtrend-data";
const prefix = (uid: string) => `${uid}/staging/integrated-allocation-inputs/v1`;
interface UsEvidence {
  version: "integrated-us-daily-evidence-v1";
  analysis: UsProspectiveAnalysis;
  clock: AllocationAdapterClock;
}
class IntegratedEvidenceStorageError extends Error {}
async function read<T>(client: SupabaseClient, path: string): Promise<T | null> {
  const { data, error } = await downloadFreshObject(client, bucket, path);
  if (error) {
    if (String(error.statusCode) === "404" || /not found/i.test(error.message)) return null;
    throw new IntegratedEvidenceStorageError("통합 배분 입력 조회 실패");
  }
  if (!data) return null;
  const envelope = JSON.parse(await data.text()) as { hash: SeriesHash; payload: T };
  if ((await hashSeriesValue(envelope.payload)) !== envelope.hash)
    throw new Error("통합 배분 입력 해시 불일치");
  return envelope.payload;
}
export async function hasIntegratedAllocationEvidence(
  client: SupabaseClient,
  uid: string,
  market: "KR" | "US",
  date: string,
) {
  return (await read<unknown>(client, `${prefix(uid)}/${market}/${date}.json`)) !== null;
}
async function put(client: SupabaseClient, path: string, payload: unknown) {
  const hash = await hashSeriesValue(payload);
  const existing = await read<unknown>(client, path);
  if (existing) {
    if ((await hashSeriesValue(existing)) !== hash)
      throw new Error("통합 배분 날짜별 입력은 변경할 수 없습니다");
    return;
  }
  const bytes = JSON.stringify({ hash, payload });
  const { error } = await client.storage.from(bucket).upload(path, new Blob([bytes]), {
    upsert: false,
    contentType: "application/json",
    cacheControl: "0",
  });
  const checked = await read<unknown>(client, path);
  if (!checked)
    throw new IntegratedEvidenceStorageError(
      `통합 배분 입력 저장 확인 실패${error ? " · 재조회 필요" : ""}`,
    );
  if ((await hashSeriesValue(checked)) !== hash)
    throw new Error("통합 배분 날짜별 입력은 변경할 수 없습니다");
}
async function stageOrRetainOutbox(
  client: SupabaseClient,
  uid: string,
  market: "KR" | "US",
  date: string,
  payload: IntegratedAllocationOutboxPayload,
  calculatedAt?: string,
) {
  await recordIntegratedRuntimeAttempt(client, uid, {
    admission: integratedAllocationRuntimeAdmission,
    kind: "EVIDENCE_PREPARED",
    date,
    market,
    subjectHash: await hashSeriesValue(payload),
    sourceHash: payload.clock.sourceHash,
  });
  try {
    await put(client, `${prefix(uid)}/${market}/${date}.json`, payload);
  } catch (error) {
    if (!(error instanceof IntegratedEvidenceStorageError)) throw error;
    const { storeIntegratedAllocationOutbox } =
      await import("./integratedAllocationRecovery.server");
    // Persist exact prepared evidence before the existing market publication continues.
    // Failure of both channels remains explicit; no lost-input success is returned.
    await storeIntegratedAllocationOutbox(client, uid, {
      market,
      date,
      payload,
      ...(calculatedAt ? { calculatedAt } : {}),
    });
  }
}
async function readOrRestore<T>(
  client: SupabaseClient,
  uid: string,
  market: "KR" | "US",
  date: string,
): Promise<T | null> {
  const path = `${prefix(uid)}/${market}/${date}.json`;
  const saved = await read<T>(client, path);
  if (saved) return saved;
  const { readIntegratedAllocationOutbox } = await import("./integratedAllocationRecovery.server");
  const retained = await readIntegratedAllocationOutbox(client, uid, market, date);
  if (!retained) return null;
  await recordIntegratedRuntimeAttempt(client, uid, {
    admission: integratedAllocationRuntimeAdmission,
    kind: "EVIDENCE_RESTORED",
    date,
    market,
    subjectHash: await hashSeriesValue(retained),
    sourceHash: retained.clock.sourceHash,
  });
  await put(client, path, retained);
  return read<T>(client, path);
}
async function clock(
  market: "KR" | "US",
  date: string,
  sourceHash: SeriesHash,
  availableAt: string,
  decisionAt: string,
): Promise<AllocationAdapterClock> {
  const calendar = await octoberModelCalendar(market, OCTOBER_CALENDAR_EVIDENCE.coverageEnd);
  return {
    openAt: regularOpenAt(market, date),
    closeAt: regularCloseAt(market, date),
    availableAt,
    decisionAt,
    sourceHash,
    codeHash: integratedAllocationCodeHash,
    calendar: { sourceHash: calendar.sourceHash, sessions: calendar.regularSessions },
  };
}
export async function stageIntegratedKrEvidence(
  client: SupabaseClient,
  uid: string,
  input: {
    dataset: MarketDataset;
    analysis: AnalysisResult;
    sourceHash: SeriesHash;
    availableAt: string;
    decisionAt: string;
    calculatedAt?: string;
  },
) {
  if (input.analysis.asOfDate < "2026-10-12") return;
  const evidence = prepareIntegratedKrEvidence(
    input.dataset,
    input.analysis,
    await clock(
      "KR",
      input.analysis.asOfDate,
      input.sourceHash,
      input.availableAt,
      input.decisionAt,
    ),
  );
  await stageOrRetainOutbox(client, uid, "KR", evidence.date, evidence, input.calculatedAt);
}
export async function stageIntegratedUsEvidence(
  client: SupabaseClient,
  uid: string,
  input: {
    analysis: UsProspectiveAnalysis;
    sourceHash: SeriesHash;
    availableAt: string;
    decisionAt: string;
    calculatedAt?: string;
  },
) {
  if (input.analysis.date < "2026-10-12") return;
  const evidence: UsEvidence = {
    version: "integrated-us-daily-evidence-v1",
    analysis: input.analysis,
    clock: await clock(
      "US",
      input.analysis.date,
      input.sourceHash,
      input.availableAt,
      input.decisionAt,
    ),
  };
  await stageOrRetainOutbox(client, uid, "US", input.analysis.date, evidence, input.calculatedAt);
}
/** Reuses only completed dated inputs. No fresh scoring, no raw-source reload, no actual-book access. */
export async function replayIntegratedAllocationAvailable(
  client: SupabaseClient,
  uid: string,
  throughDate: string,
  now = new Date().toISOString(),
  mode: "service" | "authenticated-owner" = "authenticated-owner",
) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(throughDate) ||
    !Number.isFinite(Date.parse(`${throughDate}T00:00:00Z`)) ||
    new Date(`${throughDate}T00:00:00Z`).toISOString().slice(0, 10) !== throughDate
  )
    throw new Error("통합 배분 조회 기준일이 올바르지 않습니다");
  if (throughDate > OCTOBER_CALENDAR_EVIDENCE.coverageEnd)
    throw new Error("검증된 시장 달력 범위 밖입니다. 새 달력 확인 후 이어 계산합니다");
  if (throughDate < "2026-10-12") return { recorded: 0, waiting: null };
  const krCalendar = await octoberModelCalendar("KR", OCTOBER_CALENDAR_EVIDENCE.coverageEnd),
    usCalendar = await octoberModelCalendar("US", OCTOBER_CALENDAR_EVIDENCE.coverageEnd);
  const dates = [...new Set([...krCalendar.regularSessions, ...usCalendar.regularSessions])]
    .filter((d) => d >= "2026-10-12" && d <= throughDate)
    .sort();
  const krCache = new Map<string, IntegratedKrEvidence | null>(),
    usCache = new Map<string, UsEvidence | null>();
  const kr = async (d: string) => {
    if (!krCache.has(d))
      krCache.set(d, await readOrRestore<IntegratedKrEvidence>(client, uid, "KR", d));
    return krCache.get(d)!;
  };
  const us = async (d: string) => {
    if (!usCache.has(d)) usCache.set(d, await readOrRestore<UsEvidence>(client, uid, "US", d));
    return usCache.get(d)!;
  };
  let recorded = 0,
    waiting: string | null = null;
  for (const kind of ["O1", "S07"] as const) {
    let book = await readIntegratedAllocationBook(client, uid, kind);
    if (!book.registry || !book.ledger) {
      waiting = "신규 자산배분 장부 초기화 대기";
      continue;
    }
    for (const date of dates.filter((d) => d > (book.head?.receipt.date ?? ""))) {
      if (!book.ledger || !book.registry) throw new Error("통합 Shadow 초기 상태 누락");
      const due = await integratedMarketsDue(date),
        ke = due.includes("K") ? await kr(date) : null,
        ue = due.includes("U") ? await us(date) : null;
      if ((due.includes("K") && !ke) || (due.includes("U") && !ue)) {
        waiting = `${date} 전체 시장 입력 대기`;
        break;
      }
      const history: IntegratedKrEvidence[] = [];
      for (const day of book.ledger.markets.K.sessions) {
        const e = await kr(day);
        if (!e) throw new Error("통합 한국 입력 연속성 누락");
        history.push(e);
      }
      const priorUs = book.ledger.markets.U.lastSessionDate
        ? await us(book.ledger.markets.U.lastSessionDate)
        : null;
      const sessions = due.map((m) =>
        m === "U"
          ? adaptIntegratedUsSession(book.ledger!, {
              analysis: ue!.analysis,
              previousAnalysis: priorUs?.analysis ?? null,
              clock: ue!.clock,
            })
          : adaptIntegratedKrEvidence(book.ledger!, { market: m, evidence: ke!, history }),
      );
      const monthEnd = ![...krCalendar.regularSessions, ...usCalendar.regularSessions].some(
        (day) => day > date && day.slice(0, 7) === date.slice(0, 7),
      );
      const decisionAt = sessions
        .map((session) => session.decisionAt)
        .sort((a, b) => Date.parse(a) - Date.parse(b))
        .at(-1)!;
      const monthReview =
        kind === "O1" && monthEnd
          ? {
              month: date.slice(0, 7),
              decisionAt,
              codeHash: integratedAllocationCodeHash,
              sourceHash: await hashSeriesValue({
                month: date.slice(0, 7),
                policy: "PREVIOUS_CALENDAR_MONTH_DELIVERED_ENTRY_SIGNALS",
                priorStateHash: book.ledger!.stateHash,
                dailyInputs: sessions,
              }),
              calendars: {
                K: { sourceHash: krCalendar.sourceHash, sessions: krCalendar.regularSessions },
                E: { sourceHash: krCalendar.sourceHash, sessions: krCalendar.regularSessions },
                U: { sourceHash: usCalendar.sourceHash, sessions: usCalendar.regularSessions },
              },
            }
          : undefined;
      const publication = await prepareIntegratedDailyPublication({
        registry: book.registry,
        previous: book.head,
        date,
        sessions,
        ...(monthReview ? { monthReview } : {}),
        now,
      });
      const saved = await appendIntegratedAllocationPublication(
        client,
        uid,
        publication,
        book.head,
        mode,
      );
      book = saved.book;
      recorded++;
    }
  }
  return { recorded, waiting };
}
