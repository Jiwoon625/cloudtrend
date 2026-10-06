import { STRATEGY_CONFIG } from "@/lib/engine/operationalStrategy";
import { DomesticStrategyRules } from "./DomesticStrategyRules";

export function StrategyDescription({ market }: { market?: string | undefined } = {}) {
  if (market === "KOSPI" || market === "KOSDAQ") {
    return <DomesticStrategyRules market={market} />;
  }

  return (
    <div className="space-y-1 text-[11px] leading-relaxed text-muted-foreground">
      <p>{STRATEGY_CONFIG.KOSPI.summary}</p>
      <p>{STRATEGY_CONFIG.KOSDAQ.summary}</p>
      <p>
        섹터 보유 한도: KOSPI {Math.round(STRATEGY_CONFIG.KOSPI.sectorCap * 100)}% · KOSDAQ{" "}
        {Math.round(STRATEGY_CONFIG.KOSDAQ.sectorCap * 100)}%.
      </p>
      <p>
        KOSPI는 8.0 Onset 다음 KOSPI 거래일 종가에 8점 이상 유지·U9.5 상향돌파 없음·RSAccel &gt; 0을
        확인한 뒤, 그다음 거래 가능한 시가에 진입합니다. 원래 Onset일과 체결 직전 마지막 완료 KOSPI
        거래일의 시장국면이 모두 Risk-On 또는 Neutral이어야 합니다. Risk-Off(하락장)·자료
        결측·오래된 시장자료는 신규 진입을 차단합니다.
      </p>
      <p>
        시장국면 때문에 취소된 후보는 시장이 회복되어도 되살리지 않으며 새 Onset이 필요합니다. 이
        규칙은 확인일 2026-10-02부터 적용하며, 기존 보유종목의 U9.5·H60 청산은 유지합니다.
      </p>
      <p>
        KOSDAQ은 진입 당일 상단 점수를 함께 돌파하면 진입을 우선합니다. KOSDAQ 진입과 점수 청산은
        다음 거래일 시가, H60 만기는 해당일 종가 기준입니다.
      </p>
    </div>
  );
}
