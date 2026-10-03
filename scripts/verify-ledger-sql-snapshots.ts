/** Verify synthetic PostgreSQL RPC envelopes with the production TypeScript reader. */
import { readFileSync } from "node:fs";
import { deepStrictEqual } from "node:assert";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readWebsiteDocument } from "../src/lib/ledger/websiteRepository.server";
import type { WebsiteSourceSystem } from "../src/lib/ledger/websiteProjection";

const path = process.argv[2];
if (!path) throw new Error("Supply the synthetic PostgreSQL envelope JSON path");
const envelopes: Array<{
  label: string;
  sourceSystem: WebsiteSourceSystem;
  revision: number;
  payload: unknown;
}> = JSON.parse(readFileSync(path, "utf8"));
for (const required of [
  "activation-kr",
  "activation-us",
  "app-add",
  "app-edit",
  "app-void",
  "us-app-add",
  "migrated-edit",
  "notes-only",
  "settings-only",
  "etf-high-precision-add",
  "etf-repeating-price-edit",
  "etf-void",
])
  if (!envelopes.some((snapshot) => snapshot.label === required))
    throw new Error(`Missing SQL scenario: ${required}`);
for (const snapshot of envelopes) {
  const client = {
    rpc: async () => ({ data: snapshot, error: null }),
  } as unknown as Pick<SupabaseClient, "rpc">;
  const projected = await readWebsiteDocument(
    client,
    "11111111-1111-4111-8111-111111111111",
    snapshot.sourceSystem,
  );
  deepStrictEqual(projected?.payload, snapshot.payload);
  deepStrictEqual(projected?.revision, snapshot.revision);
  console.log(`PASS SQL -> TypeScript canonical snapshot: ${snapshot.label}`);
}
