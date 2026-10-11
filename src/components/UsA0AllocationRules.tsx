import {
  US_A0_OPERATING_COST_EFFECTIVE_DATE,
  US_A0_OPERATING_ONE_WAY_COST,
  US_PROSPECTIVE_MAX_POSITIONS,
} from "@/lib/engine/usProspectivePortfolio";

/** Current A0 allocation copy shared by the signal, model and actual-account views. */
export function UsA0AllocationRules() {
  return (
    <div className="text-[11px] leading-relaxed text-muted-foreground">
      <p>
        기존 독립 A0 Shadow: 계좌별 초기 투자금액 ÷ 고정 목표 {US_PROSPECTIVE_MAX_POSITIONS}종목을
        종목당 매입 예산으로 사용합니다. 당일 후보 수·현재 평가자산으로 다시 나누지 않습니다. 정기
        리밸런싱과 신규 진입 자금 마련용 부분매도는 하지 않으며, 미투자금은 현금으로 유지합니다.
      </p>
      <p>
        실제 S06·통합 자산배분 Shadow의 미국 예산은 연초 미국 배정자산 ÷ 20종목으로 갱신합니다. 실제
        달러 자금과 시장 귀속이 확인되기 전에는 주문 수량을 확정하지 않습니다.
      </p>
      <p>
        Shadow 모델 비용은 편도 {(US_A0_OPERATING_ONE_WAY_COST * 100).toFixed(2)}% · 왕복{" "}
        {(US_A0_OPERATING_ONE_WAY_COST * 200).toFixed(2)}%이며, 기존 A0 운영 모델도{" "}
        {US_A0_OPERATING_COST_EFFECTIVE_DATE} 미국 거래일부터 같은 비용을 적용합니다. 실제 원장은
        입력한 비용을 사용합니다.
      </p>
    </div>
  );
}
