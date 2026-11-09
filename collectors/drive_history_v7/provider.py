TARGET_COUNT = FLOW_COUNT = 1
"""Provider functions copied from the SHA-pinned existing KR v3.3.3 runtime.
Original bundle SHA256: 91d4992be9a2d06916ee2e425cb43d210350eed5e73a83429dbb4d041c8b7aba
Only reviewed definitions/constants are vendored. No runtime archive execution, publisher or pickle.
"""
# 패키지 설치는 첫 번째 Colab bootstrap 셀에서 완료합니다.

import os
import re
import sys
import time
import random
import json
import warnings
import threading
import math
from pathlib import Path
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
import pandas as pd
from bs4 import BeautifulSoup
from tqdm.auto import tqdm
try:
    from IPython.display import display, FileLink
except ImportError:
    display = print
    FileLink = str

from urllib.parse import urlparse as _bootstrap_urlparse

pass  # 공식 API 경로만 사용

pd.set_option("display.max_columns", 200)
warnings.filterwarnings("default")

# Python 3.13 + jupyter_client 자체의 utcnow 경고가 tqdm 화면을 반복해서 밀어내는
# 현상만 숨깁니다. 수집 코드에서 발생하는 다른 경고는 그대로 표시합니다.
warnings.filterwarnings(
    "ignore",
    message=r"datetime\.datetime\.utcnow\(\) is deprecated.*",
    category=DeprecationWarning,
    module=r"jupyter_client\.session",
)
# Google Drive 마운트는 bootstrap 셀에서 한 번만 처리합니다.
IN_COLAB = "google.colab" in sys.modules

import os, json, time, math, re
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo
import pandas as pd
import requests

KRX_OFFICIAL_SERVICES = {'KOSPI': 'sto/stk_bydd_trd', 'KOSDAQ': 'sto/ksq_bydd_trd', 'ETF': 'etp/etf_bydd_trd'}
KRX_OFFICIAL_BASE_URL = 'https://data-dbg.krx.co.kr/svc/apis/'
NUMBERS = {'TDD_OPNPRC':'open','TDD_HGPRC':'high','TDD_LWPRC':'low','TDD_CLSPRC':'close',
           'ACC_TRDVOL':'volume','ACC_TRDVAL':'tradingValue','MKTCAP':'marketCap','LIST_SHRS':'listedShares'}
ETF_NUMBERS = {'NAV':'etfNav','MKTCAP':'etfMarketCap','INVSTASST_NETASST_TOTAMT':'etfNetAssetTotalAmount',
               'LIST_SHRS':'etfListedUnits','OBJ_STKPRC_IDX':'etfUnderlyingIndexClose'}
ENRICH_FIELDS = ['marketCap','krxMarketCap','listedShares','krxListedShares',
                *ETF_NUMBERS.values(),'etfUnderlyingIndexName']

class OfficialAPIError(RuntimeError): pass

def official_atomic_json(path, data):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    temp=path.with_suffix('.tmp');temp.write_text(json.dumps(data,ensure_ascii=False),encoding='utf-8');temp.replace(path)

def official_numeric(value):
    if value is None or str(value).strip() in ('','-','--'): return None
    try: n=float(str(value).replace(',',''))
    except ValueError: raise OfficialAPIError('숫자 응답 형식 오류') from None
    if not math.isfinite(n) or n<0: raise OfficialAPIError('음수 또는 비유한 숫자 응답')
    return n

def official_normalize(rows, market, day):
    result=[];seen=set()
    for r in rows:
        if not isinstance(r,dict): raise OfficialAPIError('행 형식 오류')
        rawday=str(r.get('BAS_DD','')).replace('-','')
        if rawday!=day: raise OfficialAPIError('요청일과 응답일 불일치')
        symbol=str(r.get('ISU_CD','')).strip().upper()
        if symbol.isdigit():symbol=symbol.zfill(6)
        if not re.fullmatch('[0-9A-Z]{6}',symbol):raise OfficialAPIError('6자리 종목코드 형식 불일치')
        if symbol in seen:raise OfficialAPIError('종목·날짜 중복 응답')
        seen.add(symbol)
        required={'TDD_CLSPRC','MKTCAP','ACC_TRDVAL'} | (set(ETF_NUMBERS) if market=='ETF' else set())
        if not required.issubset(r):raise OfficialAPIError('공식 명세 필수 응답 열 누락')
        row={'symbol':symbol,'date':datetime.strptime(day,'%Y%m%d').strftime('%Y-%m-%d'),
             'name':r.get('ISU_NM',''),'market':market,'securityType':'ETF' if market=='ETF' else 'STOCK'}
        row.update({target:official_numeric(r.get(src)) for src,target in NUMBERS.items()})
        for col in ['marketCap','listedShares']:
            if row[col]==0:row[col]=None
        row['krxMarketCap']=row['marketCap'];row['krxListedShares']=row['listedShares']
        row['marketCapSource']='KRX_ETF' if market=='ETF' else 'KRX_STOCK'
        row['priceSource']='KRX_OPENAPI_UNADJUSTED'
        if market=='ETF':
            row.update({target:official_numeric(r.get(src)) for src,target in ETF_NUMBERS.items()})
            for target in ETF_NUMBERS.values():
                if row[target]==0:row[target]=None
            row['etfUnderlyingIndexName']=r.get('IDX_IND_NM') or None
        result.append(row)
    return pd.DataFrame(result)

class OfficialClient:
    def __init__(self,key,root,budget=9000,refresh=False):
        if not key:raise OfficialAPIError('승인받은 KRX_OPENAPI_KEY가 필요합니다. KRX_ID/KRX_PW와 다릅니다.')
        self.key=key;self.root=Path(root);self.budget=int(budget);self.refresh=refresh
        if not 1<=self.budget<=9000:raise ValueError('요청 예산은 1~9000입니다.')
        self.session=requests.Session();self.last=0
    def fetch(self,market,day):
        if market not in KRX_OFFICIAL_SERVICES:raise ValueError('지원하지 않는 시장')
        cache=self.root/'cache'/market/(day+'.json')
        if cache.exists() and not self.refresh:
            rows=json.loads(cache.read_text(encoding='utf-8'));official_normalize(rows,market,day);return rows
        today=datetime.now(ZoneInfo('Asia/Seoul')).strftime('%Y%m%d')
        counter=self.root/'usage'/(today+'.json')
        used=json.loads(counter.read_text()).get('attempts',0) if counter.exists() else 0
        if used>=self.budget:raise OfficialAPIError('로컬 일일 요청 예산 도달. 캐시는 보존됩니다.')
        time.sleep(max(0,.4-(time.monotonic()-self.last)))
        official_atomic_json(counter,{'attempts':used+1});self.last=time.monotonic()
        try:
            resp=self.session.get(KRX_OFFICIAL_BASE_URL+KRX_OFFICIAL_SERVICES[market],params={'basDd':day},
                                  headers={'AUTH_KEY':self.key},timeout=(10,45),allow_redirects=False)
        except requests.RequestException:raise OfficialAPIError('네트워크 오류. 자동 재시도하지 않습니다.') from None
        if resp.status_code!=200:raise OfficialAPIError(f'공식 API HTTP {resp.status_code}: 인증키·서비스 승인·한도를 확인하세요.')
        try:body=resp.json()
        except ValueError:raise OfficialAPIError('공식 API 비JSON 응답. 자동 재시도하지 않습니다.') from None
        if not isinstance(body,dict) or not isinstance(body.get('OutBlock_1'),list):
            raise OfficialAPIError('OutBlock_1 응답 없음. 키·서비스 승인 상태를 확인하세요.')
        rows=body['OutBlock_1'];official_normalize(rows,market,day)
        # Empty days may be holidays or not yet published; never cache as success.
        if rows:official_atomic_json(cache,rows)
        return rows

# Official API adapter: shared daily requests, exact date joins, bounded disk index.
import sqlite3
import tempfile
_OFFICIAL_DB = None
_OFFICIAL_LOADED = set()
_OFFICIAL_LOCK = threading.RLock()
_OFFICIAL_CLIENT = None
_OFFICIAL_FAILURE = None
_OFFICIAL_QA = []

class KRXSchemaError(ValueError): pass
class KRXServiceUnavailable(RuntimeError): pass

def official_client():
    global _OFFICIAL_CLIENT
    if _OFFICIAL_CLIENT is None:
        root = Path(os.environ.get('CLOUDTREND_STATE_ROOT', '/content/drive/MyDrive/CloudTrend/toss_krx_integrated')) / 'official_api_v1'
        _OFFICIAL_CLIENT = OfficialClient(os.environ.get('KRX_OPENAPI_KEY'), root, budget=9000, refresh=globals().get('REFRESH_CACHE', False))
    return _OFFICIAL_CLIENT

def official_db():
    global _OFFICIAL_DB
    if _OFFICIAL_DB is None:
        handle = tempfile.NamedTemporaryFile(prefix='cloudtrend_official_', suffix='.sqlite', delete=False)
        handle.close()
        _OFFICIAL_DB = sqlite3.connect(handle.name, check_same_thread=False)
        _OFFICIAL_DB.execute('CREATE TABLE rows (market TEXT, date TEXT, symbol TEXT, payload TEXT, PRIMARY KEY(market,date,symbol))')
        _OFFICIAL_DB.execute('CREATE INDEX symbol_dates ON rows(symbol,date)')
    return _OFFICIAL_DB

def official_day(market, day, ensure_only=False):
    global _OFFICIAL_FAILURE
    day = pd.Timestamp(day).strftime('%Y%m%d')
    iso = pd.Timestamp(day).strftime('%Y-%m-%d')
    with _OFFICIAL_LOCK:
        if _OFFICIAL_FAILURE:
            raise KRXServiceUnavailable(_OFFICIAL_FAILURE)
        db = official_db()
        key = (market, day)
        if key not in _OFFICIAL_LOADED:
            try:
                raw = official_client().fetch(market, day)
                frame = official_normalize(raw, market, day)
            except OfficialAPIError as exc:
                _OFFICIAL_FAILURE = str(exc)
                raise KRXServiceUnavailable(_OFFICIAL_FAILURE) from None
            # ETF master-only rows on weekends are NOT trading observations.
            if not frame.empty:
                frame = frame[pd.to_numeric(frame['close'], errors='coerce').gt(0) & pd.to_numeric(frame['marketCap'], errors='coerce').gt(0)].copy()
            status = 'received' if len(frame) else ('reference_only_no_prices' if raw else 'empty_unconfirmed')
            _OFFICIAL_QA.append({'date':iso,'market':market,'rawRows':len(raw),'usableRows':len(frame),'status':status})
            if 'OUTPUT_ROOT' in globals() and (len(_OFFICIAL_QA) == 1 or len(_OFFICIAL_QA) % 25 == 0):
                pd.DataFrame(_OFFICIAL_QA).to_csv(OUTPUT_ROOT/'official_api_coverage.csv',index=False,encoding='utf-8-sig')
            for row in frame.to_dict('records'):
                db.execute('INSERT OR REPLACE INTO rows VALUES (?,?,?,?)',(market,iso,row['symbol'],json.dumps(row,ensure_ascii=False)))
            db.commit()
            _OFFICIAL_LOADED.add(key)
            if len(_OFFICIAL_QA)%25==0:
                print(f'KRX 공식 API 날짜×시장 {len(_OFFICIAL_QA):,}개 확인 (공유 캐시 사용)')
        if ensure_only:
            return None
        rows = db.execute('SELECT payload FROM rows WHERE market=? AND date=?',(market,iso)).fetchall()
        return pd.DataFrame([json.loads(r[0]) for r in rows])

def official_symbol_frame(symbol, start, end, etf=False):
    # Use actual Toss candle dates: no holiday rows and no fabricated dates.
    candles = cached_frame('toss_candles',symbol,lambda:get_candles_frame(symbol,TARGET_COUNT,False))
    dates = sorted(set(candles.loc[candles.date.between(pd.Timestamp(start).strftime('%Y-%m-%d'),pd.Timestamp(end).strftime('%Y-%m-%d')),'date']))
    markets = ['ETF'] if etf else ['KOSPI','KOSDAQ'] # both for historical market transfers
    for day in dates:
        for market in markets:
            official_day(market,day,ensure_only=True)
    with _OFFICIAL_LOCK:
        rows=official_db().execute('SELECT payload FROM rows WHERE symbol=? AND date BETWEEN ? AND ? ORDER BY date',
            (symbol,pd.Timestamp(start).strftime('%Y-%m-%d'),pd.Timestamp(end).strftime('%Y-%m-%d'))).fetchall()
    f=pd.DataFrame([json.loads(r[0]) for r in rows])
    if f.empty:return pd.DataFrame(columns=['date'])
    if f.date.duplicated().any():raise KRXSchemaError('동일 종목·날짜의 시장 중복')
    mapping = {'tradingValue':'etfTradingValue' if etf else 'krxTradingValue', 'volume':'krxVolume'}
    cols=['date','tradingValue'] + (['etfNav','etfMarketCap','etfNetAssetTotalAmount','etfListedUnits','etfUnderlyingIndexClose','etfUnderlyingIndexName'] if etf else ['krxMarketCap','krxListedShares','volume'])
    return f[cols].rename(columns=mapping)

def get_krx_market_frame(symbol,start_yyyymmdd,end_yyyymmdd):
    return official_symbol_frame(symbol,start_yyyymmdd,end_yyyymmdd)

def get_krx_etf_reference_frame(symbol,start_yyyymmdd,end_yyyymmdd):
    return official_symbol_frame(symbol,start_yyyymmdd,end_yyyymmdd,True)

def get_krx_etf_investor_value_frame(symbol,start_yyyymmdd,end_yyyymmdd):
    # Official service has no individual-stock/ETF investor amount history.
    return pd.DataFrame(columns=['date'])

def get_krx_market_cap_market_day(trade_date,market):
    f=official_day(market,trade_date)
    cols=['date','symbol','krxLatestMarketCap','krxLatestListedShares']
    if f.empty:return pd.DataFrame(columns=cols)
    return f[['date','symbol','marketCap','listedShares']].rename(columns={'marketCap':'krxLatestMarketCap','listedShares':'krxLatestListedShares'})

def apply_screening_krx_foreign_batch(frame):
    print('공식 API 미제공: 개별 종목 외국인 순매수금액. Toss 수량 및 명시된 기존 추정금액을 유지합니다.')
    return frame.copy()

def diagnose_krx_connection():
    result={'provider':'KRX_OPENAPI','ok':False,'markets':{}}
    for market in (['KOSPI','KOSDAQ'] if UNIVERSE_MODE=='STOCK_ONLY' else ['ETF'] if UNIVERSE_MODE=='ETF_ONLY' else ['KOSPI','KOSDAQ','ETF']):
        for day in pd.date_range(end=COLLECTION_CUTOFF_DATE,periods=10)[::-1]:
            if day.weekday()>=5:continue
            f=official_day(market,day)
            if not f.empty:
                result['markets'][market]={'date':day.strftime('%Y-%m-%d'),'rows':len(f)}
                break
        if market not in result['markets']:
            raise KRXServiceUnavailable(f'{market}: 최근 조회일에 유효 가격·시총 자료가 없습니다. 공식 API 승인·공표일을 확인하세요.')
    result['ok']=True
    print(json.dumps(result,ensure_ascii=False,indent=2))
    return result

def ensure_krx_connection():
    diagnose_krx_connection()

def official_current_etfs():
    end = globals().get('COLLECTION_CUTOFF_DATE') or pd.Timestamp.now(tz='Asia/Seoul').date().isoformat()
    for day in pd.date_range(end=end,periods=10)[::-1]:
        if day.weekday()>=5:continue
        f=official_day('ETF',day)
        if not f.empty:
            print(f'공식 API ETF 목록: {day.date()} / {len(f):,}종')
            return f.symbol.tolist()
    raise KRXServiceUnavailable('공식 API ETF 목록의 유효 거래일을 찾지 못했습니다.')

errors = []

_errors_lock = threading.Lock()

def add_error(stage, symbol=None, endpoint=None, error=None):
    with _errors_lock:
        errors.append({
            "time": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "stage": stage,
            "symbol": symbol,
            "endpoint": endpoint,
            "error": str(error)[:2000] if error is not None else None,
        })

def normalize_symbol(value):
    if value is None:
        return None
    s = str(value).strip().upper()
    return s or None

def first_text(*values):
    for v in values:
        if v is None:
            continue
        s = str(v).strip()
        if s and s.lower() not in {"none", "nan", "null"}:
            return s
    return None

def to_number(value):
    if value is None:
        return None
    if isinstance(value, bool):
        return float(value)
    s = str(value).replace(",", "").replace("₩", "").replace("%", "").strip()
    if not s or s in {"-", "--"} or s.lower() in {"none", "null", "nan"}:
        return None
    try:
        return float(s)
    except Exception:
        return None

def first_number(*values):
    for v in values:
        n = to_number(v)
        if n is not None:
            return n
    return None

def unwrap_payload(payload):
    if isinstance(payload, dict) and "result" in payload:
        return payload["result"]
    return payload

def extract_list(payload, keys=("records", "candles", "stocks", "items", "results")):
    obj = unwrap_payload(payload)
    if isinstance(obj, list):
        return obj
    if isinstance(obj, dict):
        for key in keys:
            value = obj.get(key)
            if isinstance(value, list):
                return value
    return []

def extract_cursor(payload, keys=("nextUntil", "nextBefore", "nextCursor", "cursor")):
    obj = unwrap_payload(payload)
    if isinstance(obj, dict):
        for key in keys:
            value = obj.get(key)
            if value not in (None, ""):
                return str(value)
    if isinstance(payload, dict):
        for key in keys:
            value = payload.get(key)
            if value not in (None, ""):
                return str(value)
    return None

def to_trade_date(value):
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    try:
        ts = pd.Timestamp(s)
        # Toss 공식 timestamp는 +09:00 offset 포함. naive면 날짜 자체를 유지한다.
        if ts.tzinfo is not None:
            ts = ts.tz_convert("Asia/Seoul")
        return ts.strftime("%Y-%m-%d")
    except Exception:
        digits = re.sub(r"\D", "", s)
        if len(digits) >= 8:
            return f"{digits[:4]}-{digits[4:6]}-{digits[6:8]}"
        return None

def split_batches(values, size):
    for i in range(0, len(values), size):
        yield values[i:i+size]

def normalize_market(value):
    text = first_text(value)
    if text is None:
        return None
    upper = text.upper()
    if "KOSDAQ" in upper:
        return "KOSDAQ"
    if "KOSPI" in upper:
        return "KOSPI"
    if "KONEX" in upper:
        return "KONEX"
    return text

def safe_filename(text):
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", str(text))

_REFRESHED_STAGE_KEYS = set()

def validate_toss_openapi(strict=True):
    required_paths = {
        "/api/v1/candles",
        "/api/v1/stocks/{symbol}/investor-trading",
        "/api/v1/stocks/{symbol}/program-trades",
        "/api/v1/stocks/{symbol}/short-selling",
        "/api/v1/stocks/{symbol}/credit-trades",
        "/api/v1/stocks/{symbol}/securities-lending",
    }
    try:
        r = requests.get(OPENAPI_SPEC_URL, timeout=20)
        r.raise_for_status()
        spec = r.json()
        version = spec.get("info", {}).get("version")
        paths = set(spec.get("paths", {}))
        missing = sorted(required_paths - paths)
        print(f"Toss OpenAPI server schema version: {version}")
        if missing:
            msg = "필수 endpoint가 현재 OpenAPI에서 사라졌습니다: " + ", ".join(missing)
            if strict:
                raise RuntimeError(msg)
            warnings.warn(msg)
        return version
    except Exception as e:
        if strict:
            raise
        warnings.warn(f"OpenAPI schema 확인 실패: {e}")
        return None

class PacedRateLimiter:
    """여러 worker가 같은 공식 Rate Limits Group 한도를 넘지 않도록 시작 시각을 예약합니다."""

    def __init__(self, minimum_gap):
        self.minimum_gap = float(minimum_gap)
        self.next_at = 0.0
        self.lock = threading.Lock()

    def acquire(self, requested_gap=None):
        gap = max(self.minimum_gap, float(requested_gap or 0.0))
        with self.lock:
            now = time.monotonic()
            slot = max(now, self.next_at)
            self.next_at = slot + gap
        delay = slot - now
        if delay > 0:
            time.sleep(delay)

    def pause(self, seconds):
        with self.lock:
            self.next_at = max(self.next_at, time.monotonic() + max(0.0, seconds))

class TossClient:
    """Thread-safe OAuth client with per-rate-group pacing and pooled connections."""

    def __init__(self):
        self.timeout = (TOSS_CONNECT_TIMEOUT, TOSS_READ_TIMEOUT)
        self.max_retries = TOSS_MAX_RETRIES
        self._local = threading.local()
        self._token_lock = threading.Lock()
        self._token = None
        self._token_generation = 0
        self._metrics_lock = threading.Lock()
        self._request_count = 0
        self._retry_count = 0
        self._rate_limit_count = 0
        self._observed_limits = {}
        self._limiters = {
            "MARKET_DATA_CHART": PacedRateLimiter(TOSS_CHART_GAP),
            "MARKET_INDICATOR_CHART": PacedRateLimiter(TOSS_INDICATOR_CHART_GAP),
            "STOCK_TRADING_TREND": PacedRateLimiter(TOSS_TREND_GAP),
            "STOCK": PacedRateLimiter(TOSS_STOCK_GAP),
            "MARKET_INDICATOR": PacedRateLimiter(TOSS_INDICATOR_GAP),
        }
        self.issue_token()

    def _session(self):
        session = getattr(self._local, "session", None)
        if session is None:
            session = requests.Session()
            adapter = requests.adapters.HTTPAdapter(
                pool_connections=TOSS_WORKERS + 2,
                pool_maxsize=TOSS_WORKERS + 2,
                max_retries=0,
                pool_block=True,
            )
            session.mount("https://", adapter)
            session.headers.update({"Accept": "application/json"})
            self._local.session = session
        return session

    @staticmethod
    def _group_for(endpoint):
        if "/market-indicators/" in endpoint and endpoint.endswith("/candles"):
            return "MARKET_INDICATOR_CHART"
        if endpoint.startswith("/api/v1/market-indicators/"):
            return "MARKET_INDICATOR"
        if endpoint == "/api/v1/candles":
            return "MARKET_DATA_CHART"
        if endpoint.startswith("/api/v1/stocks/") and endpoint.rsplit("/", 1)[-1] in {
            "investor-trading", "program-trades", "short-selling",
            "credit-trades", "securities-lending",
        }:
            return "STOCK_TRADING_TREND"
        return "STOCK"

    def issue_token(self, observed_generation=None):
        # client당 유효 token은 하나뿐이므로 refresh를 단일화합니다.
        with self._token_lock:
            if observed_generation is not None and observed_generation != self._token_generation:
                return
            response = requests.post(
                BASE + "/oauth2/token",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                data={
                    "grant_type": "client_credentials",
                    "client_id": CLIENT_ID,
                    "client_secret": CLIENT_SECRET,
                },
                timeout=self.timeout,
            )
            if not response.ok:
                raise RuntimeError(
                    f"Toss 토큰 발급 실패 HTTP {response.status_code}"
                )
            payload = response.json()
            token = payload.get("access_token")
            if not token:
                obj = unwrap_payload(payload)
                if isinstance(obj, dict):
                    token = obj.get("access_token")
            if not token:
                raise RuntimeError("Toss token 응답에 access_token이 없습니다.")
            self._token = token
            self._token_generation += 1

    def _token_snapshot(self):
        with self._token_lock:
            return self._token, self._token_generation

    def _record_response(self, group, response):
        limit = response.headers.get("X-RateLimit-Limit")
        with self._metrics_lock:
            self._request_count += 1
            if response.status_code == 429:
                self._rate_limit_count += 1
            if limit:
                self._observed_limits[group] = limit

    def metrics(self):
        with self._metrics_lock:
            return {
                "requests": self._request_count,
                "retries": self._retry_count,
                "http_429": self._rate_limit_count,
                "observed_limits": dict(self._observed_limits),
            }

    def get(self, endpoint, minimum_gap=None, **params):
        group = self._group_for(endpoint)
        limiter = self._limiters[group]
        last_error = None

        for attempt in range(self.max_retries):
            if COLLECTION_STOP_EVENT.is_set():
                raise InterruptedError("수집 중단 요청")
            if attempt > 0:
                with self._metrics_lock:
                    self._retry_count += 1
            limiter.acquire(minimum_gap)
            token, generation = self._token_snapshot()
            try:
                response = self._session().get(
                    BASE + endpoint,
                    params=params,
                    headers={"Authorization": f"Bearer {token}"},
                    timeout=self.timeout,
                )
            except requests.RequestException as e:
                last_error = e
                time.sleep(min(6.0, 0.4 * (2 ** attempt)) + random.random() * 0.15)
                continue

            self._record_response(group, response)

            if response.status_code == 401:
                self.issue_token(observed_generation=generation)
                continue

            if response.status_code == 429:
                retry_after = response.headers.get("Retry-After")
                reset_after = response.headers.get("X-RateLimit-Reset")
                try:
                    delay = float(retry_after or reset_after or (0.75 * (attempt + 1)))
                except Exception:
                    delay = 0.75 * (attempt + 1)
                last_error = RuntimeError(f"HTTP 429, {delay:.2f}초 후 재시도")
                limiter.pause(max(0.5, delay))
                continue

            if 500 <= response.status_code < 600:
                last_error = RuntimeError(f"HTTP {response.status_code}")
                time.sleep(min(6.0, 0.4 * (2 ** attempt)) + random.random() * 0.15)
                continue

            if not response.ok:
                raise RuntimeError(
                    f"Toss API 오류 {endpoint} HTTP {response.status_code}"
                )

            return response.json()

        raise RuntimeError(f"Toss API 반복 실패 {endpoint}: {last_error}")

def get_market_master():
    output = {}
    for market in ["KOSPI", "KOSDAQ"]:
        try:
            payload = client.get(
                "/api/v1/stocks/all",
                minimum_gap=1.05,
                market=market,
                status="ACTIVE",
            )
            for record in extract_list(payload, ("stocks", "items", "records", "results")):
                if not isinstance(record, dict):
                    continue
                symbol = normalize_symbol(
                    first_text(
                        record.get("symbol"), record.get("code"),
                        record.get("ticker"), record.get("shortCode"),
                    )
                )
                if not symbol:
                    continue
                output[symbol] = {
                    **record,
                    "symbol": symbol,
                    "name": first_text(
                        record.get("name"), record.get("displayName"),
                        record.get("koreanName"), record.get("securityName"), symbol,
                    ),
                    "market": market,
                }
        except Exception as e:
            add_error("market_master", market, "/api/v1/stocks/all", e)
    return output

def get_stock_details(symbols):
    output = {}
    for batch in tqdm(list(split_batches(symbols, 200)), desc="Toss 종목 상세"):
        try:
            payload = client.get(
                "/api/v1/stocks",
                minimum_gap=0.35,
                symbols=",".join(batch),
            )
            for record in extract_list(payload, ("stocks", "items", "records", "results")):
                if not isinstance(record, dict):
                    continue
                symbol = normalize_symbol(
                    first_text(
                        record.get("symbol"), record.get("code"),
                        record.get("ticker"), record.get("shortCode"),
                    )
                )
                if symbol:
                    output[symbol] = record
        except Exception as e:
            add_error("stock_details", ",".join(batch[:10]), "/api/v1/stocks", e)
    return output

def get_candles_frame(symbol, target_count=TARGET_COUNT, is_index=False):
    endpoint = (
        f"/api/v1/market-indicators/{symbol}/candles"
        if is_index else "/api/v1/candles"
    )
    output = {}
    # 최초 요청부터 지정 기준일 이전 구간으로 이동합니다.
    # Toss before는 inclusive ISO 8601이므로 전날 23:59:59를 사용합니다.
    before = COLLECTION_CUTOFF_BEFORE
    seen = set()
    max_pages = max(20, (target_count // 200) + 5)

    for _ in range(max_pages):
        if COLLECTION_STOP_EVENT.is_set():
            raise InterruptedError("수집 중단 요청")
        params = {"interval": "1d", "count": min(200, target_count)}
        if not is_index:
            params.update({"symbol": symbol, "adjusted": "true"})
        if before is not None:
            params["before"] = before

        payload = client.get(endpoint, minimum_gap=TOSS_CHART_GAP, **params)
        records = extract_list(payload, ("candles", "records", "items", "results"))
        if not records:
            break

        for rec in records:
            if not isinstance(rec, dict):
                continue
            ts = first_text(rec.get("timestamp"), rec.get("date"), rec.get("tradeDate"))
            date = to_trade_date(ts)
            if not date:
                continue
            if COLLECTION_CUTOFF_DATE is not None and date > COLLECTION_CUTOFF_DATE:
                continue
            output[date] = {
                "date": date,
                "open": first_number(rec.get("openPrice")),
                "high": first_number(rec.get("highPrice")),
                "low": first_number(rec.get("lowPrice")),
                "close": first_number(rec.get("closePrice")),
                "volume": first_number(rec.get("volume")),
            }

        if len(output) >= target_count:
            break
        cursor = extract_cursor(payload, ("nextBefore",))
        if not cursor or cursor in seen:
            break
        seen.add(cursor)
        before = cursor

    if not output:
        return pd.DataFrame()
    df = pd.DataFrame(output.values()).sort_values("date").tail(target_count).reset_index(drop=True)
    return df

def fetch_trend_frame(symbol, suffix, parser, target_count=FLOW_COUNT):
    endpoint = f"/api/v1/stocks/{symbol}/{suffix}"
    output = {}
    # Toss until은 inclusive YYYY-MM-DD이므로 기준일 전날을 최초 상한으로 사용합니다.
    until = COLLECTION_CUTOFF_DATE
    seen = set()
    max_pages = max(20, (target_count // 100) + 5)

    for _ in range(max_pages):
        if COLLECTION_STOP_EVENT.is_set():
            raise InterruptedError("수집 중단 요청")
        params = {"count": min(100, target_count)}
        if until is not None:
            params["until"] = until

        payload = client.get(endpoint, minimum_gap=TOSS_TREND_GAP, **params)
        records = extract_list(payload, ("records",))
        if not records:
            break

        for rec in records:
            if not isinstance(rec, dict):
                continue
            date = to_trade_date(rec.get("date"))
            if not date:
                continue
            if COLLECTION_CUTOFF_DATE is not None and date > COLLECTION_CUTOFF_DATE:
                continue
            row = parser(rec)
            row["date"] = date
            output[date] = row

        if len(output) >= target_count:
            break
        cursor = extract_cursor(payload, ("nextUntil",))
        if not cursor or cursor in seen:
            break
        seen.add(cursor)
        until = cursor

    if not output:
        return pd.DataFrame()
    return (
        pd.DataFrame(output.values())
        .sort_values("date")
        .tail(target_count)
        .reset_index(drop=True)
    )

def parse_short_record(record):
    return {
        **{key: first_number(record.get(key)) for key in (
            'shortSellingVolume', 'shortSellingAmount',
            'shortSellingVolumeRate', 'shortSellingAmountRate')},
        'shortUpdatedAt': first_text(record.get('updatedAt')),
    }

def parse_lending_record(record):
    fields = {'executionQuantity':'lendingExecutionQuantity',
              'repaymentQuantity':'lendingRepaymentQuantity',
              'balanceQuantity':'lendingBalanceQuantity',
              'balanceAmount':'lendingBalanceAmount'}
    return {**{dest:first_number(record.get(src)) for src,dest in fields.items()},
            'lendingUpdatedAt':first_text(record.get('updatedAt'))}

def _volume_triplet(obj, prefix):
    obj = obj if isinstance(obj, dict) else {}
    return {
        f"{prefix}BuyVolume": first_number(obj.get("buyVolume")),
        f"{prefix}SellVolume": first_number(obj.get("sellVolume")),
        f"{prefix}NetBuyVolume": first_number(obj.get("netBuyVolume")),
    }

def parse_investor_record(record):
    individual = record.get("individual")
    foreigner = record.get("foreigner")
    institution = record.get("institution")
    other = record.get("otherCorporation")
    institution = institution if isinstance(institution, dict) else {}
    breakdown = institution.get("breakdown")
    breakdown = breakdown if isinstance(breakdown, dict) else {}
    holding = record.get("foreignerHolding")
    holding = holding if isinstance(holding, dict) else {}
    cfd = record.get("cfd")
    cfd = cfd if isinstance(cfd, dict) else {}

    out = {}
    out.update(_volume_triplet(individual, "individual"))
    out.update(_volume_triplet(foreigner, "foreign"))
    out.update(_volume_triplet(institution, "institution"))
    out.update(_volume_triplet(other, "otherCorporation"))

    detail_map = {
        "financialInvestment": "financialInvestment",
        "insurance": "insurance",
        "trust": "trust",
        "privateEquityFund": "privateEquityFund",
        "bank": "bank",
        "otherFinancialInstitution": "otherFinancialInstitution",
        "pensionFund": "pensionFund",
    }
    for api_key, prefix in detail_map.items():
        part = breakdown.get(api_key)
        part = part if isinstance(part, dict) else {}
        out[f"{prefix}NetBuyVolume"] = first_number(part.get("netBuyVolume"))

    rate = first_number(holding.get("holdingRate"))
    out.update({
        "foreignHoldingQuantity": first_number(holding.get("holdingQuantity")),
        "foreignHoldingLimitQuantity": first_number(holding.get("limitQuantity")),
        "foreignHoldingRate": rate,
        "foreignHoldingRatePct": rate * 100 if rate is not None else None,
        "cfdBuyBalanceQuantity": first_number(cfd.get("buyBalanceQuantity")),
        "cfdBuyBalanceRate": first_number(cfd.get("buyBalanceRate")),
        "cfdSellBalanceQuantity": first_number(cfd.get("sellBalanceQuantity")),
        "cfdSellBalanceRate": first_number(cfd.get("sellBalanceRate")),
        "investorUpdatedAt": first_text(record.get("updatedAt")),
    })
    return out

def get_market_investor_flow_frame(symbol, target_count=FLOW_COUNT):
    endpoint = f"/api/v1/market-indicators/{symbol}/investor-trading"
    output = {}
    # 지수 수급도 동일하게 기준일 이전으로 시작합니다.
    until = COLLECTION_CUTOFF_DATE
    seen = set()
    max_pages = max(20, (target_count // 100) + 5)

    for _ in range(max_pages):
        if COLLECTION_STOP_EVENT.is_set():
            raise InterruptedError("수집 중단 요청")
        params = {"interval": "1d", "count": min(100, target_count)}
        if until:
            params["until"] = until
        payload = client.get(endpoint, minimum_gap=TOSS_TREND_GAP, **params)
        records = extract_list(payload, ("records",))
        if not records:
            break

        for rec in records:
            if not isinstance(rec, dict):
                continue
            date = to_trade_date(rec.get("date"))
            if not date:
                continue
            if COLLECTION_CUTOFF_DATE is not None and date > COLLECTION_CUTOFF_DATE:
                continue

            def net_amount(key):
                obj = rec.get(key)
                obj = obj if isinstance(obj, dict) else {}
                buy = first_number(obj.get("buyAmount"))
                sell = first_number(obj.get("sellAmount"))
                return buy - sell if buy is not None and sell is not None else None

            output[date] = {
                "date": date,
                "foreignNetBuyValue": net_amount("foreigner"),
                "institutionNetBuyValue": net_amount("institution"),
                "individualNetBuyValue": net_amount("individual"),
                "otherCorporationNetBuyValue": net_amount("otherCorporation"),
                "marketFlowUpdatedAt": first_text(rec.get("updatedAt")),
            }

        if len(output) >= target_count:
            break
        cursor = extract_cursor(payload, ("nextUntil",))
        if not cursor or cursor in seen:
            break
        seen.add(cursor)
        until = cursor

    if not output:
        return pd.DataFrame()
    return pd.DataFrame(output.values()).sort_values("date").tail(target_count).reset_index(drop=True)

def set_symbol_status(symbol, stage):
    with _ACTIVE_STATUS_LOCK:
        _ACTIVE_STATUS[symbol] = stage

def get_status_summary():
    with _ACTIVE_STATUS_LOCK:
        return Counter(_ACTIVE_STATUS.values())

def merge_on_date(base, frames):
    out = base.copy()
    for frame in frames:
        if frame is None or frame.empty:
            continue
        f = frame.copy()
        if "date" not in f.columns:
            continue
        # 같은 이름이 의도치 않게 겹치면 기존 base가 아닌 새 source를 명시적으로 설계해야 한다.
        overlap = (set(out.columns) & set(f.columns)) - {"date"}
        if overlap:
            raise RuntimeError(f"merge column 충돌: {sorted(overlap)}")
        out = out.merge(f, on="date", how="left", validate="one_to_one")
    return out

def cached_toss_trend(symbol, stage, suffix, parser):
    return cached_frame(
        stage,
        symbol,
        lambda: fetch_trend_frame(symbol, suffix, parser, FLOW_COUNT),
    )

def collect_short_lending_frames(symbol):
    # This addition is for individual equities; ETF/index behavior is unchanged.
    if symbol in ETF_SET:
        return []
    frames = []
    for enabled, stage, suffix, parser in [
        (COLLECT_TOSS_SHORT, 'toss_short', 'short-selling', parse_short_record),
        (COLLECT_TOSS_LENDING, 'toss_lending', 'securities-lending', parse_lending_record),
    ]:
        if not enabled:
            continue
        set_symbol_status(symbol, stage)
        frame = cached_toss_trend(symbol, stage, suffix, parser)
        if frame.empty:
            add_error(stage + '_no_data', symbol, suffix,
                      '조회 결과 없음 또는 수집 오류: 공표 여부와 오류 로그를 확인하세요. 0으로 대체하지 않습니다.')
        frames.append(frame)
    return frames

def build_symbol_frame(symbol):
    info = symbol_info.get(symbol, {})
    is_etf = symbol in ETF_SET

    set_symbol_status(symbol, "candles")
    candles = cached_frame(
        "toss_candles",
        symbol,
        lambda: get_candles_frame(symbol, TARGET_COUNT, False),
    )
    if candles.empty:
        raise RuntimeError("Toss candle 데이터 없음")

    start = candles["date"].min().replace("-", "")
    end = candles["date"].max().replace("-", "")

    frames = []

    # Priority 3: Toss 투자자별 매매 + 보유량
    if COLLECT_TOSS_INVESTOR:
        set_symbol_status(symbol, "investor")
        frames.append(cached_toss_trend(
            symbol, "toss_investor", "investor-trading", parse_investor_record
        ))

    frames.extend(collect_short_lending_frames(symbol))

    # Toss 네트워크 대기를 먼저 겹쳐 처리한 후 KRX 구간으로 진입합니다.
    # KRX 자체는 krx_retry 내부 lock에 의해 전체 worker에서 1개씩만 호출됩니다.

    if is_etf and COLLECT_KRX_ETF:
        set_symbol_status(symbol, "krx_etf_reference")
        frames.append(cached_frame(
            "krx_etf_reference",
            symbol,
            lambda: get_krx_etf_reference_frame(symbol, start, end),
        ))
        set_symbol_status(symbol, "krx_etf_investor")
        frames.append(cached_frame(
            "krx_etf_investor_value",
            symbol,
            lambda: get_krx_etf_investor_value_frame(symbol, start, end),
        ))

    df = merge_on_date(candles, frames)

    # 메타데이터
    df.insert(0, "symbol", symbol)
    df.insert(1, "name", first_text(info.get("name"), symbol))
    df.insert(2, "market", first_text(info.get("market")))
    df.insert(3, "securityType", "ETF" if is_etf else "STOCK")
    df["priceSource"] = "TOSS_ADJUSTED_CANDLE"

    # Priority 1 canonical exact fields.
    if is_etf:
        exact_tv = df["etfTradingValue"] if "etfTradingValue" in df.columns else pd.Series(pd.NA, index=df.index)
        exact_cap = df["etfMarketCap"] if "etfMarketCap" in df.columns else pd.Series(pd.NA, index=df.index)
        listed = df["etfListedUnits"] if "etfListedUnits" in df.columns else pd.Series(pd.NA, index=df.index)
        exact_source = "KRX_ETF"
    else:
        exact_tv = df["krxTradingValue"] if "krxTradingValue" in df.columns else pd.Series(pd.NA, index=df.index)
        exact_cap = df["krxMarketCap"] if "krxMarketCap" in df.columns else pd.Series(pd.NA, index=df.index)
        listed = df["krxListedShares"] if "krxListedShares" in df.columns else pd.Series(pd.NA, index=df.index)
        exact_source = "KRX_STOCK"

    exact_tv_num = pd.to_numeric(exact_tv, errors="coerce")
    close_num = pd.to_numeric(df["close"], errors="coerce")
    volume_num = pd.to_numeric(df["volume"], errors="coerce")

    df["tradingValue"] = exact_tv_num
    proxy_mask = df["tradingValue"].isna()
    df.loc[proxy_mask, "tradingValue"] = close_num[proxy_mask] * volume_num[proxy_mask]
    df["tradingValueSource"] = exact_source
    df.loc[proxy_mask, "tradingValueSource"] = "CLOSE_X_VOLUME_PROXY"

    # 과거 시가총액은 KRX exact가 없으면 null. 현재 발행주식수×과거종가 금지.
    df["marketCap"] = pd.to_numeric(exact_cap, errors="coerce")
    df["listedShares"] = pd.to_numeric(listed, errors="coerce")
    df["marketCapSource"] = pd.NA
    df.loc[df["marketCap"].notna(), "marketCapSource"] = exact_source

    # KRX exact 금액이 있으면 우선 사용합니다.
    value_cols = [
        "foreignNetBuyValue", "institutionNetBuyValue",
        "individualNetBuyValue", "otherCorporationNetBuyValue",
    ]
    for c in value_cols:
        if c not in df.columns:
            df[c] = pd.NA

    df["investorValueSource"] = pd.NA
    exact_value_present = df[
        ["foreignNetBuyValue", "institutionNetBuyValue"]
    ].notna().all(axis=1)
    df.loc[
        exact_value_present,
        "investorValueSource"
    ] = "KRX_ETF" if is_etf else "KRX_STOCK"

    partial_exact = df[value_cols].notna().any(axis=1) & ~exact_value_present
    df.loc[partial_exact, "investorValueSource"] = "KRX_ETF_PARTIAL" if is_etf else "KRX_STOCK_PARTIAL"
    # 운영 주식 스크리닝에서만 V1 proxy fallback을 유지합니다.
    # ETF 및 exact 백테스트의 KRX 금액 결측은 그대로 둡니다.
    if not is_etf:
        for value_col, volume_col in [
            ("foreignNetBuyValue", "foreignNetBuyVolume"),
            ("institutionNetBuyValue", "institutionNetBuyVolume"),
            ("individualNetBuyValue", "individualNetBuyVolume"),
            ("otherCorporationNetBuyValue", "otherCorporationNetBuyVolume"),
        ]:
            if volume_col in df:
                q = pd.to_numeric(df[volume_col], errors="coerce")
                mask = df[value_col].isna() & q.notna() & close_num.notna()
                df.loc[mask, value_col] = q[mask] * close_num[mask]
        proxy_mask = df[value_cols].notna().any(axis=1) & df["investorValueSource"].isna()
        df.loc[proxy_mask, "investorValueSource"] = "TOSS_NET_VOLUME_X_CLOSE_PROXY"

    # Toss 종목 수급은 KRX+NXT 통합 거래량. 금액으로 환산하지 않는다.
    investor_volume_cols = [
        "individualNetBuyVolume", "foreignNetBuyVolume",
        "institutionNetBuyVolume", "otherCorporationNetBuyVolume",
    ]
    present_cols = [c for c in investor_volume_cols if c in df.columns]
    df["investorVolumeSource"] = pd.NA
    if present_cols:
        m = df[present_cols].notna().any(axis=1)
        df.loc[m, "investorVolumeSource"] = "TOSS_KRX_NXT"

    df["programTradeSource"] = pd.NA
    if "programNetBuyVolume" in df.columns:
        df.loc[df["programNetBuyVolume"].notna(), "programTradeSource"] = "TOSS_KRX_ONLY"

    return df

def _completion_quality(frame, expected_symbol=None):
    result = {'ok':False, 'reason':None, 'metrics':{}}
    required = {'symbol','date','open','high','low','close','volume'}
    if not isinstance(frame, pd.DataFrame) or frame.empty or not required.issubset(frame.columns):
        result['reason'] = 'empty_or_missing_price_columns'
        return result
    symbols = set(frame['symbol'].astype(str).str.upper())
    if len(symbols) != 1 or (expected_symbol and symbols != {expected_symbol}):
        result['reason'] = 'unexpected_symbol'
        return result
    if frame.duplicated(['symbol','date']).any():
        result['reason'] = 'duplicate_symbol_date'
        return result
    dates = pd.to_datetime(frame['date'], errors='coerce')
    if dates.isna().any() or (COLLECTION_CUTOFF_DATE and (dates > pd.Timestamp(COLLECTION_CUTOFF_DATE)).any()):
        result['reason'] = 'invalid_or_future_date'
        return result
    def num(col):
        return pd.to_numeric(frame.get(col, pd.Series(float('nan'), index=frame.index)), errors='coerce')
    def source(col, value):
        return frame.get(col, pd.Series('', index=frame.index)).eq(value).fillna(False)
    def _recent_latest_krx_gap_allowed():
        if not globals().get("ALLOW_RECENT_KRX_PUBLICATION_LAG", True):
            return False
        if globals().get("_OFFICIAL_FAILURE"):
            return False
        if dates.isna().all():
            return False
        latest_date = dates.max()
        now_date = pd.Timestamp.now(tz="Asia/Seoul").tz_localize(None).normalize()
        lag_days = int((now_date - latest_date.normalize()).days)
        return 0 <= lag_days <= int(globals().get("KRX_PUBLICATION_LAG_MAX_CALENDAR_DAYS", 7))

    latest_date_mask = dates.eq(dates.max()) if not dates.isna().all() else pd.Series(False, index=frame.index)
    krx_eval_mask = pd.Series(True, index=frame.index)
    latest_krx_pending = False
    price_ok = (num('open').gt(0) & num('high').gt(0) & num('low').gt(0) & num('close').gt(0)
                & num('volume').ge(0) & num('high').ge(num('low'))
                & num('high').ge(num('open')) & num('high').ge(num('close'))
                & num('low').le(num('open')) & num('low').le(num('close')))
    checks = {'priceCoverage':(price_ok, 0.95)}
    is_etf = next(iter(symbols)) in ETF_SET
    if is_etf and COLLECT_KRX_ETF:
        # KRX가 아직 최신 거래일을 공표하지 않았다면 그 최신 1일만 exact coverage 분모에서 제외합니다.
        # 인증/네트워크 장애(_OFFICIAL_FAILURE)는 절대 이 예외로 숨기지 않습니다.
        latest_krx_complete = (
            source('tradingValueSource','KRX_ETF')
            & num('etfNav').gt(0)
            & num('etfMarketCap').gt(0)
            & num('etfListedUnits').gt(0)
        )
        latest_rows_have_krx = bool(latest_krx_complete.loc[latest_date_mask].any()) if latest_date_mask.any() else True
        if (not latest_rows_have_krx) and _recent_latest_krx_gap_allowed():
            krx_eval_mask = ~latest_date_mask
            latest_krx_pending = True
            result.setdefault('warnings', []).append('latest_krx_publication_pending')
        if krx_eval_mask.any():
            checks.update({
                'exactTradingValue':((source('tradingValueSource','KRX_ETF') & num('tradingValue').ge(0)).loc[krx_eval_mask], EXACT_MIN_COVERAGE),
                'etfNav':(num('etfNav').gt(0).loc[krx_eval_mask], EXACT_MIN_COVERAGE),
                # AUM은 KRX가 장 마감 직후/단일일 조회에서 비어 있을 수 있어
                # 스크리닝에서는 AUM을 선택 품질항목으로 기록합니다.
                'etfMarketCap':(num('etfMarketCap').gt(0).loc[krx_eval_mask], EXACT_MIN_COVERAGE),
                'etfListedUnits':(num('etfListedUnits').gt(0).loc[krx_eval_mask], EXACT_MIN_COVERAGE),
                'exactInvestorValue':((source('investorValueSource','KRX_ETF') & num('foreignNetBuyValue').notna()
                                      & num('institutionNetBuyValue').notna()).loc[krx_eval_mask], EXACT_MIN_COVERAGE),
            })
        else:
            result.setdefault('warnings', []).append('krx_exact_pending_all_observed_rows')
        _aum_mask = num('etfNetAssetTotalAmount').gt(0).fillna(False)
        aum_cov = float(_aum_mask.loc[krx_eval_mask].mean()) if krx_eval_mask.any() else float("nan")
        result['metrics']['etfAum'] = aum_cov
        if pd.notna(aum_cov) and aum_cov < EXACT_MIN_COVERAGE:
            result.setdefault('warnings', []).append('etfAum_optional_missing_screening')
    if not is_etf:
        for enabled, label, column in [
            (COLLECT_TOSS_SHORT, 'tossShort', 'shortSellingVolume'),
            (COLLECT_TOSS_LENDING, 'tossLending', 'lendingBalanceQuantity'),
        ]:
            if enabled:
                cov = float(num(column).notna().mean())
                result['metrics'][label] = cov
                if cov < EXACT_MIN_COVERAGE:
                    result.setdefault('warnings', []).append(label + '_missing_or_publication_pending')
    # V2.1: Toss 수급수량은 보조지표. 장기 결측으로 KRX 핵심 데이터 전체를 버리지 않습니다.
    toss_mask = num('foreignNetBuyVolume').notna() & num('institutionNetBuyVolume').notna()
    result['metrics']['tossInvestorVolume'] = float(toss_mask.mean())
    result.setdefault('warnings', [])
    if COLLECT_TOSS_INVESTOR and float(toss_mask.mean()) < EXACT_MIN_COVERAGE:
        result['warnings'].append('tossInvestorVolume_optional_missing')
    # 주식 스크리닝은 최근 20거래일 수급수량의 coverage를 확인합니다.
    if not is_etf:
        recent = frame.assign(_parsed_date=dates).sort_values('_parsed_date').tail(20).index
        checks['screeningInvestorVolume'] = (toss_mask.loc[recent], EXACT_MIN_COVERAGE)
    checks.pop('exactInvestorValue', None)
    result.setdefault('warnings', []).append('individualInvestorAmount_not_provided_by_official_api')

    failed = []
    for name, (mask, minimum) in checks.items():
        cov = float(mask.fillna(False).mean())
        result['metrics'][name] = cov
        if cov < minimum:
            failed.append(f'{name}_coverage_below_{minimum:.2f}:{cov:.3f}')
    result['ok'] = not failed
    result['reason'] = ';'.join(failed) or None
    return result


from collections import Counter
BASE = "https://openapi.tossinvest.com"
OPENAPI_SPEC_URL = BASE + "/openapi-docs/latest/openapi.json"
TARGET_COUNT = FLOW_COUNT = 1
TOSS_WORKERS = 1
TOSS_CONNECT_TIMEOUT = 5
TOSS_READ_TIMEOUT = 15
TOSS_MAX_RETRIES = 5
TOSS_CHART_GAP = .15
TOSS_TREND_GAP = .12
TOSS_STOCK_GAP = .35
TOSS_INDICATOR_GAP = .12
TOSS_INDICATOR_CHART_GAP = .12
COLLECTION_STOP_EVENT = threading.Event()
_ACTIVE_STATUS = {}
_ACTIVE_STATUS_LOCK = threading.Lock()
COLLECT_TOSS_INVESTOR = COLLECT_TOSS_SHORT = COLLECT_TOSS_LENDING = True
COLLECT_KRX_ETF = True
EXACT_MIN_COVERAGE = .80
COLLECTION_CUTOFF_DATE = COLLECTION_CUTOFF_BEFORE = None

def cached_frame(stage, symbol, loader, refresh=None):
    # Per-symbol in-process stage reuse only. Durable checkpoints are verified CSV in collector.py.
    key = (stage,symbol,TARGET_COUNT,FLOW_COUNT,COLLECTION_CUTOFF_DATE)
    if key not in _stage_frames: _stage_frames[key] = loader()
    return _stage_frames[key].copy()
_stage_frames = {}
