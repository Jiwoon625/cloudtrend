import process from "node:process";
import { pathToFileURL } from "node:url";
import { ANALYSIS_BUCKET, trustedSupabaseClient } from "./analysis-run-store";
import { publishSameSessionRevision, type RevisionOriginal } from "./us-same-session-revision";
import { OPERATIONAL_SIGNAL_START } from "../src/lib/operationalSignalStart";
import {
  US_PROSPECTIVE_RULE_VERSION,
  type UsProspectivePreviousState,
} from "../src/lib/engine/usProspective";

export async function runRevision(
  client: ReturnType<typeof trustedSupabaseClient>,
  uid: string,
  path: string,
  hash: string,
) {
  // Storage has no compare-and-swap API. Only the serialized, main-branch workflow may publish.
  if (
    process.env["GITHUB_ACTIONS"] !== "true" ||
    process.env["GITHUB_REF"] !== "refs/heads/main" ||
    process.env["GITHUB_WORKFLOW"] !== "US Same-session Reference Revision"
  )
    throw new Error("Revision publication requires the serialized main-branch workflow");
  const bucket = client.storage.from(ANALYSIS_BUCKET);
  const read = async (p: string): Promise<string | null> => {
    const { data, error } = await bucket.download(
      p,
      { cacheNonce: crypto.randomUUID() },
      { cache: "no-store" },
    );
    if (error) {
      if (/not.?found|404|Object not found/i.test(error.message)) return null;
      throw error;
    }
    return data.text();
  };
  const original = async (): Promise<RevisionOriginal> => {
    const { data: ingest, error: ie } = await client
      .from("us_screening_ingest")
      .select("*")
      .eq("user_id", uid)
      .single();
    if (ie) throw ie;
    const { data: history, error: he } = await client
      .from("us_screening_history")
      .select("date,data_hash,rule_version")
      .eq("user_id", uid)
      .order("date", { ascending: false })
      .limit(1)
      .single();
    if (he) throw he;
    if (
      ingest.storage_bucket !== ANALYSIS_BUCKET ||
      history.date !== ingest.as_of_date ||
      history.data_hash !== ingest.data_hash ||
      history.rule_version !== US_PROSPECTIVE_RULE_VERSION ||
      !String(ingest.storage_path).startsWith(`${uid}/`)
    )
      throw new Error("Current original ingest/history incomplete or inconsistent");
    const resultRaw = await read(`${uid}/results/us-screening/${history.date}.json`);
    const manifestRaw = await read(`${uid}/results/us-screening/${history.date}.manifest.json`);
    const csv = await read(ingest.storage_path);
    if (!resultRaw || !manifestRaw || !csv) throw new Error("Immutable original artifacts missing");
    const manifest = JSON.parse(manifestRaw);
    if (manifest.dataHash !== history.data_hash || manifest.ruleVersion !== history.rule_version)
      throw new Error("Original manifest mismatch");
    const { data: previous, error: pe } = await client
      .from("us_screening_history")
      .select("date")
      .eq("user_id", uid)
      .lt("date", history.date)
      .order("date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (pe) throw pe;
    let previousState: UsProspectivePreviousState = {};
    if (previous && history.date !== OPERATIONAL_SIGNAL_START) {
      const replayRaw = await read(`${uid}/results/us-replay-state/${previous.date}.json`);
      const priorRaw =
        replayRaw ?? (await read(`${uid}/results/us-screening/${previous.date}.json`));
      if (!priorRaw) throw new Error("Original prior-session state missing");
      const prior = JSON.parse(priorRaw);
      if (
        (replayRaw && prior.version !== "us-replay-state-v1") ||
        prior.analysis?.ruleVersion !== history.rule_version ||
        prior.analysis?.state?.lastDate !== previous.date
      )
        throw new Error("Original prior-session state identity mismatch");
      previousState = prior.analysis.state;
    }
    return {
      date: history.date,
      dataHash: history.data_hash,
      ruleVersion: history.rule_version,
      csv,
      result: JSON.parse(resultRaw),
      previousState,
    };
  };
  return publishSameSessionRevision(
    {
      read,
      original,
      immutable: async (p, bytes) => {
        const { error } = await bucket.upload(p, bytes, {
          upsert: false,
          contentType: "application/json",
        });
        if (error && (await read(p)) !== bytes) throw error;
      },
      pointer: async (p, bytes) => {
        const { error } = await bucket.upload(p, bytes, {
          upsert: true,
          contentType: "application/json",
          cacheControl: "0",
        });
        if (error) throw error;
      },
    },
    uid,
    path,
    hash,
  );
}
async function main() {
  const uid = process.env["SUPABASE_USER_ID"];
  const path = process.env["US_REVISION_MANIFEST_PATH"];
  const hash = process.env["US_REVISION_MANIFEST_HASH"];
  if (!uid || !path || !hash) throw new Error("Revision owner, manifest path and hash required");
  const result = await runRevision(trustedSupabaseClient(), uid, path, hash);
  console.log(
    JSON.stringify({
      status: result.status,
      date: result.pointer.date,
      revisionDataHash: result.pointer.revisionDataHash,
    }),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error(
      "Reference revision held. Original screening and ledgers remain unchanged; inspect the private source/manifest before retrying.",
    );
    process.exitCode = 1;
  });
}
