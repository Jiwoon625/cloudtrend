type Metadata = Record<string, unknown>;

function isRecord(value: unknown): value is Metadata {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function UsRecoveryNotice({ metadata }: { metadata?: unknown }) {
  if (!isRecord(metadata)) return null;
  const publication = metadata["recoveryPublication"];
  if (!isRecord(publication) || publication["version"] !== "us-recovery-publication-v1") {
    return null;
  }

  for (const key of [
    "manifestHash",
    "operatingPlanHash",
    "originalDataHash",
    "originalResultHash",
  ]) {
    const value = publication[key];
    if (typeof value !== "string" || value.trim().length === 0) return null;
  }

  const sourceKind = publication["sourceKind"];
  const reconstructed =
    sourceKind === "DATED_ROSTER_RECONSTRUCTION" || sourceKind === "REVIEWED_ATOMIC_QUARANTINE";
  if (!reconstructed && sourceKind !== "ATOMIC_DATED_SNAPSHOT") return null;

  const quarantinedSymbols = metadata["quarantinedSymbols"];
  const incomplete =
    metadata["sourceCoverageComplete"] === false ||
    (Array.isArray(quarantinedSymbols) && quarantinedSymbols.length > 0);

  return (
    <p role="note" className="text-[11px] leading-relaxed text-muted-foreground">
      {reconstructed
        ? "검토용 재구성 자료를 날짜순으로 이어 계산한 결과입니다."
        : "날짜순으로 이어 계산한 복구 결과입니다."}
      {incomplete ? " 일부 종목은 제외됐으며 원래 게시 결과는 보존됩니다." : null}
    </p>
  );
}
