import { trustedSupabaseClient } from "../analysis-run-store";
import { applyOperation, assertRecoveryWorkflow } from "./operation-apply";
async function main() {
  assertRecoveryWorkflow();
  return applyOperation({
    client: trustedSupabaseClient(),
    origin: process.env.SUPABASE_URL ?? "",
    key: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    owner: process.env.SUPABASE_USER_ID ?? "",
    manifestHash: process.env.EXPECTED_OPERATION_HASH ?? "",
    planHash: process.env.EXPECTED_FULL_PLAN_HASH ?? "",
    approvalHash: process.env.EXPECTED_APPLY_APPROVAL_HASH ?? "",
  });
}
main()
  .then((x) => console.log(JSON.stringify(x)))
  .catch(() => {
    console.log(
      JSON.stringify({
        status: "RECOVERY_APPLY_REJECTED_OR_PARTIAL_REQUIRES_EXACT_READBACK",
        completionClaim: false,
      }),
    );
    process.exitCode = 1;
  });
