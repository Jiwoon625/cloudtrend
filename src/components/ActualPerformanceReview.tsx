import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/cloud";
import { actualPerformanceServer } from "@/lib/actualPerformance.functions";
import {
  MAX_REVIEWED_PERFORMANCE_BYTES,
  actualPerformanceErrorMessage,
  parseReviewedPerformanceInput,
  type ReviewedPerformanceInput,
} from "@/lib/actualPerformanceInput";
import type { ActualPerformanceSeries } from "@/lib/ledger/actualPerformance";
import { ActualPerformancePanel } from "./ActualPerformancePanel";
import { Button } from "./ui/button";

type Preview = {
  input: ReviewedPerformanceInput;
  revision: number;
  series: ActualPerformanceSeries;
};
async function accessToken() {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) throw new Error("먼저 로그인해 주세요.");
  return data.session.access_token;
}
/** Deliberate reconciliation entry, not an automatic Notion import or a daily valuation scheduler. */
export function ActualPerformanceReview() {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [revisions, setRevisions] = useState<string | null>(null);
  const lock = useRef(false);
  const change = (value: string) => {
    setText(value);
    setPreview(null);
    setConfirmed(false);
    setMessage(null);
  };
  async function run(task: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setMessage(null);
    setFailed(false);
    try {
      await task();
    } catch (error) {
      setPreview(null);
      setConfirmed(false);
      setFailed(true);
      setMessage(actualPerformanceErrorMessage(error));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function loadRevisions() {
    return run(async () => {
      setPreview(null);
      setConfirmed(false);
      const loaded = await actualPerformanceServer({
        data: { accessToken: await accessToken(), action: "load" },
      });
      if (loaded.action !== "load") throw new Error("원장 버전을 확인하지 못했습니다.");
      setRevisions(
        `현재 한국 원장 ${loaded.revision ?? "없음"} · 미국 원장 ${loaded.usRevision ?? "없음"}`,
      );
      setMessage("대조용 원장 버전을 읽었습니다. 실제 금액이나 기준점은 변경하지 않았습니다.");
    });
  }
  function inspect() {
    return run(async () => {
      setPreview(null);
      setConfirmed(false);
      if (new TextEncoder().encode(text).length > MAX_REVIEWED_PERFORMANCE_BYTES)
        throw new Error("검토 파일은 256KB 이하로 준비해 주세요.");
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new Error("JSON 형식을 확인해 주세요. 검토 자료를 입력한 후 미리보기를 눌러 주세요.");
      }
      const input = parseReviewedPerformanceInput(raw);
      const token = await accessToken();
      const loaded = await actualPerformanceServer({
        data: { accessToken: token, action: "load" },
      });
      if (loaded.action !== "load") throw new Error("원장 버전을 확인하지 못했습니다.");
      if (loaded.revision === null) throw new Error("기존 실제 원장을 먼저 대조해 주세요.");
      setRevisions(`현재 한국 원장 ${loaded.revision} · 미국 원장 ${loaded.usRevision ?? "없음"}`);
      const result = await actualPerformanceServer({
        data: {
          accessToken: token,
          action: "preview",
          expectedRevision: loaded.revision,
          input,
        },
      });
      if (result.revision === null)
        throw new Error("원장 버전을 확인하지 못했습니다. 다시 대조해 주세요.");
      setPreview({ input, revision: result.revision, series: result.series });
      setMessage(
        "검사가 끝났습니다. 아래 신규 운용 범위와 배정 자료를 다시 확인한 뒤 확정해 주세요. 아직 저장하지 않았습니다.",
      );
    });
  }
  function save() {
    if (!preview || !confirmed) return;
    const reviewed = preview;
    return run(async () => {
      // Invalidate the local approval before submission. An uncertain response requires a fresh read/preview.
      setPreview(null);
      setConfirmed(false);
      await actualPerformanceServer({
        data: {
          accessToken: await accessToken(),
          action: "save",
          expectedRevision: reviewed.revision,
          input: reviewed.input,
          reviewConfirmed: true,
        },
      });
      change("");
      setMessage("성과 자료 저장을 확인했습니다. 기존 보유·체결·취득원가는 그대로 유지됩니다.");
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["portfolio-ledgers"] }),
        qc.invalidateQueries({ queryKey: ["actual-performance"] }),
      ]);
    });
  }
  const valuation =
    preview?.input.action === "confirmBaseline"
      ? preview.input.baseline.valuation
      : preview?.input.observation.valuation;
  return (
    <details className="mb-4 rounded-lg border bg-card p-4">
      <summary className="cursor-pointer font-medium">실제 성과 자료 대조·확정</summary>
      <p className="mt-3 text-sm text-muted-foreground">
        토요일 원장 대조 후 준비한 구조화 자료를 검사하는 입력 경로입니다. 실제 배정 현금·환율은
        비워 두며, 일별 자동평가에 필요한 실제 원장 연결은 대조 후 결정합니다.
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        시작 자료에는 신규 구간에 실제 배정한 현금만 넣고 보유종목·기존 미결제금은 넣지 않습니다.
        일별 기록에는 새 구간의 현금·보유 평가, 원본 체결에 연결한 신규 매매 배정, 입출금을
        포함합니다. 기존 보유 매도대금의 재배정은 외부입금입니다. 가격·현금 증빙을 실제 확보한
        시점은 검토자가 대조합니다. 원시 거래 전체나 비밀정보는 넣지 마세요.
      </p>
      <Button
        className="mt-3"
        type="button"
        variant="outline"
        disabled={busy}
        onClick={() => void loadRevisions()}
      >
        대조용 원장 버전 확인
      </Button>
      <p className="mt-2 text-sm text-muted-foreground">
        같은 종목의 기존·신규 보유가 섞인 매도는 신규 구간에 배정할 수량·거래금액·실제 비용을 직접
        확인해야 합니다. FIFO나 비례 배분으로 자동 결정하지 않습니다.
      </p>
      <label className="mt-3 block text-sm font-medium" htmlFor="actual-performance-json">
        검토된 성과 자료 (JSON)
      </label>
      <textarea
        id="actual-performance-json"
        className="mt-1 min-h-40 w-full rounded border bg-background p-2 font-mono text-xs"
        value={text}
        onChange={(e) => change(e.target.value)}
        disabled={busy}
        placeholder="확정된 대조 자료만 입력해 주세요. 금액이나 환율은 자동으로 채우지 않습니다."
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <label className="text-sm">
          검토 파일 읽기
          <input
            className="ml-2 max-w-full text-xs"
            type="file"
            accept="application/json,.json"
            disabled={busy}
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = "";
              if (!file) return;
              void run(async () => {
                if (file.size > MAX_REVIEWED_PERFORMANCE_BYTES)
                  throw new Error("검토 파일은 256KB 이하로 준비해 주세요.");
                change(await file.text());
              });
            }}
          />
        </label>
        <Button
          type="button"
          variant="outline"
          disabled={busy || !text.trim()}
          onClick={() => void inspect()}
        >
          {busy ? "검사·저장 중…" : "검사 후 미리보기"}
        </Button>
      </div>
      {revisions ? <p className="mt-2 text-xs text-muted-foreground">{revisions}</p> : null}
      {message ? (
        <p
          className={`mt-3 text-sm ${failed ? "text-warn" : ""}`}
          role={failed ? "alert" : "status"}
        >
          {message}
        </p>
      ) : null}
      {preview && valuation ? (
        <div className="mt-4 border-t pt-4">
          <h3 className="mb-2 font-medium">
            저장 전 미리보기 ·{" "}
            {preview.input.action === "confirmBaseline" ? "시작 기준점" : "일별 평가"}
          </h3>
          <ActualPerformancePanel series={preview.series} />
          <p className="text-xs text-muted-foreground">
            평가일 {valuation.date} · 기록시각 {valuation.recordedAt}
          </p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <caption className="mb-2 text-left">계좌별 신규 구간 배정 범위</caption>
              <thead>
                <tr>
                  {["계좌", "통화", "현금", "미결제금", "총평가", "보유 수"].map((x) => (
                    <th className="p-2" key={x}>
                      {x}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {valuation.accounts.map((a) => (
                  <tr className="border-t" key={`${a.accountId}:${a.currency}`}>
                    {[
                      a.accountId,
                      a.currency,
                      a.cash ?? "미확정",
                      a.unsettledCash ?? "미확정",
                      a.equity ?? "미확정",
                      a.positions.length,
                    ].map((x, i) => (
                      <td className="p-2" key={i}>
                        {x}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details className="mt-3 text-xs">
            <summary className="cursor-pointer">가격·환율·입출금 및 증빙 전체 확인</summary>
            <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-muted p-3">
              {JSON.stringify(preview.input, null, 2)}
            </pre>
          </details>
          <label className="mt-4 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>
              Notion·증권사 자료와 신규 구간 수량·거래금액·비용·현금 배정, 평가일, 가격·환율,
              입출금을 대조하고 기존 보유·미배정 현금을 제외했습니다. 거래 비용과 별도 비용 조정에
              같은 수수료를 중복 입력하지 않았습니다. 확정된 기준점과 일별 기록은 덮어쓸 수 없음을
              확인합니다.
            </span>
          </label>
          <Button
            className="mt-3"
            type="button"
            disabled={busy || !confirmed}
            onClick={() => void save()}
          >
            검토한 자료 확정 저장
          </Button>
        </div>
      ) : null}
    </details>
  );
}
