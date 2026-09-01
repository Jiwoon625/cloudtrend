import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { getCollectionProgress } from "@/lib/market.functions";

/** 일봉 수집 진행률. 수집이 진행 중일 때 2초 간격으로 갱신하고, 완료되면 분석 결과를 새로고침한다. */
export function CollectionProgress() {
  const queryClient = useQueryClient();
  const wasRunning = useRef(false);

  const { data } = useQuery({
    queryKey: ["collection-progress"],
    queryFn: () => getCollectionProgress(),
    refetchInterval: (q) => (q.state.data?.running ? 2000 : 8000),
    staleTime: 0,
  });

  useEffect(() => {
    if (!data) return;
    if (wasRunning.current && !data.running) {
      void queryClient.invalidateQueries({ queryKey: ["market-analysis"] });
    }
    wasRunning.current = data.running;
  }, [data, queryClient]);

  const total = data?.total ?? 0;
  const done = data?.done ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : data ? 100 : 0;
  const running = data?.running ?? false;

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between text-[12px]">
        <span className={running ? "text-primary" : "text-muted-foreground"}>
          {running ? "일봉 수집 진행 중…" : total > 0 ? "수집 완료" : "수집 대기"}
        </span>
        <span className="num font-semibold">
          {done} / {total || "-"} ({pct}%)
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full transition-all duration-500 ${running ? "bg-primary" : "bg-primary/60"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">
        캐시된 종목 {data?.cached ?? 0}개 · 수집이 끝나면 스크리닝 결과가 자동으로 갱신됩니다.
      </p>
    </div>
  );
}
