import { useState } from "react";

import { ScreenerTable } from "@/components/ScreenerTable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useSuspenseQuery } from "@tanstack/react-query";

import { analysisQueryOptions } from "@/lib/analysisQuery";
import type { ScreeningRow } from "@/lib/engine/pipeline";

type Mode = "STOCK" | "ETF";

type PresetId =
  | "CORE"
  | "GRADE_A"
  | "GRADE_B"
  | "VOLUME"
  | "NEAR_HIGH"
  | "FOREIGN"
  | "VALUEUP"
  | "HEAD_FAKE"
  | "EXIT";

const PRESETS: Array<{ id: PresetId; label: string; test: (r: ScreeningRow) => boolean }> = [
  { id: "CORE", label: "Core 후보", test: (r) => r.grade !== "C" && r.hardFilterPassed },
  { id: "GRADE_A", label: "A등급", test: (r) => r.grade === "A" },
  { id: "GRADE_B", label: "B등급 리테스트 대기", test: (r) => r.grade === "B" },
  { id: "VOLUME", label: "거래량 폭발", test: (r) => (r.snapshot.volumeRatio20 ?? 0) >= 200 },
  {
    id: "NEAR_HIGH",
    label: "신고가 근접",
    test: (r) => (r.snapshot.distanceFrom52wHigh ?? -100) >= -10,
  },
  {
    id: "FOREIGN",
    label: "외국인 수급 우수",
    test: (r) => (r.snapshot.foreignNet60d ?? -1) > 0,
  },
  {
    id: "VALUEUP",
    label: "밸류업",
    test: (r) => r.instrument.indexMemberships.includes("KOREA_VALUEUP"),
  },
  { id: "HEAD_FAKE", label: "Head Fake 경고", test: (r) => r.warnings.includes("HEAD_FAKE") },
  { id: "EXIT", label: "청산 점검", test: (r) => r.warnings.includes("EXIT_TRIGGER") },
];

export function ScreenerView({ mode }: { mode: Mode }) {
  const { data } = useSuspenseQuery(analysisQueryOptions);
  const analysis = data.analysis;
  const [query, setQuery] = useState("");
  const [minTechnical, setMinTechnical] = useState(0);
  const [minTotal, setMinTotal] = useState(0);
  const [minVolumeRatio, setMinVolumeRatio] = useState(0);
  const [sector, setSector] = useState("ALL");
  const [showDisqualified, setShowDisqualified] = useState(true);
  const [includeLeveraged, setIncludeLeveraged] = useState(true);
  const [preset, setPreset] = useState<PresetId | null>(null);
  const [savedPresets, setSavedPresets] = useState<
    Array<{
      name: string;
      state: {
        query: string;
        minTechnical: number;
        minTotal: number;
        minVolumeRatio: number;
        sector: string;
        showDisqualified: boolean;
      };
    }>
  >([]);

  const base = analysis.rows.filter((r) => r.instrument.instrumentType === mode);
  const sectors = [...new Set(base.map((r) => r.instrument.sectorName))];

  const filtered = base.filter((r) => {
    if (!showDisqualified && !r.hardFilterPassed) return false;
    if (mode === "ETF" && !includeLeveraged && (r.instrument.isLeveraged || r.instrument.isInverse))
      return false;
    if (query) {
      const q = query.trim().toLowerCase();
      if (
        !r.instrument.name.toLowerCase().includes(q) &&
        !r.instrument.symbol.includes(q)
      )
        return false;
    }
    if (sector !== "ALL" && r.instrument.sectorName !== sector) return false;
    if (r.technical.points < minTechnical) return false;
    if (r.totalScoreNormalized < minTotal) return false;
    if ((r.snapshot.volumeRatio20 ?? 0) < minVolumeRatio) return false;
    if (preset) {
      const p = PRESETS.find((x) => x.id === preset)!;
      if (!p.test(r)) return false;
    }
    return true;
  });

  const numberField = (
    label: string,
    value: number,
    onChange: (v: number) => void,
    step = 1,
  ) => (
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
            기준일 {analysis.asOfDate} · 시장 게이트{" "}
            {analysis.marketGate.status === "RISK_ON"
              ? "Risk-On"
              : analysis.marketGate.status === "NEUTRAL"
                ? "Neutral"
                : "Risk-Off"}{" "}
            ({analysis.marketGate.metCount}/4)
          </p>
          <p className="text-[12px] text-muted-foreground">
            분석 종목 {base.length}건 중 <span className="text-foreground">{filtered.length}건</span>{" "}
            표시 · 통과 {base.filter((r) => r.hardFilterPassed).length}건 / 실격{" "}
            {base.filter((r) => !r.hardFilterPassed).length}건
          </p>
        </div>
      </header>

      <div className="flex flex-wrap gap-1">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setPreset(preset === p.id ? null : p.id)}
            className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${preset === p.id ? "border-primary bg-primary text-primary-foreground" : "border-border bg-surface hover:bg-accent"}`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-2 lg:grid-cols-6">
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
        {numberField("기술점수 최소 (0~7)", minTechnical, setMinTechnical)}
        {numberField("종합점수 최소", minTotal, setMinTotal, 5)}
        {numberField("거래량 비율 최소(%)", minVolumeRatio, setMinVolumeRatio, 10)}
        <div className="flex items-center gap-2 lg:col-span-2">
          <Switch
            id="disq"
            checked={showDisqualified}
            onCheckedChange={setShowDisqualified}
          />
          <Label htmlFor="disq" className="text-[12px]">
            실격 종목 보기 (사유 표시)
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
        <div className="flex items-end gap-2 lg:col-span-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setSavedPresets((prev) => [
                ...prev,
                {
                  name: `내 프리셋 ${prev.length + 1}`,
                  state: { query, minTechnical, minTotal, minVolumeRatio, sector, showDisqualified },
                },
              ])
            }
          >
            현재 필터 저장
          </Button>
          {savedPresets.map((p) => (
            <button
              key={p.name}
              type="button"
              className="rounded border border-border px-2 py-1 text-[11px] hover:bg-accent"
              onClick={() => {
                setQuery(p.state.query);
                setMinTechnical(p.state.minTechnical);
                setMinTotal(p.state.minTotal);
                setMinVolumeRatio(p.state.minVolumeRatio);
                setSector(p.state.sector);
                setShowDisqualified(p.state.showDisqualified);
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>

      <ScreenerTable rows={filtered} />
    </div>
  );
}
