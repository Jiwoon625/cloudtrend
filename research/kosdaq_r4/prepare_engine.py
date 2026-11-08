"""Copy and minimally patch a pinned research engine. Never patch production."""
import argparse,hashlib,json,pathlib,shutil,difflib
def sha(p):return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def replace_once(text,old,new):
 if text.count(old)!=1:raise ValueError('Frozen engine patch anchor mismatch: '+old[:90])
 return text.replace(old,new,1)
def main():
 p=argparse.ArgumentParser();p.add_argument('--source',type=pathlib.Path,required=True);p.add_argument('--output',type=pathlib.Path,required=True);p.add_argument('--strict-observed-exits',action='store_true');p.add_argument('--profit-exit-replacement',action='store_true');a=p.parse_args();src=a.source.resolve();out=a.output.resolve()
 if out.exists():raise ValueError('Use a new engine-copy directory; never overwrite a completed engine')
 shutil.copytree(src,out);proof=[];diff=[]
 rel='src/lib/research/exitRiskPolicy.ts';f=out/rel;old=f.read_text();s=old
 s=replace_once(s,'export interface ExitRiskPolicy { id:string;','export interface ExitRiskPolicy { id:string; highScoreMin?:number; maxHold?:number; trailActivate?:number; gateSlots?:number; gateStates?:Record<string,string>;')
 s=replace_once(s,"if(policy.trail!==undefined)conditions['TRAIL'+policy.trail]=validClose&&hitsRelativeDecline(b.close,highest,policy.trail);","if(policy.trail!==undefined)conditions['TRAIL'+policy.trail]=validClose&&atLeastRise(highest,entryPrice,policy.trailActivate??0)&&hitsRelativeDecline(b.close,highest,policy.trail);")
 s=replace_once(s,'const signal=firstAdditionalSignal(t.symbol,t.entryDate,t.entryPrice);if(!signal)return original;','const signal=additionalExitSignal(t);if(!signal)return original;')
 s+='''
// R4 opt-in additions: entry score is frozen at entry, never a future score.
export function atLeastRise(value:number,reference:number,rise:number):boolean {
 const unit=100000000n;
 return decimal(representedLegacyNumber(value))*unit>=decimal(representedLegacyNumber(reference))*(unit+decimal(representedLegacyNumber(rise)));
}
export function additionalExitSignal(t:PortfolioTrade):{date:string,reason:string}|null {
 const p=entryExitRiskPolicy(t.entryDate);
 if(p.id==='OFF'||(p.highScoreMin!==undefined&&(!(Number.isFinite(t.entryTechnicalPoints))||t.entryTechnicalPoints!<p.highScoreMin)))return null;
 const candidates=[];
 const technical=firstAdditionalSignal(t.symbol,t.entryDate,t.entryPrice);if(technical)candidates.push(technical);
 if(p.maxHold!==undefined){const i=dateIndex.get(t.entryDate);const d=i===undefined?undefined:dates[i+p.maxHold-1];if(d)candidates.push({date:d,reason:'MAXHOLD'+p.maxHold});}
 return candidates.sort((a,b)=>a.date.localeCompare(b.date))[0]??null;
}
export function researchEntryGate(entryDate:string,activeNames:number){
 if(policy.gateSlots===undefined)return {allowed:true,reason:'NO_GATE',asOf:null};
 const i=dateIndex.get(entryDate);const asOf=i===undefined?undefined:dates[i-1];const state=asOf?policy.gateStates?.[asOf]:undefined;
 if(!state||state==='UNKNOWN')return {allowed:false,reason:'R4_GATE_UNKNOWN',asOf:asOf??null};
 if(state==='BELOW'&&activeNames>=policy.gateSlots)return {allowed:false,reason:'R4_GATE_BELOW20_CAP'+policy.gateSlots,asOf};
 return {allowed:true,reason:state,asOf};
}
'''
 f.write_text(s);proof.append(dict(path=rel,before=sha(src/rel),after=sha(f)));diff+=list(difflib.unified_diff(old.splitlines(True),s.splitlines(True),fromfile=rel+'.original',tofile=rel+'.r4'))
 rel='src/lib/portfolioLedgers.ts';f=out/rel;old=f.read_text();s=replace_once(old,"import { exitRiskPolicy, partialDone, partialFills } from './research/exitRiskPolicy';","import { exitRiskPolicy, partialDone, partialFills, researchEntryGate } from './research/exitRiskPolicy';")
 anchor='    if (active.length >= settings.maxPositions) {'
 s=replace_once(s,anchor,"    if(c.market==='KOSDAQ'){const gate=researchEntryGate(c.entryDate,active.length);if(!gate.allowed){c.decision=gate.reason;continue;}}\n"+anchor);f.write_text(s);proof.append(dict(path=rel,before=sha(src/rel),after=sha(f)));diff+=list(difflib.unified_diff(old.splitlines(True),s.splitlines(True),fromfile=rel+'.original',tofile=rel+'.r4'))
 if a.strict_observed_exits:
  rel='src/lib/portfolioStrategyRules.ts';f=out/rel;old=f.read_text();s=replace_once(old,'  let exceptionPlan: ExitPlan | null = null;\n  if (unified) {','  let exceptionPlan: ExitPlan | null = null;\n  // R4 sensitivity: absence is unresolved, never a prior-open synthetic sale.\n  const allowSyntheticMissingDataLiquidation = false;\n  if (unified && allowSyntheticMissingDataLiquidation) {');f.write_text(s);proof.append(dict(path=rel,before=sha(src/rel),after=sha(f)));diff+=list(difflib.unified_diff(old.splitlines(True),s.splitlines(True),fromfile=rel+'.original',tofile=rel+'.r4-strict'))
 if a.profit_exit_replacement:
  rel='src/lib/research/exitRiskPolicy.ts';f=out/rel;old=f.read_text();s=replace_once(old,'highScoreMin?:number;','highScoreMin?:number; replaceProfitExitOnHighScore?:boolean;');f.write_text(s);proof.append(dict(path=rel+'#replace-profit-flag',before=hashlib.sha256(old.encode()).hexdigest(),after=sha(f)));diff+=list(difflib.unified_diff(old.splitlines(True),s.splitlines(True),fromfile=rel+'.r4',tofile=rel+'.r4E'))
  rel='src/lib/portfolioStrategyRules.ts';f=out/rel;old=f.read_text();s=replace_once(old,"import { overlayKrExit } from './research/exitRiskPolicy';","import { overlayKrExit, exitRiskPolicy } from './research/exitRiskPolicy';");s=replace_once(s,'    const signal = operationalExit(entry, trade.market, true);\n    if (!signal) continue;','    const signal = operationalExit(entry, trade.market, true);\n    if (!signal) continue;\n    if(signal===\"UP90\"&&trade.market===\"KOSDAQ\"&&exitRiskPolicy().replaceProfitExitOnHighScore&&Number.isFinite(trade.entryTechnicalPoints)&&trade.entryTechnicalPoints!>=9)continue;');f.write_text(s);proof.append(dict(path=rel+'#replace-profit',before=hashlib.sha256(old.encode()).hexdigest(),after=sha(f)));diff+=list(difflib.unified_diff(old.splitlines(True),s.splitlines(True),fromfile=rel+'.r4-strict',tofile=rel+'.r4E'))
 (out/'R4_PATCH.diff').write_text(''.join(diff));(out/'R4_PATCH.json').write_text(json.dumps(dict(source='R3 frozen overlay, original engine 38da620ced597eaae4e07b54f36a2173c70d9640',only_research_copy=True,strict_observed_exits=a.strict_observed_exits,profit_exit_replacement_enabled=a.profit_exit_replacement,files=proof),indent=2));print('Prepared isolated engine:',out)
if __name__=='__main__':main()
