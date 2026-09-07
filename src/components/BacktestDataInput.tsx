import { AlertTriangle, CheckCircle2, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { ManualParseStats } from "@/lib/engine/manualDataset";
import {
  clearBacktestData,
  getBacktestDataMeta,
  hydrateBacktestData,
  loadBacktestDataset,
  saveBacktestData,
  type BacktestDataMeta,
} from "@/lib/backtestDataStore";
import { formatCount } from "@/lib/format";

const MB = 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

interface Props {
  /** 저장 데이터가 바뀌었을 때 알린다(있으면 true). */
  onChanged: (hasData: boolean) => void;
}

export function BacktestDataInput({ onChanged }: Props) {
  const [meta, setMeta] = useState<BacktestDataMeta | null>(null);
  const [text, setText] = useState("");
  const [stats, setStats] = useState<ManualParseStats | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void hydrateBacktestData()
      .then(() => {
        const m = getBacktestDataMeta();
        setMeta(m);
        onChanged(!!m);
      })
      .catch((e: Error) => setError(e.message));
    // 최초 1회만 복원한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const apply = async (source: Blob | string, name: string | null) => {
    setError(null);
    setBusy(true);
    try {
      setMeta(await saveBacktestData(source, name));
      const parsed = await loadBacktestDataset();
      setStats(parsed?.stats ?? null);
      setWarnings(parsed?.warnings ?? []);
      onChanged(true);
    } catch (e) {
      setStats(null);
      setWarnings([]);
      setError(e instanceof Error ? e.message : "데이터를 해석할 수 없습니다.");
      onChanged(false);
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (busy || !window.confirm("모든 기기에서 공유하는 이 CSV를 삭제할까요?")) return;
    setBusy(true);
    try {
      await clearBacktestData();
    } catch (e) {
      setError(e instanceof Error ? e.message : "삭제 실패");
      setBusy(false);
      return;
    }
    setBusy(false);
    setMeta(null);
    setText("");
    setStats(null);
    setWarnings([]);
    setError(null);
    onChanged(false);
  };

  return (
    <section className="space-y-2 rounded-lg border border-border bg-card p-3">
      <h2 className="text-sm font-semibold">백테스트용 장기 데이터</h2>
      <p className="text-[11px] text-muted-foreground">
        스크리닝 데이터와 별도로 Supabase에 보관됩니다. 최신 파일 1개, 저장 크기 45MB까지
        지원합니다.
      </p>

      <input
        ref={fileRef}
        type="file"
        accept=".csv,.txt,.json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void apply(f, f.name);
          e.target.value = "";
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          className="gap-1.5"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          <Upload className="size-3.5" />
          {busy ? "저장 중…" : "CSV/JSON 업로드"}
        </Button>
        <Button size="sm" variant="ghost" className="gap-1.5 text-muted-foreground" onClick={reset}>
          <Trash2 className="size-3.5" />
          삭제
        </Button>
      </div>

      <details className="text-[11px] text-muted-foreground">
        <summary className="cursor-pointer">텍스트로 붙여넣기</summary>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="symbol,name,market,date,open,high,low,close,volume"
          className="mt-2 h-28 font-mono text-[11px]"
          spellCheck={false}
        />
        <Button
          size="sm"
          variant="outline"
          className="mt-2"
          disabled={busy || text.trim().length === 0}
          onClick={() => void apply(text, "붙여넣기")}
        >
          붙여넣은 데이터 적용
        </Button>
      </details>

      {meta ? (
        <p className="text-[11px] text-muted-foreground">
          Supabase 저장됨 · {meta.fileName ?? "붙여넣기"} · {formatBytes(meta.bytes)}
        </p>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          백테스트 전용 데이터가 없으면 “데이터·산식” 탭의 스크리닝 데이터를 사용합니다.
        </p>
      )}

      {error ? (
        <p className="flex items-start gap-1.5 rounded-md border border-down/40 bg-down/10 p-2 text-[12px] text-down">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          {error}
        </p>
      ) : null}

      {stats ? (
        <div className="rounded-md border border-up/40 bg-up/10 p-2 text-[12px]">
          <p className="flex items-center gap-1.5 font-medium text-up">
            <CheckCircle2 className="size-3.5" />
            주식 {formatCount(stats.stocks)}종목 · ETF {formatCount(stats.etfs)}종목 · 일봉{" "}
            {formatCount(stats.bars)}건
          </p>
          <p className="mt-0.5 text-muted-foreground">
            기간 {stats.firstDate} ~ {stats.lastDate}
          </p>
          {warnings.length > 0 ? (
            <ul className="mt-1 list-inside list-disc text-[11px] text-warn">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
