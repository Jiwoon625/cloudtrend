/** Cheap, read-only no-work detection. Never certifies the historical payloads. */
import type { SupabaseClient } from "@supabase/supabase-js";
import { readIntegratedAllocationBook } from "../../src/lib/integratedAllocationStore.server";
import { octoberShadowStore } from "../../src/lib/ledger/octoberShadowRepository.server";
import {
  octoberModelCalendar,
  regularOpenAt,
  OCTOBER_CALENDAR_EVIDENCE,
} from "../../src/lib/ledger/octoberShadowCalendar";
import { RESTART_SERIES_VERSION, type AdoptedSeriesKind } from "../../src/lib/ledger/modelSeries";
import type { GenerationProbe } from "./generation-cache";
const KINDS: Record<"KR" | "US", AdoptedSeriesKind[]> = {
  KR: ["KR_MIXED", "KR_KOSPI", "KR_KOSDAQ", "ETF_V02", "KR_KOSPI_CONFIRM1_BEAR"],
  US: ["US_A0", "US_A2", "US_B3"],
};
export type QuickInspection = {
  status: "NO_WORK_METADATA_ONLY" | "WAITING_METADATA_ONLY" | "NEEDS_FULL_INSPECTION";
  needsFullInspection: boolean;
  payloadProvenanceRevalidated: false;
  reason: string;
  checkedInputs: number;
  waitingDate?: string;
  missingMarkets?: Array<{ market: "KR" | "US"; published: number; required: number }>;
};
/** freshGeneration must use an authenticated uncached owner-scoped storage metadata probe. */
export async function inspectNoWork(
  client: SupabaseClient,
  uid: string,
  throughDate: string,
  freshGeneration: (path: string) => Promise<GenerationProbe>,
): Promise<QuickInspection> {
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(uid))
    throw Error("Verified owner required");
  let checkedInputs = 0;
  const full = (reason: string): QuickInspection => ({
    status: "NEEDS_FULL_INSPECTION",
    needsFullInspection: true,
    payloadProvenanceRevalidated: false,
    reason,
    checkedInputs,
  });
  // Error details may contain upstream URLs; expose only classified reasons.
  try {
    const calendars = {
      KR: await octoberModelCalendar("KR", throughDate),
      US: await octoberModelCalendar("US", throughDate),
    };
    if (throughDate < "2026-10-12" || throughDate > OCTOBER_CALENDAR_EVIDENCE.coverageEnd)
      return full("OUTSIDE_REVIEWED_HORIZON");
    const dates = {
      KR: calendars.KR.regularSessions.filter((d) => d >= "2026-10-12"),
      US: calendars.US.regularSessions.filter((d) => d >= "2026-10-12"),
    };
    if (!dates.KR.includes(throughDate) && !dates.US.includes(throughDate))
      return full("HORIZON_NOT_SESSION");
    // Preserve pending special-session hours holds rather than silently passing metadata.
    for (const market of ["KR", "US"] as const)
      for (const date of dates[market]) regularOpenAt(market, date);
    const heads: string[] = [];
    for (const kind of ["O1", "S07"] as const) {
      const book = await readIntegratedAllocationBook(client, uid, kind);
      const head = book.head?.receipt.date;
      if (
        !book.registry ||
        !head ||
        head > throughDate ||
        (!dates.KR.includes(head) && !dates.US.includes(head))
      )
        return full("INTEGRATED_HEAD_OUTSIDE_HORIZON");
      heads.push(head);
    }
    if (heads[0] !== heads[1]) return full("INTEGRATED_HEADS_DIVERGENT");
    const checkpoint = heads[0];
    const pendingDate = [...new Set([...dates.KR, ...dates.US])].sort().find((d) => d > checkpoint);
    const pendingCounts = { KR: 0, US: 0 };
    const store = octoberShadowStore(client, uid, "service");
    for (const market of ["KR", "US"] as const)
      for (const kind of KINDS[market]) {
        const bookId = `${RESTART_SERIES_VERSION}:${kind}`;
        const registry = await store.readSeries(bookId);
        if (
          !registry ||
          registry.bookId !== bookId ||
          registry.policy.kind !== kind ||
          registry.policy.market !== market
        )
          return full("MODEL_REGISTRY_MISMATCH");
        let index = 0;
        for (let offset = 0; ; offset += 100) {
          const { data, error } = await client
            .from("ledger_model_sessions")
            .select("series_id,session_date,previous_session_date,state_hash")
            .eq("user_id", uid)
            .eq("series_id", bookId)
            .gte("session_date", "2026-10-12")
            .lte("session_date", throughDate)
            .order("session_date", { ascending: true })
            .range(offset, offset + 99);
          if (error || !Array.isArray(data)) throw Error("MODEL_METADATA_QUERY_FAILED");
          for (const row of data) {
            if (
              row.series_id !== bookId ||
              row.session_date !== dates[market][index] ||
              row.previous_session_date !== (dates[market][index - 1] ?? null) ||
              typeof row.state_hash !== "string" ||
              !/^sha256:[a-f0-9]{64}$/.test(row.state_hash)
            )
              return full("MODEL_DATED_GRID_MISMATCH");
            if (row.session_date === pendingDate) pendingCounts[market]++;
            index++;
          }
          if (data.length < 100) break;
        }
        const historicCount = dates[market].filter((d) => d <= checkpoint).length;
        if (index < historicCount || (!pendingDate && index !== dates[market].length))
          return full("MODEL_DATED_GRID_INCOMPLETE");
      }
    const missingMarkets = pendingDate
      ? (["KR", "US"] as const)
          .filter(
            (market) =>
              dates[market].includes(pendingDate) && pendingCounts[market] < KINDS[market].length,
          )
          .map((market) => ({
            market,
            published: pendingCounts[market],
            required: KINDS[market].length,
          }))
      : [];
    if (pendingDate && !missingMarkets.length)
      return full("FIRST_PENDING_DATE_REQUIRES_FULL_INSPECTION");
    for (const market of ["KR", "US"] as const)
      for (const date of dates[market].filter((d) => d <= checkpoint)) {
        const g = await freshGeneration(
          `${uid}/staging/integrated-allocation-inputs/v1/${market}/${date}.json`,
        );
        if (
          !g ||
          g.kind !== "strong" ||
          ![g.objectId, g.version, g.etag].every(
            (v) => typeof v === "string" && v.trim().length > 0,
          ) ||
          !Number.isSafeInteger(g.size) ||
          g.size <= 0
        )
          return full("INPUT_GENERATION_MISSING_OR_WEAK");
        checkedInputs++;
      }
    if (pendingDate)
      return {
        status: "WAITING_METADATA_ONLY",
        needsFullInspection: false,
        payloadProvenanceRevalidated: false,
        checkedInputs,
        waitingDate: pendingDate,
        missingMarkets,
        reason:
          "First pending date lacks complete market publication metadata; no append eligible, historical payload provenance and finality not revalidated",
      };
    return {
      status: "NO_WORK_METADATA_ONLY",
      needsFullInspection: false,
      payloadProvenanceRevalidated: false,
      reason:
        "Verified integrated heads and complete metadata grid; historical input payload provenance not revalidated",
      checkedInputs,
    };
  } catch {
    throw Error(
      "Quick inspection stopped: operational or reviewed-calendar validation failure; no full-path retry",
    );
  }
}
