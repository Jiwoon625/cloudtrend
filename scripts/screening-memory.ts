import process from "node:process";
export function memory(stage: string, details: Record<string, number> = {}) {
  if (process.env["SCREENING_MEMORY_PROFILE"] !== "1") return;
  process.stderr.write(
    `${JSON.stringify({ stage, ...details, ...process.memoryUsage(), maxRssKiB: process.resourceUsage().maxRSS })}\n`,
  );
}
