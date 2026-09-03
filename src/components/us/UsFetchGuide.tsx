import { Check, Copy } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";

export const US_JUPYTER_SNIPPET = `# TrendScore US 입력 데이터 생성 (로컬 Jupyter)
# 토스증권 API 키/시크릿은 로컬 OS 환경변수에만 두고, 브라우저·클라우드에 올리지 않습니다.
# pip install requests pandas
import os, time, requests, pandas as pd

BASE = "https://openapi.tossinvest.com"
CLIENT_ID     = os.environ["TOSS_CLIENT_ID"]
CLIENT_SECRET = os.environ["TOSS_CLIENT_SECRET"]

tok = requests.post(f"{BASE}/oauth2/token",
    headers={"Content-Type": "application/x-www-form-urlencoded"},
    data={"grant_type": "client_credentials",
          "client_id": CLIENT_ID, "client_secret": CLIENT_SECRET}).json()["access_token"]
H = {"Authorization": f"Bearer {tok}"}

def api(path, **params):
    r = requests.get(BASE + path, headers=H, params=params, timeout=20)
    r.raise_for_status(); time.sleep(0.35)     # 호출 간격 확보
    return r.json()

# ── 1) 분석 유니버스 --------------------------------------------------------
# 벤치마크(SPY/QQQ/IWM)와 11개 섹터 프록시 ETF는 필수입니다.
BENCH   = ["SPY", "QQQ", "IWM"]
SECTOR  = ["XLK","XLF","XLV","XLY","XLP","XLC","XLI","XLE","XLU","XLRE","XLB"]
STOCKS  = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","JPM","XOM","UNH","CAT"]
ETFS    = ["VOO","SCHD","SMH","IBIT","TLT"]

# 종목의 GICS 섹터는 토스 마스터 응답의 업종 필드 또는 직접 정리한 매핑을 사용하세요.
SECTOR_OF = {
  "AAPL":"Information Technology","MSFT":"Information Technology","NVDA":"Information Technology",
  "AMZN":"Consumer Discretionary","GOOGL":"Communication Services","META":"Communication Services",
  "JPM":"Financials","XOM":"Energy","UNH":"Health Care","CAT":"Industrials",
}
SECTOR_OF.update({e: s for e, s in zip(
  SECTOR,
  ["Information Technology","Financials","Health Care","Consumer Discretionary",
   "Consumer Staples","Communication Services","Industrials","Energy",
   "Utilities","Real Estate","Materials"])})

# ── 2) 수정주가 일봉 (호출당 최대 200봉 → 페이지네이션으로 320봉 이상) ------
def daily(symbol, need=320):
    out, cursor = [], None
    while len(out) < need:
        params = {"symbol": symbol, "market": "US", "period": "D", "count": 200}
        if cursor: params["endDate"] = cursor
        js = api("/v1/stocks/candles", **params)
        rows = js.get("candles") or js.get("data") or []
        if not rows: break
        out = rows + out
        cursor = rows[0].get("date") or rows[0].get("baseDate")
        if len(rows) < 200: break
    return out[-need:]

# ── 3) 마스터(시가총액 등) --------------------------------------------------
def master(symbol):
    try:
        js = api("/v1/stocks/info", symbol=symbol, market="US")
        d = js.get("data") or js
        return {"name": d.get("nameEn") or d.get("name") or symbol,
                "nameKo": d.get("name"),
                "marketCap": d.get("marketCap"),
                "tossTradable": True}
    except Exception:
        return {"name": symbol, "nameKo": None, "marketCap": None, "tossTradable": None}

rows = []
for sym in BENCH + SECTOR + ETFS + STOCKS:
    kind = "ETF" if sym in BENCH + SECTOR + ETFS else "STOCK"
    m = master(sym)
    for c in daily(sym):
        d = str(c.get("date") or c.get("baseDate"))[:10]
        rows.append({
            "symbol": sym, "name": m["name"], "nameKo": m["nameKo"],
            "type": kind, "sector": SECTOR_OF.get(sym, ""),
            "date": d,
            "open": c.get("open"), "high": c.get("high"),
            "low": c.get("low"),  "close": c.get("close") or c.get("adjClose"),
            "volume": c.get("volume"),
            "marketCap": m["marketCap"] if kind == "STOCK" else None,
            "tossTradable": m["tossTradable"],
        })

df = pd.DataFrame(rows).dropna(subset=["close"]).drop_duplicates(["symbol","date"])
df.to_csv("trendscore_us_input.csv", index=False, encoding="utf-8-sig")
print(df.groupby("symbol").size().describe())
# → 생성된 trendscore_us_input.csv를 “2. 데이터 입력” 칸에 업로드하세요.
`;

const COLUMNS: Array<[string, string, string]> = [
  ["symbol", "필수", "미국 티커(대문자). SPY는 200봉 이상 필수."],
  ["date", "필수", "거래일(YYYY-MM-DD 또는 YYYYMMDD)."],
  [
    "open/high/low/close",
    "필수(close)",
    "수정주가 기준. close만 있어도 계산되지만 정확도가 낮아집니다.",
  ],
  ["volume", "필수", "정규장 거래량. 거래대금은 close×volume으로 계산합니다."],
  ["type", "권장", "STOCK 또는 ETF. 없으면 티커로 추정합니다."],
  ["sector", "권장", "GICS 섹터명(영문/국문). 없으면 섹터 게이트는 판단 보류."],
  ["name / nameKo", "선택", "영문 공식명 / 한글명."],
  ["marketCap", "선택", "USD. 없으면 규모·유니버스 항목은 N/A."],
  ["aum / expenseRatio / spreadBps", "선택", "ETF Health·Priority 항목. 없으면 N/A."],
  ["securityType", "선택", "ETN·CEF·REIT 구분. ETN은 ETF Health 대상 제외."],
];

export function UsFetchGuide() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(US_JUPYTER_SNIPPET);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="bg-surface-strong text-left">
              <th className="px-2 py-1.5 font-semibold">컬럼</th>
              <th className="px-2 py-1.5 font-semibold">구분</th>
              <th className="px-2 py-1.5 font-semibold">설명</th>
            </tr>
          </thead>
          <tbody>
            {COLUMNS.map(([col, req, desc]) => (
              <tr key={col} className="border-t border-border align-top">
                <td className="px-2 py-1.5 font-mono">{col}</td>
                <td className="px-2 py-1.5 whitespace-nowrap text-muted-foreground">{req}</td>
                <td className="px-2 py-1.5 text-muted-foreground">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="list-inside list-disc space-y-0.5 text-[11px] text-muted-foreground">
        <li>
          벤치마크 SPY·QQQ·IWM과 11개 섹터 프록시 ETF(XLK…XLB)를 함께 넣어야 시장·섹터 게이트가
          판정됩니다.
        </li>
        <li>
          토스증권 일봉은 호출당 최대 200봉이므로 페이지네이션으로 320봉 이상 적재하는 것을
          권장합니다(MA200 필요).
        </li>
        <li>
          점수는 미국 정규장 종료 후 확정 일봉(EOD)만 사용합니다. 현재가·호가는 표시용이며 점수와
          섞지 않습니다.
        </li>
        <li>제공되지 않은 값은 비워 두세요. 임의값을 넣으면 coverage가 왜곡됩니다.</li>
      </ul>

      <div className="relative">
        <Button
          size="sm"
          variant="outline"
          className="absolute right-2 top-2 gap-1.5"
          onClick={copy}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "복사됨" : "코드 복사"}
        </Button>
        <pre className="max-h-72 overflow-auto rounded-md border border-border bg-surface-strong p-3 pr-24 font-mono text-[10.5px] leading-relaxed">
          {US_JUPYTER_SNIPPET}
        </pre>
      </div>
    </div>
  );
}
