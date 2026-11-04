export type ScreeningStage =
  | "COMPLETED"
  | "RUNNING"
  | "FAILED"
  | "WAITING_INPUT"
  | "WAITING_FOLLOWUP"
  | "NOT_RUN"
  | "SKIPPED_PRELIMINARY"
  | "UPDATED"
  | "REUSED"
  | "NOT_INITIALIZED";
export type ScreeningStages = Record<
  "screening" | "actualPortfolio" | "models" | "publication",
  ScreeningStage
>;
export function initialScreeningStages(preliminary = false): ScreeningStages {
  return {
    screening: "COMPLETED",
    actualPortfolio: preliminary ? "SKIPPED_PRELIMINARY" : "NOT_RUN",
    models: preliminary ? "SKIPPED_PRELIMINARY" : "NOT_RUN",
    publication: "NOT_RUN",
  };
}
export function screeningStagesPath(userId: string, runId: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(userId) || !/^[a-zA-Z0-9:_-]{1,200}$/.test(runId))
    throw new Error("Invalid screening status identity");
  return `${userId}/results/screening/stages/${runId}.json`;
}
export const screeningStageLabels: Record<ScreeningStage, string> = {
  COMPLETED: "완료",
  RUNNING: "진행 중",
  FAILED: "실패",
  WAITING_INPUT: "자료 대기",
  WAITING_FOLLOWUP: "후속 처리 대기",
  NOT_RUN: "미실행",
  SKIPPED_PRELIMINARY: "예비자료 · 보류",
  UPDATED: "갱신 완료",
  REUSED: "기존 결과 확인",
  NOT_INITIALIZED: "원장 미설정",
};

export function validScreeningStages(value: unknown): value is ScreeningStages {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).length === 4 &&
    ["screening", "actualPortfolio", "models", "publication"].every(
      (key) =>
        typeof row[key] === "string" && Object.hasOwn(screeningStageLabels, row[key] as string),
    )
  );
}
