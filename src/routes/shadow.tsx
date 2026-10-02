import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { KospiShadowPanel } from "@/components/KospiShadowPanel";
import { UsPortfolioView } from "@/components/UsPortfolioView";
export const Route = createFileRoute("/shadow")({
  ssr: false,
  head: () => ({ meta: [{ title: "Shadow 연구 관찰 | CloudTrend" }] }),
  component: ShadowPage,
});
export function ShadowPage() {
  const [model, setModel] = useState("KOSPI"),
    [fromDate, setFromDate] = useState(""),
    [toDate, setToDate] = useState("");
  const invalid = !!fromDate && !!toDate && fromDate > toDate;
  return (
    <AppShell loadAnalysis={false}>
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-bold">Shadow · 연구 관찰</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            한국·미국 Shadow를 한 곳에서 관리합니다. 실제 포트폴리오와 분리된 모델 기록이며 KRW와
            USD 금액을 합산하지 않습니다.
          </p>
        </header>
        <div className="grid min-w-0 items-end gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
          <label className="min-w-0 text-sm">
            Shadow 모델
            <select
              aria-label="Shadow 모델"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="mt-1 block w-full min-w-0 max-w-full rounded border bg-background p-2"
            >
              <option value="KOSPI">KOSPI 하루확인·불황 시 RSAccel 필터 · KRW</option>
              <option value="A2_QUARTER_SHADOW">미국 A2 분기 · USD</option>
              <option value="B3_BETA_SHADOW">미국 B3 Beta · USD</option>
            </select>
          </label>
          <label className="min-w-0 text-sm">
            시작일
            <input
              aria-label="시작일"
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="mt-1 block w-full min-w-0 max-w-full rounded border bg-background p-2"
            />
          </label>
          <label className="min-w-0 text-sm">
            종료일
            <input
              aria-label="종료일"
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="mt-1 block w-full min-w-0 max-w-full rounded border bg-background p-2"
            />
          </label>
          <button
            className="rounded border px-3 py-2 text-sm"
            onClick={() => {
              setFromDate("");
              setToDate("");
            }}
          >
            전체 기간
          </button>
        </div>
        {invalid ? (
          <p role="alert">종료일은 시작일 이후여야 합니다.</p>
        ) : model === "KOSPI" ? (
          <KospiShadowPanel fromDate={fromDate} toDate={toDate} />
        ) : (
          <UsPortfolioView
            key={model}
            shadowStrategyId={model as "A2_QUARTER_SHADOW" | "B3_BETA_SHADOW"}
            fromDate={fromDate}
            toDate={toDate}
          />
        )}
      </div>
    </AppShell>
  );
}
