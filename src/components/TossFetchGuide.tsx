import { Check, Copy } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";

export const JUPYTER_SNIPPET = `# TrendScore KR 입력 데이터 생성 (Jupyter)
# pip install requests pandas
import os, time, requests, pandas as pd

BASE = "https://openapi.tossinvest.com"
CLIENT_ID     = os.environ["TOSS_CLIENT_ID"]      # 또는 "..." 직접 입력
CLIENT_SECRET = os.environ["TOSS_CLIENT_SECRET"]

tok = requests.post(f"{BASE}/oauth2/token",
    headers={"Content-Type": "application/x-www-form-urlencoded"},
    data={"grant_type": "client_credentials",
          "client_id": CLIENT_ID, "client_secret": CLIENT_SECRET}).json()["access_token"]
H = {"Authorization": f"Bearer {tok}"}

def api(path, **params):
    r = requests.get(BASE + path, headers=H, params=params, timeout=20)
    r.raise_for_status(); time.sleep(0.35)          # 호출 간격 확보
    return r.json()

def kst_date(ts):  # ISO 타임스탬프 -> KST 거래일
    return pd.to_datetime(ts).tz_convert("Asia/Seoul").strftime("%Y-%m-%d")

# 1) 분석할 종목 목록 -----------------------------------------------------------
# 직접 지정하거나, 아래처럼 상장목록/거래대금 순위에서 뽑아도 됩니다.
STOCKS = ["005930", "000660", "373220", "207940", "005380"]   # 코스피/코스닥 종목코드
ETFS   = ["069500", "360750", "379800", "133690"]              # 국내 상장 ETF 코드

# 상장 전체 목록에서 이름/시장 정보 가져오기
listed = {}
for mkt in ("KOSPI", "KOSDAQ"):
    res = api("/api/v1/stocks/all", market=mkt, status="ACTIVE")
    for s in (res if isinstance(res, list) else res.get("stocks", [])):
        listed[s["symbol"]] = {"name": s.get("name", s["symbol"]), "market": mkt}

# 발행주식수 (시가총액 = 발행주식수 x 종가)
shares = {}
codes = STOCKS + ETFS
for i in range(0, len(codes), 200):
    res = api("/api/v1/stocks", symbols=",".join(codes[i:i+200]))
    for s in (res if isinstance(res, list) else res.get("stocks", [])):
        if s.get("sharesOutstanding"):
            shares[s["symbol"]] = float(s["sharesOutstanding"])

# 2) 일봉 + 투자자 수급 --------------------------------------------------------
COUNT = 250        # 최대 200~250봉 (약 1년)
rows = []

def add_candles(symbol, name, market, path, params, flow=None):
    for c in api(path, **params).get("candles", []):
        d = kst_date(c["timestamp"]); close = float(c["closePrice"]); vol = float(c["volume"])
        f = (flow or {}).get(d)
        rows.append({
            "symbol": symbol, "name": name, "market": market, "date": d,
            "open": float(c["openPrice"]), "high": float(c["highPrice"]),
            "low": float(c["lowPrice"]), "close": close, "volume": vol,
            "tradingValue": close * vol,
            "marketCap": shares[symbol] * close if symbol in shares else "",
            "foreignNetBuyValue": (f["fo"] * close) if f else "",
            "institutionNetBuyValue": (f["inst"] * close) if f else "",
        })

for symbol in codes:
    is_etf = symbol in ETFS
    info = listed.get(symbol, {"name": symbol, "market": "KOSPI"})
    flow = {}
    try:   # 종목별 투자자 매매는 "수량"만 제공 -> 종가를 곱해 금액으로 환산
        for r in api(f"/api/v1/stocks/{symbol}/investor-trading",
                     interval="1d", count=100).get("records", []):
            flow[r["date"]] = {"fo": float((r.get("foreigner") or {}).get("netBuyVolume") or 0),
                               "inst": float((r.get("institution") or {}).get("netBuyVolume") or 0)}
    except Exception:
        pass
    add_candles(symbol, info["name"], "ETF" if is_etf else info["market"],
                "/api/v1/candles",
                dict(symbol=symbol, interval="1d", count=COUNT, adjusted="true"), flow)

# 3) 지수 (필수: KOSPI / 권장: KOSDAQ, VKOSPI) ---------------------------------
for code, label in (("KOSPI", "코스피"), ("KOSDAQ", "코스닥"), ("VKOSPI", "변동성지수")):
    try:
        add_candles(code, label, "INDEX",
                    f"/api/v1/market-indicators/{code}/candles",
                    dict(symbol=code, interval="1d", count=COUNT))
    except Exception as e:
        print("지수 조회 실패", code, e)

df = pd.DataFrame(rows).sort_values(["symbol", "date"])
df.to_csv("trendscore_input.csv", index=False, encoding="utf-8-sig")
print(df.groupby("market")["symbol"].nunique(), len(df), "rows -> trendscore_input.csv")
`;

/** 사용자가 주피터노트북에서 토스증권 Open API로 입력 데이터를 만드는 코드와 형식 안내 */
export function TossFetchGuide() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(JUPYTER_SNIPPET);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border bg-surface p-3 text-[12px] leading-relaxed">
        <p className="mb-1 font-semibold">필요한 데이터 (CSV 한 줄 = 종목 하루)</p>
        <ul className="list-inside list-disc space-y-0.5 text-muted-foreground">
          <li>
            <b>필수 열</b>: <code>symbol, name, market, date, open, high, low, close, volume</code>
          </li>
          <li>
            <b>선택 열</b>: <code>tradingValue</code>(없으면 종가×거래량), <code>marketCap</code>,{" "}
            <code>foreignNetBuyValue</code>, <code>institutionNetBuyValue</code>,{" "}
            <code>sector</code>
          </li>
          <li>
            <code>market</code>: <code>KOSPI</code> / <code>KOSDAQ</code> / <code>ETF</code> /{" "}
            <code>INDEX</code>
          </li>
          <li>
            <b>지수 행 필수</b>: <code>symbol=KOSPI, market=INDEX</code> 60거래일 이상 (시장 게이트
            판정). <code>KOSDAQ</code>, <code>VKOSPI</code>는 있으면 사용, 없으면 “데이터 없음” 처리
          </li>
          <li>
            기간은 종목당 <b>120거래일 이상</b> 권장 (일목균형표·MA120 계산)
          </li>
          <li>없는 열·값은 0으로 채우지 말고 비워 두면 점수 계산에서 제외됩니다</li>
        </ul>
      </div>

      <div className="relative">
        <Button
          size="sm"
          variant="outline"
          className="absolute right-2 top-2 gap-1"
          onClick={() => void copy()}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "복사됨" : "코드 복사"}
        </Button>
        <pre className="max-h-80 overflow-auto rounded-md border border-border bg-surface-strong p-3 text-[11px] leading-relaxed">
          <code>{JUPYTER_SNIPPET}</code>
        </pre>
      </div>
    </div>
  );
}
