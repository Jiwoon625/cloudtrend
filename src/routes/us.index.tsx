import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Database, ExternalLink, ShieldCheck, TimerReset } from "lucide-react";
import type { ReactNode } from "react";

import { AppShell } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { loadUsProspectiveCache, loadUsScreeningHistory } from "@/lib/usProspectiveCloud";

export const Route = createFileRoute("/us/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "US 시장·데이터 | CloudTrend Prospective" },
      {
        name: "description",
        content:
          "Toss Open API 기반 미국주식 자료수집 상태와 A0 분기 실제운용, A2/B3 Shadow prospective OOS 규칙을 확인합니다.",
      },
    ],
  }),
  component: UsMarketDataPage,
});

const RULES = [
  ["Core", "ret120 rank 50% + ret252 rank 50% → 횡단면 재순위"],
  ["Primary Entry", "Core 0.80 Onset + beta60_spy 상위 10% + TK gap 상위 20% + 유동성 eligibility"],
  ["Primary Exit", "Core < 0.70 / universe 이탈"],
  ["A0 Portfolio", "동일 섹터 cap 없음 · 최대 20종목 · 분기 첫 거래일 비중조정 · 진입/청산은 매일"],
  ["Execution model", "다음 미국 정규장 시가 · 편도 25bp · ADV20 1% 참여율 · 정수 주식"],
] as const;

function fmtDate(value: string | undefined | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString("ko-KR", { hour12: false });
}

function UsMarketDataPage() {
  const cache = useQuery({ queryKey: ["us-prospective-cache"], queryFn: loadUsProspectiveCache, staleTime: 60_000 });
  const history = useQuery({ queryKey: ["us-screening-history"], queryFn: () => loadUsScreeningHistory(10), staleTime: 60_000 });
  const value = cache.data;

  return (
    <AppShell loadAnalysis={false}>
      <div className="space-y-5">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="mb-1 flex items-center gap-2">
              <h1 className="text-xl font-bold tracking-tight">US 시장 · 데이터</h1>
              <Badge variant="outline">Prospective OOS</Badge>
            </div>
            <p className="max-w-3xl text-[12px] leading-relaxed text-muted-foreground">
              과거 US3.8 이후 파라미터 탐색은 중단했습니다. 실제운용 기준은 A0 분기이며 A2 분기와 B3 Beta는 Shadow로 같은 미래 데이터를 누적합니다.
            </p>
          </div>
          <Link to="/us/screener"><Button size="sm">US 스크리너 보기</Button></Link>
        </header>

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric icon={<Database className="size-4" />} label="최근 데이터 기준일" value={value?.analysis.date ?? "미수집"} />
          <Metric icon={<TimerReset className="size-4" />} label="수집 완료 시각" value={fmtDate(value?.source.collectedAt)} />
          <Metric icon={<ShieldCheck className="size-4" />} label="룰 버전" value={value?.analysis.ruleVersion ?? "-"} />
          <Metric icon={<Database className="size-4" />} label="랭킹 가능 종목" value={value ? `${Number(value.analysis.summary.rankedRows ?? 0).toLocaleString()}종목` : "-"} />
        </section>

        <section className="rounded-lg border border-border bg-card p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold">현재 운용 규칙 · A0 분기</h2>
              <p className="text-[11px] text-muted-foreground">세부 숫자는 prospective 기간 동안 고정합니다.</p>
            </div>
            <Badge>PRIMARY</Badge>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {RULES.map(([label, description]) => (
              <div key={label} className="rounded-md border border-border bg-surface px-3 py-2">
                <p className="text-[11px] font-semibold">{label}</p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{description}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="grid gap-3 lg:grid-cols-3">
          <StrategyCard role="PRIMARY" title="A0 분기" detail="공격형 · sector cap 없음 · E80 Onset · X70 · 분기 리밸런싱" />
          <StrategyCard role="SHADOW" title="A2 분기" detail="A0와 동일 신호 · 동일 섹터 최대 2종목 · 분기 리밸런싱" />
          <StrategyCard role="SHADOW" title="B3 Beta 0.60×3" detail="균형형 · 동일 섹터 최대 3종목 · E80 · X50 + beta rank<0.60 3일" />
        </section>

        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">실제 자료수집 계약</h2>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Google Colab의 미국주식 전용 수집기가 Toss Open API를 호출하고, 계산에 필요한 원자 피처를 Supabase에 업로드합니다. 횡단면 순위와 Onset/Exit는 GitHub 엔진이 한 번만 계산합니다.
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <DataField title="가격" body="Adjusted 일봉 OHLCV, 현재가" />
            <DataField title="종목 마스터" body="시장·통화·상장상태·발행주식수·보통주 여부" />
            <DataField title="전략 피처" body="ret120/252, beta60, TK gap, relvol, ADV20, Amihud20" />
            <DataField title="시장 메타" body="US 캘린더, USD/KRW, Toss 랭킹 snapshot(진단용)" />
          </div>
          <p className="mt-3 text-[10px] text-muted-foreground">
            국내 전용 투자자매매·프로그램·공매도·신용·대차 데이터는 미국 전략 입력에 포함하지 않습니다.
          </p>
        </section>

        <section className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Prospective 누적 상태</h2>
            <Link to="/us/portfolio" className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline">
              US 포트폴리오 <ExternalLink className="size-3" />
            </Link>
          </div>
          <p className="mt-2 text-[12px] text-muted-foreground">
            저장된 스크리닝 일수: <span className="font-semibold text-foreground">{history.data?.length ?? 0}</span>
            {history.data?.[0]?.date ? ` · 최근 ${history.data[0].date}` : ""}
          </p>
        </section>
      </div>
    </AppShell>
  );
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return <div className="rounded-lg border border-border bg-card p-3"><div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">{icon}{label}</div><p className="mt-1 text-sm font-semibold">{value}</p></div>;
}
function StrategyCard({ role, title, detail }: { role: string; title: string; detail: string }) {
  return <div className="rounded-lg border border-border bg-card p-4"><Badge variant={role === "PRIMARY" ? "default" : "outline"}>{role}</Badge><h3 className="mt-2 text-sm font-semibold">{title}</h3><p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{detail}</p></div>;
}
function DataField({ title, body }: { title: string; body: string }) {
  return <div className="rounded-md bg-muted/40 px-3 py-2"><p className="text-[11px] font-medium">{title}</p><p className="mt-0.5 text-[10px] text-muted-foreground">{body}</p></div>;
}