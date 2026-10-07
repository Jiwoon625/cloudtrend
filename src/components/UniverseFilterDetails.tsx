import type { ScreeningRow } from "@/lib/engine/pipeline";

/** Keep missing eligibility inputs separate from rules known to have failed. */
export function UniverseFilterDetails({
  row,
  compact = false,
}: {
  row: Pick<ScreeningRow, "hardFilterPassed" | "hardFilterStatus" | "failedRules" | "pendingRules">;
  compact?: boolean;
}) {
  const status = row.hardFilterStatus ?? (row.hardFilterPassed ? "PASS" : "FAIL");
  const pending = row.pendingRules ?? [];
  if (status === "PASS" && pending.length === 0) return null;
  return (
    <div className={compact ? "space-y-0.5 text-[10px]" : "mt-3 space-y-2 text-[12px]"}>
      {status === "FAIL" ? (
        <p
          className={
            compact
              ? "text-down"
              : "rounded-md border border-destructive/30 bg-down-soft p-2 text-down"
          }
        >
          {compact ? "실격" : "실격 사유"}: {row.failedRules.join(", ") || "조건 미충족"}
        </p>
      ) : null}
      {status === "PENDING" || pending.length > 0 ? (
        <div
          className={
            compact ? "text-warn" : "rounded-md border border-warn/30 bg-warn-soft p-2 text-warn"
          }
        >
          <p>
            {status === "PENDING" ? "판단 보류" : "판단 보류 항목"}:{" "}
            {pending.join(", ") || "필수 자료 미확인"}
          </p>
          {!compact ? <p>기술점수는 별도 표시하며, 자료 확인 전 신규 진입은 제외합니다.</p> : null}
        </div>
      ) : null}
    </div>
  );
}
