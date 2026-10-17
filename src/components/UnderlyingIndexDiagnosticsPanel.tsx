import { useState } from "react";
import { supabase } from "@/lib/cloud";
import {
  installUnderlyingIndexArtifactServer,
  readUnderlyingIndexDiagnosticsServer,
} from "@/lib/underlyingIndexDiagnostics.functions";
import { Button } from "@/components/ui/button";

type Result = Awaited<ReturnType<typeof readUnderlyingIndexDiagnosticsServer>>;
async function accessToken() {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) throw new Error("먼저 로그인해 주세요.");
  return data.session.access_token;
}
async function compressedFile(file: File) {
  if (file.size > 16 * 1024 * 1024) throw new Error("검증자료 크기는 16MB 이하여야 합니다.");
  const bytes = new Uint8Array(
    await new Response(file.stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer(),
  );
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
const number = (value: number | null) =>
  value === null ? "미확인" : value.toLocaleString("ko-KR", { maximumFractionDigits: 6 });
export function UnderlyingIndexDiagnosticsPanel() {
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [file, setFile] = useState<File | null>(null);
  async function read() {
    setResult(null);
    setBusy(true);
    setError("");
    try {
      setResult(
        await readUnderlyingIndexDiagnosticsServer({ data: { accessToken: await accessToken() } }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function install() {
    if (!file) return;
    setResult(null);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const installed = await installUnderlyingIndexArtifactServer({
        data: { accessToken: await accessToken(), compressedBase64: await compressedFile(file) },
      });
      setNotice(
        installed.reused
          ? "동일한 검증자료가 이미 연결되어 있습니다. 중복 저장하지 않았습니다."
          : "검증된 기초지수 전용 자료만 연결했습니다. 원래 가격자료는 그대로입니다.",
      );
      setResult(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const ready = result?.status === "ready" ? result : null;
  const rows =
    ready?.report.rows
      .filter((r) => `${r.symbol} ${r.name}`.toLowerCase().includes(search.toLowerCase()))
      .slice(0, 50) ?? [];
  return (
    <section
      id="underlying-index-diagnostics"
      aria-label="기초지수 연결 검증"
      className="min-w-0 space-y-3 rounded-lg border bg-card p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">기초지수 연결 검증</h2>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void read()}>
          {busy ? "백엔드 검증 중" : "기초지수 비교 계산"}
        </Button>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        기존 장기자료의 기초지수만 백엔드에서 별도로 읽어 활성 입력과 비교합니다.
        가격·거래량·원천·기존 Shadow·원장은 수정하지 않습니다. 계산에는 활성 원천 전체를 읽으므로
        잠시 걸릴 수 있습니다.
      </p>
      <p className="text-xs font-medium">
        진단 전용: 이 MA60는 현재 매매신호·전략 적격·비주식형 ETF 매도규칙에 반영되지 않습니다.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {result?.status === "not-installed" && (
        <p className="text-sm">
          검증된 기초지수 전용 자료가 아직 연결되지 않았습니다. 일반 스크리닝 업로드는 사용하지
          마세요.
        </p>
      )}
      {result?.status === "disabled" && (
        <p className="text-sm">기초지수 진단 연결이 비활성화되어 있습니다.</p>
      )}
      {ready && (
        <>
          <p className="text-sm">
            기준일 {ready.report.asOfDate} · {ready.report.summary.symbols.toLocaleString()} ETF ·
            비교 MA60 확보 {ready.report.summary.ma60Available.toLocaleString()} · 활성 원천 재계산
            대비 신규 확보 {ready.report.summary.newlyAvailable.toLocaleString()} · 격리{" "}
            {ready.report.summary.quarantined.toLocaleString()} · 이력 부족{" "}
            {ready.report.summary.incomplete.toLocaleString()} · 사용자 선택 빈티지{" "}
            {ready.report.summary.approvedPreferenceSymbols.toLocaleString()}종/
            {ready.report.summary.approvedPreferenceObservations.toLocaleString()}관측
          </p>
          <p className="text-xs text-muted-foreground">
            원천 {ready.activeSourcesRead}개 바이트 해시 재검증 · 가격 입력 전후 해시 동일 · 진단 중
            저장 0회 · 원천 기준 {ready.report.sourceCutoffDate}
          </p>
          <label className="block text-xs">
            종목 검색
            <input
              className="mt-1 block w-full rounded border bg-background p-2 text-sm"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="종목코드 또는 이름"
            />
          </label>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr>
                  <th className="p-2">종목</th>
                  <th className="p-2">활성 원천 재계산 MA60</th>
                  <th className="p-2">별도 비교 MA60</th>
                  <th className="p-2">유효 관측</th>
                  <th className="p-2">검증 상태</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.symbol} className="border-t">
                    <td className="p-2">
                      {r.symbol}
                      <br />
                      {r.name}
                    </td>
                    <td className="p-2">{number(r.activeMa60)}</td>
                    <td className="p-2">
                      {number(r.diagnosticMa60)}
                      {r.userSelectedVintage && (
                        <>
                          <br />
                          사용자 선택 보강 빈티지
                        </>
                      )}
                    </td>
                    <td className="p-2">
                      {r.activeValidCount} → {r.combinedValidCount}/60
                    </td>
                    <td className="p-2">
                      {r.issues.join(" / ") ||
                        (r.userSelectedVintage
                          ? `승인 충돌 ${r.approvedPreferenceDates.length}일 보강값 우선 · 원본 유지 · 신호 미적용`
                          : "") ||
                        (r.status === "compared"
                          ? "지수명·중복값 대조 통과 (진단용)"
                          : "60개 관측 미충족")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            최대 50개 표시합니다. 전체 결과는 아래 검증 결과 파일로 받을 수 있습니다.
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(ready, null, 2)], { type: "application/json" }),
              );
              const a = document.createElement("a");
              a.href = url;
              a.download = `underlying-index-diagnostic-${ready.report.asOfDate}.json`;
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            검증 결과 내려받기
          </Button>
          <details className="text-xs">
            <summary>한계와 불변성 해시</summary>
            <ul className="mt-2 space-y-1">
              {ready.report.limitations.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
            <p className="mt-2 break-all">
              입력 전: {ready.datasetBeforeSha256}
              <br />
              입력 후: {ready.datasetAfterSha256}
              <br />
              연결 자료: {ready.sha256}
              <br />
              활성 집합: {ready.sourceSetDigest}
            </p>
          </details>
        </>
      )}
      <details className="text-xs">
        <summary>검증된 전용 자료 연결</summary>
        <p className="my-2 text-muted-foreground">
          사전에 바이트 해시가 고정된 기초지수 전용 자료만 허용됩니다. 일반 CSV·가격 자료는 받지
          않습니다. 같은 소유자의 비공개 저장소에 새 불변 파일로 보관하며 기존 자료는 덮어쓰지
          않습니다.
        </p>
        <input
          aria-label="검증된 기초지수 전용 자료"
          type="file"
          accept="application/json,.json"
          disabled={busy}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <Button
          className="mt-2"
          size="sm"
          variant="outline"
          disabled={!file || busy}
          onClick={() => void install()}
        >
          검증자료만 연결
        </Button>
      </details>
    </section>
  );
}
