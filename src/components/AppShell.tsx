import { Link } from "@tanstack/react-router";
import { Info, Moon, Sun, TriangleAlert } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

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
  { to: "/data-status", label: "데이터 상태" },
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
}: {
  children: ReactNode;
  source?: AppShellSource;
}) {
  const live = source?.isLive ?? false;
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
        <div className="flex items-center gap-2 border-t border-border bg-warn-soft px-4 py-1.5 text-[11px] text-foreground">
          <TriangleAlert className="size-3.5 shrink-0 text-warn" />
          <span>
            합성 데이터 모드 ({DATA_PROVIDER}) — 화면 검증용 mock 데이터이며 실제 시세·재무가
            아닙니다. 투자 판단 및 자동 주문 기능은 제공하지 않습니다.
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
