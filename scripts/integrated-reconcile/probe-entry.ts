import { createReadOnlyProbe } from "./probe";
let usage:
  | (() => { infoRequests: number; payloadDownloads: number; bytes: number; requests: number })
  | undefined;
async function main() {
  const origin = process.env.SUPABASE_URL ?? "",
    uid = process.env.SUPABASE_USER_ID ?? "",
    key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!key) throw Error("Existing service configuration required");
  const probe = createReadOnlyProbe({
    origin,
    uid,
    fetch: globalThis.fetch,
    headers: { Authorization: `Bearer ${key}`, apikey: key },
  });
  usage = probe.usage;
  console.log(JSON.stringify(await probe.run()));
}
main().catch(() => {
  console.error("FIXED_READ_ONLY_PROBE_BLOCKED");
  if (usage) console.error(JSON.stringify(usage()));
  process.exitCode = 1;
});
