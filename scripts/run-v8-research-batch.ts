import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const allowed = new Set([
  "run-v8-ma-bb-ablation-3fos.ts",
  "run-v8-kosdaq80-exit-portfolio-3fos.ts",
  "run-v8-kosdaq80-exit-portfolio-fixed-entry-3fos.ts",
  "run-v8-kospi-explanatory-baseline-3fos.ts",
  "run-v8-kospi-relative-strength-3fos.ts",
  "run-v8-kospi-rsaccel-stage3-3fos.ts",
  "run-v8-kospi-rsaccel-stage4-portfolio-3fos.ts",
  "run-v8-kospi-rsaccel-stage5-regime-3fos.ts",
  "run-v8-kospi-rsaccel-stage6-yearly-regime-3fos.ts",
  "run-v8-kospi-rsaccel-stage7-neutral-subregime.ts",
  "run-v8-kospi-rsaccel-stage8-adaptive-portfolio.ts",
  "run-v8-kospi-relative-quality-stage9.ts",
  "run-v8-kospi-relative-quality-stage10-composite.ts",
  "run-v8-kospi-relative-quality-stage11-benchmark-decomposition.ts",
  "run-v8-kospi-relative-quality-stage12-sector-relative.ts",
]);

async function main() {
  const argv = process.argv.slice(2);
  const index = argv.indexOf("--scripts");
  if (index < 0 || !argv[index + 1]) throw new Error("--scripts is required");
  const scripts = argv
    .splice(index, 2)[1]!
    .split(",")
    .map((x) => x.trim());
  if (!scripts.length || scripts.some((x) => !x.startsWith("scripts/") || !allowed.has(x.slice(8))))
    throw new Error("Unknown research script");
  // Validate every selection before starting any study.
  for (const script of scripts) await readFile(script, "utf8");
  const originalArgv = process.argv;
  const report: Array<{ script: string; status: string; error?: string }> = [];
  try {
    for (const script of scripts) {
      process.stdout.write(`Batch study: ${script}\n`);
      process.argv = [originalArgv[0]!, "batch", ...argv];
      try {
        const module = await import(path.resolve(script));
        await module.runStudy();
        report.push({ script, status: "completed" });
      } catch (error) {
        report.push({ script, status: "failed", error: String(error) });
        throw error;
      }
    }
  } finally {
    process.argv = originalArgv;
    await mkdir("analysis-runs", { recursive: true });
    await writeFile("analysis-runs/batch-summary.json", JSON.stringify(report, null, 2));
  }
}
main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
