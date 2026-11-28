import { it, expect } from "vitest";
import { newMasterRow, type MasterSnapshot } from "./manualMaster";
import { projectManualMasterSignals } from "./manualMasterSignals";
import type { DashboardIndex } from "./dashboardOperations";
const date="2026-11-28";
const row={...newMasterRow(),symbol:"005930",name:"Synthetic held",listing:"KOSDAQ",quantity:"2",averageKrw:"100",amountKrw:"200",start:"2026-11-01"};
const sold={...row,symbol:"000002",name:"Synthetic sold",quantity:"0",averageKrw:"",amountKrw:"0",lastSell:date};
const snapshot:MasterSnapshot={revision:1,asOf:date,savedAt:date+"T00:00:00Z",rows:[row,sold]};
const index:DashboardIndex={date,tradeDates:[date],rows:[{symbol:row.symbol,name:row.name,market:"KOSDAQ",sector:"test",sectorCode:"test",date,price:100,score:9,priority:1,onset:true,exitReason:"UP90"},{symbol:sold.symbol,name:sold.name,market:"KOSDAQ",sector:"test",sectorCode:"test",date,price:100,score:8,priority:1,onset:true,exitReason:null}]};
it("uses held/last-sell aggregates without changing raw rows",()=>{
  const before=JSON.stringify(index);
  const projected=projectManualMasterSignals(snapshot,index,null,[]);
  const kr=projected.markets.find(m=>m.market==="KOSDAQ")!;
  expect(kr.onsets).toEqual([]);expect(kr.exits.map(r=>r.symbol)).toEqual([row.symbol]);expect(JSON.stringify(index)).toBe(before);
  expect(kr.conditions?.map(r=>r.actualState).sort()).toEqual(["CONSUMED","HELD"]);
});
it("older snapshot cannot imply actual zero holdings",()=>{
  const result=projectManualMasterSignals({...snapshot,asOf:"2026-11-27"},index,null,[]);
  const kr=result.markets.find(m=>m.market==="KOSDAQ")!;
  expect(kr.holdingsKnown).toBe(false);expect(kr.onsetCount).toBeNull();expect(kr.exitCount).toBeNull();
});
