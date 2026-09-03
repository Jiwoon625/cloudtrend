import { Link } from "@tanstack/react-router";
import { BarChart3, Loader2, Play } from "lucide-react";

import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";

/** 직접 입력한 데이터가 없을 때 대시보드 입력 화면으로 안내한다. */
export function AnalysisRequired({ loading = false }: { loading?: boolean }) {
  if (loading) {
    return (
      <AppShell>
        <section className="mx-auto max-w-2xl py-16 text-center">
          <Loader2 className="mx-auto mb-3 size-6 animate-spin text-primary" />
          <p className="text-[13px] text-muted-foreground">
            입력한 시세로 지표와 점수를 계산하는 중입니다…
          </p>
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <section className="mx-auto max-w-2xl py-16 text-center">
        <BarChart3 className="mx-auto mb-3 size-8 text-primary" />
        <h1 className="text-lg font-bold">먼저 시세 데이터를 입력해 주세요</h1>
        <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-muted-foreground">
          이 화면은 대시보드에서 붙여넣거나 업로드한 시세 데이터로 계산합니다. 서버에서 외부 시세
          API를 호출하지 않으므로, 주피터노트북에서 받은 데이터를 먼저 입력해 주세요.
        </p>
        <Button asChild className="mt-5 gap-2">
          <Link to="/">
            <Play className="size-4" />
            대시보드에서 데이터 입력 · 스크리닝 시작
          </Link>
        </Button>
      </section>
    </AppShell>
  );
}
