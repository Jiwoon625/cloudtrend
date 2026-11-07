import { prepareDriveCharts } from "./prepare-drive-result-charts";
try {
  await prepareDriveCharts(process.env["CT_DRIVE_RUN_DIR"] ?? "drive-screening");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Chart preparation failed");
  process.exitCode = 1;
}
