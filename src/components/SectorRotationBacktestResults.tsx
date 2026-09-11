import type {
  SectorRankGroup,
  SectorRotationBacktestResult,
} from "@/lib/engine/sectorRotationBacktest";

const days = (value: number | null) =>
  value === null || !Number.isFinite(value) ? "—" : `${value.toFixed(1)}일`;

const pct = (value: number | null) =>
  value === null || !Number.isFinite(value) ? "—" : `${value.toFixed(1)}%`;

const ret = (value: number | null) =>
  value === null || !Number.isFinite(value)
    ? "—"
    : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;

const groupLabel: Record<SectorRankGroup, string> = {
  TOP: "상위권",
  MID: "중위권",
  BOTTOM: "하위권",
};

export function SectorRotationBacktestResults({
  result,
}: {
  result: SectorRotationBacktestResult;
}) {
  const transition5 = result.transitions.find((row) => row.horizon === 5) ?? result.transitions[0];

  return (
    <section className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">섹터 로테이션 주기 백테스트</h2>
            <span className="rounded bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
              ROTATION CYCLE
            </span>
          </div>
          <p className="mt-1 max-w-4xl text-[10px] leading-relaxed text-muted-foreground">
            매 거래일 로테이션 점수를 다시 계산해 {result.sectorCount}개 섹터를 상위 1~4위,
            중위 5~10위, 하위 11~14위로 나누고 체류기간·생존율·그룹 전이·신규 Top4 이후
            성과를 측정합니다.
          </p>
        </div>
        <p className="text-[10px] text-muted-foreground">
          {result.from} ~ {result.to} · {result.tradingDays.toLocaleString("ko-KR")}거래일
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["Strict Top4 평균", days(result.strictTop.avgDays)],
          ["Strict Top4 중앙값", days(result.strictTop.medianDays)],
          ["Buffered Top4 평균", days(result.bufferedTop.avgDays)],
          ["Top4 재진입 간격 중앙값", days(result.topReentryGap.medianDays)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-md border border-border p-3">
            <p className="text-[10px] text-muted-foreground">{label}</p>
            <p className="num mt-0.5 text-sm font-semibold">{value}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <div className="space-y-2">
          <div>
            <h3 className="text-[12px] font-semibold">그룹별 연속 체류기간</h3>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              Strict 기준. 데이터 시작·종료 경계에 걸린 에피소드는 통계에서 제외합니다.
            </p>
          </div>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[560px] text-[10px]">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-2 py-2 text-left">그룹</th>
                  <th className="px-2 py-2 text-right">에피소드</th>
                  <th className="px-2 py-2 text-right">평균</th>
                  <th className="px-2 py-2 text-right">중앙값</th>
                  <th className="px-2 py-2 text-right">25%</th>
                  <th className="px-2 py-2 text-right">75%</th>
                  <th className="px-2 py-2 text-right">최대</th>
                </tr>
              </thead>
              <tbody>
                {result.groupResidency.map((row) => (
                  <tr key={row.group} className="border-t border-border">
                    <td className="px-2 py-2 font-medium">{row.label}</td>
                    <td className="num px-2 py-2 text-right">{row.episodes}</td>
                    <td className="num px-2 py-2 text-right">{days(row.avgDays)}</td>
                    <td className="num px-2 py-2 text-right">{days(row.medianDays)}</td>
                    <td className="num px-2 py-2 text-right">{days(row.p25Days)}</td>
                    <td className="num px-2 py-2 text-right">{days(row.p75Days)}</td>
                    <td className="num px-2 py-2 text-right">{days(row.maxDays)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="space-y-2">
          <div>
            <h3 className="text-[12px] font-semibold">Top4 진입 후 연속 생존율</h3>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              Strict는 5위에서 종료. Buffered는 5위까지 허용하고 6위 이하에서 종료합니다.
            </p>
          </div>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[520px] text-[10px]">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-2 py-2 text-left">경과</th>
                  <th className="px-2 py-2 text-right">Strict 생존</th>
                  <th className="px-2 py-2 text-right">Strict 표본</th>
                  <th className="px-2 py-2 text-right">Buffered 생존</th>
                  <th className="px-2 py-2 text-right">Buffered 표본</th>
                </tr>
              </thead>
              <tbody>
                {result.survival.map((row) => (
                  <tr key={row.horizon} className="border-t border-border">
                    <td className="px-2 py-2 font-medium">{row.horizon}거래일</td>
                    <td className="num px-2 py-2 text-right">{pct(row.strictRate)}</td>
                    <td className="num px-2 py-2 text-right">{row.strictEligible}</td>
                    <td className="num px-2 py-2 text-right">{pct(row.bufferedRate)}</td>
                    <td className="num px-2 py-2 text-right">{row.bufferedEligible}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {transition5 ? (
        <div className="space-y-2">
          <div>
            <h3 className="text-[12px] font-semibold">5거래일 그룹 전이확률</h3>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              현재 그룹에 속한 섹터가 5거래일 뒤 어느 그룹으로 이동했는지 행 기준 확률로 표시합니다.
            </p>
          </div>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[520px] text-[10px]">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-2 py-2 text-left">현재 → 5D</th>
                  <th className="px-2 py-2 text-right">상위권</th>
                  <th className="px-2 py-2 text-right">중위권</th>
                  <th className="px-2 py-2 text-right">하위권</th>
                  <th className="px-2 py-2 text-right">표본</th>
                </tr>
              </thead>
              <tbody>
                {transition5.rows.map((row) => (
                  <tr key={row.from} className="border-t border-border">
                    <td className="px-2 py-2 font-medium">{groupLabel[row.from]}</td>
                    <td className="num px-2 py-2 text-right">{pct(row.top)}</td>
                    <td className="num px-2 py-2 text-right">{pct(row.mid)}</td>
                    <td className="num px-2 py-2 text-right">{pct(row.bottom)}</td>
                    <td className="num px-2 py-2 text-right">{row.observations}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div className="space-y-2">
        <div>
          <h3 className="text-[12px] font-semibold">Top4 신규진입 이후 섹터 성과</h3>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            직전 거래일에는 Top4가 아니었다가 처음 1~4위에 진입한 {result.topEntryCount}개 이벤트를
            기준으로 구성 종목 중앙값 수익률과 KOSPI 대비 초과수익률을 측정합니다.
          </p>
        </div>
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[720px] text-[10px]">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-2 py-2 text-left">보유</th>
                <th className="px-2 py-2 text-right">표본</th>
                <th className="px-2 py-2 text-right">평균수익률</th>
                <th className="px-2 py-2 text-right">중앙수익률</th>
                <th className="px-2 py-2 text-right">상승률</th>
                <th className="px-2 py-2 text-right">평균 초과수익</th>
                <th className="px-2 py-2 text-right">초과수익 승률</th>
              </tr>
            </thead>
            <tbody>
              {result.topEntryPerformance.map((row) => (
                <tr key={row.horizon} className="border-t border-border">
                  <td className="px-2 py-2 font-medium">{row.horizon}D</td>
                  <td className="num px-2 py-2 text-right">{row.observations}</td>
                  <td className="num px-2 py-2 text-right">{ret(row.avgReturn)}</td>
                  <td className="num px-2 py-2 text-right">{ret(row.medianReturn)}</td>
                  <td className="num px-2 py-2 text-right">{pct(row.winRate)}</td>
                  <td className="num px-2 py-2 text-right">{ret(row.avgExcessReturn)}</td>
                  <td className="num px-2 py-2 text-right">{pct(row.excessWinRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="space-y-2">
        <div>
          <h3 className="text-[12px] font-semibold">섹터별 Top4 체류 특성</h3>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            어떤 섹터가 한 번 주도권을 잡았을 때 오래 유지되는지 비교합니다.
          </p>
        </div>
        <div className="max-h-[420px] overflow-auto rounded-md border border-border">
          <table className="w-full min-w-[760px] text-[10px]">
            <thead className="sticky top-0 bg-muted text-muted-foreground">
              <tr>
                <th className="px-2 py-2 text-left">섹터</th>
                <th className="px-2 py-2 text-right">Strict 진입</th>
                <th className="px-2 py-2 text-right">Strict 평균</th>
                <th className="px-2 py-2 text-right">Strict 중앙</th>
                <th className="px-2 py-2 text-right">Buffered 평균</th>
                <th className="px-2 py-2 text-right">Buffered 중앙</th>
                <th className="px-2 py-2 text-right">20D 생존</th>
              </tr>
            </thead>
            <tbody>
              {[...result.sectorResidency]
                .sort((a, b) => (b.topMedianDays ?? -1) - (a.topMedianDays ?? -1))
                .map((row) => (
                  <tr key={row.sectorCode} className="border-t border-border">
                    <td className="px-2 py-2 font-medium">{row.sectorName}</td>
                    <td className="num px-2 py-2 text-right">{row.topEpisodes}</td>
                    <td className="num px-2 py-2 text-right">{days(row.topAvgDays)}</td>
                    <td className="num px-2 py-2 text-right">{days(row.topMedianDays)}</td>
                    <td className="num px-2 py-2 text-right">{days(row.bufferedTopAvgDays)}</td>
                    <td className="num px-2 py-2 text-right">{days(row.bufferedTopMedianDays)}</td>
                    <td className="num px-2 py-2 text-right">{pct(row.top20dSurvivalRate)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-md border border-border bg-muted/20 p-3 text-[10px] leading-relaxed text-muted-foreground">
        <p className="font-medium text-foreground">해석 시 유의사항</p>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          {result.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
