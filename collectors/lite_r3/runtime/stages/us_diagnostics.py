if RUN_US_MARKET:
    _us_begin_stage('diagnostics')
    _us_require_stage('features')
    # ===== 9. US 캘린더 · 환율 · 현재가 · 랭킹 snapshot (진단용) =====
    def safe_get(path, params=None):
        try:
            body,headers=toss_get(path,params)
            return {'ok':True,'body':body,'rateLimit':{k:v for k,v in headers.items() if 'rate' in k.lower() or 'limit' in k.lower()}}
        except Exception as e:
            return {'ok':False,'error':str(e)}

    market_calendar={'ok':True,'body':asof_calendar}
    exchange_rate=safe_get('/api/v1/exchange-rate',{'baseCurrency':'USD','quoteCurrency':'KRW'})
    # 순위/별도 현재가 조회는 스크리닝 입력과 무관한 추가 진단입니다.
    # 기본 OFF로 API 호출·시간·중간 객체를 줄이고 필요할 때만 켭니다.
    US_EXTRA_MARKET_DIAGNOSTICS = False
    ranking_amount={'ok':False,'skipped':True,'reason':'optional_diagnostics_disabled'}
    ranking_gainers={'ok':False,'skipped':True,'reason':'optional_diagnostics_disabled'}
    price_rows=[]
    if US_EXTRA_MARKET_DIAGNOSTICS:
        ranking_amount=safe_get('/api/v1/rankings',{'marketCountry':'US','type':'MARKET_TRADING_AMOUNT','duration':'1d','count':100})
        ranking_gainers=safe_get('/api/v1/rankings',{'marketCountry':'US','type':'TOP_GAINERS','duration':'1d','count':100})
        for batch in chunks(seed.ticker.tolist(),200):
            try:
                body,_=toss_get('/api/v1/prices',{'symbols':','.join(batch)})
                result=body.get('result',[])
                if isinstance(result,list): price_rows.extend(result)
            except Exception:
                pass
            time.sleep(0.08)

    # fx 숫자는 응답 형태가 바뀔 수 있어 원문을 metadata에 남기고, 찾을 수 있을 때만 row에 기록
    fx_usdkrw=np.nan
    def find_number(obj):
        if isinstance(obj,dict):
            for k,v in obj.items():
                if str(k).lower() in {'rate','exchangerate','usdkrw','price'}:
                    try: return float(v)
                    except: pass
            for v in obj.values():
                x=find_number(v)
                if x is not None:return x
        if isinstance(obj,list):
            for v in obj:
                x=find_number(v)
                if x is not None:return x
        return None
    if exchange_rate.get('ok'):
        fx_usdkrw=find_number(exchange_rate['body']) or np.nan
    snap['fx_usdkrw']=fx_usdkrw

    market_meta={
        'collectedAt':datetime.now(timezone.utc).isoformat(),
        'asOfDate':latest_date,
        'marketCalendar':market_calendar,
        'exchangeRate':exchange_rate,
        'rankingMarketTradingAmount':ranking_amount,
        'rankingTopGainers':ranking_gainers,
        'currentPriceSampleCount':len(price_rows),
    }
    (BASE_DIR/'market_meta_latest.json').write_text(json.dumps(market_meta,ensure_ascii=False,indent=2,default=str))
    print('market meta saved')

    _us_finish_stage('diagnostics')

else:
    print('SKIP: RUN_US_MARKET')
