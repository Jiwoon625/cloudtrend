import { parseManualMarketData, type ManualParseResult } from "@/lib/engine/manualDataset";
import { readFile, writeFile, removeFile, type CloudFile } from "@/lib/cloud";
export interface BacktestDataMeta {
  savedAt: string;
  fileName: string | null;
  bytes: number;
}
let file: CloudFile<BacktestDataMeta> | null = null;
let hydration: Promise<void> | null = null;
let cache: ManualParseResult | null = null;
export function hydrateBacktestData(): Promise<void> {
  return (hydration ??= readFile<BacktestDataMeta>("backtest")
    .then((v) => {
      file = v;
    })
    .catch((e) => {
      hydration = null;
      throw e;
    }));
}
export function getBacktestDataMeta() {
  return file?.meta ?? null;
}
export async function saveBacktestData(
  source: Blob | string,
  fileName?: string | null,
): Promise<BacktestDataMeta> {
  const text = typeof source === "string" ? source : await source.text();
  const parsed = parseManualMarketData(text);
  const next = {
    text,
    meta: {
      savedAt: new Date().toISOString(),
      fileName: fileName ?? null,
      bytes: new Blob([text]).size,
    },
  };
  await writeFile("backtest", next);
  file = next;
  cache = parsed;
  hydration = Promise.resolve();
  return next.meta;
}
export async function clearBacktestData() {
  await removeFile("backtest");
  file = null;
  cache = null;
}
export async function loadBacktestDataset(): Promise<ManualParseResult | null> {
  await hydrateBacktestData();
  if (!file) return null;
  return (cache ??= parseManualMarketData(file.text));
}
