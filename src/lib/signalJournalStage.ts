import type { ScreeningStages } from "./screeningStages";
/** The same status contract for browser, scheduled and manual screening. */
export async function runSignalJournalStage<T extends { pending: unknown[] }>(
  stages: ScreeningStages,
  save: () => Promise<void>,
  work: () => Promise<T>,
): Promise<T> {
  stages.signalHistory = "RUNNING";
  await save();
  try {
    const result = await work();
    stages.signalHistory = result.pending.length ? "WAITING_INPUT" : "COMPLETED";
    await save();
    return result;
  } catch (error) {
    stages.signalHistory = "FAILED";
    stages.publication = "FAILED";
    await save();
    throw error;
  }
}
