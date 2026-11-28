import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { chartPath } from "./instrumentChartContract";
import { readChartBundle, type PriceChart } from "./instrumentChartStore.server";
import { downloadFreshObject } from "./freshStorage";
import {
  strategyMarket,
  validMasterDay,
  type MasterSnapshot,
  type MasterRow,
} from "./manualMaster";
import {
  catchUpMasterExit,
  masterExitPending,
  MASTER_EXIT_POLICY,
  type MasterExit,
} from "./manualMasterPriceExit";
import type { DashboardIndex } from "./dashboardOperations";
import { loadManualMaster } from "./manualMaster.server";

const bucketName = "cloudtrend-data";

function signalPath(uid: string, row: MasterRow) {
  const key = createHash("sha256")
    .update(JSON.stringify([strategyMarket(row), row.symbol, row.start]))
    .digest("hex");
  return uid + "/holding-price-exits/" + MASTER_EXIT_POLICY + "/" + key + "/signal.json";
}

async function readSignal(
  client: SupabaseClient,
  path: string,
  row: MasterRow,
): Promise<MasterExit | null> {
  const { data, error } = await downloadFreshObject(client, bucketName, path);
  if (error) {
    if (String(error.statusCode) === "404" || /object not found/i.test(error.message)) return null;
    throw new Error("청산신호 조회 실패");
  }
  if (!data) return null;
  const signal = JSON.parse(await data.text()) as MasterExit;
  if (
    signal.symbol !== row.symbol ||
    signal.start !== row.start ||
    signal.market !== strategyMarket(row) ||
    signal.reason !== (signal.market === "ETF" ? "E4" : "K4") ||
    !signal.signalDate ||
    !validMasterDay(signal.signalDate) ||
    signal.signalDate < row.start ||
    signal.observationDate !== signal.signalDate ||
    !signal.threshold ||
    !Number.isFinite(Number(signal.threshold)) ||
    Number(signal.threshold) <= 0 ||
    !signal.observedClose ||
    !Number.isFinite(signal.observedClose) ||
    signal.observedClose <= 0 ||
    signal.observedClose > Number(signal.threshold) + 1e-8
  )
    throw new Error("청산신호 근거 오류");
  return { ...signal, auditStatus: "LATCHED", status: "청산 대기 · 전량매도 전까지 유지" };
}

export async function loadMasterPriceExits(
  client: SupabaseClient,
  uid: string,
  snapshot: MasterSnapshot | null,
  kr: DashboardIndex | null,
  now = new Date(),
): Promise<Record<string, MasterExit>> {
  if (snapshot?.reviewStatus !== "confirmed") return {};
  const today = now.toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
  const afterClose =
    now.toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul", hour12: false }) >= "15:30:00";
  const rows = snapshot.rows.filter(
    (r) => Number(r.quantity) > 0 && ["KOSPI", "ETF"].includes(strategyMarket(r)),
  );
  const result: Record<string, MasterExit> = {};
  const charts = new Map<string, Promise<Record<string, PriceChart> | null>>();
  const chart = (path: string) => {
    let pending = charts.get(path);
    if (!pending) {
      pending = readChartBundle<PriceChart>(client, uid, path);
      charts.set(path, pending);
    }
    return pending;
  };
  // Each independently verified holding uses the same saved screening identity. No raw CSV fallback.
  for (const row of rows) {
    result[row.symbol] = masterExitPending(row);
    try {
      const path = signalPath(uid, row);
      const prior = await readSignal(client, path, row);
      if (prior) {
        if (prior.signalDate! > today || (prior.signalDate === today && !afterClose)) continue;
        const sameDateMark = kr?.rows.find(
          (r) =>
            r.symbol === row.symbol && r.market === prior.market && r.date === prior.signalDate,
        );
        if (
          kr?.pricePublicationFinal &&
          sameDateMark?.price != null &&
          sameDateMark.price !== prior.observedClose
        ) {
          result[row.symbol] = {
            ...masterExitPending(row),
            auditStatus: "MISMATCH",
            status: "청산신호 원천가격 대사 확인 대기",
          };
          continue;
        }
        result[row.symbol] = prior;
        continue;
      }
      if (
        !kr?.priceIdentity ||
        kr.pricePublicationFinal !== true ||
        kr.date > today ||
        (kr.date === today && !afterClose)
      )
        continue;
      let bars: PriceChart["chart"] = [];
      {
        const identity = kr.priceIdentity;
        const recent = await chart(chartPath(identity, row.symbol, "120", "prices"));
        bars = recent?.[row.symbol]?.chart ?? [];
        const from = strategyMarket(row) === "ETF" ? row.start : snapshot.asOf;
        if (!bars.some((b) => b.tradeDate <= from)) {
          const full = await chart(chartPath(identity, row.symbol, "all", "prices"));
          bars = full?.[row.symbol]?.chart ?? [];
        }
      }
      const exit = catchUpMasterExit(row, snapshot.asOf, kr, bars);
      if (!exit.reason) {
        result[row.symbol] = exit;
        continue;
      }
      // Check revision before writing. Old holding-cycle evidence cannot become a new cycle's signal.
      const latest = await loadManualMaster(client, uid);
      if (latest?.revision !== snapshot.revision || latest.reviewStatus !== "confirmed") continue;
      const { error } = await client.storage
        .from(bucketName)
        .upload(path, new Blob([JSON.stringify(exit)], { type: "application/json" }), {
          upsert: false,
          contentType: "application/json",
          cacheControl: "0",
        });
      if (error && !/already exists|duplicate/i.test(error.message)) continue;
      const saved = await readSignal(client, path, row);
      if (saved) result[row.symbol] = saved;
    } catch {
      // A storage failure or incomplete price series is unknown, never a negative stop.
    }
  }
  return result;
}
