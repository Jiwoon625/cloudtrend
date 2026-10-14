import{describe,it,expect}from'vitest';import{configureExitRisk,firstAdditionalSignal,overlayKrExit,etfAdditionalAt,partialDone,confirmIndexExit}from'./exitRiskPolicy';
const ds=['2026-01-02','2026-01-05','2026-01-06','2026-01-07','2026-01-08'] as const;
function setup(p:any,closes=[100,89,88,92,96],vols=[1,0,1,1,1]){const bars:any={X:ds.map((d,i)=>({tradeDate:d,open:closes[i]!+1,close:closes[i],volume:vols[i]}))};const sc:any={X:new Map(ds.map((d,i)=>[d,[8,4,4,6,2][i]]))};configureExitRisk(p,bars,sc,[...ds]);return bars;}
describe('Exit risk causal signal contracts',()=>{
 it('Disabled overlays preserve original plan',()=>{setup({id:'OFF'});const old:any={exitDate:ds[4],timing:'CLOSE'};expect(overlayKrExit({symbol:'X',id:'t',entryDate:ds[0],entryPrice:100}as any,old,ds[4])).toBe(old);});
 it('Down crossing requires previous valid score above threshold',()=>{setup({id:'K2',down:4});expect(firstAdditionalSignal('X',ds[0],100)?.date).toBe(ds[1]);});
 it('Two-day confirmation records the second close',()=>{setup({id:'K2C',down:4,confirm:2});expect(firstAdditionalSignal('X',ds[0],100)?.date).toBe(ds[2]);});
 it('Next open execution never uses zero volume',()=>{setup({id:'K2',down:4});const t:any={symbol:'X',id:'t',entryDate:ds[0],entryPrice:100};expect(overlayKrExit(t,null,ds[1])).toBeNull();expect(overlayKrExit(t,null,ds[4])?.exitDate).toBe(ds[2]);});
 it('Trailing high uses only already observed closes',()=>{setup({id:'E3',trail:.08},[100,101,110,100,1000],[1,1,1,1,1]);expect(firstAdditionalSignal('X',ds[0],100)?.date).toBe(ds[3]);expect(etfAdditionalAt('X',ds[0],100,ds[1])).toBeNull();});
 it('A partial warning is consumed once per position',()=>{setup({id:'K4P',stop:.08,fraction:.5});const t:any={symbol:'X',id:'t',entryDate:ds[0],entryPrice:100};partialDone.add('t');expect(overlayKrExit(t,null,ds[4])).toBeNull();});
 it('Index confirmation resets when a session is not below MA',()=>{setup({id:'E1C',ma:20,confirm:2});expect(confirmIndexExit('X',ds[0],'MA60')).toBeNull();expect(confirmIndexExit('X',ds[1],null)).toBeNull();expect(confirmIndexExit('X',ds[2],'MA60')).toBeNull();expect(confirmIndexExit('X',ds[3],'MA60')).toBe('MA60');});
});
