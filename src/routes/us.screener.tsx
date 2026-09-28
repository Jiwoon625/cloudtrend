import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ArrowUpDown, Download } from "lucide-react";
import { useMemo, useState } from "react";

import { AppShell } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { loadUsProspectiveCache, type UsProspectiveCacheRow } from "@/lib/usProspectiveCloud";

export const Route = createFileRoute("/us/screener")({
  ssr: false,
  head: () => ({ meta: [{ title: "US 스크리너 | CloudTrend A0 Prospective" }] }),
  component: UsScreenerPage,
});

const EMPTY_ROWS: UsProspectiveCacheRow[] = [];

type Filter =
  "PRIMARY_WATCH" | "PRIMARY_ENTRY" | "PRIMARY_EXIT" | "A2_ENTRY" | "B3_ENTRY" | "B3_EXIT" | "ALL";

type SortDirection = "asc" | "desc";
type SortKey =
  | "symbol"
  | "marketSector"
  | "close"
  | "ret120"
  | "ret252"
  | "ret120Rank"
  | "ret252Rank"
  | "onset80"
  | "betaWeakStreak"
  | "coreRank"
  | "betaRank"
  | "tkRank"
  | "relvolRank"
  | "liquidityRank"
  | "amihudRank"
  | "adv20Usd"
  | "a0Signal"
  | "shadowSignal";

function pct(v: number | null, digits = 1) {
  return v === null ? "-" : `${(v * 100).toFixed(digits)}%`;
}
function money(v: number | null) {
  if (v === null) return "-";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  return `$${v.toLocaleString()}`;
}

function UsScreenerPage() {
  const query = useQuery({
    queryKey: ["us-prospective-cache"],
    queryFn: loadUsProspectiveCache,
    staleTime: 60_000,
  });
  const [filter, setFilter] = useState<Filter>("PRIMARY_ENTRY");
  const [sector, setSector] = useState("");
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection } | null>(null);
  const rows = query.data?.analysis.rows ?? EMPTY_ROWS;
  const entryFunnel = useMemo(() => {
    const candidates = rows.filter((r) => r.symbol !== "SPY");
    const onset = candidates.filter((r) => r.onset80);
    const beta = onset.filter((r) => (r.betaRank ?? -1) >= 0.9);
    const aggressiveConfirm = beta.filter((r) => (r.tkRank ?? -1) >= 0.8);
    const balancedConfirm = beta.filter((r) => (r.relvolRank ?? -1) >= 0.8);

    return [
      {
        step: "1",
        label: "E80 Onset",
        description: "전일 Core <80% → 당일 ≥80%",
        a0: onset.length,
        b3: onset.length,
      },
      {
        step: "2",
        label: "Beta 통과",
        description: "Onset 중 Beta Rank ≥90%",
        a0: beta.length,
        b3: beta.length,
      },
      {
        step: "3",
        label: "Confirm 통과",
        description: "A0/A2 TK ≥80% · B3 RelVol ≥80%",
        a0: aggressiveConfirm.length,
        b3: balancedConfirm.length,
      },
      {
        step: "4",
        label: "최종 Entry",
        description: "유동성·거래가능 등 공통 조건까지 통과",
        a0: candidates.filter((r) => r.a0Entry).length,
        b3: candidates.filter((r) => r.b3Entry).length,
      },
    ];
  }, [rows]);
  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    return rows.filter((r) => {
      if (r.symbol === "SPY") return false;
      if (q && !r.symbol.includes(q) && !r.name.toUpperCase().includes(q)) return false;
      if (sector && (r.sector ?? "미분류") !== sector) return false;
      if (filter === "PRIMARY_WATCH") return !r.a0Exit && (r.coreRank ?? 0) >= 0.7;
      if (filter === "PRIMARY_ENTRY") return r.a0Entry;
      if (filter === "PRIMARY_EXIT") return r.a0Exit;
      if (filter === "A2_ENTRY") return r.a2Entry;
      if (filter === "B3_ENTRY") return r.b3Entry;
      if (filter === "B3_EXIT") return r.b3Exit;
      return r.coreRank !== null;
    });
  }, [rows, filter, search, sector]);

  const sortValue = (r: UsProspectiveCacheRow, key: SortKey): number | string | null => {
    if (key === "symbol") return `${r.symbol} ${r.name}`;
    if (key === "marketSector") return `${r.market ?? ""} ${r.sector ?? ""}`;
    if (key === "onset80") return r.onset80 ? 1 : 0;
    if (key === "a0Signal") return r.a0Entry ? 2 : r.a0Exit ? 0 : 1;
    if (key === "shadowSignal")
      return (r.a2Entry ? 8 : 0) + (r.b3Entry ? 4 : 0) + (r.a2Exit ? 2 : 0) + (r.b3Exit ? 1 : 0);
    return r[key];
  };

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const direction = sort.direction === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = sortValue(a, sort.key);
      const bv = sortValue(b, sort.key);
      if (av === null || av === undefined) return bv === null || bv === undefined ? 0 : 1;
      if (bv === null || bv === undefined) return -1;
      if (typeof av === "string" || typeof bv === "string")
        return String(av).localeCompare(String(bv), undefined, { numeric: true }) * direction;
      return (Number(av) - Number(bv)) * direction;
    });
  }, [filtered, sort]);

  const toggleSort = (key: SortKey) => {
    setSort((current) =>
      current?.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: "asc" },
    );
    setPage(0);
  };

  const pageCount = Math.max(1, Math.ceil(sorted.length / 100));
  const currentPage = Math.min(page, pageCount - 1);
  const visibleRows = sorted.slice(currentPage * 100, (currentPage + 1) * 100);

  const download = () => {
    const header = [
      "date",
      "symbol",
      "name",
      "market",
      "sector",
      "close",
      "ret120",
      "ret252",
      "ret120Rank",
      "ret252Rank",
      "onset80",
      "primarySignal",
      "a0BetaExit",
      "betaWeakStreak",
      "a2Exit",
      "coreRank",
      "betaRank",
      "tkRank",
      "relvolRank",
      "liquidityRank",
      "amihudRank",
      "a0Entry",
      "a0Exit",
      "a2Entry",
      "b3Entry",
      "b3Exit",
    ];
    const body = sorted.map((r) =>
      header
        .map(
          (k) =>
            `"${String((r as unknown as Record<string, unknown>)[k] ?? "").replaceAll('"', '""')}"`,
        )
        .join(","),
    );
    const blob = new Blob([[header.join(","), ...body].join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cloudtrend-us-${query.data?.analysis.date ?? "latest"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <AppShell loadAnalysis={false}>
      <div className="space-y-4">
        <header className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold">US 스크리너</h1>
              <Badge>A0 PRIMARY</Badge>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              기준일 {query.data?.analysis.date ?? "-"} · E80 Onset / X70 + Beta 0.60×3 Anchor ·
              Core ret120/252 50:50 · 숫자 재튜닝 금지
            </p>
          </div>
          <div className="flex gap-2">
            <Link to="/us/portfolio">
              <Button size="sm" variant="outline">
                US 포트폴리오
              </Button>
            </Link>
            <Button size="sm" variant="outline" onClick={download}>
              <Download className="size-3.5" />
              CSV
            </Button>
          </div>
        </header>
        {query.isError ? (
          <p role="alert">US 결과를 불러오지 못했습니다: {query.error.message}</p>
        ) : !query.data ? (
          <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
            아직 GitHub 엔진이 생성한 US 결과가 없습니다. Colab 수집기를 실행한 뒤 workflow가
            완료되면 표시됩니다.
          </div>
        ) : (
          <>
            <section className="space-y-2 rounded-lg border border-border bg-card p-3">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold">신규 진입 Funnel</h2>
                  <p className="text-[10px] text-muted-foreground">
                    각 단계는 직전 단계 통과 종목 기준 · A0/A2는 동일 진입 신호
                  </p>
                </div>
                {entryFunnel[0]?.a0 === 0 ? (
                  <span className="text-[10px] text-muted-foreground">
                    bootstrap 기준일에는 이전 Core가 없어 E80 Onset이 0건일 수 있습니다.
                  </span>
                ) : null}
              </div>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                {entryFunnel.map((item) => (
                  <div key={item.step} className="rounded-md border border-border bg-background p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] font-semibold text-muted-foreground">
                        STEP {item.step}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        A0/A2 · B3
                      </span>
                    </div>
                    <p className="mt-1 text-xs font-semibold">{item.label}</p>
                    <div className="mt-2 flex items-baseline gap-3">
                      <span className="text-lg font-bold tabular-nums">
                        {item.a0.toLocaleString()}
                      </span>
                      <span className="text-[10px] text-muted-foreground">A0/A2</span>
                      <span className="text-lg font-bold tabular-nums">
                        {item.b3.toLocaleString()}
                      </span>
                      <span className="text-[10px] text-muted-foreground">B3</span>
                    </div>
                    <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
                      {item.description}
                    </p>
                  </div>
                ))}
              </div>
            </section>
            <div className="flex flex-wrap gap-1">
              {(
                [
                  ["PRIMARY_ENTRY", "A0 신규진입"],
                  ["PRIMARY_WATCH", "A0 보유·관찰 후보"],
                  ["PRIMARY_EXIT", "A0 청산"],
                  ["A2_ENTRY", "A2 Shadow 진입"],
                  ["B3_ENTRY", "B3 Shadow 진입"],
                  ["B3_EXIT", "B3 Shadow 청산"],
                  ["ALL", "전체"],
                ] as Array<[Filter, string]>
              ).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => {
                    setFilter(id);
                    setPage(0);
                  }}
                  className={`rounded-full border px-2.5 py-1 text-[11px] ${filter === id ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="rounded-lg border border-border bg-card p-3">
              <Input
                className="h-8 max-w-sm text-[12px]"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(0);
                }}
                placeholder="티커 또는 종목명"
              />
              <select
                aria-label="섹터"
                value={sector}
                onChange={(e) => {
                  setSector(e.target.value);
                  setPage(0);
                }}
                className="mt-2 rounded border bg-background p-1 text-xs"
              >
                <option value="">전체 섹터</option>
                {Array.from(new Set(rows.map((r) => r.sector ?? "미분류")))
                  .sort()
                  .map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
              </select>
            </div>
            <nav aria-label="종목 페이지" className="flex items-center gap-3 text-xs">
              <span>
                전체 {filtered.length.toLocaleString()}종목 · {currentPage + 1} / {pageCount}페이지
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                이전
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={currentPage + 1 >= pageCount}
                onClick={() => setPage(currentPage + 1)}
              >
                다음
              </Button>
            </nav>
            <div className="overflow-x-auto rounded-lg border border-border bg-card">
              <table className="w-full min-w-[1280px] text-[11px]">
                <thead>
                  <tr className="border-b bg-surface-strong text-muted-foreground [&>th]:px-2 [&>th]:py-2 [&>th]:text-right">
                    <SortableHeader label="종목" sortKey="symbol" sort={sort} onSort={toggleSort} align="left" />
                    <SortableHeader label="시장/섹터" sortKey="marketSector" sort={sort} onSort={toggleSort} align="left" />
                    <SortableHeader label="종가" sortKey="close" sort={sort} onSort={toggleSort} />
                    <SortableHeader label="120D" sortKey="ret120" sort={sort} onSort={toggleSort} />
                    <SortableHeader label="252D" sortKey="ret252" sort={sort} onSort={toggleSort} />
                    <SortableHeader label="120D 순위" sortKey="ret120Rank" sort={sort} onSort={toggleSort} />
                    <SortableHeader label="252D 순위" sortKey="ret252Rank" sort={sort} onSort={toggleSort} />
                    <SortableHeader label="Onset" sortKey="onset80" sort={sort} onSort={toggleSort} />
                    <SortableHeader label="β 약화일" sortKey="betaWeakStreak" sort={sort} onSort={toggleSort} />
                    <SortableHeader label="Core" sortKey="coreRank" sort={sort} onSort={toggleSort} />
                    <SortableHeader label="Beta" sortKey="betaRank" sort={sort} onSort={toggleSort} />
                    <SortableHeader label="TK" sortKey="tkRank" sort={sort} onSort={toggleSort} />
                    <SortableHeader label="RelVol" sortKey="relvolRank" sort={sort} onSort={toggleSort} />
                    <SortableHeader label="Liquidity" sortKey="liquidityRank" sort={sort} onSort={toggleSort} />
                    <SortableHeader label="Amihud" sortKey="amihudRank" sort={sort} onSort={toggleSort} />
                    <SortableHeader label="ADV20" sortKey="adv20Usd" sort={sort} onSort={toggleSort} />
                    <SortableHeader label="A0" sortKey="a0Signal" sort={sort} onSort={toggleSort} align="left" />
                    <SortableHeader label="Shadow" sortKey="shadowSignal" sort={sort} onSort={toggleSort} align="left" />
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((r) => (
                    <ScreenerRow key={r.symbol} row={r} />
                  ))}
                </tbody>
              </table>
              {filtered.length === 0 ? (
                <p className="p-8 text-center text-[12px] text-muted-foreground">
                  해당 조건의 종목이 없습니다.
                </p>
              ) : null}
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}


function SortableHeader({
  label,
  sortKey,
  sort,
  onSort,
  align = "right",
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; direction: SortDirection } | null;
  onSort: (key: SortKey) => void;
  align?: "left" | "right";
}) {
  const active = sort?.key === sortKey;
  const Icon = active ? (sort.direction === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  const ariaSort = active ? (sort.direction === "asc" ? "ascending" : "descending") : "none";

  return (
    <th className={align === "left" ? "!text-left" : undefined} aria-sort={ariaSort}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex w-full items-center gap-1 rounded px-1 py-0.5 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
          align === "left" ? "justify-start" : "justify-end"
        }`}
        title={active ? `${label} ${sort.direction === "asc" ? "오름차순" : "내림차순"} 정렬 중` : `${label} 정렬`}
      >
        <span>{label}</span>
        <Icon className={`size-3 ${active ? "text-foreground" : "opacity-40"}`} aria-hidden="true" />
      </button>
    </th>
  );
}

function ScreenerRow({ row: r }: { row: UsProspectiveCacheRow }) {
  return (
    <tr className="border-b border-border/60 last:border-0 [&>td]:px-2 [&>td]:py-2 [&>td]:text-right">
      <td className="!text-left">
        <span className="font-semibold">{r.symbol}</span>
        <span className="ml-1 text-muted-foreground">{r.name}</span>
      </td>
      <td className="!text-left text-muted-foreground">
        {r.market ?? "-"}
        <br />
        <span className="text-[9px]">{r.sector ?? "미분류"}</span>
      </td>
      <td>{r.close?.toFixed(2) ?? "-"}</td>
      <td>{pct(r.ret120)}</td>
      <td>{pct(r.ret252)}</td>
      <td>{pct(r.ret120Rank)}</td>
      <td>{pct(r.ret252Rank)}</td>
      <td>{r.onset80 ? "E80" : "-"}</td>
      <td>{r.betaWeakStreak}</td>
      <td className="font-semibold">{pct(r.coreRank)}</td>
      <td>{pct(r.betaRank)}</td>
      <td>{pct(r.tkRank)}</td>
      <td>{pct(r.relvolRank)}</td>
      <td>{pct(r.liquidityRank)}</td>
      <td>{pct(r.amihudRank)}</td>
      <td>{money(r.adv20Usd)}</td>
      <td className="!text-left">
        {r.a0Entry ? (
          <Badge className="bg-up text-white">ENTRY</Badge>
        ) : r.a0Exit ? (
          <Badge variant="outline">{r.a0BetaExit ? "EXIT · β Anchor" : "EXIT"}</Badge>
        ) : (
          <span className="text-muted-foreground">-</span>
        )}
      </td>
      <td className="!text-left text-[10px]">
        {r.a2Entry ? "A2 E " : ""}
        {r.a2Exit ? "A2 X " : ""}
        {r.b3Entry ? "B3 E " : ""}
        {r.b3Exit ? `B3 X${r.b3BetaExit ? "(β)" : ""}` : ""}
      </td>
    </tr>
  );
}
