import type { AllocationRecord } from "./integratedAllocationShadow";

export interface AllocationWarningEvidence {
  date: string;
  sourceHash: string;
  rows: Array<{ symbol: string; name: string; issues: string[] }>;
}
export function allocationWarningGroups(
  record: AllocationRecord,
  evidence?: AllocationWarningEvidence,
) {
  const valid =
    evidence?.date === record.date &&
    evidence.sourceHash === record.sourceHash &&
    new Set(evidence.rows.map((r) => r.symbol)).size === evidence.rows.length;
  const rows = new Map(valid ? evidence.rows.map((r) => [r.symbol, r]) : []);
  const groups = {
    excluded: [] as string[],
    unclassified: [] as string[],
    unavailable: [] as string[],
    unverified: [] as string[],
    other: [] as string[],
  };
  for (const issue of record.issues) {
    const match = /^SIGNAL_DATA_UNAVAILABLE:([A-Z0-9]+)$/.exec(issue);
    if (!match) {
      groups.other.push(issue);
      continue;
    }
    const row = rows.get(match[1]!);
    const label = row ? `${row.symbol} · ${row.name}` : match[1]!;
    if (!row || !row.issues.length) groups.unverified.push(label);
    else if (row.issues.includes("검증된 ETF 분류 없음")) groups.unclassified.push(label);
    else if (row.issues.includes("주식형·커버드콜 ETF 전략 대상 아님")) groups.excluded.push(label);
    else groups.unavailable.push(label);
  }
  return groups;
}
