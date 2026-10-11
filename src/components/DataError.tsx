import { AlertTriangle, RefreshCw } from "lucide-react";
import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";

/** Saved/uploaded-data failures retry their existing query, never reset provider credentials. */
export function DataError({
  error,
  reset,
  embedded = false,
}: {
  error: unknown;
  reset?: () => void | Promise<unknown>;
  embedded?: boolean;
}) {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "알 수 없는 오류";
  const [retrying, setRetrying] = useState(false);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);
  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    setRetryMessage("저장된 자료를 다시 확인하고 있습니다…");
    try {
      if (reset) await reset();
      else window.location.reload();
      setRetryMessage("다시 조회했습니다.");
    } catch (retryError) {
      setRetryMessage(
        retryError instanceof Error
          ? `조회 실패: ${retryError.message}`
          : "자료를 다시 불러오지 못했습니다.",
      );
    } finally {
      setRetrying(false);
    }
  };
  const content = (
    <div className="mx-auto max-w-2xl space-y-4 py-10">
      <div className="flex items-center gap-2">
        <AlertTriangle className="size-5 text-warn" />
        <h1 className="text-lg font-bold">시세 데이터를 불러오지 못했습니다</h1>
      </div>
      <p className="rounded-md border border-border bg-muted/40 p-3 font-mono text-[12px] leading-relaxed break-words">
        {message}
      </p>
      <p className="text-[13px] text-muted-foreground">
        로그인 상태와 업로드된 자료를 확인한 뒤 다시 시도해 주세요. 자료 기준일이나 계산 결과가 갱신
        중이면 잠시 후 다시 조회해 주세요.
      </p>
      {retryMessage ? (
        <p role="status" className="text-[12px] text-muted-foreground">
          {retryMessage}
        </p>
      ) : null}
      <Button onClick={() => void retry()} disabled={retrying} className="gap-2">
        <RefreshCw className={`size-4 ${retrying ? "animate-spin" : ""}`} />
        {retrying ? "조회 중…" : "다시 조회"}
      </Button>
    </div>
  );
  return embedded ? content : <AppShell dataUnavailable>{content}</AppShell>;
}
