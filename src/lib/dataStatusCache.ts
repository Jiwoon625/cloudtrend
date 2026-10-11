import type { DataStatusPayload } from "./marketPayload";

/** Small owner/revision-scoped QA summaries only; never retain raw source text. */
export function createDataStatusCache(maxEntries = 4) {
  const completed = new Map<string, DataStatusPayload>();
  const pending = new Map<string, Promise<DataStatusPayload>>();
  return {
    async get(owner: string, fingerprint: string, build: () => Promise<DataStatusPayload>) {
      const key = JSON.stringify(["data-status-v2", owner, fingerprint]);
      const hit = completed.get(key);
      if (hit) return hit;
      const active = pending.get(key);
      if (active) return active;
      const task = build()
        .then((value) => {
          completed.set(key, value);
          if (completed.size > maxEntries) completed.delete(completed.keys().next().value!);
          return value;
        })
        .finally(() => pending.delete(key));
      pending.set(key, task);
      return task;
    },
  };
}
