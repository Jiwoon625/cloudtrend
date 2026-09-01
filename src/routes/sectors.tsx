import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { AppShell } from "@/components/AppShell";
import { DataError } from "@/components/DataError";
import { Delta } from "@/components/ScreenerTable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { analysisQueryOptions } from "@/lib/analysisQuery";
import { formatKstDateTime, formatNumber } from "@/lib/format";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  CONFIDENCE_LABEL,
  FLOW_STATUS_LABEL,
  QUADRANT_LABEL,
  type FlowStatus,
  type RotationLink,
  type SectorRotationRow,
  type SectorTimeline,
} from "@/lib/engine/sectorRotation";

export const Route = createFileRoute("/sectors")({
  // 외부 시세 API 실패 시 SSR 500(빈 화면) 대신 클라이언트 에러 화면을 보여준다.
  ssr: false,
  head: () => ({
    meta: [
      { title: "섹터 로테이션 엔진 | TrendScore KR" },
      {
        name: "description",
        content:
          "가격 리더십과 실제 자금흐름을 분리 계산해 어느 섹터로 자금이 유입·유출되는지, 시장 전체 유입인지 섹터 순환매인지 신뢰도와 함께 추적합니다.",
      },
      { property: "og:title", content: "섹터 로테이션 엔진 | TrendScore KR" },
      {
        property: "og:description",
        content: "외국인·기관 수급, 거래대금 점유율, 상대강도를 결합한 섹터 자금 유입·유출 분석.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(analysisQueryOptions),
  errorComponent: ({ error, reset }) => <DataError error={error} reset={reset} />,
  component: SectorsPage,
});

// ───────── 표시 유틸 ─────────
const eok = (v: number | null | undefined): string =>
  v === null || v === undefined || !Number.isFinite(v)
    ? "데이터 없음"
    : `${(v / 100_000_000).toLocaleString("ko-KR", { maximumFractionDigits: 0 })}억`;

const pct = (v: number | null | undefined, digits = 1): string =>
  v === null || v === undefined || !Number.isFinite(v) ? "-" : `${v.toFixed(digits)}%`;

const pp = (v: number | null | undefined, digits = 2): string =>
  v === null || v === undefined || !Number.isFinite(v)
    ? "-"
    : `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%p`;

const scoreText = (v: number | null): string => (v === null ? "판단 보류" : v.toFixed(1));

const STATUS_CLASS: Record<FlowStatus, string> = {
  STRONG_INFLOW: "bg-up-soft text-up",
  SUSTAINED_INFLOW: "bg-up-soft text-up",
  EARLY_INFLOW: "bg-up-soft text-up",
  OVERHEATED: "bg-warn-soft text-warn",
  NEUTRAL: "bg-surface-strong text-muted-foreground",
  EARLY_OUTFLOW: "bg-down-soft text-down",
  SUSTAINED_OUTFLOW: "bg-down-soft text-down",
  CAPITULATION: "bg-down-soft text-down",
  INSUFFICIENT_DATA: "bg-surface-strong text-muted-foreground",
};

const RELIABILITY_LABEL: Record<SectorRotationRow["reliabilityTag"], string> = {
  HIGH: "높은 신뢰도",
  MEDIUM: "보통",
  CAUTION: "주의",
  LIMITED: "판단 제한",
};

function Card({
  title,
  value,
  sub,
  tone,
}: {
  title: string;
  value: string;
  sub?: string | undefined;
  tone?: "up" | "down" | "warn" | undefined;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="text-[11px] text-muted-foreground">{title}</p>
      <p
        className={`mt-0.5 text-[13px] font-semibold ${
          tone === "up" ? "text-up" : tone === "down" ? "text-down" : tone === "warn" ? "text-warn" : ""
        }`}
      >
        {value}
      </p>
      {sub ? <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

function HeatCell({ value, format }: { value: number | null; format: (v: number) => string }) {
  if (value === null || !Number.isFinite(value))
    return <td className="px-2 py-1 text-center text-[11px] text-muted-foreground">데이터 없음</td>;
  const tone =
    value > 0
      ? "bg-up-soft text-up"
      : value < 0
        ? "bg-down-soft text-down"
        : "bg-surface-strong text-muted-foreground";
  return <td className={`num px-2 py-1 text-right text-[11px] ${tone}`}>{format(value)}</td>;
}

type SortKey =
  | "rank"
  | "rotationScore"
  | "price"
  | "flow"
  | "momentum"
  | "foreign5"
  | "inst5"
  | "share"
  | "shareChange"
  | "reliability";

function SectorsPage() {
  const { data } = useSuspenseQuery(analysisQueryOptions);
  const analysis = data.analysis;
  const rot = analysis.sectorRotation;

  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "INFLOW" | "OUTFLOW" | "NEUTRAL">("ALL");
  const [minReliability, setMinReliability] = useState(0);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "rank",
    dir: "asc",
  });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [openLink, setOpenLink] = useState<number | null>(null);

  const rows = useMemo(() => {
    const src = rot?.sectors ?? [];
    const filtered = src.filter((r) => {
      if (query && !r.sectorName.includes(query) && !r.sectorCode.includes(query.toUpperCase()))
        return false;
      if (r.reliability < minReliability) return false;
      if (statusFilter === "INFLOW")
        return ["STRONG_INFLOW", "EARLY_INFLOW", "SUSTAINED_INFLOW", "OVERHEATED"].includes(r.status);
      if (statusFilter === "OUTFLOW")
        return ["EARLY_OUTFLOW", "SUSTAINED_OUTFLOW", "CAPITULATION"].includes(r.status);
      if (statusFilter === "NEUTRAL")
        return r.status === "NEUTRAL" || r.status === "INSUFFICIENT_DATA";
      return true;
    });
    const get = (r: SectorRotationRow): number => {
      switch (sort.key) {
        case "rank":
          return r.rank;
        case "rotationScore":
          return r.rotationScore;
        case "price":
          return r.priceLeadership.score ?? -1;
        case "flow":
          return r.moneyFlow.score ?? -1;
        case "momentum":
          return r.rotationMomentum ?? -1;
        case "foreign5":
          return r.foreignNet5d ?? 0;
        case "inst5":
          return r.institutionNet5d ?? 0;
        case "share":
          return r.turnoverShare5d;
        case "shareChange":
          return r.turnoverShareChange5d;
        case "reliability":
          return r.reliability;
      }
    };
    return [...filtered].sort((a, b) => (sort.dir === "asc" ? get(a) - get(b) : get(b) - get(a)));
  }, [rot, query, statusFilter, minReliability, sort]);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));

  const downloadCsv = () => {
    if (!rot) return;
    const header = [
      "기준일","순위","섹터코드","섹터","최종로테이션점수","가격리더십","자금흐름","로테이션모멘텀","상태",
      "RS20","RS60","RS120","외국인1일","외국인5일","외국인20일","외국인60일","기관1일","기관5일","기관20일","기관60일",
      "외국인5일/시총(%)","기관5일/시총(%)","거래대금점유율5일(%)","점유율변화5일(%p)","상대거래대금",
      "MA20상회비율","MA60상회비율","정배열비율","신고가근접비율","외국인매수확산도","기관매수확산도","동시매수확산도",
      "종목수","수급집중도(%)","시총집중도(%)","데이터완전성(%)","신뢰도","전주대비순위","대표ETF/대표주","경고",
    ];
    const lines = rot.sectors.map((r) =>
      [
        rot.asOfDate, r.rank, r.sectorCode, r.sectorName,
        r.rotationScore.toFixed(2), r.priceLeadership.score?.toFixed(2) ?? "", r.moneyFlow.score?.toFixed(2) ?? "",
        r.rotationMomentum?.toFixed(2) ?? "", FLOW_STATUS_LABEL[r.status],
        r.rs20?.toFixed(2) ?? "", r.rs60?.toFixed(2) ?? "", r.rs120?.toFixed(2) ?? "",
        r.foreignNet1d ?? "", r.foreignNet5d ?? "", r.foreignNet20d ?? "", r.foreignNet60d ?? "",
        r.institutionNet1d ?? "", r.institutionNet5d ?? "", r.institutionNet20d ?? "", r.institutionNet60d ?? "",
        r.foreignNet5dPerCap?.toFixed(4) ?? "", r.institutionNet5dPerCap?.toFixed(4) ?? "",
        r.turnoverShare5d.toFixed(3), r.turnoverShareChange5d.toFixed(3), r.relativeTurnover?.toFixed(3) ?? "",
        r.breadth.aboveMa20?.toFixed(1) ?? "", r.breadth.aboveMa60?.toFixed(1) ?? "", r.breadth.maAligned?.toFixed(1) ?? "",
        r.breadth.nearHigh52w?.toFixed(1) ?? "", r.breadth.foreignBuy5d?.toFixed(1) ?? "",
        r.breadth.institutionBuy5d?.toFixed(1) ?? "", r.breadth.bothBuy5d?.toFixed(1) ?? "",
        r.memberCount, r.supplyConcentration?.toFixed(1) ?? "", r.capConcentration?.toFixed(1) ?? "",
        r.dataCompleteness.toFixed(1), r.reliability.toFixed(1), r.prevRank,
        r.representativeEtf ?? "", r.anomalies.join(" / "),
      ]
        .map((v) => `"${String(v).replaceAll('"', '""')}"`)
        .join(","),
    );
    const blob = new Blob(["\uFEFF" + [header.join(","), ...lines].join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sector-rotation-${rot.asOfDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!rot) {
    return (
      <AppShell>
        <h1 className="text-xl font-bold tracking-tight">섹터 로테이션</h1>
        <p className="mt-2 rounded-lg border border-border bg-card p-4 text-[12px] text-muted-foreground">
          섹터 로테이션을 계산할 수 있는 데이터가 없습니다. 대시보드에서 스크리닝을 먼저 실행해
          주세요. (판단 보류)
        </p>
      </AppShell>
    );
  }

  const bestInflow = [...rot.sectors].sort(
    (a, b) => (b.moneyFlow.score ?? -1) - (a.moneyFlow.score ?? -1),
  )[0];
  const worstOutflow = [...rot.sectors].sort(
    (a, b) => (a.moneyFlow.score ?? 101) - (b.moneyFlow.score ?? 101),
  )[0];
  const nextLeader = rot.sectors.find((r) => r.isNextLeaderCandidate);
  const foreignTop = [...rot.sectors].sort((a, b) => (b.foreignNet5d ?? 0) - (a.foreignNet5d ?? 0))[0];
  const instTop = [...rot.sectors].sort(
    (a, b) => (b.institutionNet5d ?? 0) - (a.institutionNet5d ?? 0),
  )[0];
  const bothTop = [...rot.sectors]
    .filter((r) => (r.foreignNet5d ?? 0) > 0 && (r.institutionNet5d ?? 0) > 0)
    .sort((a, b) => (b.breadth.bothBuy5d ?? 0) - (a.breadth.bothBuy5d ?? 0))[0];
  const shareTop = [...rot.sectors].sort(
    (a, b) => b.turnoverShareChange5d - a.turnoverShareChange5d,
  )[0];

  return (
    <AppShell>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold tracking-tight">섹터 로테이션 엔진</h1>
          <p className="text-[12px] text-muted-foreground">
            기준일 {rot.asOfDate} · 벤치마크 KOSPI · 계산 {formatKstDateTime(analysis.calculatedAt)}{" "}
            (KST) · 가격 리더십과 자금흐름을 분리 계산하고 최종 로테이션 점수 = 가격{" "}
            {(rot.weights.priceLeadership * 100).toFixed(0)}% + 자금흐름{" "}
            {(rot.weights.moneyFlow * 100).toFixed(0)}% + 모멘텀{" "}
            {(rot.weights.rotationMomentum * 100).toFixed(0)}%
          </p>
        </div>
        <div className="flex gap-2 print:hidden">
          <Button size="sm" variant="outline" onClick={downloadCsv}>
            CSV 내보내기
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.print()}>
            PDF로 내보내기
          </Button>
        </div>
      </div>

      {/* 시장 전체 자금 상태 */}
      <div className="mb-3 rounded-lg border border-border bg-surface p-3">
        <p className="text-[13px] font-semibold">{rot.market.label}</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {rot.market.reasons.join(" · ")}
        </p>
      </div>

      {/* 11.1 상단 요약 카드 */}
      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <Card title="시장 자금 상태" value={rot.market.label} sub={`유입 ${rot.market.inflowSectorCount} / 유출 ${rot.market.outflowSectorCount} 섹터`} />
        <Card
          title="최강 유입 섹터"
          value={bestInflow ? bestInflow.sectorName : "판단 보류"}
          sub={bestInflow ? `자금흐름 ${scoreText(bestInflow.moneyFlow.score)}점` : undefined}
          tone="up"
        />
        <Card
          title="최대 유출 섹터"
          value={worstOutflow ? worstOutflow.sectorName : "판단 보류"}
          sub={worstOutflow ? `자금흐름 ${scoreText(worstOutflow.moneyFlow.score)}점` : undefined}
          tone="down"
        />
        <Card
          title="차기 주도 후보"
          value={nextLeader ? nextLeader.sectorName : "해당 없음"}
          sub={nextLeader ? nextLeader.quadrantMove : "개선 → 주도 전환 섹터 없음"}
        />
        <Card
          title="외국인 최선호 섹터 (5일)"
          value={foreignTop ? foreignTop.sectorName : "판단 보류"}
          sub={foreignTop ? `${eok(foreignTop.foreignNet5d)} 원` : undefined}
        />
        <Card
          title="기관 최선호 섹터 (5일)"
          value={instTop ? instTop.sectorName : "판단 보류"}
          sub={instTop ? `${eok(instTop.institutionNet5d)} 원` : undefined}
        />
        <Card
          title="외국인·기관 동시매수"
          value={bothTop ? bothTop.sectorName : "해당 없음"}
          sub={bothTop ? `동시매수 확산도 ${pct(bothTop.breadth.bothBuy5d)}` : undefined}
        />
        <Card
          title="거래대금 점유율 최대 상승"
          value={shareTop ? shareTop.sectorName : "판단 보류"}
          sub={shareTop ? pp(shareTop.turnoverShareChange5d) : undefined}
        />
        <Card title="데이터 기준일" value={rot.asOfDate} sub={`분석 섹터 ${rot.sectors.length}개`} />
        <Card
          title="전체 데이터 완전성"
          value={`${rot.overallCompleteness.toFixed(0)}%`}
          sub="미제공 항목은 가중치 재조정"
          tone={rot.overallCompleteness < 60 ? "warn" : undefined}
        />
      </div>

      {/* 12. 자동 해설 */}
      <section className="mb-4 rounded-lg border border-border bg-card p-3">
        <h2 className="mb-1 text-sm font-semibold">자동 해설</h2>
        <ul className="list-disc space-y-1 pl-4 text-[12px] leading-relaxed">
          {rot.commentary.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
        <div className="mt-2 border-t border-border pt-2 text-[11px] text-muted-foreground">
          <p className="font-medium">평가에서 제외한 데이터 (공급자 미제공)</p>
          <ul className="list-disc pl-4">
            {rot.excludedItems.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      </section>

      {/* 8. 4분면 */}
      <section className="mb-4 rounded-lg border border-border bg-card p-3">
        <h2 className="mb-1 text-sm font-semibold">섹터 로테이션 4분면</h2>
        <p className="mb-2 text-[11px] text-muted-foreground">
          X축 = 가격 리더십, Y축 = 자금흐름, 버블 크기 = 거래대금 점유율, 색 = 최근 5일 자금흐름
          점수 변화, 화살표 = 5거래일 전 위치에서의 이동. 기준일 {rot.asOfDate}
        </p>
        <QuadrantChart rows={rot.sectors} />
      </section>

      {/* 필터 */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="섹터 검색"
          className="h-8 w-40 text-[12px]"
        />
        {(
          [
            ["ALL", "전체"],
            ["INFLOW", "유입"],
            ["OUTFLOW", "유출"],
            ["NEUTRAL", "중립·보류"],
          ] as const
        ).map(([k, label]) => (
          <Button
            key={k}
            size="sm"
            variant={statusFilter === k ? "default" : "outline"}
            onClick={() => setStatusFilter(k)}
          >
            {label}
          </Button>
        ))}
        <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
          최소 신뢰도
          <Input
            type="number"
            value={minReliability}
            step={5}
            onChange={(e) => setMinReliability(Number(e.target.value))}
            className="h-8 w-20 text-right text-[12px]"
          />
        </label>
        <span className="text-[11px] text-muted-foreground">{rows.length}개 표시</span>
      </div>

      {/* 11.2 메인 테이블 */}
      <div className="mb-4 overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full min-w-[1900px] text-[12px]">
          <thead className="bg-surface-strong text-[11px]">
            <tr>
              {(
                [
                  ["rank", "순위"],
                  [null, "섹터"],
                  ["rotationScore", "로테이션 점수"],
                  ["price", "가격 리더십"],
                  ["flow", "자금흐름"],
                  ["momentum", "모멘텀"],
                  [null, "상태"],
                  [null, "RS20"],
                  [null, "RS60"],
                  [null, "RS120"],
                  ["foreign5", "외국인 5일"],
                  [null, "외국인 20일"],
                  ["inst5", "기관 5일"],
                  [null, "기관 20일"],
                  [null, "동시매수 비율"],
                  ["share", "점유율(5일)"],
                  ["shareChange", "점유율 변화"],
                  [null, "상대 거래대금"],
                  [null, "MA20 상회"],
                  [null, "MA60 상회"],
                  [null, "신고가 비율"],
                  [null, "전주 대비"],
                  ["reliability", "신뢰도"],
                  [null, "완전성"],
                  [null, "대표 ETF/대표주"],
                ] as Array<[SortKey | null, string]>
              ).map(([key, label]) => (
                <th
                  key={label}
                  className={`px-2 py-2 ${key ? "cursor-pointer select-none hover:text-foreground" : ""} ${
                    label.includes("섹터") || label.includes("상태") || label.includes("ETF")
                      ? "text-left"
                      : "text-right"
                  }`}
                  onClick={key ? () => toggleSort(key) : undefined}
                >
                  {label}
                  {sort.key === key ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <>
                <tr
                  key={s.sectorCode}
                  className="cursor-pointer border-t border-border hover:bg-surface-strong/50"
                  onClick={() => setExpanded(expanded === s.sectorCode ? null : s.sectorCode)}
                >
                  <td className="num px-2 py-1.5">{s.rank}</td>
                  <td className="px-2 py-1.5 font-medium">
                    {s.sectorName}
                    {s.anomalies.length > 0 ? (
                      <span className="ml-1 text-warn" title={s.anomalies.join(" / ")}>
                        ⚠
                      </span>
                    ) : null}
                    <span className="ml-1 text-[10px] text-muted-foreground">
                      {s.memberCount}종목
                    </span>
                  </td>
                  <td className="num px-2 py-1.5 font-semibold">{s.rotationScore.toFixed(1)}</td>
                  <td className="num px-2 py-1.5">{scoreText(s.priceLeadership.score)}</td>
                  <td className="num px-2 py-1.5">{scoreText(s.moneyFlow.score)}</td>
                  <td className="num px-2 py-1.5">{scoreText(s.rotationMomentum)}</td>
                  <td className="px-2 py-1.5">
                    <span className={`rounded px-1 py-0.5 text-[10px] ${STATUS_CLASS[s.status]}`}>
                      {FLOW_STATUS_LABEL[s.status]}
                    </span>
                  </td>
                  <td className="num px-2 py-1.5">
                    <Delta value={s.rs20} digits={2} />
                  </td>
                  <td className="num px-2 py-1.5">
                    <Delta value={s.rs60} digits={2} />
                  </td>
                  <td className="num px-2 py-1.5">
                    <Delta value={s.rs120} digits={2} />
                  </td>
                  <td className={`num px-2 py-1.5 ${(s.foreignNet5d ?? 0) >= 0 ? "text-up" : "text-down"}`}>
                    {eok(s.foreignNet5d)}
                  </td>
                  <td className={`num px-2 py-1.5 ${(s.foreignNet20d ?? 0) >= 0 ? "text-up" : "text-down"}`}>
                    {eok(s.foreignNet20d)}
                  </td>
                  <td className={`num px-2 py-1.5 ${(s.institutionNet5d ?? 0) >= 0 ? "text-up" : "text-down"}`}>
                    {eok(s.institutionNet5d)}
                  </td>
                  <td className={`num px-2 py-1.5 ${(s.institutionNet20d ?? 0) >= 0 ? "text-up" : "text-down"}`}>
                    {eok(s.institutionNet20d)}
                  </td>
                  <td className="num px-2 py-1.5">{pct(s.breadth.bothBuy5d)}</td>
                  <td className="num px-2 py-1.5">{pct(s.turnoverShare5d)}</td>
                  <td className="num px-2 py-1.5">
                    <span className={s.turnoverShareChange5d >= 0 ? "text-up" : "text-down"}>
                      {pp(s.turnoverShareChange5d)}
                    </span>
                  </td>
                  <td className="num px-2 py-1.5">
                    {s.relativeTurnover === null ? "-" : `${s.relativeTurnover.toFixed(2)}배`}
                  </td>
                  <td className="num px-2 py-1.5">{pct(s.breadth.aboveMa20)}</td>
                  <td className="num px-2 py-1.5">{pct(s.breadth.aboveMa60)}</td>
                  <td className="num px-2 py-1.5">{pct(s.breadth.nearHigh52w)}</td>
                  <td className="num px-2 py-1.5">
                    {s.prevRank > s.rank ? (
                      <span className="text-up">▲{s.prevRank - s.rank}</span>
                    ) : s.prevRank < s.rank ? (
                      <span className="text-down">▼{s.rank - s.prevRank}</span>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </td>
                  <td className="num px-2 py-1.5">
                    {s.reliability.toFixed(0)}
                    <span className="ml-1 text-[10px] text-muted-foreground">
                      {RELIABILITY_LABEL[s.reliabilityTag]}
                    </span>
                  </td>
                  <td className="num px-2 py-1.5">{s.dataCompleteness.toFixed(0)}%</td>
                  <td className="px-2 py-1.5">{s.representativeEtf ?? "데이터 없음"}</td>
                </tr>
                {expanded === s.sectorCode ? (
                  <tr key={`${s.sectorCode}-detail`} className="border-t border-border bg-surface">
                    <td colSpan={25} className="px-3 py-3">
                      <div className="grid gap-4 lg:grid-cols-3">
                        <ScoreBreakdown title="가격 리더십 점수 구성" block={s.priceLeadership} />
                        <ScoreBreakdown title="자금흐름 점수 구성" block={s.moneyFlow} />
                        <div className="text-[11px] leading-relaxed">
                          <p className="mb-1 text-[12px] font-semibold">상태·품질 진단</p>
                          <p>
                            상태: {FLOW_STATUS_LABEL[s.status]} — {s.statusReason}
                          </p>
                          <p>
                            4분면: {QUADRANT_LABEL[s.quadrant]} ({s.quadrantMove})
                          </p>
                          <p>
                            동일가중 20일 수익률 {pct(s.equalWeightReturn20)} / 시총가중{" "}
                            {pct(s.capWeightReturn20)}
                          </p>
                          <p>
                            수급 집중도 {pct(s.supplyConcentration)} · 시총 집중도{" "}
                            {pct(s.capConcentration)}
                          </p>
                          <p>
                            외국인 5일 순매수 ÷ 섹터 시총 {pct(s.foreignNet5dPerCap, 3)} · ÷ 20일
                            거래대금{" "}
                            {s.foreignNet5dPerTurnover === null
                              ? "-"
                              : `${s.foreignNet5dPerTurnover.toFixed(3)}배`}
                          </p>
                          <p>
                            가격 확산도 {pct(s.breadth.advancing)} · 외국인 매수 확산도{" "}
                            {pct(s.breadth.foreignBuy5d)} · 기관 매수 확산도{" "}
                            {pct(s.breadth.institutionBuy5d)} · 동시매수 확산도{" "}
                            {pct(s.breadth.bothBuy5d)}
                          </p>
                          <p>
                            신뢰도 {s.reliability.toFixed(0)}점 (
                            {RELIABILITY_LABEL[s.reliabilityTag]})
                          </p>
                          {s.anomalies.length > 0 ? (
                            <div className="mt-1 rounded border border-warn/40 bg-warn-soft p-2 text-warn">
                              <p className="font-medium">경고</p>
                              <ul className="list-disc pl-4">
                                {s.anomalies.map((a) => (
                                  <li key={a}>{a}</li>
                                ))}
                              </ul>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </>
            ))}
          </tbody>
        </table>
      </div>

      {/* 11.3 히트맵 */}
      <section className="mb-4 overflow-x-auto rounded-lg border border-border bg-card">
        <header className="border-b border-border bg-surface-strong px-3 py-2">
          <h2 className="text-sm font-semibold">자금 흐름 히트맵</h2>
          <p className="text-[11px] text-muted-foreground">
            순유입 = 붉은색, 순유출 = 파란색. 색과 함께 숫자(억 원 / %p / 점)를 병기합니다. 기준일{" "}
            {rot.asOfDate}
          </p>
        </header>
        <table className="w-full min-w-[900px] text-[12px]">
          <thead className="bg-surface text-[11px]">
            <tr>
              <th className="px-2 py-2 text-left">섹터</th>
              <th className="px-2 py-2 text-right">외국인 1일</th>
              <th className="px-2 py-2 text-right">외국인 5일</th>
              <th className="px-2 py-2 text-right">외국인 20일</th>
              <th className="px-2 py-2 text-right">기관 1일</th>
              <th className="px-2 py-2 text-right">기관 5일</th>
              <th className="px-2 py-2 text-right">기관 20일</th>
              <th className="px-2 py-2 text-right">점유율 변화</th>
              <th className="px-2 py-2 text-right">가격 리더십 변화</th>
            </tr>
          </thead>
          <tbody>
            {rot.sectors.map((s) => (
              <tr key={s.sectorCode} className="border-t border-border">
                <td className="px-2 py-1 font-medium">{s.sectorName}</td>
                <HeatCell value={s.foreignNet1d} format={(v) => eok(v)} />
                <HeatCell value={s.foreignNet5d} format={(v) => eok(v)} />
                <HeatCell value={s.foreignNet20d} format={(v) => eok(v)} />
                <HeatCell value={s.institutionNet1d} format={(v) => eok(v)} />
                <HeatCell value={s.institutionNet5d} format={(v) => eok(v)} />
                <HeatCell value={s.institutionNet20d} format={(v) => eok(v)} />
                <HeatCell value={s.turnoverShareChange5d} format={(v) => pp(v)} />
                <HeatCell
                  value={s.priceLeadershipChange5d}
                  format={(v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}점`}
                />
              </tr>
            ))}
          </tbody>
        </table>
        <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
          연기금·투신·보험·개인 수급과 ETF 순유입 열은 공급자가 제공하지 않아 표시하지 않습니다.
        </p>
      </section>

      {/* 시계열 추이 */}
      <section className="mb-4 rounded-lg border border-border bg-card p-3">
        <h2 className="text-sm font-semibold">섹터 점수 시계열 추이</h2>
        <p className="mb-2 text-[11px] text-muted-foreground">
          5거래일 간격으로 과거 시점의 프레임을 재계산한 값입니다. 섹터 이름을 눌러 표시 여부를
          바꿀 수 있습니다.
        </p>
        <TimelineChart timeline={rot.timeline} sectors={rot.sectors} />
      </section>

      {/* 11.4 섹터 간 자금 이동 */}

      <section className="mb-4 rounded-lg border border-border bg-card p-3">
        <h2 className="text-sm font-semibold">섹터 간 자금 이동 추정</h2>
        <p className="mb-2 text-[11px] text-muted-foreground">
          왼쪽 = 유출 후보, 오른쪽 = 유입 후보. 연결선 굵기는 <b>로테이션 증거 점수</b>이며 실제
          송금 경로나 이동 금액이 아닙니다.
        </p>
        {rot.links.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">
            유출·유입이 동시에 확인되는 섹터 쌍이 없어 로테이션 연결을 표시하지 않습니다 (판단 보류).
          </p>
        ) : (
          <div className="space-y-2">
            {rot.links.map((l, i) => (
              <LinkRow
                key={`${l.fromCode}-${l.toCode}`}
                link={l}
                open={openLink === i}
                onToggle={() => setOpenLink(openLink === i ? null : i)}
              />
            ))}
          </div>
        )}
      </section>

      {/* 기존 상대강도 표 유지 */}
      <section className="overflow-x-auto rounded-lg border border-border bg-card">
        <header className="border-b border-border bg-surface-strong px-3 py-2">
          <h2 className="text-sm font-semibold">기존 섹터 상대강도 (RS 기준)</h2>
          <p className="text-[11px] text-muted-foreground">
            점수 = RS20 백분위 35 + RS60 백분위 25 + 추세 20 + Breadth 20
          </p>
        </header>
        <table className="w-full min-w-[1000px] text-[12px]">
          <thead className="bg-surface text-[11px]">
            <tr>
              <th className="px-2 py-2 text-left">RS 순위</th>
              <th className="px-2 py-2 text-left">섹터</th>
              <th className="px-2 py-2 text-right">섹터 점수</th>
              <th className="px-2 py-2 text-right">RS20</th>
              <th className="px-2 py-2 text-right">RS60</th>
              <th className="px-2 py-2 text-right">정배열 비율</th>
              <th className="px-2 py-2 text-right">신고가 근접</th>
              <th className="px-2 py-2 text-right">상승 종목</th>
              <th className="px-2 py-2 text-right">A / B등급</th>
              <th className="px-2 py-2 text-left">대표 ETF/대표주</th>
            </tr>
          </thead>
          <tbody>
            {analysis.sectors.map((s) => (
              <tr key={s.sectorCode} className="border-t border-border">
                <td className="num px-2 py-1.5">{s.rank}</td>
                <td className="px-2 py-1.5 font-medium">{s.sectorName}</td>
                <td className="num px-2 py-1.5 font-semibold">{formatNumber(s.score, 1)}</td>
                <td className="num px-2 py-1.5">
                  <Delta value={s.rs20} digits={2} />
                </td>
                <td className="num px-2 py-1.5">
                  <Delta value={s.rs60} digits={2} />
                </td>
                <td className="num px-2 py-1.5">{formatNumber(s.breadthMaAligned, 0)}%</td>
                <td className="num px-2 py-1.5">{formatNumber(s.breadthNearHigh, 0)}%</td>
                <td className="num px-2 py-1.5">{formatNumber(s.breadthAdvancing, 0)}%</td>
                <td className="num px-2 py-1.5">
                  {s.gradeACount} / {s.gradeBCount}
                </td>
                <td className="px-2 py-1.5">{s.representativeEtf ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </AppShell>
  );
}

function ScoreBreakdown({
  title,
  block,
}: {
  title: string;
  block: SectorRotationRow["priceLeadership"];
}) {
  return (
    <div className="text-[11px]">
      <p className="mb-1 text-[12px] font-semibold">
        {title}: {scoreText(block.score)}점{" "}
        <span className="font-normal text-muted-foreground">
          (데이터 완전성 {block.completeness.toFixed(0)}%)
        </span>
      </p>
      <table className="w-full">
        <tbody>
          {block.components.map((c) => (
            <tr key={c.label} className="border-t border-border/60">
              <td className="py-0.5 pr-2">{c.label}</td>
              <td className="num py-0.5 pr-2 text-right text-muted-foreground">{c.weight}점</td>
              <td className="num py-0.5 text-right">
                {c.ratio === null ? (
                  <span className="text-muted-foreground">제외</span>
                ) : (
                  (c.ratio * c.weight).toFixed(1)
                )}
              </td>
              <td className="py-0.5 pl-2 text-muted-foreground">{c.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {block.missing.length > 0 ? (
        <p className="mt-1 text-muted-foreground">누락 데이터: {block.missing.join(", ")}</p>
      ) : null}
    </div>
  );
}

function LinkRow({
  link,
  open,
  onToggle,
}: {
  link: RotationLink;
  open: boolean;
  onToggle: () => void;
}) {
  const width = Math.max(2, Math.round(link.evidenceScore / 12));
  return (
    <div className="rounded-md border border-border">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full flex-wrap items-center gap-3 px-3 py-2 text-left text-[12px] hover:bg-surface-strong/50"
      >
        <span className="w-28 shrink-0 text-down">{link.fromName}</span>
        <span className="flex-1">
          <span
            className="block rounded-full bg-primary/60"
            style={{ height: `${width}px` }}
            aria-hidden
          />
        </span>
        <span className="w-28 shrink-0 text-up">{link.toName}</span>
        <span className="w-40 shrink-0 text-right text-[11px] text-muted-foreground">
          증거 점수 {link.evidenceScore.toFixed(0)} · 신뢰도 {CONFIDENCE_LABEL[link.confidence]}
        </span>
      </button>
      {open ? (
        <div className="border-t border-border px-3 py-2 text-[11px] leading-relaxed">
          <p className="mb-2 text-[12px]">{link.sentence}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="font-medium text-down">유출 근거 · {link.fromName}</p>
              <ul className="list-disc pl-4">
                {link.outflowEvidence.length === 0 ? <li>확인된 근거 없음</li> : null}
                {link.outflowEvidence.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
            <div>
              <p className="font-medium text-up">유입 근거 · {link.toName}</p>
              <ul className="list-disc pl-4">
                {link.inflowEvidence.length === 0 ? <li>확인된 근거 없음</li> : null}
                {link.inflowEvidence.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          </div>
          <div className="mt-2 border-t border-border pt-2 text-muted-foreground">
            <p className="font-medium">판단 제한사항</p>
            <ul className="list-disc pl-4">
              {link.caveats.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function QuadrantChart({ rows }: { rows: SectorRotationRow[] }) {
  const W = 720;
  const H = 420;
  const pad = 40;
  const x = (v: number) => pad + (v / 100) * (W - pad * 2);
  const y = (v: number) => H - pad - (v / 100) * (H - pad * 2);
  const maxShare = Math.max(1, ...rows.map((r) => r.turnoverShare5d));

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="min-w-[720px]" role="img" aria-label="섹터 로테이션 4분면">
        <rect x={pad} y={pad} width={W - pad * 2} height={H - pad * 2} className="fill-surface" />
        <line x1={x(50)} y1={pad} x2={x(50)} y2={H - pad} className="stroke-border" />
        <line x1={pad} y1={y(50)} x2={W - pad} y2={y(50)} className="stroke-border" />
        <text x={W - pad - 6} y={pad + 14} textAnchor="end" className="fill-muted-foreground text-[11px]">
          주도
        </text>
        <text x={pad + 6} y={pad + 14} className="fill-muted-foreground text-[11px]">
          개선
        </text>
        <text x={W - pad - 6} y={H - pad - 6} textAnchor="end" className="fill-muted-foreground text-[11px]">
          약화
        </text>
        <text x={pad + 6} y={H - pad - 6} className="fill-muted-foreground text-[11px]">
          소외
        </text>
        <text x={W / 2} y={H - 8} textAnchor="middle" className="fill-muted-foreground text-[11px]">
          가격 리더십 점수
        </text>
        <text x={12} y={H / 2} transform={`rotate(-90 12 ${H / 2})`} textAnchor="middle" className="fill-muted-foreground text-[11px]">
          자금흐름 점수
        </text>
        {rows.map((r) => {
          const px = r.priceLeadership.score;
          const py = r.moneyFlow.score;
          if (px === null || py === null) return null;
          const rad = 5 + (r.turnoverShare5d / maxShare) * 14;
          const change = r.moneyFlowChange5d ?? 0;
          const fill = change > 2 ? "fill-up" : change < -2 ? "fill-down" : "fill-muted-foreground";
          const prevX = r.prevPriceLeadership;
          const prevY = r.prevMoneyFlow;
          return (
            <g key={r.sectorCode}>
              {prevX !== null && prevY !== null ? (
                <line
                  x1={x(prevX)}
                  y1={y(prevY)}
                  x2={x(px)}
                  y2={y(py)}
                  className="stroke-muted-foreground/50"
                  strokeDasharray="3 3"
                  markerEnd="url(#arrow)"
                />
              ) : null}
              <circle cx={x(px)} cy={y(py)} r={rad} className={`${fill} opacity-60`}>
                <title>{`${r.sectorName}\n가격 리더십 ${px.toFixed(1)} / 자금흐름 ${py.toFixed(1)}\n거래대금 점유율 ${r.turnoverShare5d.toFixed(1)}%\n5일 자금흐름 변화 ${change.toFixed(1)}점`}</title>
              </circle>
              <text x={x(px)} y={y(py) - rad - 3} textAnchor="middle" className="fill-foreground text-[10px]">
                {r.sectorName}
              </text>
            </g>
          );
        })}
        <defs>
          <marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 z" className="fill-muted-foreground/70" />
          </marker>
        </defs>
      </svg>
    </div>
  );
}

const TIMELINE_METRICS = [
  { key: "priceLeadership", label: "가격 리더십 점수", unit: "점" },
  { key: "moneyFlow", label: "자금흐름 점수", unit: "점" },
  { key: "turnoverShare5d", label: "거래대금 점유율", unit: "%" },
] as const;

const TIMELINE_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--up)",
  "var(--down)",
];

/** 섹터별 점수 시계열 추이 (5거래일 간격). 기본은 로테이션 점수 상위 5개 섹터. */
function TimelineChart({
  timeline,
  sectors,
}: {
  timeline: SectorTimeline[];
  sectors: SectorRotationRow[];
}) {
  const [metric, setMetric] = useState<(typeof TIMELINE_METRICS)[number]["key"]>("moneyFlow");
  const ordered = useMemo(
    () =>
      sectors
        .map((s) => timeline.find((t) => t.sectorCode === s.sectorCode))
        .filter((t): t is SectorTimeline => Boolean(t)),
    [sectors, timeline],
  );
  const [visible, setVisible] = useState<string[]>(() => ordered.slice(0, 5).map((t) => t.sectorCode));

  const dates = ordered[0]?.points.map((p) => p.date) ?? [];
  const data = useMemo(
    () =>
      dates.map((date, i) => {
        const row: Record<string, string | number | null> = { date: date.slice(5) };
        for (const t of ordered) {
          row[t.sectorCode] = t.points[i]?.[metric] ?? null;
        }
        return row;
      }),
    [dates, ordered, metric],
  );

  const unit = TIMELINE_METRICS.find((m) => m.key === metric)!.unit;

  if (dates.length < 2) {
    return (
      <p className="text-[12px] text-muted-foreground">
        과거 데이터가 부족해 시계열 추이를 계산할 수 없습니다 (판단 보류).
      </p>
    );
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-1">
        {TIMELINE_METRICS.map((m) => (
          <Button
            key={m.key}
            size="sm"
            variant={metric === m.key ? "default" : "outline"}
            className="h-7 text-[11px]"
            onClick={() => setMetric(m.key)}
          >
            {m.label}
          </Button>
        ))}
      </div>
      <div className="h-[300px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" />
            <YAxis tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" width={44} />
            <Tooltip
              contentStyle={{
                background: "var(--card)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                fontSize: 12,
              }}
              formatter={(value: number | string, name: string) => [
                `${typeof value === "number" ? value.toFixed(1) : value}${unit}`,
                name,
              ]}
            />
            {ordered
              .filter((t) => visible.includes(t.sectorCode))
              .map((t) => (
                <Line
                  key={t.sectorCode}
                  type="monotone"
                  dataKey={t.sectorCode}
                  name={t.sectorName}
                  stroke={TIMELINE_COLORS[ordered.indexOf(t) % TIMELINE_COLORS.length]}
                  strokeWidth={2}
                  dot={{ r: 2 }}
                  connectNulls
                />
              ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {ordered.map((t, i) => {
          const on = visible.includes(t.sectorCode);
          return (
            <button
              key={t.sectorCode}
              type="button"
              onClick={() =>
                setVisible((prev) =>
                  prev.includes(t.sectorCode)
                    ? prev.filter((c) => c !== t.sectorCode)
                    : [...prev, t.sectorCode],
                )
              }
              className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${
                on ? "border-border bg-surface" : "border-border/60 text-muted-foreground opacity-60"
              }`}
            >
              <span
                className="inline-block size-2 rounded-full"
                style={{ background: TIMELINE_COLORS[i % TIMELINE_COLORS.length] }}
              />
              {t.sectorName}
            </button>
          );
        })}
      </div>
    </div>
  );
}
