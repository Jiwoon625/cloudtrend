import { STRATEGY_CONFIG } from "@/lib/engine/operationalStrategy";

export function StrategyDescription() {
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
        확인한 뒤, 그다음 거래 가능한 시가에 진입합니다. 확인 실패·결측은 진입하지 않습니다.
      </p>
      <p>
        KOSDAQ은 진입 당일 상단 점수를 함께 돌파하면 진입을 우선합니다. KOSDAQ 진입과 점수 청산은
        다음 거래일 시가, H60 만기는 해당일 종가 기준입니다.
      </p>
    </div>
  );
}
