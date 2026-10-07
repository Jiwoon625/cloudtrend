export function UniversePendingSummary({ reasons }: { reasons?: Array<[string, number]> }) {
  if (!reasons?.length) return null;
  return (
    <section className="mt-4 overflow-hidden rounded-lg border border-warn/30 bg-card">
      <div className="border-b border-warn/30 bg-warn-soft px-3 py-2">
        <h2 className="text-sm font-semibold text-warn">주식 판단 보류 사유</h2>
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          필수 자료 확인 전 신규 진입은 제외합니다. 기술점수와 산정 가능 여부는 별도로 확인할 수
          있습니다.
        </p>
      </div>
      <table className="w-full text-[12px]" aria-label="주식 판단 보류 사유별 종목 수">
        <tbody>
          {reasons.map(([reason, count]) => (
            <tr key={reason} className="border-b border-border last:border-0">
              <td className="px-3 py-2">{reason}</td>
              <td className="num px-3 py-2 text-right font-semibold text-warn">
                {count.toLocaleString("ko-KR")}건
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
