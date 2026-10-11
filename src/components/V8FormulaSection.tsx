import {
  VF_FEATURE_WEIGHTS,
  VF_ETF_PL_KOSPI_OVERHEAT_THRESHOLD,
  VF_MODEL_LABEL,
  VF_STOCK_PL_FALLBACK_OVERHEAT_THRESHOLD,
} from "@/lib/engine/vfConfig";

function Section({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <header className="border-b border-border bg-surface-strong px-3 py-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {desc ? <p className="text-[11px] text-muted-foreground">{desc}</p> : null}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

const FEATURES = [
  ["일목 구름 상단 위", VF_FEATURE_WEIGHTS.ICH_ABOVE_CLOUD, "종가 > 일목 구름 상단"],
  ["이동평균 정배열", VF_FEATURE_WEIGHTS.MA_ALIGNED, "MA20 > MA60 > MA120"],
  ["전환선 > 기준선", VF_FEATURE_WEIGHTS.ICH_TENKAN_KIJUN, "일목 모멘텀 confirmation"],
  ["볼린저밴드 상단 돌파", VF_FEATURE_WEIGHTS.BB_BREAKOUT, "Head Fake면 미충족"],
  ["Volume Surge", VF_FEATURE_WEIGHTS.VOLUME_SURGE, "20D 평균 대비 거래량 ≥150% + CLV ≥0.70"],
  ["52주 신고가 근접", VF_FEATURE_WEIGHTS.NEAR_52W_HIGH, "52주 고점 대비 -10% 이내"],
  ["외국인 20D 순매수+", VF_FEATURE_WEIGHTS.FOREIGN_NET_POSITIVE, "최근 20거래일 누적 순매수 > 0"],
  [
    "Sector Price Leadership",
    VF_FEATURE_WEIGHTS.SECTOR_PRICE_LEADERSHIP,
    `KOSPI: ETF PL < ${VF_ETF_PL_KOSPI_OVERHEAT_THRESHOLD} 우선 (없으면 Stock PL < ${VF_STOCK_PL_FALLBACK_OVERHEAT_THRESHOLD}) · KOSDAQ: Stock PL < ${VF_STOCK_PL_FALLBACK_OVERHEAT_THRESHOLD}이면 +0.5`,
  ],
] as const;

export function V8FormulaSection() {
  return (
    <details className="mt-4 rounded-lg border p-3">
      <summary className="cursor-pointer text-sm font-semibold">
        계산 산식 · {VF_MODEL_LABEL}
      </summary>
      <Section
        title="기술점수 구성요소"
        desc="각 조건의 충족 점수를 합산합니다. 채택·실험 전략의 진입·청산 규칙은 운영규칙 탭에서 관리합니다."
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr>
                <th>구성요소</th>
                <th>배점</th>
                <th>산식·판정</th>
              </tr>
            </thead>
            <tbody>
              {FEATURES.map(([name, weight, formula]) => (
                <tr key={name} className="border-t">
                  <td className="py-2">{name}</td>
                  <td>{weight}</td>
                  <td>{formula}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </details>
  );
}
