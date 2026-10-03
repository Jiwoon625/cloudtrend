import type { UsProspectiveSummary } from "@/lib/usBrowserViews";

export function UsDataQualityPanel({ value }: { value: UsProspectiveSummary | null }) {
  const quality = value?.quality;
  const count = (n: number | null | undefined) => (n == null ? "미확인" : n.toLocaleString());
  return (
    <section
      className="min-w-0 rounded-lg border border-border bg-card p-4"
      aria-label="미국 데이터 품질 및 제공 범위"
    >
      <h2 className="text-sm font-semibold">미국 · 항목별 제공 범위와 검증</h2>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        저장된 최신 스크리닝 결과의 실제 값만 집계합니다. SPY를 포함하며, 공란은 0으로 채우지
        않습니다.
      </p>
      <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["엔진 입력 레코드", count(value?.analysis.summary["inputRows"])],
          ["저장된 종목 행", count(value?.analysis.rowCount)],
          ["중복 심볼", quality ? `${count(quality.duplicateSymbols)}건` : "미확인"],
          ["요약 기준일과 다른 행", quality ? `${count(quality.dateMismatch)}건` : "미확인"],
        ].map(([label, body]) => (
          <div key={label} className="rounded-md bg-muted/40 p-3">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="num mt-1 text-sm font-semibold">{body}</dd>
          </div>
        ))}
      </dl>
      {quality ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {quality.coverage.map((field) => (
            <div
              key={field.key}
              className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md border p-3 text-xs"
            >
              <span className="font-medium">{field.label}</span>
              <span className="num text-muted-foreground">
                {count(field.present)} / {count(quality.rowCount)}행 확인 ·{" "}
                {count(quality.rowCount - field.present)}행 미제공/산정 불가
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-xs text-warn">
          {value?.qualityNote ??
            "항목별 제공 범위를 확인할 자료가 없습니다. 오류 0건을 뜻하지 않습니다."}
        </p>
      )}
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        한국의 원본 일봉 검증과 범위가 다릅니다. 미국 요약에는 전체 OHLC·거래량 검증, 종목별 일봉
        수집 구간, 재무·ETF NAV·총보수 제공 여부가 없어 정상으로 판정하지 않습니다. 순위 공란은
        미제공뿐 아니라 전략 대상 제외로도 생길 수 있습니다.
      </p>
    </section>
  );
}
