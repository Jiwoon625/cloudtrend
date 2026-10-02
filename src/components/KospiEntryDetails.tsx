import type { ScreeningRow } from "@/lib/engine/pipeline";
import { kospiEntryStateLabel, kospiMarketGateLabel } from "./kospiEntryPresentation";

type Entry = ScreeningRow["kospiEntry"];
type MarketEvidence = NonNullable<NonNullable<Entry>["marketGate"]>["origin"];

function MarketEvidenceLine({
  label,
  evidence,
  expectedDate,
}: {
  label: string;
  evidence: MarketEvidence | undefined;
  expectedDate: string | null;
}) {
  const isDated = Boolean(evidence && evidence.date === expectedDate);
  const excluded =
    !isDated ||
    !evidence ||
    (evidence.status !== "RISK_ON" && evidence.status !== "NEUTRAL") ||
    evidence.incomplete ||
    evidence.issues.length > 0 ||
    evidence.evaluatedCount !== 4;
  return (
    <p className={excluded ? "text-warn" : undefined}>
      {label} {evidence?.date ?? expectedDate ?? "날짜 미확인"} ·{" "}
      {kospiMarketGateLabel(evidence?.status)}
      {excluded ? " · 신규 진입 제외" : ""}
      {evidence && !isDated ? ` · 기준일 불일치(필요 ${expectedDate ?? "미확인"})` : ""}
      {!evidence ? " · 시장자료 없음" : ""}
      {evidence?.issues.length ? ` · ${evidence.issues.join(" · ")}` : ""}
    </p>
  );
}

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
      {entry.state !== "none" ? (
        <>
          <MarketEvidenceLine
            label="Onset일 시장"
            evidence={entry.marketGate?.origin}
            expectedDate={entry.originDate}
          />
          {entry.state === "pending" && !entry.confirmationDate ? (
            <p>확인일 시장 · 다음 KOSPI 거래일 종가 평가</p>
          ) : (
            <MarketEvidenceLine
              label="확인일 시장"
              evidence={entry.marketGate?.confirmation}
              expectedDate={entry.confirmationDate}
            />
          )}
        </>
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
