import { pathToFileURL } from "node:url";
import { trustedSupabaseClient } from "./analysis-run-store";
import { loadCurrentReportContextForOwner } from "../src/lib/currentReportContext.server";

/** Explicit owner required; reads only. Never persists or initializes a book. */
export async function readCurrentReportContext(uid: string) {
  return loadCurrentReportContextForOwner(trustedSupabaseClient(), uid);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf("--user-id");
  const uid = i >= 0 ? process.argv[i + 1] : undefined;
  if (!uid)
    throw new Error(
      "Usage: vite-node --script scripts/read-current-report-context.ts --user-id <verified-owner-uuid>",
    );
  console.log(JSON.stringify(await readCurrentReportContext(uid), null, 2));
}
