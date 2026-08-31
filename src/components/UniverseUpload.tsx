import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { setUniverse } from "@/lib/market.functions";

function parseSymbols(text: string): Array<{ symbol: string; name: string }> {
  const out: Array<{ symbol: string; name: string }> = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const [a = "", b = ""] = line.split(/[,\t;]/);
    const symbol = a.trim().replace(/^["']|["']$/g, "");
    if (!/^[0-9A-Z]{6}$/i.test(symbol)) continue; // 헤더·빈줄 무시
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    out.push({ symbol: symbol.toUpperCase(), name: b.trim() });
  }
  return out;
}

export function UniverseUpload() {
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleFile = async (file: File) => {
    setBusy(true);
    setStatus(null);
    try {
      const text = await file.text();
      const parsed = parseSymbols(text);
      if (parsed.length === 0) {
        setStatus("CSV에서 유효한 종목코드를 찾지 못했습니다. (형식: symbol,name)");
        return;
      }
      const res = await setUniverse({ data: { symbols: parsed.map((p) => p.symbol) } });
      await queryClient.invalidateQueries();
      setStatus(
        `${res.count}종목으로 유니버스를 교체했습니다. 일봉 수집이 다시 시작되며, 잠시 후 새로고침하면 더 많은 종목이 표시됩니다.`,
      );
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "업로드에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <p className="text-[12px] text-muted-foreground">
        코스피200 구성종목 CSV(첫 열 종목코드, 둘째 열 종목명)를 올리면 스크리닝 유니버스가 해당
        목록으로 교체됩니다.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv,text/plain"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
            e.target.value = "";
          }}
        />
        <Button size="sm" disabled={busy} onClick={() => inputRef.current?.click()}>
          <Upload className="mr-1.5 h-3.5 w-3.5" />
          {busy ? "업로드 중…" : "CSV 업로드"}
        </Button>
      </div>
      {status ? <p className="text-[11px] text-muted-foreground">{status}</p> : null}
    </div>
  );
}
