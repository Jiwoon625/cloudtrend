import { Link } from "@tanstack/react-router";
import { BarChart3, Loader2, Play } from "lucide-react";

import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";

/** 게시된 결과가 없을 때 조회 상태 화면으로 안내한다. */
export function AnalysisRequired({ loading = false }: { loading?: boolean }) {
  if (loading) {
    return (
      <AppShell>
        <section className="mx-auto max-w-2xl py-16 text-center">
          <Loader2 className="mx-auto mb-3 size-6 animate-spin text-primary" />
          <p className="text-[13px] text-muted-foreground">
            게시된 스크리닝 결과를 불러오는 중입니다…
          </p>
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <section className="mx-auto max-w-2xl py-16 text-center">
        <BarChart3 className="mx-auto mb-3 size-8 text-primary" />
        <h1 className="text-lg font-bold">게시된 스크리닝 결과를 기다리고 있습니다</h1>
        <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-muted-foreground">
          자동 수집·계산·게시가 완료되면 결과를 확인할 수 있습니다. 데이터 관리에서 최근 게시 상태를
          확인해 주세요.
        </p>
        <Button asChild className="mt-5 gap-2">
          <Link to="/scoring">
            <Play className="size-4" />
            데이터 관리에서 게시 상태 확인
          </Link>
        </Button>
      </section>
    </AppShell>
  );
}
