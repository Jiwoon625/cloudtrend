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
        진입 당일 상단 점수를 함께 돌파하면 진입을 우선합니다. 점수 신호는 다음 거래일 시가, H60
        만기는 해당일 종가로 체결합니다.
      </p>
    </div>
  );
}
