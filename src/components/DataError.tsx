import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw } from "lucide-react";

import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { ipQueryOptions } from "@/lib/analysisQuery";

/** 데이터 조회(토스 API) 실패 시 빈 화면 대신 원인과 대응 방법을 보여준다. */
export function DataError({ error, reset }: { error: unknown; reset?: () => void }) {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "알 수 없는 오류";
  const { data: ip } = useQuery({ ...ipQueryOptions, retry: false });
  const isAuth = /401|unidentified-client|인증/.test(message);
  const isIp = /IP|403/.test(message);

  return (
    <AppShell dataUnavailable>
      <div className="mx-auto max-w-2xl space-y-4 py-10">
        <div className="flex items-center gap-2">
          <AlertTriangle className="size-5 text-warn" />
          <h1 className="text-lg font-bold">시세 데이터를 불러오지 못했습니다</h1>
        </div>
        <p className="rounded-md border border-border bg-muted/40 p-3 font-mono text-[12px] leading-relaxed break-words">
          {message}
        </p>
        {isAuth || isIp ? (
          <ul className="list-disc space-y-1.5 pl-5 text-[13px] text-muted-foreground">
            <li>
              현재 서버 출구 IP: <span className="num font-medium text-foreground">{ip ?? "확인 중"}</span>
              {" — 토스증권 개발자센터 > 앱 설정의 허용 IP에 이 주소가 등록되어 있어야 합니다."}
            </li>
            <li>
              게시(배포)된 주소에서는 요청이 전 세계 엣지 서버로 분산되어 출구 IP가 매 요청마다
              바뀌므로, IP 허용목록 방식으로는 고정할 수 없습니다. 실제 스크리닝은 미리보기 주소에서
              실행해 주세요.
            </li>

            <li>
              TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 값이 유효한지(재발급·오탈자·앞뒤 공백) 확인하세요.
            </li>
          </ul>
        ) : (
          <p className="text-[13px] text-muted-foreground">
            잠시 후 다시 시도해 주세요. 반복되면 토스증권 API 상태와 호출 한도를 확인하세요.
          </p>
        )}
        <Button onClick={() => (reset ? reset() : window.location.reload())} className="gap-2">
          <RefreshCw className="size-4" />
          다시 시도
        </Button>
      </div>
    </AppShell>
  );
}
