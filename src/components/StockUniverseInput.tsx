import { useEffect, useState } from "react";
import { ListPlus } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { getUniverse, setUniverse } from "@/lib/market.functions";

function parseCodes(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[\s,;\t]+/)) {
    const code = raw.trim().replace(/^["']|["']$/g, "").toUpperCase();
    if (!/^[0-9A-Z]{6}$/.test(code)) continue;
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

export function StockUniverseInput() {
  const queryClient = useQueryClient();
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void getUniverse()
      .then((res) => {
        if (!alive) return;
        if (res.custom) setValue(res.symbols.join(", "));
        else setStatus(`현재 내장 코스피200 스냅샷 ${res.count}종목을 사용 중입니다.`);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const apply = async (codes: string[]) => {
    setBusy(true);
    setStatus(null);
    try {
      const res = await setUniverse({ data: { symbols: codes } });
      await queryClient.invalidateQueries();
      setStatus(
        res.custom
          ? `주식 ${res.count}종목으로 유니버스를 교체했습니다. 일봉 수집이 다시 시작되며 진행률이 아래에 표시됩니다.`
          : `내장 코스피200 스냅샷 ${res.count}종목으로 되돌렸습니다.`,
      );
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "저장에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const codes = parseCodes(value);

  return (
    <div className="space-y-2">
      <p className="text-[12px] text-muted-foreground">
        스크리닝할 코스피·코스닥 종목코드를 직접 입력하세요. 쉼표·공백·줄바꿈으로 구분합니다 (예:
        005930, 000660, 247540). 비워두고 저장하면 내장 코스피200 스냅샷을 사용합니다.
      </p>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={4}
        placeholder="005930, 000660, 247540"
        className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => void apply(codes)}>
          <ListPlus className="mr-1.5 h-3.5 w-3.5" />
          {busy ? "저장 중…" : `주식 ${codes.length}종목 적용`}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setValue("");
            void apply([]);
          }}
        >
          코스피200 기본값으로 초기화
        </Button>
      </div>
      {status ? <p className="text-[11px] text-muted-foreground">{status}</p> : null}
    </div>
  );
}
