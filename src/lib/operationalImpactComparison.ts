import type { compareOperationalIndexPhase } from "./operationalUnderlyingIndex.server";
export type OperationalImpactPhase = Awaited<ReturnType<typeof compareOperationalIndexPhase>>;
/** Compare compact results only; no source data, persistence or screening execution. */
export function combineOperationalImpactPhases(
  web: OperationalImpactPhase,
  actions: OperationalImpactPhase,
) {
  if (web.phase !== "web" || actions.phase !== "actions") throw new Error("비교 단계가 다릅니다.");
  for (const key of [
    "asOfDate",
    "sourceSetDigest",
    "scoringConfigSha256",
    "providerVersion",
    "artifactSha256",
  ] as const) {
    if (web.report[key] !== actions.report[key])
      throw new Error(`비교 요청 사이 입력·설정이 변경되었습니다: ${key}`);
  }
  const ingressComparison = {
    mode: "read-only-original-vs-canonical" as const,
    webResultDigest: web.webResultDigest,
    actionsResultDigest: actions.webResultDigest,
    webInputFingerprint: web.webInputFingerprint,
    actionsInputFingerprint: actions.webInputFingerprint,
    resultDigestMatched: web.webResultDigest === actions.webResultDigest,
    inputFingerprintMatched: web.webInputFingerprint === actions.webInputFingerprint,
    firstNewSessionVerified: false as const,
  };
  if (!ingressComparison.resultDigestMatched || !ingressComparison.inputFingerprintMatched)
    throw new Error(`웹·Actions 저장 없는 비교 불일치: ${JSON.stringify(ingressComparison)}`);
  return { ...web.report, ingressComparison };
}
