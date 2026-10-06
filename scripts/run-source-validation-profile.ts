import { trustedSupabaseClient } from "./analysis-run-store";
import { profileSourceValidationCache } from "./profile-source-validation-cache";
const userId = process.env["SUPABASE_USER_ID"];
if (!userId) {
  console.error(JSON.stringify({ ok: false, stage: "configuration", reason: "missing_user" }));
  process.exitCode = 1;
} else {
  try {
    const result = await profileSourceValidationCache(trustedSupabaseClient(), userId);
    console.log(JSON.stringify({ ok: true, ...result }));
  } catch {
    console.error(
      JSON.stringify({
        ok: false,
        stage: "source_validation_profile",
        reason: "read_or_identity_verification_failed",
      }),
    );
    process.exitCode = 1;
  }
}
