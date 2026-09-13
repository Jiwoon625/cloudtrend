import { AlertTriangle, CheckCircle2, Trash2, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { ManualParseStats } from "@/lib/engine/manualDataset";
import {
  appendManualDataSource,
  clearManualData,
  ensureManualDataset,
  getManualFiles,
  getManualTotalBytes,
  hasManualData,
  hydrateManualData,
  removeManualDataSource,
  type ManualSourceFileEntry,
} from "@/lib/manualDataStore";
import { formatCount } from "@/lib/format";

const MB = 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

interface Props {
  /** 데이터가 바뀌었을 때 상위(대시보드)에서 분석 캐시를 비우도록 알린다. */
  onChanged: (hasData: boolean) => void;
}

export function ManualDataInput({ onChanged }: Props) {
  const [files, setFiles] = useState<ManualSourceFileEntry[]>([]);
  const [text, setText] = useState("");
  const [stats, setStats] = useState<ManualParseStats | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const sync = () => {
    const current = getManualFiles();
    setFiles([...current]);
    onChanged(hasManualData());
  };

  useEffect(() => {
    void hydrateManualData(false)
      .then(sync)
      .catch((e: Error) => setError(e.message));
    // 최초 1회만 복원한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshStats = async () => {
    if (!hasManualData()) {
      setStats(null);
      setWarnings([]);
      return;
    }
    setBusy("통합 데이터 확인 중…");
    try {
      const parsed = await ensureManualDataset();
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

  const add = async (sources: Array<{ source: Blob | string; name: string | null }>) => {
    setError(null);
    const failures: string[] = [];
    for (const { source, name } of sources) {
      setBusy(`${name ?? "데이터"} 저장 중…`);
      try {
        await appendManualDataSource(source, name);
      } catch (e) {
        failures.push(`${name ?? "데이터"}: ${e instanceof Error ? e.message : "저장하지 못했습니다."}`);
      }
    }
    sync();
    if (failures.length > 0) setError(failures.join("\n"));
    await refreshStats();
  };

  const removeOne = async (entry: ManualSourceFileEntry) => {
    if (busy) return;
    setError(null);
    setBusy("삭제 중…");
    try {
      await removeManualDataSource(entry.id);
      sync();
    } catch (e) {
      setError(e instanceof Error ? e.message : "삭제 실패");
    } finally {
      setBusy(null);
    }
    await refreshStats();
  };

  const reset = async () => {
    if (busy || !window.confirm("모든 기기에서 공유하는 스크리닝 원천파일을 전부 삭제할까요?")) return;
    setBusy("삭제 중…");
    try {
      await clearManualData();
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
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-muted-foreground">
        장기 백테스트와 동일한 Toss+KRX 102컬럼 자료형을 여러 파일로 나눠 올릴 수 있습니다. 파일
        1개는 45MB 이하이며 개수 제한은 두지 않습니다. 스크리닝 시작 시 활성 파일을 모두 합쳐
        하나의 시계열로 사용합니다. 완전히 같은 종목·거래일 중복은 한 번만 사용하고, 값이 다른
        중복은 잘못된 혼합을 막기 위해 업로드를 거부합니다. 현재 Vf 점수는 검증된 7개 피처만
        사용하며 섹터 0.5점 실험은 포함하지 않습니다.
      </p>

      <input
        ref={fileRef}
        type="file"
        multiple
        accept=".csv,.txt,.json,.xlsx"
        className="hidden"
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          if (picked.length)
            void add(picked.map((file) => ({ source: file as Blob, name: file.name })));
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
          {busy ?? "CSV/XLSX/JSON 여러 파일 추가"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="gap-1.5 text-muted-foreground"
          disabled={!!busy || !hasManualData()}
          onClick={() => void reset()}
        >
          <Trash2 className="size-3.5" />
          전체 삭제
        </Button>
      </div>

      <details className="text-[11px] text-muted-foreground">
        <summary className="cursor-pointer">텍스트로 데이터 추가</summary>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={
            "symbol,name,market,type,date,open,high,low,close,volume,tradingValue,marketCap,foreignNetBuyValue\n005930,삼성전자,KOSPI,STOCK,2026-08-29,71000,72000,70800,71800,12345678,886000000000,420000000000000,12500000000"
          }
          className="mt-2 h-32 font-mono text-[11px]"
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
            void add([{ source: value, name: "붙여넣기.csv" }]);
          }}
        >
          붙여넣은 데이터 추가
        </Button>
      </details>

      {files.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-[11px] text-muted-foreground">
            Supabase 활성 파일 {files.length}개 · 합계 {formatBytes(getManualTotalBytes())}
          </p>
          <ul className="max-h-56 space-y-1 overflow-auto pr-1">
            {files.map((file) => (
              <li
                key={file.id}
                className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1.5 text-[11px]"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{file.fileName}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {formatBytes(file.bytes)} · {formatCount(file.rows)}행 · {formatCount(file.symbols)}심볼
                    {file.minDate && file.maxDate ? ` · ${file.minDate} ~ ${file.maxDate}` : ""}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label={`${file.fileName} 삭제`}
                  className="shrink-0 text-muted-foreground hover:text-down"
                  disabled={!!busy}
                  onClick={() => void removeOne(file)}
                >
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : hasManualData() ? (
        <p className="rounded-md border border-warn/30 bg-warn/10 p-2 text-[11px] text-warn">
          기존 단일 스크리닝 데이터가 있습니다. 새 파일을 추가하면 원천파일 registry 기반 다중파일
          방식으로 전환됩니다.
        </p>
      ) : (
        <p className="text-[11px] text-muted-foreground">저장된 스크리닝 원천파일이 없습니다.</p>
      )}

      {error ? (
        <p className="whitespace-pre-wrap rounded-md border border-down/40 bg-down/10 p-2 text-[12px] text-down">
          <span className="inline-flex items-start gap-1.5">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>{error}</span>
          </span>
        </p>
      ) : null}

      {stats ? (
        <div className="rounded-md border border-up/40 bg-up/10 p-2 text-[12px]">
          <p className="flex items-center gap-1.5 font-medium text-up">
            <CheckCircle2 className="size-3.5" />
            통합 결과 · 주식 {formatCount(stats.stocks)}종목 · ETF {formatCount(stats.etfs)}종목 · 지수{" "}
            {stats.indexes.join(", ") || "없음"} · 일봉 {formatCount(stats.bars)}건
          </p>
          <p className="mt-0.5 text-muted-foreground">
            기간 {stats.firstDate} ~ {stats.lastDate} · 아래 “스크리닝 시작”을 누르면 활성 파일 전체로
            대시보드·스크리너·상세화면을 계산합니다.
          </p>
          {warnings.length > 0 ? (
            <ul className="mt-1 list-inside list-disc text-[11px] text-warn">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
