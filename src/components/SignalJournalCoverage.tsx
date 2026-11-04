import { useQuery } from "@tanstack/react-query";
import { supabase, userId } from "@/lib/cloud";
import { formatKstDateTime } from "@/lib/format";
interface Coverage {
  version: 1;
  throughDate: string;
  checkedAt: string;
  pending: Array<{ date: string; reason: string }>;
}
export function SignalJournalCoverage() {
  const query = useQuery({
    queryKey: ["signal-journal-coverage"],
    retry: false,
    queryFn: async () => {
      const owner = await userId();
      return Promise.all(
        (["KR", "US"] as const).map(async (market) => {
          const { data, error } = await supabase.storage
            .from("cloudtrend-data")
            .download(`${owner}/results/screening/signal-journal/${market}/coverage.json`);
          if (error) {
            if (/not.?found|404/i.test(error.message)) return { market, coverage: null };
            throw new Error("일별 신호 기록 상태를 읽지 못했습니다.");
          }
          const coverage = JSON.parse(await data.text()) as Coverage;
          if (coverage.version !== 1 || !Array.isArray(coverage.pending))
            throw new Error("일별 신호 기록 상태 형식 오류");
          return { market, coverage };
        }),
      );
    },
  });
  return (
    <section className="mb-4 rounded border p-3 text-xs" aria-label="일별 신호 기록 상태">
      <p className="mb-2 font-medium">일별 신호 기록 · 수익률 계산 없음</p>
      <p className="mb-2 text-muted-foreground">
        자료가 확보된 거래일은 당시 설정으로 기록합니다. 미수집 날짜는 자료 대기로 남으며, 후일
        복원한 신호는 당시 기록과 구분합니다.
      </p>
      {query.isPending ? (
        <p>기록 상태 확인 중…</p>
      ) : query.error ? (
        <p role="alert">{query.error.message}</p>
      ) : (
        query.data?.map(({ market, coverage }) => (
          <div key={market} className="mt-2">
            <p>
              {market === "KR" ? "한국·ETF" : "미국"} ·{" "}
              {coverage
                ? `자료 기준 ${coverage.throughDate} · 확인 ${formatKstDateTime(coverage.checkedAt)} KST`
                : "첫 기록 점검 대기"}
            </p>
            {coverage ? (
              coverage.pending.length ? (
                <details className="mt-1">
                  <summary className="cursor-pointer text-warn">
                    미완료 {coverage.pending.length}거래일
                  </summary>
                  <ul className="mt-1 space-y-1">
                    {coverage.pending.map((p) => (
                      <li key={p.date}>
                        {p.date} · {p.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : (
                <p>점검 범위 내 누락 없음</p>
              )
            ) : null}
          </div>
        ))
      )}
      <p className="mt-2 text-muted-foreground">
        기존 원장과 Shadow 기록은 보관 기록에서 조회할 수 있습니다. 성과 비교는 추후 백테스트
        자료수집기로 별도 연구합니다.
      </p>
    </section>
  );
}
