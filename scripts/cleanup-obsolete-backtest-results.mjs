import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const userId = process.env.SUPABASE_USER_ID;

if (!url || !serviceRoleKey || !userId) {
  throw new Error("Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or SUPABASE_USER_ID");
}

const bucket = "cloudtrend-data";
const root = `${userId}/results`;
const obsoleteGroups = [
  "backtest",
  "sector-v7-flow",
  "sector-v7-transition",
  "sector-v8-penalty",
  "sector-v8-penalty-portfolio",
  "v8-vf-feature-validation",
  "v8-score-monotonicity",
  "v8-entry-onset-threshold",
  "v8-exit-holding-validation",
  "v8-sector-slot-validation",
  "v8-market-split-validation",
  "v8-11-kosdaq80-exit-portfolio-3fos",
];

const supabase = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function listRecursive(prefix) {
  const files = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase.storage.from(bucket).list(prefix, {
      limit: pageSize,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) throw new Error(`List failed for ${prefix}: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const item of data) {
      const child = `${prefix}/${item.name}`;
      if (item.id) files.push(child);
      else files.push(...(await listRecursive(child)));
    }
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return files;
}

const manifest = [];
for (const group of obsoleteGroups) {
  const prefix = `${root}/${group}`;
  const files = await listRecursive(prefix);
  manifest.push({ group, files });
}

const paths = manifest.flatMap((entry) => entry.files);
console.log("Deletion manifest:");
for (const entry of manifest) console.log(`- ${entry.group}: ${entry.files.length} object(s)`);
console.log(`Total objects scheduled: ${paths.length}`);

if (paths.length !== 18) {
  throw new Error(`Safety guard: expected exactly 18 objects, found ${paths.length}. Nothing deleted.`);
}

for (let i = 0; i < paths.length; i += 100) {
  const batch = paths.slice(i, i + 100);
  const { error } = await supabase.storage.from(bucket).remove(batch);
  if (error) throw new Error(`Storage delete failed: ${error.message}`);
}

const remaining = [];
for (const group of obsoleteGroups) {
  const files = await listRecursive(`${root}/${group}`);
  if (files.length) remaining.push({ group, files });
}
if (remaining.length) {
  throw new Error(`Verification failed: obsolete objects remain: ${JSON.stringify(remaining)}`);
}

const { error: runDeleteError } = await supabase
  .from("analysis_runs")
  .delete()
  .eq("id", "backtest-20260911114419-fa12452b");
if (runDeleteError) throw new Error(`analysis_runs cleanup failed: ${runDeleteError.message}`);

console.log("Cleanup complete: 18 obsolete storage objects removed and legacy analysis_runs row deleted.");
