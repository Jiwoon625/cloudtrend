// Temporary, exact November 3 repair request. Never executes arbitrary commands or exports credentials.
import fs from "node:fs";
const request = JSON.parse(fs.readFileSync(".github/operations/nov3-repair.json", "utf8"));
if (
  process.env.GITHUB_EVENT_NAME !== "push" ||
  process.env.GITHUB_REF !== "refs/heads/main" ||
  process.env.GITHUB_REPOSITORY !== "Jiwoon625/cloudtrend"
)
  throw Error("Repair request context rejected");
const modes = {
  "kospi-nov3-recovery.yml": ["PLAN", "AUTHORIZE", "VALIDATE", "APPLY"],
  "kr-nov3-recovery.yml": ["AUTHORIZE", "STAGE_AUTHORITY", "VALIDATE", "APPLY"],
};
if (request.version !== 1 || !modes[request.workflow]?.includes(request.inputs?.mode))
  throw Error("Repair request rejected");
const fields =
  request.workflow === "kr-nov3-recovery.yml"
    ? ["mode", "expected_plan_hash", "expected_approval_hash"]
    : ["mode", "expected_capsule_hash", "expected_approval_hash"];
if (Object.keys(request.inputs).some((k) => !fields.includes(k)))
  throw Error("Unexpected repair input");
for (const key of fields.slice(1))
  if (request.inputs.mode !== "PLAN" && !/^sha256:[a-f0-9]{64}$/.test(request.inputs[key]))
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
if (response.status !== 204) throw Error(`Reviewed dispatch failed (${response.status})`);
console.log(`Dispatched reviewed ${request.workflow}: ${request.inputs.mode}`);
