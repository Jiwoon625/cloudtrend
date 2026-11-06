import { runDriveScreening } from "./run-drive-screening";
// Keep the Vite CLI config active: --script discards --config in vite-node v3.
try {
  await runDriveScreening(process.env["CT_DRIVE_RUN_DIR"] ?? "drive-screening");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Drive screening failed");
  process.exitCode = 1;
}
