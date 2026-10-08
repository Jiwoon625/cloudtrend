import requests
import pandas as pd
import io, json, hashlib, time, re

from pathlib import Path

from urllib.parse import urlparse, quote

AUTO_PUBLISH_TO_CLOUDTREND = bool(globals().get("AUTO_PUBLISH_TO_CLOUDTREND", True))

SUPABASE_URL = str(globals()["SUPABASE_URL"]).rstrip("/")

SOURCE_ALIASES = {'symbol': 'symbol', 'code': 'symbol', 'ticker': 'symbol', '종목코드': 'symbol', '단축코드': 'symbol', 'name': 'name', '종목명': 'name', 'market': 'market', '시장': 'market', 'type': 'type', '종류': 'type', 'securitytype': 'type', 'date': 'date', 'tradedate': 'date', '기준일': 'date', '일자': 'date', 'open': 'open', '시가': 'open', 'high': 'high', '고가': 'high', 'low': 'low', '저가': 'low', 'close': 'close', '종가': 'close', 'volume': 'volume', '거래량': 'volume', 'tradingvalue': 'tradingValue', 'amount': 'tradingValue', 'tradingamount': 'tradingValue', '거래대금': 'tradingValue', 'marketcap': 'marketCap', '시가총액': 'marketCap', 'foreignnetbuyvalue': 'foreignNetBuyValue', 'foreignnet': 'foreignNetBuyValue', '외국인순매수': 'foreignNetBuyValue', 'institutionnetbuyvalue': 'institutionNetBuyValue', 'institutionnet': 'institutionNetBuyValue', '기관순매수': 'institutionNetBuyValue', 'sector': 'sector', 'sectorcode': 'sector', '섹터': 'sector', '업종': 'sector', 'listedshares': 'listedShares', 'krxvolume': 'krxVolume', 'krxtradingvalue': 'krxTradingValue', 'krxmarketcap': 'krxMarketCap', 'krxlistedshares': 'krxListedShares', 'individualnetbuyvalue': 'individualNetBuyValue', 'othercorporationnetbuyvalue': 'otherCorporationNetBuyValue', 'registeredforeignnetbuyvalue': 'registeredForeignNetBuyValue', 'otherforeignnetbuyvalue': 'otherForeignNetBuyValue', 'financialinvestmentnetbuyvalue': 'financialInvestmentNetBuyValue', 'insurancenetbuyvalue': 'insuranceNetBuyValue', 'trustnetbuyvalue': 'trustNetBuyValue', 'privateequityfundnetbuyvalue': 'privateEquityFundNetBuyValue', 'banknetbuyvalue': 'bankNetBuyValue', 'otherfinancialinstitutionnetbuyvalue': 'otherFinancialInstitutionNetBuyValue', 'pensionfundnetbuyvalue': 'pensionFundNetBuyValue', 'individualbuyvolume': 'individualBuyVolume', 'individualsellvolume': 'individualSellVolume', 'individualnetbuyvolume': 'individualNetBuyVolume', 'foreignbuyvolume': 'foreignBuyVolume', 'foreignsellvolume': 'foreignSellVolume', 'foreignnetbuyvolume': 'foreignNetBuyVolume', 'institutionbuyvolume': 'institutionBuyVolume', 'institutionsellvolume': 'institutionSellVolume', 'institutionnetbuyvolume': 'institutionNetBuyVolume', 'othercorporationbuyvolume': 'otherCorporationBuyVolume', 'othercorporationsellvolume': 'otherCorporationSellVolume', 'othercorporationnetbuyvolume': 'otherCorporationNetBuyVolume', 'financialinvestmentnetbuyvolume': 'financialInvestmentNetBuyVolume', 'insurancenetbuyvolume': 'insuranceNetBuyVolume', 'trustnetbuyvolume': 'trustNetBuyVolume', 'privateequityfundnetbuyvolume': 'privateEquityFundNetBuyVolume', 'banknetbuyvolume': 'bankNetBuyVolume', 'otherfinancialinstitutionnetbuyvolume': 'otherFinancialInstitutionNetBuyVolume', 'pensionfundnetbuyvolume': 'pensionFundNetBuyVolume', 'foreignholdingquantity': 'foreignHoldingQuantity', 'foreignholdinglimitquantity': 'foreignHoldingLimitQuantity', 'foreignholdingrate': 'foreignHoldingRate', 'foreignholdingratepct': 'foreignHoldingRatePct', 'cfdbuybalancequantity': 'cfdBuyBalanceQuantity', 'cfdbuybalancerate': 'cfdBuyBalanceRate', 'cfdsellbalancequantity': 'cfdSellBalanceQuantity', 'cfdsellbalancerate': 'cfdSellBalanceRate', 'investorupdatedat': 'investorUpdatedAt', 'programarbitragebuyvolume': 'programArbitrageBuyVolume', 'programarbitragesellvolume': 'programArbitrageSellVolume', 'programarbitragenetbuyvolume': 'programArbitrageNetBuyVolume', 'programnonarbitragebuyvolume': 'programNonArbitrageBuyVolume', 'programnonarbitragesellvolume': 'programNonArbitrageSellVolume', 'programnonarbitragenetbuyvolume': 'programNonArbitrageNetBuyVolume', 'programnetbuyvolume': 'programNetBuyVolume', 'shortsellingvolume': 'shortSellingVolume', 'shortsellingamount': 'shortSellingAmount', 'shortsellingvolumerate': 'shortSellingVolumeRate', 'shortsellingamountrate': 'shortSellingAmountRate', 'shortupdatedat': 'shortUpdatedAt', 'marginloannewquantity': 'marginLoanNewQuantity', 'marginloanreturnquantity': 'marginLoanReturnQuantity', 'marginloanbalancequantity': 'marginLoanBalanceQuantity', 'marginloanbalancerate': 'marginLoanBalanceRate', 'marginloantradingrate': 'marginLoanTradingRate', 'stockloannewquantity': 'stockLoanNewQuantity', 'stockloanreturnquantity': 'stockLoanReturnQuantity', 'stockloanbalancequantity': 'stockLoanBalanceQuantity', 'stockloanbalancerate': 'stockLoanBalanceRate', 'stockloantradingrate': 'stockLoanTradingRate', 'creditupdatedat': 'creditUpdatedAt', 'lendingexecutionquantity': 'lendingExecutionQuantity', 'lendingrepaymentquantity': 'lendingRepaymentQuantity', 'lendingbalancequantity': 'lendingBalanceQuantity', 'lendingbalanceamount': 'lendingBalanceAmount', 'lendingupdatedat': 'lendingUpdatedAt', 'etfnav': 'etfNav', 'etftradingvalue': 'etfTradingValue', 'etfmarketcap': 'etfMarketCap', 'etfnetassettotalamount': 'etfNetAssetTotalAmount', 'etflistedunits': 'etfListedUnits', 'etfunderlyingindexname': 'etfUnderlyingIndexName', 'etfunderlyingindexclose': 'etfUnderlyingIndexClose', 'etfpremiumdiscountrate': 'etfPremiumDiscountRate', 'etftrackingerrorrate': 'etfTrackingErrorRate', 'pricesource': 'priceSource', 'tradingvaluesource': 'tradingValueSource', 'marketcapsource': 'marketCapSource', 'investorvaluesource': 'investorValueSource', 'investorvolumesource': 'investorVolumeSource', 'programtradesource': 'programTradeSource', 'marketflowupdatedat': 'marketFlowUpdatedAt'}

class PublishStopped(RuntimeError):
    pass

def require(condition, message):
    if not condition:
        raise PublishStopped(message)

def safe_request(method, url, **kwargs):
    try:
        response = requests.request(method, url, timeout=kwargs.pop('timeout', (15, 120)), **kwargs)
    except requests.RequestException:
        raise PublishStopped('네트워크 응답을 확인하지 못했습니다. 재실행 전에 publish_receipt.json을 확인하세요.') from None
    if not response.ok:
        # HTTP exception text can contain signed URLs; never print it.
        raise PublishStopped(f'요청 실패 HTTP {response.status_code} ({urlparse(url).hostname})')
    return response

def source_registry(ctx):
    return safe_request('GET',SUPABASE_URL+'/rest/v1/analysis_source_files',headers=sb_headers(ctx),params={
        'select':'id,user_id,original_filename,min_date,max_date,schema_hash,file_hash,file_size_bytes,storage_bucket,storage_path,status,activated_at,created_at',
        'user_id':'eq.'+ctx['uid'],'source_type':'eq.screening','status':'eq.active',
        'order':'activated_at.desc,created_at.desc','limit':'1000'}).json()

def source_fingerprint(rows):
    return sorted((x['id'],x['file_hash']) for x in rows)

def supply_risk_history_status(ctx, required_observations=21):
    rows = safe_request('GET', SUPABASE_URL + '/rest/v1/analysis_source_files',
        headers=sb_headers(ctx), params={
            'select':'id,original_filename,row_count,symbol_count,min_date,max_date,validation_result',
            'user_id':'eq.' + ctx['uid'], 'source_type':'eq.screening', 'status':'eq.active',
            'order':'activated_at.desc,created_at.desc', 'limit':'1000'
        }).json()
    best = {'ready': False, 'requiredObservations': int(required_observations),
            'observations': 0, 'shortRate': 0.0, 'lendingRate': 0.0, 'source': None}
    for row in rows:
        validation = row.get('validation_result') or {}
        stats = validation.get('stats') or {}
        rates = stats.get('columnNonEmptyRates') or {}
        symbols = int(row.get('symbol_count') or stats.get('symbolCount') or 0)
        row_count = int(row.get('row_count') or stats.get('rowCount') or 0)
        observations = int(round(row_count / symbols)) if symbols > 0 else 0
        short_rate = float(rates.get('shortSellingVolumeRate') or 0)
        lending_rate = float(rates.get('lendingBalanceQuantity') or 0)
        # 주식 614 + ETF 150 + 지수 2 구조에서는 주식만 값이 있어 전체 비율이 약 0.80이다.
        # 0.70 이상이면 개별주식 기준으로 실질적인 공급데이터가 있는 source로 본다.
        if observations > best['observations'] and short_rate >= 0.70 and lending_rate >= 0.70:
            best.update(observations=observations, shortRate=short_rate,
                        lendingRate=lending_rate, source=row.get('original_filename'))
        if observations >= required_observations and short_rate >= 0.70 and lending_rate >= 0.70:
            return {'ready': True, 'requiredObservations': int(required_observations),
                    'observations': observations, 'shortRate': short_rate,
                    'lendingRate': lending_rate, 'source': row.get('original_filename')}
    return best

def schema_hash(columns):
    def normal(c):
        compact = re.sub(r'[\s_()\-/]','',str(c).lstrip('\ufeff').strip()).lower()
        return SOURCE_ALIASES.get(compact, compact)
    columns = sorted(set(normal(c) for c in columns))
    return 'sha256:'+hashlib.sha256(json.dumps(columns,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()



# Supabase direct registration. No browser, login password, or workflow dispatch.
import subprocess, os, shutil, tarfile, platform
SUPABASE_USER_ID = str(globals().get("SUPABASE_USER_ID") or os.environ.get("SUPABASE_USER_ID") or "")
INGEST_COMMIT = '13f794889a57c1ccea204efe1cd30a7ec032cb84'
INGEST_REPO_URL = 'https://github.com/Jiwoon625/cloudtrend.git'

INGEST_DRIVER = "import { readFile } from 'node:fs/promises';\nimport { validateSourceBytes, toCanonicalCsv } from '../src/lib/sourceData';\nimport { trustedSupabaseClient } from './analysis-run-store';\nimport { registerSourceBytes, loadAnalysisSourceInputs, syncLegacyScreening } from './source-registry-store';\nconst file=process.env['CT_INPUT'];\nconst mode=process.env['CT_MODE'];\nconst uid=process.env['SUPABASE_USER_ID'];\nconst fingerprintJson=process.env['CT_FINGERPRINT'];\ntry {\n  if (!file || !['append','merge','reuse','validate'].includes(mode ?? '')) throw new Error('Invalid arguments');\n  const bytes = new Uint8Array(await readFile(file));\n  if (mode === 'validate') {\n    const v = await validateSourceBytes({bytes, filename:'source.csv'});\n    if (!v.valid) throw new Error('Source validator rejected input');\n    console.log('PUBLISH_RESULT='+JSON.stringify({ok:true, schemaHash:v.schemaHash, rows:v.stats.rowCount}));\n  } else {\n    const client = trustedSupabaseClient();\n    const {data,error} = await client.from('analysis_source_files')\n      .select('id,file_hash').eq('user_id',uid!).eq('source_type','screening').eq('status','active');\n    if (error) throw error;\n    const actual=(data ?? []).map(r=>[r.id,r.file_hash]).sort((a,b)=>a[0].localeCompare(b[0]));\n    if (JSON.stringify(actual)!==fingerprintJson) throw new Error('Source registry changed during review');\n    if (mode === 'reuse') {\n      const inputs = await loadAnalysisSourceInputs(client,uid!,'screening');\n      const v = await validateSourceBytes({bytes,filename:file.split('/').at(-1)!});\n      const exact=inputs.find(i=>i.fileHash===v.fileHash);\n      if (!exact?.sourceRecord) throw new Error('Previously registered source not found');\n      await syncLegacyScreening(client,uid!,inputs,file.split('/').at(-1)!);\n      console.log('PUBLISH_RESULT='+JSON.stringify({ok:true,sourceId:exact.id,status:'active',\n        fileHash:v.fileHash,asOfDate:exact.sourceRecord.max_date,legacySynced:true}));\n    } else {\n    const result = await registerSourceBytes({client,userId:uid!,sourceType:'screening',\n      mode:mode as 'append'|'merge',origin:'gpt',bytes,filename:file.split('/').at(-1)!,syncLegacy:false});\n    console.log('PUBLISH_RESULT='+JSON.stringify({ok:true,sourceId:result.source.id,\n      status:result.source.status,fileHash:result.source.file_hash,asOfDate:result.source.max_date,\n      legacySynced:false}));\n    }\n  }\n} catch (error) {\n  const e=error as any;\n  let message=String(e?.message ?? error);\n  for (const name of ['SUPABASE_SERVICE_ROLE_KEY']) {\n    const value=process.env[name]; if(value) message=message.split(value).join('[REDACTED]');\n  }\n  message=message.replace(/https?:\\/\\/[^\\s]+/g,'[URL]').replace(/eyJ[\\w-]+\\.[\\w-]+\\.[\\w-]+/g,'[TOKEN]').replace(/sb_secret_[\\w-]+/g,'[TOKEN]');\n  console.error('PUBLISH_ERROR='+JSON.stringify({message:message.slice(0,3000),code:e?.code ?? null}));\n  process.exitCode=1;\n}\n"

def clean_child_env():
    return {k:v for k,v in os.environ.items() if k in ('PATH','HOME','TMPDIR','LANG','LC_ALL','SSL_CERT_FILE','SSL_CERT_DIR')}

def redact_error(value, env=None):
    text = str(value)
    for name, secret in (env or {}).items():
        if any(word in name.upper() for word in ('KEY','TOKEN','PASSWORD','SECRET')) and secret:
            text = text.replace(secret, '[REDACTED]')
    text = re.sub(r'https?://[^\s]+', '[URL]', text)
    text = re.sub(r'eyJ[\w-]+\.[\w-]+\.[\w-]+|sb_secret_[\w-]+', '[TOKEN]', text)
    return text[-4000:]

def run_private(args, cwd=None, env=None, timeout=600):
    try:
        r = subprocess.run(args,cwd=cwd,env=env or clean_child_env(),text=True,
                           capture_output=True,timeout=timeout,check=False)
    except (OSError,subprocess.TimeoutExpired):
        raise PublishStopped('등록 도구 실행 실패/시간 초과입니다. 원본을 보존했습니다.') from None
    if r.returncode != 0:
        detail = redact_error(r.stderr or r.stdout, env)
        if 'heap out of memory' in detail.lower() or r.returncode in (-6, -9, 134, 137):
            detail = '등록 프로세스 메모리 부족/강제 종료. 다른 작업을 종료하거나 고용량 RAM 런타임에서 재시도하세요. ' + detail
        raise PublishStopped(f'등록 도구 종료 코드 {r.returncode}: {detail or "상세 출력 없음"}')
    return r.stdout

def prepare_ingest_runtime():
    require(re.fullmatch(r'[0-9a-f]{40}', INGEST_COMMIT) is not None, '최종 검토·병합된 등록 코드 버전이 필요합니다.')
    require(platform.machine() in ('x86_64','AMD64'), '현재 등록 도구는 Colab Linux x64용입니다.')
    root=Path('/content/cloudtrend-publish-runtime');root.mkdir(parents=True,exist_ok=True)
    version='v22.16.0';name=f'node-{version}-linux-x64'
    node_home=root/name
    if not (node_home/'bin/node').is_file():
        archive=name+'.tar.xz';base=f'https://nodejs.org/dist/{version}/'
        checks=safe_request('GET',base+'SHASUMS256.txt').text
        expected=next((line.split()[0] for line in checks.splitlines() if line.split()[-1]==archive),None)
        require(expected is not None,'Node 배포 체크섬 확인 실패입니다.')
        body=safe_request('GET',base+archive,timeout=(15,300)).content
        require(hashlib.sha256(body).hexdigest()==expected,'Node 다운로드 체크섬 불일치입니다.')
        with tarfile.open(fileobj=io.BytesIO(body),mode='r:xz') as tf:
            tf.extractall(root,filter='data')
    child_env=clean_child_env();child_env['PATH']=str(node_home/'bin')+os.pathsep+child_env.get('PATH','')
    repo=root/('source-'+INGEST_COMMIT[:12])
    if not (repo/'.git').exists():
        repo.mkdir(exist_ok=True)
        run_private(['git','init',str(repo)],env=child_env)
        run_private(['git','-C',str(repo),'remote','add','origin',INGEST_REPO_URL],env=child_env)
    if not (repo/'package-lock.json').exists():
        run_private(['git','-C',str(repo),'fetch','--depth','1','origin',INGEST_COMMIT],env=child_env)
        run_private(['git','-C',str(repo),'checkout','--detach',INGEST_COMMIT],env=child_env)
    actual=run_private(['git','-C',str(repo),'rev-parse','HEAD'],env=child_env).strip()
    require(actual==INGEST_COMMIT,'등록 코드 버전이 다릅니다.')
    require(not run_private(['git','-C',str(repo),'diff','--name-only','HEAD'],env=child_env).strip(),
            '등록 코드가 로컬에서 변경되었습니다. 전용 런타임 폴더를 확인하세요.')
    if not (repo/'node_modules/.bin/vite-node').is_file():
        run_private([str(node_home/'bin/npm'),'ci','--ignore-scripts','--no-audit','--no-fund'],cwd=repo,env=child_env,timeout=1200)
    # The pinned common loader validates generations and owns cache ordering.
    require(re.fullmatch(r'[0-9a-f]{40}', INGEST_COMMIT) is not None, '최종 검토·병합된 등록 코드 버전이 필요합니다.')
    cache_root = Path('/content/drive/MyDrive/CloudTrend/toss_krx_integrated/cache/source_validation')
    require(re.fullmatch(r'[0-9a-f-]{36}', SUPABASE_USER_ID) is not None, '캐시 소유자 식별자가 올바르지 않습니다.')
    cache_dir = cache_root / SUPABASE_USER_ID
    cache_dir.mkdir(parents=True, exist_ok=True)
    child_env['SOURCE_VALIDATION_CACHE_DIR'] = str(cache_dir)
    (repo/'scripts/colab-register-only.ts').write_text(INGEST_DRIVER)
    (repo/'colab-ingest.config.ts').write_text('export default { resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } } };')
    return repo,child_env

def setup_publish():
    # Fast registry/auth preflight. Pinned Node + git + npm bootstrap runs at the
    # first guarded validation during publish, never while collecting candles.
    # Earlier Colab setup supports environment, Secrets and explicit input.
    # Reuse its credential without ever printing it or writing it to a file.
    key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
    if not key:
        try:
            key = userdata.get('SUPABASE_SERVICE_ROLE_KEY')
        except Exception:
            raise PublishStopped('SUPABASE_SERVICE_ROLE_KEY 환경변수 또는 Colab Secrets를 확인하세요.') from None
    require(isinstance(key,str) and bool(key.strip()),'SUPABASE_SERVICE_ROLE_KEY가 비어 있습니다.')
    ctx={'uid':SUPABASE_USER_ID,'key':key.strip(),'repo':None,'child_env':None}
    rows=source_registry(ctx)
    require(bool(rows),'해당 계정의 활성 스크리닝 자료를 조회하지 못했습니다. 키/프로젝트를 확인하세요.')
    print('Supabase 등록 계정 확인 완료. Node 검증 도구는 실제 게시 시에만 준비합니다.')
    return ctx

def sb_headers(ctx):
    headers={'apikey':ctx['key']}
    # Legacy service-role JWT needs Bearer; newer sb_secret keys use apikey only.
    if not ctx['key'].startswith('sb_secret_'):
        headers['Authorization']='Bearer '+ctx['key']
    return headers


def local_qa(manifest_path, run_id):
    require(manifest_path is not None, '이번 실행의 manifest가 없습니다.')
    manifest_path = Path(manifest_path)
    m = json.loads(manifest_path.read_text(encoding='utf-8'))
    require(m.get('runId') == run_id, '이전 실행의 manifest입니다.')
    require(m.get('mode') == 'SCREENING' and m.get('complete') is True, '수집이 완전하게 끝나지 않았습니다.')
    require(m.get('missingSymbols') == [] and m.get('missingIndexSymbols') == [], '누락 종목/지수가 있습니다.')
    require(m.get('missingSymbolCount') == 0 and bool(m.get('csv')), 'CSV 또는 완료 정보가 없습니다.')
    parts = []
    seen_files = set()
    for info in m['csv']:
        path = manifest_path.parent/info['file']
        require(path.is_file() and path.parent.resolve() == manifest_path.parent.resolve(), 'CSV 경로가 유효하지 않습니다.')
        require(path.name not in seen_files, 'manifest CSV 중복입니다.')
        seen_files.add(path.name)
        raw = path.read_bytes()
        require(len(raw) == info['bytes'] and hashlib.sha256(raw).hexdigest() == info['sha256'], 'CSV 크기/해시가 manifest와 다릅니다.')
        require(0 < len(raw) <= 45*1024*1024, '파일 크기 제한 초과입니다.')
        part = pd.read_csv(io.BytesIO(raw),dtype=str,keep_default_na=False,encoding='utf-8-sig')
        require(list(part.columns) == m['columns'] and len(part.columns)==102, '102열 계약이 다릅니다.')
        parts.append(part)
    table = pd.concat(parts,ignore_index=True)
    require(len(table)==m['rowCount'] and table.symbol.nunique()==m['symbolCount'], '행수/종목수가 다릅니다.')
    require(not table.duplicated(['date','symbol']).any(), '종목·날짜 중복이 있습니다.')
    dates = pd.to_datetime(table.date,format='%Y-%m-%d',errors='coerce')
    require(dates.notna().all() and dates.dt.strftime('%Y-%m-%d').eq(table.date).all(), '거래일 형식이 잘못되었습니다.')
    latest = table.date.max()
    require(latest == m.get('actualLatestPriceDate') == m.get('cutoffDateInclusive'), '실제 최신 가격일과 조회 상한일이 다릅니다.')
    expected = set(m['requestedSymbols']) | {'KOSPI','KOSDAQ'}
    require(set(table.symbol)==expected, '요청한 종목 목록과 다릅니다.')
    require(set(table.loc[table.date==latest,'symbol'])==expected, '최신 거래일에 요청 종목이 누락되었습니다.')
    # Earlier IPO/suspension rows may legitimately be absent; never manufacture rows.
    for date, part in table.groupby('date'):
        require(set(part.loc[part.securityType=='INDEX','symbol'])=={'KOSPI','KOSDAQ'}, f'{date}: 시장지수 누락입니다.')
    for col in ['open','high','low','close']:
        values = pd.to_numeric(table[col],errors='coerce')
        require(values.notna().all() and (values>0).all(), f'{col}에 결측/비정상 가격이 있습니다.')
    require((pd.to_numeric(table.high)>=pd.to_numeric(table[['open','close','low']].stack()).unstack().max(axis=1)).all(), '고가 범위 오류입니다.')
    require((pd.to_numeric(table.low)<=pd.to_numeric(table[['open','close','high']].stack()).unstack().min(axis=1)).all(), '저가 범위 오류입니다.')
    # Screening supplies stock market cap only on the latest day, not the whole history.
    latest_non_index = (table.date==latest) & (table.securityType!='INDEX')
    if m.get('latestKrxPublicationPending'):
        phase = 'PRELIMINARY'
    else:
        require((pd.to_numeric(table.loc[latest_non_index,'marketCap'],errors='coerce')>0).all(), '최신일 시가총액이 일부 누락되었습니다.')
        phase = 'FINAL'
    return m, table.sort_values(['date','symbol']).reset_index(drop=True), latest, phase


def merge_nonempty_row(previous, incoming):
    def present(value):
        return value is not None and str(value).strip() != ''
    merged = dict(previous)
    merged.update({k:v for k,v in incoming.items() if present(v)})
    # Source labels must follow their values, including retained historical values.
    for label, fields in {
        'marketCapSource':['marketCap'],
        'tradingValueSource':['tradingValue'],
        'investorValueSource':['foreignNetBuyValue','institutionNetBuyValue','individualNetBuyValue','otherCorporationNetBuyValue'],
        'investorVolumeSource':['foreignNetBuyVolume','institutionNetBuyVolume','individualNetBuyVolume','otherCorporationNetBuyVolume'],
        'shortUpdatedAt':['shortSellingVolume','shortSellingAmount','shortSellingVolumeRate','shortSellingAmountRate'],
        'lendingUpdatedAt':['lendingExecutionQuantity','lendingRepaymentQuantity','lendingBalanceQuantity','lendingBalanceAmount'],
    }.items():
        if not any(present(incoming.get(k)) for k in fields) and present(previous.get(label)):
            merged[label] = previous[label]
    # Recollection proxies must not downgrade a previously published exact value.
    for label,fields in [('tradingValueSource',['tradingValue']),('investorValueSource',[
        'foreignNetBuyValue','institutionNetBuyValue','individualNetBuyValue','otherCorporationNetBuyValue'])]:
        if str(previous.get(label,'')).startswith('KRX_') and 'PROXY' in str(incoming.get(label,'')):
            for key in fields+[label]:
                if present(previous.get(key)): merged[key]=previous[key]
    return merged


def prepare_period_merge(ctx, rows, table):
    require(rows and len(rows)<1000, '활성 source 목록이 없거나 조회 한도를 초과했습니다.')
    require(all(r['schema_hash']==schema_hash(table.columns) for r in rows), '기존 schema와 다릅니다.')
    keys = set(zip(table.symbol,table.date))
    first,last = table.date.min(),table.date.max()
    existing = {}
    for record in rows:  # newest activated first: same priority as the screening loader
        if record['max_date'] < first or record['min_date'] > last: continue
        url = SUPABASE_URL+'/storage/v1/object/authenticated/'+record['storage_bucket']+'/'+quote(record['storage_path'],safe='/')
        raw = safe_request('GET',url,headers=sb_headers(ctx)).content
        require('sha256:'+hashlib.sha256(raw).hexdigest()==record['file_hash'], '기존 원본 해시 불일치입니다.')
        for part in pd.read_csv(io.BytesIO(raw),dtype=str,keep_default_na=False,encoding='utf-8-sig',chunksize=10000):
            require(set(part.columns)==set(table.columns), '기존 파일 컬럼이 다릅니다.')
            for row in part.loc[part.date.between(first,last)].to_dict('records'):
                key=(row['symbol'],row['date'])
                if key in keys and key not in existing: existing[key]=row
    result=[]
    retained=0
    for incoming in table.to_dict('records'):
        old=existing.get((incoming['symbol'],incoming['date']),{})
        merged=merge_nonempty_row(old,incoming)
        retained += sum(bool(str(old.get(k,'')).strip()) and not bool(str(incoming.get(k,'')).strip()) for k in table.columns)
        result.append(merged)
    return pd.DataFrame(result,columns=table.columns).fillna(''), {'overlapRows':len(existing),'preservedBlankCells':retained}


def write_publish_chunks(table, folder, limit=42_000_000):
    folder=Path(folder);folder.mkdir(parents=True,exist_ok=True)
    paths=[]
    def write(part):
        path=folder/f"publish_{part.date.min().replace('-','')}_{part.date.max().replace('-','')}_{len(paths):03d}.csv"
        part.to_csv(path,index=False,encoding='utf-8-sig',na_rep='')
        if path.stat().st_size>limit:
            dates=sorted(part.date.unique())
            require(len(dates)>1,'단일 거래일 업로드 파일이 크기 제한을 초과합니다.')
            path.unlink()
            split=dates[len(dates)//2]
            write(part.loc[part.date<split]);write(part.loc[part.date>=split])
        else: paths.append(path)
    write(table)
    return paths


def publish_to_supabase(ctx, manifest_path, run_id):
    m,table,latest,phase=local_qa(manifest_path,run_id)
    rows=source_registry(ctx)
    merged,stats=prepare_period_merge(ctx,rows,table)
    paths=write_publish_chunks(merged,Path(manifest_path).parent/'publish_prepared')
    receipt_path=Path(manifest_path).parent/'publish_receipt.json'
    receipt={'runId':run_id,'fromDate':table.date.min(),'asOfDate':latest,'tradingDays':int(table.date.nunique()),
             'phase':phase,'mergePolicy':'nonempty-new-retain-old-v1','mergeStats':stats,'parts':[],
             'screeningTriggered':False,'status':'QA_PASSED'}
    def save(status):
        receipt['status']=status
        temp=receipt_path.with_suffix('.tmp');temp.write_text(json.dumps(receipt,ensure_ascii=False,indent=2));temp.replace(receipt_path)
    def invoke(path,mode,active):
        # First call is inside publish_to_supabase's try/except and receipt guard.
        # Validation, generation/hash checks, and legacy sync remain unchanged.
        if ctx.get('repo') is None:
            print('최초 게시 검증: 고정된 Node/GitHub 도구 설치 및 커밋 검증')
            repo,child_env=prepare_ingest_runtime()
            ctx['repo'],ctx['child_env']=repo,child_env
        env=ctx['child_env'].copy()
        env.update(SUPABASE_URL=SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY=ctx['key'],SUPABASE_USER_ID=ctx['uid'],NODE_OPTIONS='--max-old-space-size=8192')
        env.update(CT_INPUT=str(path.resolve()),CT_MODE=mode,CT_FINGERPRINT=json.dumps(source_fingerprint(active),separators=(',',':')))
        command=[str(ctx['repo']/'node_modules/.bin/vite-node'),'--config','colab-ingest.config.ts','scripts/colab-register-only.ts']
        output=run_private(command,cwd=ctx['repo'],env=env,timeout=1800)
        payload=next((line[len('PUBLISH_RESULT='):] for line in output.splitlines() if line.startswith('PUBLISH_RESULT=')),None)
        require(payload is not None,'등록 결과를 확인하지 못했습니다.')
        result=json.loads(payload)
        require(result.get('ok'),'등록/통합 실패입니다.')
        return result
    save('QA_PASSED')
    try:
        # Validate every prepared file before the first mutation.
        for path in paths: invoke(path,'validate',rows)
        require(source_fingerprint(source_registry(ctx))==source_fingerprint(rows),'병합 준비 중 원천 목록이 바뀌었습니다. 재시도하세요.')
        active=rows
        for path in paths:
            digest='sha256:'+hashlib.sha256(path.read_bytes()).hexdigest()
            exact=next((r for r in active if r['file_hash']==digest),None)
            save('REGISTERING')
            if exact:
                source_id=exact['id'];mode='reuse'
            else:
                result=invoke(path,'merge',active)
                require(result.get('fileHash')==digest,'등록 해시 불일치입니다.')
                source_id=result['sourceId'];mode='merge'
            current=source_registry(ctx)
            # Only this run's own source may have appeared since the snapshot.
            expected=dict(source_fingerprint(active));expected[source_id]=digest
            require(dict(source_fingerprint(current))==expected,'업로드 중 다른 실행이 원천 목록을 변경했습니다.')
            record=next((r for r in current if r['id']==source_id),None)
            require(record is not None and record['file_hash']==digest,'활성 원천 확인 실패입니다.')
            url=SUPABASE_URL+'/storage/v1/object/authenticated/'+record['storage_bucket']+'/'+quote(record['storage_path'],safe='/')
            readback=safe_request('GET',url,headers=sb_headers(ctx)).content
            require('sha256:'+hashlib.sha256(readback).hexdigest()==digest,'업로드 파일 재조회 검증 실패입니다.')
            receipt['parts'].append({'sourceId':source_id,'file':path.name,'fileHash':digest,'mode':mode,'verified':True})
            active=current
            save('REGISTERED_PART')
        save('SYNCING_LEGACY')
        result=invoke(paths[-1],'reuse',active)
        require(result.get('legacySynced') is True,'호환 데이터 동기화 실패입니다.')
        require(source_fingerprint(source_registry(ctx))==source_fingerprint(active),'통합 중 다른 실행이 원천 목록을 변경했습니다.')
        receipt['sourceId']=receipt['parts'][-1]['sourceId']
        receipt['sourceIds']=[p['sourceId'] for p in receipt['parts']]
        receipt['rowCount']=len(merged)
        receipt['coverage']={c:int(pd.to_numeric(merged[c],errors='coerce').notna().sum()) for c in ['shortSellingVolume','lendingBalanceQuantity']}
        save('PUBLISHED')
        print(f"{receipt['fromDate']} ~ {latest}: {receipt['tradingDays']}거래일 / {len(merged):,}행 업로드·통합·재조회 검증 완료")
        print(f"기존 공란 보완/보존: {stats}; 공매도·대차 유효 행수: {receipt['coverage']}")
        print('CloudTrend 스크리닝은 직접 시작하세요.')
        return receipt
    except Exception as error:
        receipt['failedStage']=receipt['status']
        receipt['error']=redact_error(error,{'SUPABASE_SERVICE_ROLE_KEY':ctx['key']})
        save('STOPPED')
        raise PublishStopped(f"{receipt['failedStage']} 실패: {receipt['error']}\n원본과 업로드 영수증을 보존했습니다. 재시도 시 같은 파일은 재사용합니다.") from None


PUBLISH_CONTEXT = setup_publish() if AUTO_PUBLISH_TO_CLOUDTREND else None
