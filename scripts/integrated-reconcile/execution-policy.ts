/** Explicit manual inspection budget; automatic mutation still uses bounded full verification. */
export function reconciliationBudget(apply: string, inspectionMiB = "8"): number {
  if (apply !== "true" && apply !== "false") throw Error("Explicit reconciliation mode required");
  if (inspectionMiB !== "8" && inspectionMiB !== "256")
    throw Error("Reviewed inspection budget required");
  return (apply === "true" ? 256 : Number(inspectionMiB)) * 1024 * 1024;
}
