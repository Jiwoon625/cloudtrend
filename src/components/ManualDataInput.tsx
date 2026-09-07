import { AlertTriangle, CheckCircle2, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { parseManualMarketData, type ManualParseStats } from "@/lib/engine/manualDataset";
import {
  clearManualData,
  getManualDataMeta,
  getManualDataText,
  hydrateManualData,
  saveManualDataText,
} from "@/lib/manualDataStore";
import { formatCount } from "@/lib/format";

/** 텍스트 영역에 그대로 담기에 너무 큰 입력은 미리보기만 보여준다. */
const TEXTAREA_LIMIT = 400_000;

interface Props {
  /** 데이터가 바뀌었을 때 상위(대시보드)에서 분석 캐시를 비우도록 알린다. */
  onChanged: (hasData: boolean) => void;
}

export function ManualDataInput({ onChanged }: Props) {
  const [text, setText] = useState("");
  const [meta, setMeta] = useState(() => getManualDataMeta());
  const [stats, setStats] = useState<ManualParseStats | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void hydrateManualData().then(() => {
      const saved = getManualDataText();
      if (saved && saved.length <= TEXTAREA_LIMIT) setText(saved);
      setMeta(getManualDataMeta());
      onChanged((saved ?? "").trim().length > 0);
    });
    // 최초 1회만 복원한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const apply = async (raw: string, name: string | null) => {
    setError(null);
    setBusy(true);
    try {
      const parsed = parseManualMarketData(raw);
      setStats(parsed.stats);
      setWarnings(parsed.warnings);
      setMeta(await saveManualDataText(raw, name));
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

  const onFile = async (file: File) => {
    const raw = await file.text();
    setText(raw.length > TEXTAREA_LIMIT ? "" : raw);
    setFileName(file.name);
    await apply(raw, file.name);
  };

  const reset = async () => {
    if (busy || !window.confirm("모든 기기에서 공유하는 이 CSV를 삭제할까요?")) return;
    setBusy(true);
    try {
      await clearManualData();
    } catch (e) {
      setError(e instanceof Error ? e.message : "삭제 실패");
      setBusy(false);
      return;
    }
    setBusy(false);
    setText("");
    setStats(null);
    setWarnings([]);
    setError(null);
    setMeta(null);
    setFileName(null);
    onChanged(false);
  };

  return (
    <div className="space-y-3">
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={
          "symbol,name,market,date,open,high,low,close,volume,tradingValue\n005930,삼성전자,KOSPI,2026-08-29,71000,72000,70800,71800,12345678,886...\nKOSPI,코스피,INDEX,2026-08-29,2650.1,2662.3,2644.0,2658.7,0,0"
        }
        className="h-40 font-mono text-[11px]"
        spellCheck={false}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={() => void apply(text, fileName)}
          disabled={busy || text.trim().length === 0}
        >
          {busy ? "저장 중…" : "데이터 적용"}
        </Button>

        <input
          ref={fileRef}
          type="file"
          accept=".csv,.txt,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFile(f);
            e.target.value = "";
          }}
        />
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={() => fileRef.current?.click()}
        >
          <Upload className="size-3.5" />
          CSV/JSON 업로드
        </Button>
        <Button size="sm" variant="ghost" className="gap-1.5 text-muted-foreground" onClick={reset}>
          <Trash2 className="size-3.5" />
          저장 데이터 삭제
        </Button>
        {meta ? (
          <span className="text-[11px] text-muted-foreground">
            Supabase 저장됨 · {meta.fileName ?? "붙여넣기"} · {formatCount(meta.chars)}자
          </span>
        ) : (
          <span className="text-[11px] text-muted-foreground">저장된 데이터 없음</span>
        )}
      </div>

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
            주식 {formatCount(stats.stocks)}종목 · ETF {formatCount(stats.etfs)}종목 · 지수{" "}
            {stats.indexes.join(", ") || "없음"} · 일봉 {formatCount(stats.bars)}건
          </p>
          <p className="mt-0.5 text-muted-foreground">
            기간 {stats.firstDate} ~ {stats.lastDate} · 아래 “스크리닝 시작”을 누르면 이 데이터로
            모든 탭이 계산됩니다.
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
    </div>
  );
}
