import { Link } from "@tanstack/react-router";
import { BarChart3, Play } from "lucide-react";

import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";

/** 분석 결과 화면이 외부 API를 자동 호출하지 않도록 명시적인 시작 경로를 안내한다. */
export function AnalysisRequired() {
  return (
    <AppShell>
      <section className="mx-auto max-w-2xl py-16 text-center">
        <BarChart3 className="mx-auto mb-3 size-8 text-primary" />
        <h1 className="text-lg font-bold">먼저 스크리닝을 실행해 주세요</h1>
        <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-muted-foreground">
          이 화면은 현재 세션의 마지막 분석 결과를 사용합니다. 외부 시세 API는 화면을 열 때 자동으로
          호출하지 않으며, 대시보드에서 직접 시작한 경우에만 호출됩니다.
        </p>
        <Button asChild className="mt-5 gap-2">
          <Link to="/">
            <Play className="size-4" />
            대시보드에서 스크리닝 시작
          </Link>
        </Button>
      </section>
    </AppShell>
  );
}