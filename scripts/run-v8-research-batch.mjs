import { spawn } from "node:child_process";
const child = spawn(
  "npx",
  ["vite-node", "--script", "scripts/run-v8-research-batch.ts", ...process.argv.slice(2)],
  { stdio: "inherit" },
);
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
