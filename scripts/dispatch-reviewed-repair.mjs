// Temporary, exact November 3 repair request. Never executes arbitrary commands or exports credentials.
import fs from "node:fs";
const request = JSON.parse(
  fs.readFileSync(".github/operations/nov3-repair.json", "utf8"),
);
if (
  process.env.GITHUB_EVENT_NAME !== "push" ||
  !["refs/heads/main", "refs/heads/ops/nov3-reviewed-repair"].includes(
    process.env.GITHUB_REF,
  ) ||
  process.env.GITHUB_REPOSITORY !== "Jiwoon625/cloudtrend"
)
  throw Error("Repair request context rejected");
const ordinary = new Set([
  "cloudtrend-analysis.yml",
  "us-prospective-screening.yml",
]);
if (ordinary.has(request.workflow)) {
  if (
    process.env.GITHUB_REF !== "refs/heads/ops/nov3-reviewed-repair" ||
    request.version !== 1 ||
    !Number.isSafeInteger(request.after_recovery_run) ||
    request.after_recovery_run <= 0 ||
    !/^[a-f0-9]{40}$/.test(request.expected_main_sha ?? "")
  )
    throw Error("Post-recovery context rejected");
  const expectedInputs =
    request.workflow === "cloudtrend-analysis.yml"
      ? { force: false }
      : { expected_server_code_sha: request.expected_main_sha };
  if (JSON.stringify(request.inputs) !== JSON.stringify(expectedInputs))
    throw Error("Only ordinary screening without force or replay is allowed");
  const headers = {
    Authorization: `Bearer ${process.env.GH_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const api = "https://api.github.com/repos/Jiwoon625/cloudtrend";
  const get = async (path) => {
    const r = await fetch(api + path, { headers });
    if (!r.ok) throw Error(`Post-recovery identity read failed (${r.status})`);
    return r.json();
  };
  const [run, main] = await Promise.all([
    get(`/actions/runs/${request.after_recovery_run}`),
    get("/branches/main"),
  ]);
  if (
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.event !== "workflow_dispatch" ||
    run.path !== ".github/workflows/kr-nov3-recovery.yml" ||
    run.head_sha !== request.expected_main_sha ||
    main.commit?.sha !== request.expected_main_sha
  )
    throw Error("Post-recovery run or main identity rejected");
  const r = await fetch(
    `${api}/actions/workflows/${request.workflow}/dispatches`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ ref: "main", inputs: expectedInputs }),
    },
  );
  if (r.status !== 204)
    throw Error(`Ordinary screening dispatch failed (${r.status})`);
  console.log(
    `Dispatched ordinary ${request.workflow} after verified recovery run ${request.after_recovery_run}`,
  );
  process.exit(0);
}
const modes = {
  "kospi-nov3-recovery.yml": ["PLAN", "AUTHORIZE", "VALIDATE", "APPLY"],
  "kr-nov3-recovery.yml": ["AUTHORIZE", "STAGE_AUTHORITY", "VALIDATE", "APPLY"],
};
if (
  request.version !== 1 ||
  !modes[request.workflow]?.includes(request.inputs?.mode)
)
  throw Error("Repair request rejected");
const fields =
  request.workflow === "kr-nov3-recovery.yml"
    ? ["mode", "expected_plan_hash", "expected_approval_hash"]
    : ["mode", "expected_capsule_hash", "expected_approval_hash"];
if (Object.keys(request.inputs).some((k) => !fields.includes(k)))
  throw Error("Unexpected repair input");
for (const key of fields.slice(1))
  if (
    request.inputs.mode !== "PLAN" &&
    !/^sha256:[a-f0-9]{64}$/.test(request.inputs[key])
  )
    throw Error("Exact reviewed authority hash required");
const response = await fetch(
  `https://api.github.com/repos/Jiwoon625/cloudtrend/actions/workflows/${request.workflow}/dispatches`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ ref: "main", inputs: request.inputs }),
  },
);
if (response.status !== 204)
  throw Error(`Reviewed dispatch failed (${response.status})`);
console.log(`Dispatched reviewed ${request.workflow}: ${request.inputs.mode}`);
