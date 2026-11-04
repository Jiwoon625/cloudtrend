import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/cloud";
import { allocatedPerformanceHistoryServer } from "@/lib/allocatedPerformanceHistory.functions";
import type { OctoberShadowBookSummary } from "@/lib/octoberShadowSummary.server";

export function AllocatedPerformanceComparison({
  owner,
  book,
}: {
  owner: string | null;
  book: OctoberShadowBookSummary | undefined;
}) {
  const currency = book?.currency ?? "KRW";
  const query = useQuery({
    queryKey: ["allocated-performance-history", owner, currency],
    enabled: !!owner && !!book,
    gcTime: 0,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const { data, error } = await supabase.auth.getSession();
      if (error || !data.session || data.session.user.id !== owner)
        throw new Error("로그인 확인 필요");
      return allocatedPerformanceHistoryServer({
        data: { accessToken: data.session.access_token, currency },
      });
    },
  });
  const point = query.data?.points.find((p) => p.date === book?.latestSessionDate);
  const comparable =
    point?.returnPercent != null &&
    book?.returnPercent != null &&
    book.scheduledStart === "2026-10-12" &&
    point.issues.length === 0;
  return (
    <section className="rounded-lg border p-4 space-y-2" aria-label="실제·전략 성과 비교">
      <h2 className="font-semibold">실제·선택 전략 성과 비교 · 보관 기록</h2>
      <p className="text-xs text-muted-foreground">
        2026-10-12 이후 명시적으로 배정한 실제 체결과 현금만 사용합니다.{" "}
        {currency === "KRW" ? "실제 국내 주식·ETF 공통 자금" : "실제 미국 자금"}과 선택한 독립
        전략을 {currency} 기준으로 비교합니다. 미입력 배당·비용은 반영되지 않으며 증권사 대사 완료
        수익률은 아닙니다. 일상 스크리닝에서는 이 비교 성과를 자동 계산하지 않습니다.
      </p>
      {query.isError ? (
        <p role="alert">{query.error.message}</p>
      ) : query.isPending ? (
        <p>실제 성과 조회 중…</p>
      ) : comparable ? (
        <table className="text-sm w-full">
          <thead>
            <tr>
              <th>동일 기준일</th>
              <th>실제 수익률</th>
              <th>선택 전략</th>
              <th>차이</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{point!.date}</td>
              <td>{Number(point!.returnPercent).toFixed(2)}%</td>
              <td>{book!.returnPercent!.toFixed(2)}%</td>
              <td>{(Number(point!.returnPercent) - book!.returnPercent!).toFixed(2)}%p</td>
            </tr>
          </tbody>
        </table>
      ) : (
        <p className="text-sm">
          동일 기준일의 검증된 비교 자료가 없습니다. 성과는 별도 연구 시 계산하며, 다음 스크리닝이나
          새로고침으로 생성되지 않습니다. 원장 변경, 가격 누락 또는 추가 입출금이 있으면 확인 전까지
          비교 수익률을 표시하지 않습니다.
        </p>
      )}
      {query.data && (
        <p className="text-xs text-muted-foreground">
          실제 자료 마지막 날짜 {query.data.throughDate} · 전략 마지막 날짜{" "}
          {book?.latestSessionDate ?? "없음"}
        </p>
      )}
    </section>
  );
}
