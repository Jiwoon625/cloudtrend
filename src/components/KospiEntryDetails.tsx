import type { ScreeningRow } from "@/lib/engine/pipeline";
import { kospiEntryStateLabel } from "./kospiEntryPresentation";

type Entry = ScreeningRow["kospiEntry"];

/** Render the stored assessment only. Never reconstruct confirmation from raw Onset or RS. */
export function KospiEntryDetails({
  entry,
  compact = false,
  showState = false,
}: {
  entry: Entry;
  compact?: boolean;
  showState?: boolean;
}) {
  if (!entry)
    return (
      <span className="text-[10px] text-muted-foreground">확인 기록 없음 · 진입 판정 제외</span>
    );
  if (entry.state === "none" && !showState) return null;
  return (
    <div className={`${compact ? "text-[10px]" : "text-[11px]"} space-y-0.5 text-muted-foreground`}>
      {showState ? (
        <p className="font-medium">
          저장 상태: {kospiEntryStateLabel(entry)} · 판정일 {entry.date}
        </p>
      ) : null}
      {entry.originDate ? (
        <p>
          Onset {entry.originDate} · 확인{" "}
          {entry.confirmationDate ??
            (entry.state === "pending" ? "다음 KOSPI 거래일 종가" : "미확인")}
        </p>
      ) : null}
      {!compact && entry.state !== "none" ? (
        <p>
          {entry.confirmationDate ? "확인일 RSAccel" : "판정일 RSAccel · 확인 전 참고"}:{" "}
          {entry.rsAccel === null || !Number.isFinite(entry.rsAccel)
            ? "미확인"
            : `${entry.rsAccel > 0 ? "+" : ""}${entry.rsAccel.toFixed(2)}%p`}
        </p>
      ) : null}
      {entry.issues.length ? <p className="text-warn">{entry.issues.join(" · ")}</p> : null}
    </div>
  );
}
