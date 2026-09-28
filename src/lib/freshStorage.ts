import type { SupabaseClient } from "@supabase/supabase-js";

/** Mutable latest pointers must bypass both the browser cache and Smart CDN.
 * no-store alone does not bypass an already warm CDN response after an upsert.
 * Keep immutable, content-addressed source files on their normal cached path.
 */
export function downloadFreshObject(client: SupabaseClient, bucket: string, path: string) {
  return client.storage
    .from(bucket)
    .download(path, { cacheNonce: crypto.randomUUID() }, { cache: "no-store" });
}
