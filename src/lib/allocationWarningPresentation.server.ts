import { ETF_POLICY } from "./engine/etfStrategy";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { IntegratedAllocationLedger } from "./integratedAllocationShadow";
import type { IntegratedKrEvidence } from "./integratedAllocationReplayAdapter";
import type { AllocationWarningEvidence } from "./allocationWarningPresentation";
import { downloadFreshObject } from "./freshStorage";
import { hashSeriesValue } from "./ledger/modelSeries";

/** Display-only. Never calls replay/restore/append or writes a missing archive. */
export async function readAllocationWarningEvidence(
  client: SupabaseClient,
  uid: string,
  ledger: IntegratedAllocationLedger,
  receiptId: string,
): Promise<Record<string, AllocationWarningEvidence>> {
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(uid))
    throw new Error("Verified owner required");
  // One lazily requested receipt only; no scan/download for other session dates.
  const record = ledger.receipts
    .map((r) => r.record)
    .filter(
      (r) =>
        r.type === "SESSION" &&
        r.id === receiptId &&
        r.id === `session:E:${r.date}` &&
        r.issues.some((issue) => issue.startsWith("SIGNAL_DATA_UNAVAILABLE:")),
    )
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  if (
    !record ||
    !/^\d{4}-\d{2}-\d{2}$/.test(record.date) ||
    !Number.isFinite(Date.parse(`${record.date}T00:00:00Z`)) ||
    new Date(`${record.date}T00:00:00Z`).toISOString().slice(0, 10) !== record.date
  )
    return {};
  try {
    const { data, error } = await downloadFreshObject(
      client,
      "cloudtrend-data",
      `${uid}/staging/integrated-allocation-inputs/v1/KR/${record.date}.json`,
    );
    if (error || !data) return {};
    const envelope = JSON.parse(await data.text()) as {
      hash: string;
      payload: IntegratedKrEvidence;
    };
    const p = envelope.payload;
    const times = [
      p.clock?.openAt,
      p.clock?.closeAt,
      p.clock?.availableAt,
      p.clock?.decisionAt,
    ].map((v) => Date.parse(v));
    if (
      envelope.hash !== (await hashSeriesValue(p)) ||
      p.version !== "integrated-kr-daily-evidence-v1" ||
      p.date !== record.date ||
      !p.clock.calendar?.sessions.includes(record.date) ||
      times.some((t) => !Number.isFinite(t)) ||
      !(times[0]! < times[1]! && times[1]! <= times[2]! && times[2]! <= times[3]!) ||
      p.snapshot.asOfDate !== record.date ||
      p.clock.sourceHash !== record.sourceHash ||
      p.clock.codeHash !== ledger.contract.codeHash ||
      !Array.isArray(p.rows) ||
      !Array.isArray(p.snapshot.entries) ||
      new Set(p.snapshot.entries.map((r) => r.symbol)).size !== p.snapshot.entries.length ||
      new Set(p.rows.map((r) => r.instrument.symbol)).size !== p.rows.length
    )
      return {};
    const names = new Map(p.snapshot.entries.map((r) => [r.symbol, r.name]));
    const rows: AllocationWarningEvidence["rows"] = [];
    for (const row of p.rows) {
      const s = row.etfStrategy;
      if (
        row.instrument.instrumentType !== "ETF" ||
        !s ||
        s.date !== record.date ||
        s.version !== ETF_POLICY.version ||
        s.exit !== "DATA_UNAVAILABLE" ||
        !Array.isArray(s.issues) ||
        !s.issues.every((v) => typeof v === "string")
      )
        continue;
      rows.push({
        symbol: row.instrument.symbol,
        name:
          typeof names.get(row.instrument.symbol) === "string"
            ? names.get(row.instrument.symbol)!
            : row.instrument.symbol,
        issues: [...s.issues],
      });
    }
    return { [record.id]: { date: record.date, sourceHash: record.sourceHash, rows } };
  } catch {
    return {};
  } // Failed annotation must not hide a valid, verified ledger or its raw warning.
}
