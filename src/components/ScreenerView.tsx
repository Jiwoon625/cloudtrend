import { HoldingsAvailability } from "./HoldingsAvailability";
import { kospiMarketGateDisplay, kospiMarketGateLabel } from "./kospiEntryPresentation";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { PdfExportButton } from "@/components/PdfExportButton";
import { ScreenerTable } from "@/components/ScreenerTable";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { AnalysisResult, ScreeningRow } from "@/lib/engine/pipeline";

type Mode = "STOCK" | "ETF";

import { stockAssessmentDisplay } from "@/lib/stockAssessmentDisplay";
import { isOperationalEntry } from "@/lib/engine/operationalStrategy";
import { loadDomesticPositionContext } from "@/lib/portfolioPositionContext";
import { isOnsetSuppressed } from "@/lib/positionSignalContext";
import { isPortfolioAwareOperationalEntry, isHeldExit } from "@/lib/statusDisplay";

type PresetId =
  | "TECHNICAL_ONSET"
  | "ENTRY"
  | "KOSDAQ_ENTRY_8"
  | "CORE"
  | "GRADE_A"
  | "GRADE_B"
  | "VOLUME"
  | "NEAR_HIGH"
  | "FOREIGN"
  | "VALUEUP"
  | "HEAD_FAKE"
  | "KOSPI_ENTRY_8"
  | "KOSPI_PENDING"
  | "KOSPI_CONFIRMED"
  | "JUDGMENT_PENDING"
  | "EXIT";

const PRESETS: Array<{ id: PresetId; label: string; test: (r: ScreeningRow) => boolean }> = [
  { id: "TECHNICAL_ONSET", label: "원신호", test: () => false },
  { id: "KOSPI_PENDING", label: "확인 대기", test: () => false },
  { id: "ENTRY", label: "진입 준비", test: isOperationalEntry },
  { id: "EXIT", label: "보유 청산", test: () => false },
  {
    id: "JUDGMENT_PENDING",
    label: "자료 판단 보류",
    test: (r) => r.hardFilterStatus === "PENDING",
  },
];

export function ScreenerView({ mode, analysis }: { mode: Mode; analysis: AnalysisResult }) {
  const positions = useQuery({
    queryKey: ["domestic-position-context"],
    queryFn: loadDomesticPositionContext,
    enabled: mode === "STOCK",
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const positionContext = positions.isSuccess ? positions.data : undefined;
  const [query, setQuery] = useState("");
  const [minTechnical, setMinTechnical] = useState(0);
  const [minVolumeRatio, setMinVolumeRatio] = useState(0);
  const [sector, setSector] = useState("ALL");
  const [showDisqualified, setShowDisqualified] = useState(true);
  const [includeLeveraged, setIncludeLeveraged] = useState(true);
  const [preset, setPreset] = useState<PresetId | null>(null);

  const gate =
    mode === "STOCK"
      ? kospiMarketGateDisplay(analysis.kospiMarketGate, analysis.asOfDate)
      : analysis.marketGate;
  const base = analysis.rows.filter((r) => r.instrument.instrumentType === mode);
  const sectors = [...new Set(base.map((r) => r.instrument.sectorName))];
  const presetMatches = (r: ScreeningRow, id: PresetId) => {
    if (mode === "STOCK") {
      if (id === "EXIT") return isHeldExit(r, positionContext);
      if (id === "TECHNICAL_ONSET")
        return stockAssessmentDisplay(r, analysis.asOfDate, analysis.tradeDates).rawOnset === true;
      if (
        r.hardFilterStatus &&
        r.hardFilterStatus !== "PASS" &&
        (id === "KOSDAQ_ENTRY_8" || id === "KOSPI_PENDING")
      )
        return false;
      if (id === "ENTRY")
        return isPortfolioAwareOperationalEntry(r, positionContext, analysis.asOfDate);
      if (id === "KOSDAQ_ENTRY_8")
        return (
          r.kosdaq80Onset &&
          !isOnsetSuppressed(positionContext, r.instrument.symbol, analysis.asOfDate)
        );
      if (id === "KOSPI_ENTRY_8")
        return (
          r.kospi80Onset &&
          !isOnsetSuppressed(positionContext, r.instrument.symbol, analysis.asOfDate)
        );
      if (id === "KOSPI_PENDING")
        return (
          r.instrument.market === "KOSPI" &&
          r.kospiEntry?.state === "pending" &&
          r.kospiEntry.date === analysis.asOfDate &&
          !isOnsetSuppressed(
            positionContext,
            r.instrument.symbol,
            r.kospiEntry.originDate ?? analysis.asOfDate,
          )
        );
      if (id === "KOSPI_CONFIRMED")
        return (
          r.instrument.market === "KOSPI" &&
          isPortfolioAwareOperationalEntry(r, positionContext, analysis.asOfDate)
        );
    }
    return PRESETS.find((presetItem) => presetItem.id === id)!.test(r);
  };

  const filtered = base.filter((r) => {
    if (!showDisqualified && !r.hardFilterPassed && r.hardFilterStatus !== "PENDING") return false;
    if (mode === "ETF" && !includeLeveraged && (r.instrument.isLeveraged || r.instrument.isInverse))
      return false;
    if (query) {
      const q = query.trim().toLowerCase();
      if (!r.instrument.name.toLowerCase().includes(q) && !r.instrument.symbol.includes(q))
        return false;
    }
    if (sector !== "ALL" && r.instrument.sectorName !== sector) return false;
    const technicalScore =
      r.instrument.instrumentType === "STOCK" ? r.operatingScore10 : (r.vf ?? r.technical).points;
    if (minTechnical > 0 && (technicalScore === null || technicalScore < minTechnical))
      return false;
    if ((r.snapshot.volumeRatio20 ?? 0) < minVolumeRatio) return false;
    if (preset) {
      if (!presetMatches(r, preset)) return false;
    }
    return true;
  });

  const numberField = (label: string, value: number, onChange: (v: number) => void, step = 1) => (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        className="h-8 text-right text-[12px]"
      />
    </div>
  );

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold tracking-tight">
            {mode === "STOCK" ? "주식 스크리너" : "ETF 스크리너"}
          </h1>
          <p className="text-[12px] text-muted-foreground">
            기준일 {analysis.asOfDate} · 전략 {analysis.strategyVersion} ·{" "}
            {mode === "STOCK" ? "KOSPI 신규진입 시장국면" : "시장 게이트"}{" "}
            {mode === "STOCK"
              ? kospiMarketGateLabel(gate.status)
              : gate.status === "RISK_ON"
                ? "Risk-On"
                : gate.status === "NEUTRAL"
                  ? "Neutral"
                  : "Risk-Off"}{" "}
            ({gate.metCount}/4)
            {mode === "STOCK" && (gate.status === "RISK_OFF" || gate.status === "UNKNOWN")
              ? " · KOSPI 신규 진입 제외"
              : ""}
          </p>
          <p className="text-[12px] text-muted-foreground">
            분석 종목 {base.length}건 중{" "}
            <span className="text-foreground">{filtered.length}건</span> 표시 · 통과{" "}
            {base.filter((r) => r.hardFilterPassed).length}건 / 실격{" "}
            {base.filter((r) => !r.hardFilterPassed && r.hardFilterStatus !== "PENDING").length}건 /
            판단 보류 {base.filter((r) => r.hardFilterStatus === "PENDING").length}건
          </p>
        </div>
        <PdfExportButton
          documentTitle={`CloudTrend ${mode === "STOCK" ? "주식" : "ETF"} 스크리너 ${analysis.asOfDate}`}
        />
      </header>

      {mode === "STOCK" ? (
        <>
          <p className="text-[12px] text-muted-foreground">
            KRX 기준일 자료는 다음 영업일 08:00 KST부터 조회 가능합니다. 저녁에는 계산된 기술 신호와
            최종 판단을 구분합니다. 조건별 근거와 상세 지표는 종목명을 눌러 확인하세요.
          </p>
        </>
      ) : null}
      {mode === "STOCK" ? (
        <HoldingsAvailability
          ready={positions.isSuccess}
          failed={positions.isError}
          retry={positions.refetch}
        />
      ) : null}
      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          onClick={() => setPreset(null)}
          className="rounded-full border px-2.5 py-1 text-[11px]"
        >
          전체
        </button>
        {PRESETS.map((p) => (
          <button
            key={p.id}
            disabled={p.id === "EXIT" && !positions.isSuccess}
            type="button"
            onClick={() => setPreset(preset === p.id ? null : p.id)}
            className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${preset === p.id ? "border-primary bg-primary text-primary-foreground" : "border-border bg-surface hover:bg-accent"}`}
          >
            {p.label} (
            {p.id === "EXIT" && !positions.isSuccess
              ? "미확인"
              : base.filter((r) => presetMatches(r, p.id)).length}
            )
          </button>
        ))}
      </div>

      <div className="grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-2 lg:grid-cols-5">
        <div className="space-y-1 lg:col-span-2">
          <Label className="text-[11px] text-muted-foreground">종목명 또는 코드</Label>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="예: 삼성전자 / 005930"
            className="h-8 text-[12px]"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">섹터</Label>
          <select
            value={sector}
            onChange={(e) => setSector(e.target.value)}
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-[12px]"
          >
            <option value="ALL">전체</option>
            {sectors.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        {numberField("기술점수 최소", minTechnical, setMinTechnical, 0.5)}
        {numberField("거래량 비율 최소(%)", minVolumeRatio, setMinVolumeRatio, 10)}
        <div className="flex items-center gap-2 lg:col-span-2">
          <Switch id="disq" checked={showDisqualified} onCheckedChange={setShowDisqualified} />
          <Label htmlFor="disq" className="text-[12px]">
            실격 종목 보기 (판단 보류는 계속 표시)
          </Label>
        </div>
        {mode === "ETF" ? (
          <div className="flex items-center gap-2 lg:col-span-2">
            <Switch id="lev" checked={includeLeveraged} onCheckedChange={setIncludeLeveraged} />
            <Label htmlFor="lev" className="text-[12px]">
              레버리지·인버스 포함
            </Label>
          </div>
        ) : null}
      </div>

      {preset === "EXIT" && !positions.isSuccess ? (
        <p role="status" className="text-xs">
          보유 조회가 완료되면 청산 목록을 표시합니다.
        </p>
      ) : (
        <ScreenerTable
          paginationKey={JSON.stringify([
            mode,
            query,
            minTechnical,
            minVolumeRatio,
            sector,
            showDisqualified,
            includeLeveraged,
            preset,
            analysis.asOfDate,
          ])}
          rows={filtered}
          positionContext={positionContext}
          signalDate={analysis.asOfDate}
          tradeDates={analysis.tradeDates}
          compactStock={mode === "STOCK"}
        />
      )}
      <details className="rounded-lg border p-3 text-sm">
        <summary>운영규칙·산식</summary>
        <Link to="/operating-rules" className="text-primary">
          운영규칙에서 시장별 채택 기준 확인
        </Link>
      </details>
    </div>
  );
}
