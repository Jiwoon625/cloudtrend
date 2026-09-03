import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useMemo, useState } from "react";

import { AppShell } from "@/components/AppShell";
import { UsDisclaimer } from "@/components/us/UsDisclaimer";
import { toCsv, UsScreenerTable } from "@/components/us/UsScreenerTable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { US_SECTOR_ETFS } from "@/lib/engine/usDataset";
import type { UsAnalysisResult, UsRow } from "@/lib/engine/usPipeline";
import { isUsAnalysisPayload, usAnalysisQueryOptions } from "@/lib/usAnalysisQuery";

export const Route = createFileRoute("/us/screener")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "US 스크리너 | 미국 주식·ETF 후보 우선도 필터" },
      {
        name: "description",
        content:
          "미국 주식과 ETF를 Technical 7, Priority 10, ETF Health, coverage 기준으로 필터링하고 결과를 CSV로 내보내는 스크리너입니다.",
      },
      { property: "og:title", content: "US 스크리너 | TrendScore US" },
      {
        property: "og:description",
        content: "Stock/ETF 탭, 섹터·점수·데이터 상태 필터, CSV 내보내기를 제공합니다.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: UsScreenerPage,
});

type Tab = "STOCK" | "ETF";

const PRESETS: Array<{ id: string; label: string; test: (r: UsRow) => boolean }> = [
  {
    id: "CORE",
    label: "핵심 후보 (표시등급 S·A)",
    test: (r) => r.displayGrade === "S" || r.displayGrade === "A",
  },
  { id: "TECH6", label: "Technical 6점 이상", test: (r) => r.technical.points >= 6 },
  {
    id: "NEAR_HIGH",
    label: "52주 고가 5% 이내",
    test: (r) => (r.snapshot.distanceFrom252High ?? -100) >= -5,
  },
  { id: "RS", label: "6M SPY 초과수익 양수", test: (r) => (r.snapshot.return126 ?? -1) > 0 },
  { id: "COMPLETE", label: "coverage 90% 이상", test: (r) => r.dataStatus === "COMPLETE" },
  {
    id: "TACTICAL",
    label: "레버리지·인버스만",
    test: (r) => r.eligibility.status === "TACTICAL_ONLY",
  },
];

function UsScreenerPage() {
  const query = useQuery(usAnalysisQueryOptions);
  const payload = isUsAnalysisPayload(query.data) ? query.data : null;

  return (
    <AppShell loadAnalysis={false}>
      {payload ? (
        <ScreenerBody analysis={payload.analysis} />
      ) : (
        <section className="rounded-lg border border-dashed border-border bg-card p-10 text-center">
          <h1 className="mb-1 text-lg font-semibold">먼저 US 스크리닝을 실행해 주세요</h1>
          <p className="mx-auto mb-4 max-w-md text-[12px] text-muted-foreground">
            미국 시장 입력 데이터를 업로드하고 “US 스크리닝 시작”을 누르면 이 화면이 채워집니다.
          </p>
          <Link to="/us">
            <Button size="sm">US 데이터 입력으로 이동</Button>
          </Link>
        </section>
      )}
      <UsDisclaimer />
    </AppShell>
  );
}

function ScreenerBody({ analysis }: { analysis: UsAnalysisResult }) {
  const [tab, setTab] = useState<Tab>("STOCK");
  const [query, setQuery] = useState("");
  const [sector, setSector] = useState("ALL");
  const [minComposite, setMinComposite] = useState(0);
  const [minTechnical, setMinTechnical] = useState(0);
  const [minCoverage, setMinCoverage] = useState(0);
  const [onlyEligible, setOnlyEligible] = useState(false);
  const [includeTactical, setIncludeTactical] = useState(true);
  const [preset, setPreset] = useState<string | null>(null);

  const base = analysis.rows.filter((r) => r.instrument.assetType === tab);
  const rows = useMemo(() => {
    const q = query.trim().toUpperCase();
    return base.filter((r) => {
      if (onlyEligible && r.eligibility.status !== "ELIGIBLE") return false;
      if (!includeTactical && r.eligibility.status === "TACTICAL_ONLY") return false;
      if (q && !r.instrument.symbol.includes(q) && !r.instrument.name.toUpperCase().includes(q))
        return false;
      if (sector !== "ALL" && r.instrument.sector !== sector) return false;
      if (r.rawComposite < minComposite) return false;
      if (r.technical.points < minTechnical) return false;
      if (r.coverage * 100 < minCoverage) return false;
      if (preset) {
        const p = PRESETS.find((x) => x.id === preset);
        if (p && !p.test(r)) return false;
      }
      return true;
    });
  }, [
    base,
    query,
    sector,
    minComposite,
    minTechnical,
    minCoverage,
    onlyEligible,
    includeTactical,
    preset,
  ]);

  const download = () => {
    const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `trendscore-us-${tab.toLowerCase()}-${analysis.asOfDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

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
          <h1 className="text-xl font-bold tracking-tight">US 스크리너</h1>
          <p className="text-[12px] text-muted-foreground">
            기준일 {analysis.asOfDate} · 시장 상태{" "}
            {analysis.market.state === "RISK_ON"
              ? "Risk-On"
              : analysis.market.state === "NEUTRAL"
                ? "Neutral"
                : "Risk-Off"}{" "}
            (표시등급 상한 {analysis.market.displayGradeCap}) · ruleVersion {analysis.ruleVersion}
          </p>
          <p className="text-[12px] text-muted-foreground">
            {tab === "STOCK" ? "주식" : "ETF"} {base.length}건 중{" "}
            <span className="text-foreground">{rows.length}건</span> 표시
          </p>
        </div>
        <Button size="sm" variant="outline" className="gap-1.5" onClick={download}>
          <Download className="size-3.5" />
          CSV 내보내기
        </Button>
      </header>

      <div className="flex gap-1">
        {(["STOCK", "ETF"] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded-md border px-3 py-1.5 text-[12px] font-medium transition-colors ${
              tab === t
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-surface hover:bg-accent"
            }`}
          >
            {t === "STOCK" ? "Stock" : "ETF"}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setPreset(preset === p.id ? null : p.id)}
            className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
              preset === p.id
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-surface hover:bg-accent"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-2 lg:grid-cols-6">
        <div className="space-y-1 lg:col-span-2">
          <Label className="text-[11px] text-muted-foreground">티커 또는 종목명</Label>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="예: AAPL / Apple"
            className="h-8 text-[12px]"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">GICS 섹터</Label>
          <select
            value={sector}
            onChange={(e) => setSector(e.target.value)}
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-[12px]"
          >
            <option value="ALL">전체</option>
            {US_SECTOR_ETFS.map((s) => (
              <option key={s.sector} value={s.sector}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        {numberField("Composite 최소", minComposite, setMinComposite, 5)}
        {numberField("Technical 최소 (0~7)", minTechnical, setMinTechnical)}
        {numberField("coverage 최소(%)", minCoverage, setMinCoverage, 10)}
        <div className="flex items-center gap-2 lg:col-span-2">
          <Switch id="eligible" checked={onlyEligible} onCheckedChange={setOnlyEligible} />
          <Label htmlFor="eligible" className="text-[12px]">
            ELIGIBLE 종목만 보기
          </Label>
        </div>
        {tab === "ETF" ? (
          <div className="flex items-center gap-2 lg:col-span-2">
            <Switch id="tactical" checked={includeTactical} onCheckedChange={setIncludeTactical} />
            <Label htmlFor="tactical" className="text-[12px]">
              레버리지·인버스(TACTICAL_ONLY) 포함
            </Label>
          </div>
        ) : null}
      </div>

      <UsScreenerTable rows={rows} />
    </div>
  );
}
