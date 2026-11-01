import type { SupabaseClient } from "@supabase/supabase-js";
/** Invocation-local bridge only. readApproved must fresh-probe and verify the pinned envelope hash. */
export function replayReadBridge(
  client: SupabaseClient,
  uid: string,
  readApproved: (market: "KR" | "US", date: string) => Promise<Blob>,
): SupabaseClient {
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(uid))
    throw Error("Verified owner required");
  const prefix = `${uid}/staging/integrated-allocation-inputs/v1/`;
  const storage = new Proxy(client.storage, {
    get(target, key) {
      if (key === "from")
        return (bucket: string) => {
          const original = target.from(bucket);
          return new Proxy(original, {
            get(api, method) {
              if (method === "download")
                return async (path: string, ...args: unknown[]) => {
                  if (bucket === "cloudtrend-data" && path.startsWith(prefix)) {
                    const match = /^(KR|US)\/(\d{4}-\d{2}-\d{2})\.json$/.exec(
                      path.slice(prefix.length),
                    );
                    if (!match) throw Error("Unplanned integrated input path");
                    return {
                      data: await readApproved(match[1] as "KR" | "US", match[2]),
                      error: null,
                    };
                  }
                  return Reflect.apply(api.download, api, [path, ...args]);
                };
              const value = Reflect.get(api, method, api);
              return typeof value === "function" ? value.bind(api) : value;
            },
          });
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(client, {
    get(target, key) {
      if (key === "storage") return storage;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
