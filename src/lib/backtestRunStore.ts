import type { BacktestRunBundle, BacktestRunIndexEntry } from "@/lib/backtestRunBundle";
import { ownerPath, readObject, writeObject } from "@/lib/cloud";

export type {
  BacktestDataFileVersion,
  BacktestDataVersionInput,
  BacktestExecutionConfig,
  BacktestRunBundle,
  BacktestRunIndexEntry,
} from "@/lib/backtestRunBundle";

const RUN_INDEX = "backtest/runs/index.json";

export async function saveBacktestRun(bundle: BacktestRunBundle): Promise<BacktestRunIndexEntry> {
  const relativePath = `backtest/runs/${bundle.run.id}.json`;
  await writeObject(await ownerPath(relativePath), bundle);
  const entry: BacktestRunIndexEntry = {
    id: bundle.run.id,
    createdAt: bundle.run.createdAt,
    engineVersion: bundle.run.engineVersion,
    codeVersion: bundle.run.codeVersion,
    dataVersion: bundle.run.dataVersion,
    asOfDate: bundle.data.asOfDate,
    symbolCount: bundle.result.symbolCount,
    from: bundle.result.from,
    to: bundle.result.to,
    path: relativePath,
  };
  const indexPath = await ownerPath(RUN_INDEX);
  const current = (await readObject<{ runs: BacktestRunIndexEntry[] }>(indexPath))?.runs ?? [];
  const runs = [entry, ...current.filter((run) => run.id !== entry.id)].slice(0, 100);
  await writeObject(indexPath, { runs });
  return entry;
}
