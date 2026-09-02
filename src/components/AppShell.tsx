import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Info, Moon, Sun, TriangleAlert } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { analysisQueryOptions } from "@/lib/analysisQuery";

export interface AppShellSource {
  isLive: boolean;
  provider: string;
  notes: string[];
  fallbackReason: string | null;
}

const NAV = [
  { to: "/", label: "대시보드" },
  { to: "/screener/stocks", label: "주식 스크리너" },
  { to: "/screener/etfs", label: "ETF 스크리너" },
  { to: "/sectors", label: "섹터" },
  { to: "/position-sizing", label: "포지션 사이징" },
  { to: "/history", label: "스크리닝 이력" },
  { to: "/data-status", label: "데이터 상태" },
  { to: "/scoring", label: "산식·가중치" },
  { to: "/backtest", label: "백테스트" },
] as const;

function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  return (
    <button
      type="button"
      onClick={() => setDark((d) => !d)}
      aria-label="다크 모드 전환"
      className="inline-flex size-8 items-center justify-center rounded-md border border-border bg-surface text-muted-foreground transition-colors hover:text-foreground"
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}

export function AppShell({
  children,
  source,
  dataUnavailable = false,
  loadAnalysis = false,
}: {
  children: ReactNode;
  source?: AppShellSource;
  dataUnavailable?: boolean;
  loadAnalysis?: boolean;
}) {
  // 셸 자체는 외부 시세 API를 호출하지 않는다. 데이터가 필요한 화면의 명시적인
  // 쿼리만 실행해 정적 화면 진입이나 오류 화면에서 인증 요청이 반복되지 않게 한다.
  const { data } = useQuery({
    ...analysisQueryOptions,
    enabled: loadAnalysis && !source && !dataUnavailable,
  });
  const resolved: AppShellSource | undefined =
    source ??
    (data
      ? {
          isLive: data.analysis.isLive,
          provider: data.analysis.dataProvider,
          notes: data.analysis.notes,
          fallbackReason: data.source.fallbackReason,
        }
      : undefined);
  const live = resolved?.isLive ?? false;
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] flex-col gap-2 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <Link to="/" className="flex flex-col leading-tight">
              <span className="text-base font-bold tracking-tight">TrendScore KR</span>
              <span className="text-[11px] text-muted-foreground">
                한국 주식·ETF 중기 추세추종 스크리너
              </span>
            </Link>
          </div>
          <nav className="flex flex-wrap items-center gap-1">
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                activeOptions={{ exact: item.to === "/" }}
                className="rounded-md px-2.5 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[status=active]:bg-primary data-[status=active]:text-primary-foreground"
              >
                {item.label}
              </Link>
            ))}
            <ThemeToggle />
          </nav>
        </div>
        <div
          className={`flex items-start gap-2 border-t border-border px-4 py-1.5 text-[11px] text-foreground ${live ? "bg-surface-strong" : "bg-warn-soft"}`}
        >
          {live ? (
            <Info className="mt-0.5 size-3.5 shrink-0 text-primary" />
          ) : (
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" />
          )}
          <span>
            {dataUnavailable
              ? "실데이터 연결 오류 — 아래 안내에 따라 토스증권 API 접속 설정을 확인해 주세요."
              : live
              ? `실데이터 모드 (${resolved?.provider ?? "-"}) — 일봉 기준 계산이며 투자 판단 및 자동 주문 기능은 제공하지 않습니다.`
              : `합성 데이터 모드 (${resolved?.provider ?? "mock"}) — 화면 검증용 mock 데이터이며 실제 시세·재무가 아닙니다.${resolved?.fallbackReason ? ` 폴백 사유: ${resolved.fallbackReason}` : ""}`}
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-[1500px] px-4 py-6">{children}</main>
      <footer className="mx-auto max-w-[1500px] px-4 pb-10 text-[11px] leading-relaxed text-muted-foreground">
        본 서비스는 규칙 기반 스크리닝 결과와 계산 근거만 제공합니다. “관심 후보”, “리테스트 대기”,
        “관망”, “청산 점검” 등의 라벨은 매수·매도 권유가 아니며, 최종 판단과 책임은 이용자에게
        있습니다.
      </footer>
    </div>
  );
}
