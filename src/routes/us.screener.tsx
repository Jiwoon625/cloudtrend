import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
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

type Filter = "PRIMARY_ENTRY" | "PRIMARY_EXIT" | "A2_ENTRY" | "B3_ENTRY" | "B3_EXIT" | "ALL";

function pct(v: number | null, digits = 1) { return v === null ? "-" : `${(v * 100).toFixed(digits)}%`; }
function money(v: number | null) { if (v === null) return "-"; if (v >= 1e9) return `$${(v/1e9).toFixed(1)}B`; if (v >= 1e6) return `$${(v/1e6).toFixed(1)}M`; return `$${v.toLocaleString()}`; }

function UsScreenerPage() {
  const query = useQuery({ queryKey: ["us-prospective-cache"], queryFn: loadUsProspectiveCache, staleTime: 60_000 });
  const [filter, setFilter] = useState<Filter>("PRIMARY_ENTRY");
  const [search, setSearch] = useState("");
  const rows = query.data?.analysis.rows ?? [];
  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    return rows.filter((r) => {
      if (r.symbol === "SPY") return false;
      if (q && !r.symbol.includes(q) && !r.name.toUpperCase().includes(q)) return false;
      if (filter === "PRIMARY_ENTRY") return r.a0Entry;
      if (filter === "PRIMARY_EXIT") return r.a0Exit;
      if (filter === "A2_ENTRY") return r.a2Entry;
      if (filter === "B3_ENTRY") return r.b3Entry;
      if (filter === "B3_EXIT") return r.b3Exit;
      return r.coreRank !== null;
    });
  }, [rows, filter, search]);

  const download = () => {
    const header = ["date","symbol","name","market","sector","close","ret120","ret252","coreRank","betaRank","tkRank","relvolRank","liquidityRank","amihudRank","a0Entry","a0Exit","a2Entry","b3Entry","b3Exit"];
    const body = filtered.map((r) => header.map((k) => JSON.stringify((r as unknown as Record<string, unknown>)[k] ?? "")).join(","));
    const blob = new Blob([[header.join(","), ...body].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href=url; a.download=`cloudtrend-us-${query.data?.analysis.date ?? "latest"}.csv`; a.click(); URL.revokeObjectURL(url);
  };

  return <AppShell loadAnalysis={false}>
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div><div className="flex items-center gap-2"><h1 className="text-xl font-bold">US 스크리너</h1><Badge>A0 PRIMARY</Badge></div><p className="mt-1 text-[11px] text-muted-foreground">기준일 {query.data?.analysis.date ?? "-"} · E80 Onset / X70 · Core ret120/252 50:50 · 숫자 재튜닝 금지</p></div>
        <div className="flex gap-2"><Link to="/us/portfolio"><Button size="sm" variant="outline">US 포트폴리오</Button></Link><Button size="sm" variant="outline" onClick={download}><Download className="size-3.5"/>CSV</Button></div>
      </header>
      {!query.data ? <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">아직 GitHub 엔진이 생성한 US 결과가 없습니다. Colab 수집기를 실행한 뒤 workflow가 완료되면 표시됩니다.</div> : <>
        <div className="flex flex-wrap gap-1">
          {([ ["PRIMARY_ENTRY","A0 신규진입"], ["PRIMARY_EXIT","A0 청산"], ["A2_ENTRY","A2 Shadow 진입"], ["B3_ENTRY","B3 Shadow 진입"], ["B3_EXIT","B3 Shadow 청산"], ["ALL","전체"] ] as Array<[Filter,string]>).map(([id,label]) => <button key={id} onClick={()=>setFilter(id)} className={`rounded-full border px-2.5 py-1 text-[11px] ${filter===id ? "border-primary bg-primary text-primary-foreground":"border-border bg-card"}`}>{label}</button>)}
        </div>
        <div className="rounded-lg border border-border bg-card p-3"><Input className="h-8 max-w-sm text-[12px]" value={search} onChange={(e)=>setSearch(e.target.value)} placeholder="티커 또는 종목명"/></div>
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full min-w-[1280px] text-[11px]"><thead><tr className="border-b bg-surface-strong text-muted-foreground [&>th]:px-2 [&>th]:py-2 [&>th]:text-right"><th className="!text-left">종목</th><th className="!text-left">시장/섹터</th><th>종가</th><th>120D</th><th>252D</th><th>Core</th><th>Beta</th><th>TK</th><th>RelVol</th><th>Liquidity</th><th>Amihud</th><th>ADV20</th><th className="!text-left">A0</th><th className="!text-left">Shadow</th></tr></thead>
          <tbody>{filtered.map((r)=><ScreenerRow key={r.symbol} row={r}/>)}</tbody></table>
          {filtered.length===0 ? <p className="p-8 text-center text-[12px] text-muted-foreground">해당 조건의 종목이 없습니다.</p>:null}
        </div>
      </>}
    </div>
  </AppShell>;
}

function ScreenerRow({ row:r }: { row: UsProspectiveCacheRow }) {
  return <tr className="border-b border-border/60 last:border-0 [&>td]:px-2 [&>td]:py-2 [&>td]:text-right">
    <td className="!text-left"><span className="font-semibold">{r.symbol}</span><span className="ml-1 text-muted-foreground">{r.name}</span></td>
    <td className="!text-left text-muted-foreground">{r.market ?? "-"}<br/><span className="text-[9px]">{r.sector ?? "미분류"}</span></td>
    <td>{r.close?.toFixed(2) ?? "-"}</td><td>{pct(r.ret120)}</td><td>{pct(r.ret252)}</td><td className="font-semibold">{pct(r.coreRank)}</td><td>{pct(r.betaRank)}</td><td>{pct(r.tkRank)}</td><td>{pct(r.relvolRank)}</td><td>{pct(r.liquidityRank)}</td><td>{pct(r.amihudRank)}</td><td>{money(r.adv20Usd)}</td>
    <td className="!text-left">{r.a0Entry?<Badge className="bg-up text-white">ENTRY</Badge>:r.a0Exit?<Badge variant="outline">EXIT</Badge>:<span className="text-muted-foreground">-</span>}</td>
    <td className="!text-left text-[10px]">{r.a2Entry?"A2 E ":""}{r.b3Entry?"B3 E ":""}{r.b3Exit?`B3 X${r.b3BetaExit?"(β)":""}`:""}</td>
  </tr>;
}