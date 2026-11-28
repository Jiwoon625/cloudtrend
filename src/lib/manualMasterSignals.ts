import { DASHBOARD_MARKETS, marketSignals, type DashboardIndex, type DashboardMarket } from "./dashboardOperations";
import { masterPositionProjection, type MasterSnapshot } from "./manualMaster";
import { OPERATIONAL_SIGNAL_START } from "./operationalSignalStart";
import { projectActualEntryDecisions } from "./actualEntryDecisionProjection";
import type { EntryDecision } from "./actualEntryDecisions";

export function projectManualMasterSignals(snapshot: MasterSnapshot, kr: DashboardIndex|null, us: DashboardIndex|null, entries: EntryDecision[]|null) {
  const {positions,recentSells}=masterPositionProjection(snapshot.rows);
  const sectorCounts=new Map<string,number>();
  let sectorsKnown=!!kr&&snapshot.asOf>=kr.date;
  for(const p of positions){
    if(p.market!=="KOSPI"&&p.market!=="KOSDAQ")continue;
    const code=kr?.rows.find(r=>r.market===p.market&&r.symbol===p.symbol&&r.date===kr.date)?.sectorCode;
    if(!code||["UNKNOWN","ETC","OTHER","-"].includes(code))sectorsKnown=false;
    else sectorCounts.set(code,(sectorCounts.get(code)??0)+1);
  }
  const markets=DASHBOARD_MARKETS.map(market=>{
    const index=market==="US"?us:kr;
    const holdings=index&&snapshot.asOf>=index.date?positions.filter(p=>p.market===market):null;
    return marketSignals(index,market,holdings,[],{
      counts:sectorsKnown?sectorCounts:null,maxPositions:30,asOfDate:kr?.date??null,issue:sectorsKnown?null:"실제 보유 섹터 미확인"
    },OPERATIONAL_SIGNAL_START,recentSells.map(r=>({...r,market:r.market as DashboardMarket})));
  });
  return {
    revision:snapshot.revision,asOf:snapshot.asOf,
    markets:projectActualEntryDecisions(markets,entries),
    warnings:[
      "미리보기: 기존 저장 스크리닝의 조건·확인·H60·실보유·최근매도일을 결합했습니다. 기존 운영 신호는 변경하지 않습니다.",
      "K4/E4 및 분할매수 고점·원가 이력, 현금/예약 한도, 별도 전략 적용 대상은 추가 검증 전 확정하지 않습니다. 원화 평단가를 USD 가격에 직접 비교하지 않습니다.",
      ...(kr&&snapshot.asOf<kr.date||us&&snapshot.asOf<us.date?["보유 기준일이 스크리닝보다 오래되어 해당 시장의 실보유 판단을 보류합니다."]:[]),
      ...(snapshot.rows.some(r=>!r.lastSell)?["최근매도일 공란은 매도 이력 없음으로 확정하지 않았습니다. 진입 후보를 최종 확정하지 않습니다."]:[]),
    ],
  };
}
