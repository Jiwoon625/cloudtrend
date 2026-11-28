import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/cloud";
import { manualMasterServer } from "@/lib/manualMaster.functions";
import { manualMasterSignalsServer } from "@/lib/manualMasterSignals.functions";
import {
  applyMasterPaste, masterChanges, masterColumns, masterIdentity, masterToday, newMasterRow,
  validateMasterRows, type MasterKey, type MasterRow, type MasterSnapshot,
} from "@/lib/manualMaster";

const fieldClass = "w-full min-w-24 rounded border border-input bg-background px-2 py-1.5 text-sm";
const buttonClass = "rounded border border-input px-3 py-2 text-sm font-medium disabled:opacity-50";
const moneyKeys = new Set(["averageKrw","amountKrw","buyAmount","sellAmount","sellCost","realized","dividends","fees"]);

async function token() {
  const { data, error } = await supabase.auth.getSession();
  if(error || !data.session) throw new Error("먼저 로그인해 주세요.");
  return data.session.access_token;
}

export function ManualSecurityMaster() {
  const [saved,setSaved]=useState<MasterSnapshot|null>(null);
  const [rows,setRows]=useState<MasterRow[]>([]);
  const [asOf,setAsOf]=useState(masterToday);
  const [loaded,setLoaded]=useState(false);
  const [busy,setBusy]=useState(true);
  const [message,setMessage]=useState("");
  const [filter,setFilter]=useState("all");
  const [paste,setPaste]=useState("");
  const [preview,setPreview]=useState<MasterRow[]|null>(null);
  const [confirmed,setConfirmed]=useState(false);
  const [signals,setSignals]=useState<Awaited<ReturnType<typeof manualMasterSignalsServer>>|null>(null);
  const lock=useRef(false);
  const dirty=JSON.stringify(rows)!==JSON.stringify(saved?.rows??[])||asOf!==(saved?.asOf??masterToday());

  useEffect(()=>{
    let alive=true;
    void (async()=>{
      try{
        const s=await manualMasterServer({data:{action:"load",accessToken:await token()}});
        if(!alive)return;
        setSaved(s);setRows(s?.rows??[]);setAsOf(s?.asOf??masterToday());setLoaded(true);
      }catch(e){if(alive)setMessage(e instanceof Error?e.message:"조회 실패");}
      finally{if(alive)setBusy(false);}
    })();
    return()=>{alive=false;};
  },[]);

  const resetPreview=()=>{setPreview(null);setConfirmed(false);setSignals(null);};
  const edit=(i:number,key:MasterKey,value:string)=>{
    if(lock.current)return;
    setRows(old=>old.map((r,j)=>j===i?{...r,[key]:value,...(key==="listing"?{currency:value==="미국"?"USD":"KRW"}:{})}:r));
    resetPreview();setMessage("");
  };
  async function reload(){
    if(lock.current||busy)return;
    if(dirty&&!window.confirm("미저장 변경을 버리고 다시 조회하시겠습니까?"))return;
    lock.current=true;setBusy(true);setMessage("");
    try{
      const s=await manualMasterServer({data:{action:"load",accessToken:await token()}});
      setSaved(s);setRows(s?.rows??[]);setAsOf(s?.asOf??masterToday());setLoaded(true);resetPreview();
    }catch(e){setMessage(e instanceof Error?e.message:"조회 실패");}
    finally{lock.current=false;setBusy(false);}
  }
  function pasteCells(text:string,i:number,j:number){
    if(lock.current||busy||!loaded)return;
    try{setRows(applyMasterPaste(rows,text,i,j));resetPreview();setMessage("");}
    catch(e){setMessage(e instanceof Error?e.message:"붙여넣기 실패");}
  }
  function pasteAll(){
    if(lock.current||busy||!loaded)return;
    try{
      if(!paste.trim())throw new Error("표를 먼저 붙여넣으세요.");
      if(!window.confirm("현재 편집 중인 표를 붙여넣은 전체 표로 바꿀까요? 저장 전 다시 검토할 수 있습니다."))return;
      setRows(applyMasterPaste([],paste,0,0));setPaste("");resetPreview();setMessage("");
    }catch(e){setMessage(e instanceof Error?e.message:"붙여넣기 실패");}
  }
  function review(){
    try{
      const next=validateMasterRows(rows,asOf);
      if(masterChanges(saved?.rows??[],next).removed.length)throw new Error("기존 종목을 삭제하지 말고 보유수량을 0으로 바꾸세요.");
      setPreview(next);setConfirmed(false);setMessage("");
    }catch(e){resetPreview();setMessage(e instanceof Error?e.message:"검증 실패");}
  }
  async function save(){
    if(lock.current||busy||!loaded||!preview||!confirmed)return;
    lock.current=true;setBusy(true);setMessage("");
    try{
      const s=await manualMasterServer({data:{action:"save",accessToken:await token(),expectedRevision:saved?.revision??0,asOf,rows:preview,confirmed:true}});
      if(!s)throw new Error("저장 결과 확인 실패");
      setSaved(s);setRows(s.rows);setAsOf(s.asOf);resetPreview();setMessage("저장 완료 · 최신 집계 스냅샷 확인");
    }catch(e){resetPreview();setMessage((e instanceof Error?e.message:"저장 실패")+" · 다시 조회하여 저장 여부를 확인하세요.");}
    finally{lock.current=false;setBusy(false);}
  }
  async function signalPreview(){
    if(lock.current||busy||!saved||dirty)return;
    lock.current=true;setBusy(true);setSignals(null);setMessage("");
    try{
      const result=await manualMasterSignalsServer({data:{accessToken:await token(),revision:saved.revision}});
      setSignals(result);
    }catch(e){setMessage(e instanceof Error?e.message:"신호 조회 실패");}
    finally{lock.current=false;setBusy(false);}
  }
  const changes=preview?masterChanges(saved?.rows??[],preview):null;
  const visible=rows.map((row,index)=>({row,index})).filter(({row})=>filter==="all"||filter==="held"&&Number(row.quantity)>0||filter==="ETF"&&row.assetType==="ETF"||filter===row.listing);
  const disabled=busy||!loaded;
  return (
    <section className="space-y-4" aria-label="종목마스터DB">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">종목마스터DB</h1>
        <p className="text-sm text-muted-foreground">매매 후 Notion 집계값을 직접 입력하거나 복사하여 저장하세요. 거래내역은 저장하지 않습니다. 평단가와 금액은 모두 원화 기준입니다.</p>
        <p className="text-xs text-muted-foreground">검증 브랜치: 기존 진입·청산 신호는 아직 이 표에 연결되지 않았습니다.</p>
      </header>
      <div className="flex flex-wrap items-end gap-3 rounded-lg border p-3">
        <div className="mr-auto space-y-1">
          <p className="text-sm font-medium">등록 {rows.length}종목 · 보유 {rows.filter(r=>Number(r.quantity)>0).length}종목</p>
          <p className="text-xs text-muted-foreground">최종 저장: {saved?new Date(saved.savedAt).toLocaleString("ko-KR",{timeZone:"Asia/Seoul"}):"미등록"} · revision {saved?.revision??0}{dirty?" · 미저장 변경":""}</p>
        </div>
        <label className="text-sm">보유 기준일<input className={fieldClass} type="date" max={masterToday()} value={asOf} disabled={disabled} onChange={e=>{setAsOf(e.target.value);resetPreview();}}/></label>
        <button className={buttonClass} type="button" disabled={busy} onClick={()=>void reload()}>다시 조회</button>
        <button className={buttonClass} type="button" disabled={disabled} onClick={()=>{setRows(old=>[...old,newMasterRow()]);setFilter("all");resetPreview();}}>+ 행 추가</button>
        <button className={buttonClass+" bg-primary text-primary-foreground"} type="button" disabled={disabled||!rows.length} onClick={review}>변경사항 검토</button>
      </div>
      {message&&<p role="status" className="rounded border p-3 text-sm">{message}</p>}
      {!loaded&&<p className="text-sm">{busy?"저장된 종목마스터를 조회하는 중입니다.":"조회 실패 또는 저장소 미설치: 다시 조회해 주세요. 기존 보유가 없는 것으로 처리하지 않습니다."}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm">보기 <select className="rounded border bg-background p-2" value={filter} onChange={e=>setFilter(e.target.value)}>
          <option value="all">전체</option><option value="held">보유만</option><option value="KOSPI">KOSPI</option><option value="KOSDAQ">KOSDAQ</option><option value="미국">미국</option><option value="ETF">ETF</option>
        </select></label>
        <span className="text-xs text-muted-foreground">셀에서 여러 행·열을 탭 구분 표로 붙여넣을 수 있습니다. 전량매도는 행을 남기고 수량 0, 원가 0 또는 공란으로 변경하세요.</span>
      </div>
      <div className="max-h-[65vh] overflow-auto rounded-lg border">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-background"><tr><th className="border p-2">행</th>{masterColumns.map(([key,label])=><th key={key} className="whitespace-nowrap border p-2">{label}{moneyKeys.has(key)?" (원)":""}</th>)}<th className="border p-2">사람</th></tr></thead>
          <tbody>{visible.map(({row,index})=><tr key={index}>
            <td className="border p-1 text-center">{index+1}</td>
            {masterColumns.map(([key,label],j)=><td key={key} className={key==="name"?"min-w-52 border p-1":"min-w-32 border p-1"}>
              {key==="listing"||key==="assetType"||key==="currency"?
                <select aria-label={label+" "+(index+1)} className={fieldClass} value={row[key]} disabled={disabled} onChange={e=>edit(index,key,e.target.value)}>
                  {(key==="listing"?["KOSPI","KOSDAQ","미국"]:key==="assetType"?["주식","ETF"]:["KRW","USD"]).map(v=><option key={v} value={v}>{v}</option>)}
                </select>:
                <input aria-label={label+" "+(index+1)} className={fieldClass} type={key==="start"||key==="lastSell"?"date":"text"} value={row[key]} disabled={disabled} onChange={e=>edit(index,key,e.target.value)} onPaste={e=>{
                  const text=e.clipboardData.getData("text/plain");if(text.includes("\t")||text.includes("\n")){e.preventDefault();pasteCells(text,index,j);}
                }}/>
              }
            </td>)}
            <td className="whitespace-nowrap border p-2">로그인 계정</td>
          </tr>)}</tbody>
        </table>
      </div>
      <details className="rounded border p-3">
        <summary className="cursor-pointer text-sm font-medium">Notion/엑셀 전체 표 붙여넣기</summary>
        <p className="my-2 text-xs text-muted-foreground">종목명과 종목코드를 포함한 헤더 행이 있으면 열 이름으로 매핑합니다. 사람·거래내역 열은 개인 소유권 및 거래원장 분리를 위해 가져오지 않습니다.</p>
        <textarea className="min-h-28 w-full rounded border bg-background p-2 text-sm" aria-label="전체 표 붙여넣기" value={paste} disabled={disabled} onChange={e=>setPaste(e.target.value)}/>
        <button className={buttonClass} type="button" disabled={disabled||!paste.trim()} onClick={pasteAll}>편집 표에 적용 (저장 전)</button>
      </details>
      <button type="button" className={buttonClass} disabled={disabled||!saved||dirty} onClick={()=>void signalPreview()}>저장된 보유현황 기준 진입·청산 미리보기</button>
      {signals&&<section className="space-y-3 rounded border p-4"><h2 className="font-semibold">진입·청산 후보 미리보기 · revision {signals.revision}</h2>{signals.warnings.map(w=><p className="text-xs text-muted-foreground" key={w}>{w}</p>)}{signals.markets.map(m=><div key={m.market} className="rounded border p-3"><h3 className="font-medium">{m.market} · {m.date??"스크리닝 미확인"}</h3>{!m.holdingsKnown?<p>보유현황 기준일 확인 필요</p>:<><p className="text-sm">진입 후보 {m.onsets.length} · 청산 후보 {m.exits.length}</p>{m.onsets.map(x=><p key={"in"+x.symbol} className="text-sm">진입 후보 · {x.name} ({x.symbol}) · {x.reason}</p>)}{m.exits.map(x=><p key={"out"+x.symbol} className="text-sm">청산 후보 · {x.name} ({x.symbol}) · {x.reason}</p>)}</>}</div>)}</section>}
      {changes&&preview&&<section className="space-y-3 rounded-lg border p-4" aria-label="저장 미리보기">
        <h2 className="font-semibold">저장 미리보기</h2>
        <p className="text-sm">신규 {changes.added.length} · 변경 {changes.changed.length} · 전량매도 {changes.closed.length} · 삭제 {changes.removed.length}</p>
        <div className="max-h-48 overflow-auto text-sm">{[...changes.added,...changes.changed].map(r=><p key={masterIdentity(r)}>{r.symbol} {r.name} · 수량 {saved?.rows.find(p=>masterIdentity(p)===masterIdentity(r))?.quantity??"신규"} → {r.quantity} · 평단가 {r.averageKrw||"—"}원</p>)}</div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={disabled} onChange={e=>setConfirmed(e.target.checked)}/> 기준일과 전체 보유/미보유 집계가 실제 Notion 및 계좌 내역과 일치함을 확인합니다.</label>
        <button className={buttonClass+" bg-primary text-primary-foreground"} type="button" disabled={disabled||!confirmed} onClick={()=>void save()}>저장</button>
      </section>}
    </section>
  );
}
