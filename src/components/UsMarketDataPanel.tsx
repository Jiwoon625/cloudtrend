import { Link } from "@tanstack/react-router";
import { Database, ExternalLink, ShieldCheck, TimerReset } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { UsDataQualityPanel } from "@/components/UsDataQualityPanel";
import type { UsProspectiveSummary } from "@/lib/usBrowserViews";

const RULES = [
  ["Core", "ret120 순위 50% + ret252 순위 50% → 횡단면 재순위"],
  [
    "Primary Entry",
    "Core 상위 20% 신규진입 + Beta 상위 10% 이내 + TK gap 상위 20% 이내 + 유동성 eligibility",
  ],
  ["Primary Exit", "Core 상위 30% 밖 또는 Beta 상위 40% 밖 3거래일 연속 (Anchor) / universe 이탈"],
  [
    "A0 Portfolio",
    "동일 섹터 cap 없음 · 최대 20종목 · 초기자금 ÷ 목표 20종목 · 고정 매입 예산 · 진입/청산은 매일",
  ],
  ["Execution model", "다음 미국 정규장 시가 · 편도 25bp · ADV20 1% 참여율 · 정수 주식"],
] as const;

function fmtDate(value: string | undefined | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString("ko-KR", { hour12: false });
}

export function UsMarketDataPanel({
  value,
  historyCount,
  latestHistoryDate,
}: {
  value: UsProspectiveSummary | null;
  historyCount: number | null;
  latestHistoryDate?: string;
}) {
  return (
    <section id="us-data" className="min-w-0 scroll-mt-4 space-y-5" aria-label="미국 데이터 상세">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-bold tracking-tight">US 시장 · 데이터</h2>
            <Badge variant="outline">Prospective OOS</Badge>
          </div>
          <p className="max-w-3xl text-[12px] leading-relaxed text-muted-foreground">
            과거 US3.8 이후 파라미터 탐색은 중단했습니다. 실제운용 기준은 A0이며 A2와 B3 Beta는
            Shadow로 같은 미래 데이터를 누적합니다.
          </p>
        </div>
        <Link to="/us/screener">
          <Button size="sm">US 스크리너 보기</Button>
        </Link>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          icon={<Database className="size-4" />}
          label="최근 데이터 기준일"
          value={value?.analysis.date ?? "미확인"}
        />
        <Metric
          icon={<TimerReset className="size-4" />}
          label="수집 완료 시각"
          value={fmtDate(value?.source.collectedAt)}
        />
        <Metric
          icon={<ShieldCheck className="size-4" />}
          label="룰 버전"
          value={value?.analysis.ruleVersion ?? "-"}
        />
        <Metric
          icon={<Database className="size-4" />}
          label="랭킹 가능 종목"
          value={
            value?.analysis.summary["rankedRows"] == null
              ? "미확인"
              : `${value.analysis.summary["rankedRows"].toLocaleString()}종목`
          }
        />
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">최근 수집 · 신호 요약</h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <DataField title="데이터 공급자" body={value?.source.provider ?? "미확인"} />
          <DataField
            title="수집 종목 수 (SPY 포함)"
            body={value ? `${value.analysis.rowCount.toLocaleString()}종목` : "-"}
          />
          <DataField title="입력 형식" body={value?.source.schemaVersion ?? "-"} />
          <DataField
            title="최근 처리 상태"
            body={value ? "확정 종가 수집 · 엔진 저장 완료" : "자료 미확인"}
          />
        </div>
        <DataField title="엔진 결과 생성 시각" body={fmtDate(value?.generatedAt)} />
        <p className="mt-3 text-[10px] text-muted-foreground">원본 데이터 해시</p>
        <p className="break-all font-mono text-[10px]">{value?.dataHash ?? "-"}</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {(["a0", "a2", "b3"] as const).map((strategy) => (
            <DataField
              key={strategy}
              title={`${strategy.toUpperCase()} 신호`}
              body={
                value
                  ? `신규 진입 ${value.analysis.summary[`${strategy}Entries`] ?? "미확인"} · 청산 조건 ${value.analysis.summary[`${strategy}Exits`] ?? "미확인"}`
                  : "-"
              }
            />
          ))}
        </div>
        <p className="mt-2 text-[10px] text-muted-foreground">
          청산 조건 수는 전체 종목의 조건 충족 수이며 실제 매도 주문 수와 다릅니다. 첫 날짜는 순위만
          저장해 신규 진입을 만들지 않습니다.
        </p>
      </section>

      <UsDataQualityPanel value={value} />

      <section className="rounded-lg border border-border bg-card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">운용 규칙 · A0 · 2026-10-05부터</h2>
            <p className="text-[11px] text-muted-foreground">
              초기자금 ÷ 목표 20종목의 매입 예산을 고정합니다. 정기 비중조정·신규 진입 자금 마련용
              부분매도는 하지 않습니다. 2026-10-05 이전 모델 기록은 당시 규칙을 보존합니다.
            </p>
          </div>
          <Badge>PRIMARY</Badge>
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          {RULES.map(([label, description]) => (
            <div key={label} className="rounded-md border border-border bg-surface px-3 py-2">
              <p className="text-[11px] font-semibold">{label}</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                {description}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-3 lg:grid-cols-3">
        <StrategyCard
          role="PRIMARY"
          title="A0 · Anchor"
          detail="공격형 · sector cap 없음 · Core 상위 20% Onset · 상위 30% 밖 또는 Beta 상위 40% 밖 3거래일 · 고정 매입 예산"
        />
        <StrategyCard
          role="SHADOW"
          title="A2"
          detail="Core 상위 20% Onset / 상위 30% 밖 청산 · Anchor 미적용 · 동일 섹터 최대 2종목 · 고정 매입 예산"
        />
        <StrategyCard
          role="SHADOW"
          title="B3 Beta 상위 40% 밖×3"
          detail="균형형 · 동일 섹터 최대 3종목 · Core 상위 20% Onset · 상위 50% 밖 청산 + Beta 상위 40% 밖 3거래일"
        />
      </section>
      <p className="text-sm text-muted-foreground">
        A0·A2·B3의 모델 보유·성과·체결 기록은{" "}
        <Link to="/shadow" className="underline">
          통합 Shadow 탭
        </Link>
        에서 확인합니다.
      </p>

      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">실제 자료수집 계약</h2>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Google Colab의 미국주식 전용 수집기가 Toss Open API를 호출하고, 계산에 필요한 원자 피처를
          Supabase에 업로드합니다. 횡단면 순위와 Onset/Exit는 GitHub 엔진이 한 번만 계산합니다.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <DataField title="가격" body="Adjusted 일봉 OHLCV, 현재가" />
          <DataField title="종목 마스터" body="시장·통화·상장상태·발행주식수·보통주 여부" />
          <DataField title="전략 피처" body="ret120/252, beta60, TK gap, relvol, ADV20, Amihud20" />
          <DataField title="시장 메타" body="US 캘린더, USD/KRW, Toss 랭킹 snapshot(진단용)" />
        </div>
        <p className="mt-3 text-[10px] text-muted-foreground">
          국내 전용 투자자매매·프로그램·공매도·신용·대차 데이터는 미국 전략 입력에 포함하지
          않습니다.
        </p>
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Prospective 누적 상태</h2>
          <Link
            to="/portfolio"
            search={{ asset: "US" }}
            className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
          >
            포트폴리오 · 미국주식 <ExternalLink className="size-3" />
          </Link>
        </div>
        <p className="mt-2 text-[12px] text-muted-foreground">
          최근 조회된 스크리닝 일수:{" "}
          <span className="font-semibold text-foreground">
            {historyCount === null ? "확인 불가" : historyCount}
          </span>
          {latestHistoryDate ? ` · 최근 ${latestHistoryDate}` : ""}
        </p>
      </section>
    </section>
  );
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
        {icon}
        {label}
      </div>
      <p className="mt-1 text-sm font-semibold">{value}</p>
    </div>
  );
}
function StrategyCard({ role, title, detail }: { role: string; title: string; detail: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <Badge variant={role === "PRIMARY" ? "default" : "outline"}>{role}</Badge>
      <h3 className="mt-2 text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{detail}</p>
    </div>
  );
}
function DataField({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-md bg-muted/40 px-3 py-2">
      <p className="text-[11px] font-medium">{title}</p>
      <p className="mt-0.5 text-[10px] text-muted-foreground">{body}</p>
    </div>
  );
}
