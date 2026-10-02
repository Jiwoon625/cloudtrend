/** Offline, read-only planner. No Supabase client, no environment credentials, no write/apply mode. */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { canonicalJson, normalizeLegacyExecution, planImport } from "../src/lib/ledger/migration";
import type { ActualExecution } from "../src/lib/portfolioLedgers";
import type { LedgerEvent, Security, SourceRef } from "../src/lib/ledger/types";
interface Input {
  capturedAt: string;
  documents: {
    table: "portfolio_ledgers" | "us_actual_portfolio_ledgers";
    revision: number;
    executions: ActualExecution<string>[];
  }[];
  securities: Security[];
  /** `${table}:${execution.id}` -> confirmed broker/account ID. Never infer these from market. */
  accountMapping: Record<string, string>;
  existingEvents: LedgerEvent[];
}
export function planLegacyDocuments(input: Input) {
  if (!input.documents.length || !Number.isFinite(Date.parse(input.capturedAt)))
    throw new Error("Captured source documents required");
  const candidates: LedgerEvent[] = [],
    unmapped: { sourceKey: string; reason: string }[] = [];
  for (const doc of input.documents) {
    if (!Number.isInteger(doc.revision) || doc.revision < 1)
      throw new Error("Original document revision required");
    for (const execution of doc.executions) {
      const sourceKey = `${doc.table}:${execution.id}`;
      const accountId = input.accountMapping[sourceKey];
      const matching = input.securities.filter(
        (s) =>
          s.symbol === execution.symbol &&
          (execution.market === "US" ? s.market === "US" : s.market !== "US") &&
          (execution.market !== "ETF" || s.assetType === "ETF"),
      );
      if (!accountId || matching.length !== 1) {
        unmapped.push({
          sourceKey,
          reason: !accountId
            ? "confirmed_account_mapping_required"
            : "unique_security_mapping_required",
        });
        continue;
      }
      const source: SourceRef = {
        system: doc.table,
        recordId: execution.id,
        revision: String(doc.revision),
        contentHash: `sha256:${createHash("sha256").update(canonicalJson(execution)).digest("hex")}`,
      };
      candidates.push(
        normalizeLegacyExecution({
          execution,
          accountId,
          security: matching[0]!,
          source,
          recordedAt: input.capturedAt,
        }),
      );
    }
  }
  const decisions = planImport(input.existingEvents, candidates);
  return {
    schemaVersion: 1,
    mode: "DRY_RUN_ONLY",
    capturedAt: input.capturedAt,
    sources: input.documents.map((d) => ({
      table: d.table,
      revision: d.revision,
      executionCount: d.executions.length,
    })),
    decisions,
    unmapped,
    canApply: false,
    warnings: [
      "No production mutation is implemented by this command",
      "Source capital settings are not opening-balance evidence",
      "Notion records are a separate scope requiring matching and receipt review",
      "Missing settlement, net cash and tax facts remain unknown",
    ],
  };
}
const args = process.argv.slice(2);
if (args.length) {
  if (args.length !== 2 || args.some((a) => a.startsWith("--")))
    throw new Error(
      "Usage: vite-node --script scripts/plan-ledger-migration.ts PRIVATE_INPUT.json PRIVATE_OUTPUT.json",
    );
  const plan = planLegacyDocuments(JSON.parse(await readFile(args[0]!, "utf8")) as Input);
  await writeFile(args[1]!, JSON.stringify(plan, null, 2), { flag: "wx", mode: 0o600 });
  console.log(
    JSON.stringify({
      mode: plan.mode,
      sources: plan.sources,
      unresolvedMappings: plan.unmapped.length,
      inserts: plan.decisions.filter((d) => d.status === "INSERT").length,
      quarantined: plan.decisions.filter((d) => d.status === "QUARANTINE").length,
      canApply: false,
    }),
  );
}
