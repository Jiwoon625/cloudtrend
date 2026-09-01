import { useEffect, useState } from "react";
import { ListPlus } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { getEtfUniverse, setEtfUniverse } from "@/lib/market.functions";

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

export function EtfUniverseInput() {
  const queryClient = useQueryClient();
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void getEtfUniverse()
      .then((res) => {
        if (!alive || res.symbols.length === 0) return;
        setValue(res.symbols.join(", "));
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
      const res = await setEtfUniverse({ data: { symbols: codes } });
      await queryClient.invalidateQueries();
      setStatus(
        res.symbols.length > 0
          ? `ETF ${res.symbols.length}종목으로 지정했습니다. 일봉 수집 후 스크리너에 반영됩니다.`
          : "지정을 해제했습니다. 거래대금 상위 50개 ETF가 자동으로 선정됩니다.",
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
        스크리닝할 ETF 종목코드를 직접 입력하세요. 쉼표·공백·줄바꿈으로 구분합니다 (예: 069500,
        360750, 133690). 비워두고 저장하면 거래대금 상위 ETF가 자동 선정됩니다.
      </p>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={3}
        placeholder="069500, 360750, 133690"
        className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => void apply(codes)}>
          <ListPlus className="mr-1.5 h-3.5 w-3.5" />
          {busy ? "저장 중…" : `ETF ${codes.length}종목 적용`}
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
          자동 선정으로 초기화
        </Button>
      </div>
      {status ? <p className="text-[11px] text-muted-foreground">{status}</p> : null}
    </div>
  );
}
