import { STRATEGY_CONFIG } from "@/lib/engine/operationalStrategy";

/** Shared concise copy; an instrument detail shows only its own domestic market. */
export function DomesticStrategyRules({ market }: { market?: "KOSPI" | "KOSDAQ" } = {}) {
  return (
    <div className="space-y-3 text-[11px] leading-relaxed text-muted-foreground">
      {!market || market === "KOSPI" ? (
        <div>
          <h3 className="font-semibold text-foreground">KOSPI</h3>
          <p>
            ETF PL 84 우선 / Stock PL 80 대체 · 8.0 신규 돌파 후 다음 거래일 종가에 8점 이상·RSAccel
            &gt; 0·9.5 상향돌파 없음 확인, 그다음 거래 가능 시가 진입.
          </p>
          <p>
            돌파일·체결 직전 완료 거래일 모두 Risk-On 또는 Neutral 필수. 하락장·시장자료 미확인 시
            제외, 새 돌파 필요.
          </p>
          <p>
            9.5 상향돌파 또는 {STRATEGY_CONFIG.KOSPI.maxHoldingDays}거래일 만기 청산 · 점수 하락
            청산 없음 · 섹터 한도 {Math.round(STRATEGY_CONFIG.KOSPI.sectorCap * 100)}%.
          </p>
        </div>
      ) : null}
      {!market || market === "KOSDAQ" ? (
        <div className={market ? undefined : "border-t border-border pt-2"}>
          <h3 className="font-semibold text-foreground">KOSDAQ</h3>
          <p>
            Stock PL 80 · 8.0 신규 돌파 진입 · 9.0 상향 재돌파·3.0 하향 이탈·
            {STRATEGY_CONFIG.KOSDAQ.maxHoldingDays}거래일 만기 청산.
          </p>
          <p>
            진입은 다음 거래일 시가 · 미보유 종목의 동시 돌파는 진입 우선 · 섹터 한도{" "}
            {Math.round(STRATEGY_CONFIG.KOSDAQ.sectorCap * 100)}%.
          </p>
        </div>
      ) : null}
      <p>
        국내 공통: 점수 청산은 다음 거래일 시가, 만기는 당일 종가. 보유 종목·청산한 동일 신호는 진입
        제외, 보유 중 청산 우선.
      </p>
    </div>
  );
}
