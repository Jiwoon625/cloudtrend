import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  DEFAULT_SCORING_CONFIG,
  priorityMaxPoints,
  technicalMaxPoints,
  type ScoringConfig,
} from "@/lib/engine/scoring";
import { formatWon } from "@/lib/format";
import { useScoringConfig } from "@/lib/scoringConfigStore";

export const Route = createFileRoute("/scoring")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "점수 산식 및 가중치 편집 | TrendScore KR" },
      {
        name: "description",
        content:
          "기술 신호·우선순위·펀더멘털·섹터 가중치와 각 항목 배점·임계값을 직접 수정하고, 수정한 산식으로 주식·ETF 스크리너를 즉시 다시 계산합니다.",
      },
      { property: "og:title", content: "점수 산식 및 가중치 편집 | TrendScore KR" },
      {
        property: "og:description",
        content: "종합점수 계산식을 화면에서 확인하고 가중치와 임계값을 직접 조정합니다.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ScoringPage,
});

function Section({
  title,
  desc,
  children,
}: {
  title: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <header className="border-b border-border bg-surface-strong px-3 py-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="text-[11px] text-muted-foreground">{desc}</p>
      </header>
      <div className="space-y-3 p-3">{children}</div>
    </section>
  );
}

function NumField({
  label,
  hint,
  value,
  step = 1,
  suffix,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  step?: number;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="grid grid-cols-[1fr_120px] items-center gap-2">
      <div>
        <Label className="text-[12px]">{label}</Label>
        {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="flex items-center gap-1">
        <Input
          type="number"
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="h-8 text-right text-[12px]"
        />
        {suffix ? <span className="text-[11px] text-muted-foreground">{suffix}</span> : null}
      </div>
    </div>
  );
}

function ScoringPage() {
  const [saved, setSaved] = useScoringConfig();
  const [draft, setDraft] = useState<ScoringConfig>(saved);
  const [syncedFrom, setSyncedFrom] = useState(saved);
  const queryClient = useQueryClient();

  // 저장된 설정이 (다른 탭 등에서) 바뀌면 편집 중이 아닐 때 반영한다.
  if (saved !== syncedFrom && JSON.stringify(saved) !== JSON.stringify(syncedFrom)) {
    setSyncedFrom(saved);
    setDraft(saved);
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const techMax = technicalMaxPoints(draft);
  const prioMax = priorityMaxPoints(draft);

  const patch = (fn: (d: ScoringConfig) => void) => {
    const next: ScoringConfig = JSON.parse(JSON.stringify(draft));
    fn(next);
    setDraft(next);
  };

  const apply = () => {
    setSaved(draft);
    setSyncedFrom(draft);
    void queryClient.invalidateQueries({ queryKey: ["market-analysis"] });
    void queryClient.invalidateQueries({ queryKey: ["instrument"] });
  };

  const weightSum = (k: "stock" | "etf") => {
    const w = draft.weights[k];
    return w.technical + w.priority + w.fundamental + w.marketSector;
  };

  return (
    <AppShell>
      <div className="mb-4">
        <h1 className="text-xl font-bold tracking-tight">점수 산식 및 가중치</h1>
        <p className="text-[12px] text-muted-foreground">
          아래 값은 주식·ETF 스크리너와 종목 상세의 점수 계산에 그대로 사용됩니다. 값을 바꾸고
          “적용하고 다시 계산”을 누르면 같은 데이터로 점수만 재산출합니다.
        </p>
      </div>

      <div className="mb-4 rounded-lg border border-border bg-surface p-3 text-[12px] leading-relaxed">
        <p className="mb-1 font-semibold">종합점수 계산식</p>
        <code className="block whitespace-pre-wrap text-[11px] text-muted-foreground">
          {`기술점수(%) = 획득 / 산정가능 만점 × 100   (만점 ${techMax}점)
우선순위(%) = 획득 / 산정가능 만점 × 100   (만점 ${prioMax}점)
품질(%)     = 주식: 펀더멘털 100점 환산 / ETF: 상품건전성 100점 환산
섹터(%)     = 섹터 상대강도·추세·breadth 종합 점수

종합점수 = Σ(항목% × 가중치) / Σ(데이터가 있는 항목의 가중치)`}
        </code>
        <p className="mt-1 text-[11px] text-muted-foreground">
          데이터가 없는 항목(예: 토스 API 미제공 재무)은 0점이 아니라 분모에서 제외됩니다. 따라서
          가중치 합이 1이 아니어도 결과는 정규화됩니다.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section
          title="1. 종합점수 가중치"
          desc="주식과 ETF에 각각 다른 가중치를 적용합니다. 합계가 1이 아니어도 자동 정규화됩니다."
        >
          {(["stock", "etf"] as const).map((k) => (
            <div key={k} className="rounded-md border border-border p-2">
              <p className="mb-2 text-[12px] font-semibold">
                {k === "stock" ? "주식" : "ETF"} · 가중치 합계 {weightSum(k).toFixed(2)}
              </p>
              <div className="space-y-2">
                <NumField
                  label="기술 신호"
                  value={draft.weights[k].technical}
                  step={0.05}
                  onChange={(v) => patch((d) => void (d.weights[k].technical = v))}
                />
                <NumField
                  label="우선순위(수급·지수·신고가)"
                  value={draft.weights[k].priority}
                  step={0.05}
                  onChange={(v) => patch((d) => void (d.weights[k].priority = v))}
                />
                <NumField
                  label={k === "stock" ? "펀더멘털" : "ETF 상품건전성"}
                  value={draft.weights[k].fundamental}
                  step={0.05}
                  onChange={(v) => patch((d) => void (d.weights[k].fundamental = v))}
                />
                <NumField
                  label="시장·섹터"
                  value={draft.weights[k].marketSector}
                  step={0.05}
                  onChange={(v) => patch((d) => void (d.weights[k].marketSector = v))}
                />
              </div>
            </div>
          ))}
        </Section>

        <Section
          title={`2. 기술 신호 배점 (현재 만점 ${techMax}점)`}
          desc="항목별 만점과 거래량 판정 임계값. 부분 충족 시 만점의 절반이 부여됩니다."
        >
          <NumField
            label="일목 추세 만점"
            hint="구름 상단 위 + 전환선>기준선 + 후행스팬 양전"
            value={draft.technical.ichimokuMax}
            step={0.5}
            suffix="점"
            onChange={(v) => patch((d) => void (d.technical.ichimokuMax = v))}
          />
          <NumField
            label="볼린저 모멘텀 만점"
            hint="스퀴즈 후 상단 돌파 + 밴드폭 확장 (Head Fake 시 0점)"
            value={draft.technical.bollingerMax}
            step={0.5}
            suffix="점"
            onChange={(v) => patch((d) => void (d.technical.bollingerMax = v))}
          />
          <NumField
            label="거래량 수급 만점"
            value={draft.technical.volumeMax}
            step={0.5}
            suffix="점"
            onChange={(v) => patch((d) => void (d.technical.volumeMax = v))}
          />
          <NumField
            label="이동평균 배열 만점"
            hint="MA20 > MA60 > MA120 + MA20 기울기 > 0"
            value={draft.technical.maMax}
            step={0.5}
            suffix="점"
            onChange={(v) => patch((d) => void (d.technical.maMax = v))}
          />
          <div className="border-t border-border pt-3" />
          <NumField
            label="거래량 강한 신호 기준"
            hint="20일 평균 거래량 대비"
            value={draft.technical.volumeStrongRatio}
            step={10}
            suffix="%"
            onChange={(v) => patch((d) => void (d.technical.volumeStrongRatio = v))}
          />
          <NumField
            label="거래대금 백분위 기준"
            hint="강한 신호 동시 조건 (70 = 상위 30%)"
            value={draft.technical.volumeStrongPercentile}
            step={5}
            onChange={(v) => patch((d) => void (d.technical.volumeStrongPercentile = v))}
          />
          <NumField
            label="거래량 약한 신호 기준"
            value={draft.technical.volumeWeakRatio}
            step={10}
            suffix="%"
            onChange={(v) => patch((d) => void (d.technical.volumeWeakRatio = v))}
          />
          <div className="border-t border-border pt-3" />
          <NumField
            label="A등급 최소 기술점수"
            value={draft.grade.aMin}
            step={0.5}
            suffix="점"
            onChange={(v) => patch((d) => void (d.grade.aMin = v))}
          />
          <NumField
            label="B등급 최소 기술점수"
            value={draft.grade.bMin}
            step={0.5}
            suffix="점"
            onChange={(v) => patch((d) => void (d.grade.bMin = v))}
          />
        </Section>

        <Section
          title={`3. 우선순위 배점 (현재 만점 ${prioMax}점)`}
          desc="지수 편입·외국인 수급 등 항목별 배점과 임계값."
        >
          <NumField
            label="지수 편입 배점"
            hint="KOSPI200 / KOSDAQ150 / KRX300"
            value={draft.priority.indexPoints}
            step={0.5}
            suffix="점"
            onChange={(v) => patch((d) => void (d.priority.indexPoints = v))}
          />
          <NumField
            label="외국인 60일 순매수 배점"
            value={draft.priority.foreignPoints}
            step={0.5}
            suffix="점"
            onChange={(v) => patch((d) => void (d.priority.foreignPoints = v))}
          />
          <NumField
            label="밸류업 편입 배점"
            value={draft.priority.valueUpPoints}
            step={0.5}
            suffix="점"
            onChange={(v) => patch((d) => void (d.priority.valueUpPoints = v))}
          />
          <NumField
            label="52주 신고가 근접 배점"
            value={draft.priority.nearHighPoints}
            step={0.5}
            suffix="점"
            onChange={(v) => patch((d) => void (d.priority.nearHighPoints = v))}
          />
          <NumField
            label="신고가 근접 기준"
            hint="52주 최고가 대비 허용 낙폭 (음수)"
            value={draft.priority.nearHighThresholdPercent}
            step={1}
            suffix="%"
            onChange={(v) => patch((d) => void (d.priority.nearHighThresholdPercent = v))}
          />
          <NumField
            label="규모 배점"
            value={draft.priority.sizePoints}
            step={0.5}
            suffix="점"
            onChange={(v) => patch((d) => void (d.priority.sizePoints = v))}
          />
          <NumField
            label="규모 기준 시가총액"
            hint={`현재 ${formatWon(draft.priority.minMarketCap)}`}
            value={draft.priority.minMarketCap / 100_000_000}
            step={500}
            suffix="억"
            onChange={(v) => patch((d) => void (d.priority.minMarketCap = v * 100_000_000))}
          />
          <NumField
            label="상대 성과 배점"
            value={draft.priority.relativePoints}
            step={0.5}
            suffix="점"
            onChange={(v) => patch((d) => void (d.priority.relativePoints = v))}
          />
          <NumField
            label="벤치마크 대비 초과수익 기준"
            value={draft.priority.excessReturnThresholdPp}
            step={0.5}
            suffix="%p"
            onChange={(v) => patch((d) => void (d.priority.excessReturnThresholdPp = v))}
          />
        </Section>

        <Section
          title="4. 실격 필터 (Universe Filter)"
          desc="이 기준에 미달하면 점수와 별개로 “실격”으로 표시됩니다. 데이터가 없는 기준은 미달로 처리하지 않습니다."
        >
          <NumField
            label="최소 주가"
            value={draft.universe.minPrice}
            step={500}
            suffix="원"
            onChange={(v) => patch((d) => void (d.universe.minPrice = v))}
          />
          <NumField
            label="최대 주가"
            value={draft.universe.maxPrice}
            step={10000}
            suffix="원"
            onChange={(v) => patch((d) => void (d.universe.maxPrice = v))}
          />
          <NumField
            label="최소 시가총액"
            hint={`현재 ${formatWon(draft.universe.minMarketCap)}`}
            value={draft.universe.minMarketCap / 100_000_000}
            step={500}
            suffix="억"
            onChange={(v) => patch((d) => void (d.universe.minMarketCap = v * 100_000_000))}
          />
          <NumField
            label="최소 당일 거래대금"
            hint={`현재 ${formatWon(draft.universe.minTradingValue)}`}
            value={draft.universe.minTradingValue / 100_000_000}
            step={5}
            suffix="억"
            onChange={(v) => patch((d) => void (d.universe.minTradingValue = v * 100_000_000))}
          />
          <NumField
            label="ETF 최소 순자산"
            hint={`현재 ${formatWon(draft.universe.etfMinAum)} · 토스 API 미제공이면 평가 제외`}
            value={draft.universe.etfMinAum / 100_000_000}
            step={100}
            suffix="억"
            onChange={(v) => patch((d) => void (d.universe.etfMinAum = v * 100_000_000))}
          />
          <NumField
            label="ETF 최소 20일 평균 거래대금"
            value={draft.universe.etfMinTradingValue20d / 100_000_000}
            step={1}
            suffix="억"
            onChange={(v) =>
              patch((d) => void (d.universe.etfMinTradingValue20d = v * 100_000_000))
            }
          />
          <NumField
            label="ETF 최대 괴리율"
            value={draft.universe.etfMaxPremiumDiscount}
            step={0.1}
            suffix="%"
            onChange={(v) => patch((d) => void (d.universe.etfMaxPremiumDiscount = v))}
          />
          <div className="flex items-center gap-2 pt-1">
            <Switch
              id="lev-ex"
              checked={draft.universe.excludeLeveragedInverse}
              onCheckedChange={(v) =>
                patch((d) => void (d.universe.excludeLeveragedInverse = v))
              }
            />
            <Label htmlFor="lev-ex" className="text-[12px]">
              레버리지·인버스 ETF 실격 처리
            </Label>
          </div>
        </Section>
      </div>

      <div className="sticky bottom-0 mt-4 flex flex-wrap items-center gap-2 border-t border-border bg-surface/95 py-3 backdrop-blur">
        <Button size="sm" onClick={apply} disabled={!dirty}>
          적용하고 다시 계산
        </Button>
        <Button size="sm" variant="outline" onClick={() => setDraft(saved)} disabled={!dirty}>
          편집 취소
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setDraft(DEFAULT_SCORING_CONFIG)}
        >
          기본값 불러오기
        </Button>
        <span className="text-[11px] text-muted-foreground">
          {dirty ? "저장되지 않은 변경이 있습니다." : "현재 설정이 스크리너에 적용되어 있습니다."}
        </span>
      </div>
    </AppShell>
  );
}
