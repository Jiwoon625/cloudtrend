/** Admission checks with no main side effects or external capabilities. */
import { KOSPI_SHADOW_NAMESPACE } from "../../src/lib/kospiShadowStore";
import { KOSPI_SHADOW_CORRECTION_REVISION_ID } from "../../src/lib/kospiShadowSeries";
function requireAdmission(ok: unknown, code: string): asserts ok {
  if (!ok) throw Error("FINAL_RETROSPECTIVE_" + code);
}
export function assertFinalWorkflow(env: NodeJS.ProcessEnv = process.env) {
  requireAdmission(
    env.GITHUB_ACTIONS === "true" &&
      env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
      env.GITHUB_REF === "refs/heads/main" &&
      env.GITHUB_WORKFLOW === "KR final retrospective reviewed PLAN APPLY" &&
      env.RECOVERY_CONCURRENCY_GROUP === "kospi-prospective-shadow" &&
      /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? ""),
    "WORKFLOW_ADMISSION",
  );
}
export function finalExecutionPhase(env: NodeJS.ProcessEnv = process.env): "VALIDATE" | "APPLY" {
  const phase = env.RECOVERY_PHASE;
  requireAdmission(phase === "VALIDATE" || phase === "APPLY", "STRICT_EXECUTION_PHASE");
  return phase;
}
export function assertFinalExclusiveScope(
  scope: { owner: string; namespace: string; requiredConcurrencyGroup: string },
  owner: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  assertFinalWorkflow(env);
  requireAdmission(
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(owner) &&
      scope.owner === owner &&
      scope.namespace ===
        `${owner}/${KOSPI_SHADOW_NAMESPACE}/revisions/${KOSPI_SHADOW_CORRECTION_REVISION_ID}` &&
      scope.requiredConcurrencyGroup === "kospi-prospective-shadow",
    "EXCLUSIVE_SCOPE",
  );
}
