import { AlertTriangle, CheckCircle2, Trash2, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { ManualParseStats } from "@/lib/engine/manualDataset";
import {
  addBacktestFile,
  clearBacktestData,
  getBacktestFiles,
  getBacktestTotalBytes,
  hydrateBacktestData,
  loadBacktestDataset,
  removeBacktestFile,
  type BacktestFileEntry,
} from "@/lib/backtestDataStore";
import { formatCount } from "@/lib/format";

const MB = 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

interface Props {
  /** 저장 데이터가 바뀌었을 때 알린다(1개 이상이면 true). */
  onChanged: (hasData: boolean) => void;
}

export function BacktestDataInput({ onChanged }: Props) {
  const [files, setFiles] = useState<BacktestFileEntry[]>([]);
  const [text, setText] = useState("");
  const [stats, setStats] = useState<ManualParseStats | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const sync = () => {
    const list = getBacktestFiles();
    setFiles([...list]);
    onChanged(list.length > 0);
  };

  useEffect(() => {
    void hydrateBacktestData()
      .then(sync)
      .catch((e: Error) => setError(e.message));
    // 최초 1회만 복원한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const add = async (sources: Array<{ source: Blob | string; name: string | null }>) => {
    setError(null);
    for (const { source, name } of sources) {
      setBusy(`${name ?? "데이터"} 저장 중…`);
      try {
        await addBacktestFile(source, name);
      } catch (e) {
        setError(
          `${name ?? "데이터"}: ${e instanceof Error ? e.message : "저장하지 못했습니다."}`,
        );
      }
    }
    sync();
    setBusy("데이터 확인 중…");
    try {
      const parsed = await loadBacktestDataset();
      setStats(parsed?.stats ?? null);
      setWarnings(parsed?.warnings ?? []);
    } catch (e) {
      setStats(null);
      setWarnings([]);
      setError(e instanceof Error ? e.message : "데이터를 해석할 수 없습니다.");
    } finally {
      setBusy(null);
    }
  };

  const removeOne = async (entry: BacktestFileEntry) => {
    if (busy) return;
    setBusy("삭제 중…");
    try {
      await removeBacktestFile(entry.id);
      setStats(null);
      setWarnings([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "삭제 실패");
    } finally {
      setBusy(null);
      sync();
    }
  };

  const reset = async () => {
    if (busy || !window.confirm("업로드한 모든 백테스트용 데이터를 삭제할까요?")) return;
    setBusy("삭제 중…");
    try {
      await clearBacktestData();
      setText("");
      setStats(null);
      setWarnings([]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "삭제 실패");
    } finally {
      setBusy(null);
      sync();
    }
  };

  return (
    <section className="space-y-2 rounded-lg border border-border bg-card p-3">
      <h2 className="text-sm font-semibold">백테스트용 장기 데이터</h2>
      <p className="text-[11px] text-muted-foreground">
        스크리닝 데이터와 별도로 Supabase에 보관됩니다. 파일 1개는 45MB 이하, 개수 제한은 없으며
        백테스트 실행 시 여기 있는 모든 파일을 합쳐서 사용합니다.
      </p>

      <input
        ref={fileRef}
        type="file"
        multiple
        accept=".csv,.txt,.json"
        className="hidden"
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          if (picked.length)
            void add(picked.map((f) => ({ source: f as Blob, name: f.name })));
          e.target.value = "";
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          className="gap-1.5"
          disabled={!!busy}
          onClick={() => fileRef.current?.click()}
        >
          <Upload className="size-3.5" />
          {busy ?? "CSV/JSON 추가 업로드"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="gap-1.5 text-muted-foreground"
          disabled={!!busy || files.length === 0}
          onClick={() => void reset()}
        >
          <Trash2 className="size-3.5" />
          전체 삭제
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
          disabled={!!busy || text.trim().length === 0}
          onClick={() => {
            const value = text;
            setText("");
            void add([{ source: value, name: "붙여넣기" }]);
          }}
        >
          붙여넣은 데이터 추가
        </Button>
      </details>

      {files.length > 0 ? (
        <div className="space-y-1">
          <p className="text-[11px] text-muted-foreground">
            저장된 파일 {files.length}개 · 합계 {formatBytes(getBacktestTotalBytes())}
          </p>
          <ul className="space-y-1">
            {files.map((f) => (
              <li
                key={f.id}
                className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1 text-[11px]"
              >
                <span className="truncate">
                  {f.fileName ?? "붙여넣기"} · {formatBytes(f.bytes)}
                </span>
                <button
                  type="button"
                  aria-label={`${f.fileName ?? "붙여넣기"} 삭제`}
                  className="text-muted-foreground hover:text-down"
                  disabled={!!busy}
                  onClick={() => void removeOne(f)}
                >
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </div>
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
