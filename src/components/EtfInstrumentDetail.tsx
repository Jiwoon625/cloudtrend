import { AppShell } from "./AppShell";
import { Link } from "@tanstack/react-router";
import type { ScreeningRow } from "@/lib/engine/pipeline";
import { etfPartialEvidence } from "@/lib/etfPartialEvidence";
import { formatKstDateTime } from "@/lib/format";

export function EtfInstrumentDetail({
  row,
  calculatedAt,
  held,
  holdingsNotice,
}: {
  row: ScreeningRow;
  calculatedAt: string;
  held: boolean | undefined;
  holdingsNotice?: import("react").ReactNode;
}) {
  const s = row.etfStrategy;
  const evidence = etfPartialEvidence(row, row.snapshot.tradeDate);
  const value = (n: number | null | undefined) =>
    n === null || n === undefined || !Number.isFinite(n)
      ? "미관측"
      : n.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
  return (
    <AppShell>
      <header className="mb-4">
        <h1 className="text-xl font-bold">
          {row.instrument.name}{" "}
          <span className="text-sm font-normal text-muted-foreground">
            {row.instrument.symbol} · ETF
          </span>
        </h1>
        <p className="text-xs text-muted-foreground">
          기준일 {s?.date ?? row.snapshot.tradeDate} · {s?.version ?? "전략 기록 없음"} · 자료{" "}
          {s?.dataStatus ?? "미확인"}
        </p>
      </header>
      {holdingsNotice}
      <div className="space-y-4">
        <section className="rounded-lg border p-4">
          <h2 className="text-sm font-semibold">M0 총점</h2>
          <p className="text-3xl font-bold">
            {value(evidence.score)} <span className="text-sm">/ 100</span>
          </p>
          <p className="text-sm">
            {evidence.score !== null && s?.entryState === "confirmed"
              ? "진입 준비"
              : s?.rawOnset
                ? "원신호 · 확인 대기"
                : s?.entryState === "data_pending"
                  ? "자료 확인 대기"
                  : "관찰"}
          </p>
        </section>
        <section className="rounded-lg border p-4">
          <h2 className="mb-2 text-sm font-semibold">구성요소</h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {[
              ["기술", evidence.technical],
              ["우선", evidence.priority],
              ["건전성", evidence.health],
              ["환경", evidence.environment],
            ].map(([label, n]) => (
              <div key={String(label)}>
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="font-semibold">{value(n as number | null | undefined)}</p>
              </div>
            ))}
          </div>
        </section>
        <section className="rounded-lg border p-4">
          <h2 className="text-sm font-semibold">원신호 · 확인일</h2>
          <p className="mt-2 text-sm">
            원신호 {s?.originDate ?? "없음"} · 확인일{" "}
            {s?.confirmationDate ??
              (s?.entryState === "pending" ? "다음 정규 거래일 종가" : "없음")}
          </p>
          <p className="text-xs text-muted-foreground">{s?.confirmationIssues?.join(" · ")}</p>
        </section>
        <section className="rounded-lg border p-4">
          <h2 className="text-sm font-semibold">기초지수 MA60</h2>
          <p className="mt-2 text-sm">
            기초지수 {value(evidence.underlyingClose)} · MA60 {value(evidence.underlyingMa60)}
          </p>
        </section>
        <section className="rounded-lg border p-4">
          <h2 className="text-sm font-semibold">보유 시 행동</h2>
          <p className="mt-2 text-sm">
            {held === undefined
              ? "보유 확인 중"
              : !held
                ? "미보유"
                : s?.exit === "MA60"
                  ? "청산 준비"
                  : s?.exit === "DATA_UNAVAILABLE"
                    ? "자료 미관측 · 모델 청산 기록 확인"
                    : "보유 유지"}
          </p>
          <Link to="/portfolio" className="text-xs text-primary hover:underline">
            포트폴리오에서 보유·체결 확인
          </Link>
        </section>
        <details className="rounded-lg border p-4">
          <summary className="text-sm font-semibold">원자료</summary>
          <p className="my-2 text-xs">
            실제 계산시각 {formatKstDateTime(calculatedAt)} · KRX 기준일{" "}
            {s?.krxReferenceDate ?? "미관측"}
          </p>
          <pre className="overflow-auto text-xs">
            {JSON.stringify({ strategy: s, snapshot: row.snapshot }, null, 2)}
          </pre>
        </details>
      </div>
    </AppShell>
  );
}
