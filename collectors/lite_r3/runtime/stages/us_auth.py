if RUN_US_MARKET:
    _us_begin_stage('auth')
    # ===== 4. Toss OAuth2 · 재시도 · rate limiter =====
    BASE_URL = 'https://openapi.tossinvest.com'

    def issue_token():
        r = requests.post(
            f'{BASE_URL}/oauth2/token',
            headers={'Content-Type':'application/x-www-form-urlencoded'},
            data={
                'grant_type':'client_credentials',
                'client_id':TOSS_CLIENT_ID,
                'client_secret':TOSS_CLIENT_SECRET,
            }, timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        token = body.get('access_token') or body.get('accessToken') or body.get('result',{}).get('accessToken')
        if not token:
            raise RuntimeError('OAuth response has no access_token')
        return token

    _token_lock = threading.Lock()
    TOKEN = issue_token()
    SESSION = requests.Session()
    SESSION.headers.update({'Authorization': f'Bearer {TOKEN}', 'Accept':'application/json'})

    _rate_lock = threading.Lock()
    _last_chart = 0.0
    _chart_count_lock = threading.Lock()
    _chart_request_count = 0

    def _chart_throttle():
        global _last_chart
        with _rate_lock:
            wait = max(0.0, (1.0/CHART_RPS) - (time.monotonic()-_last_chart))
            if wait: time.sleep(wait)
            _last_chart = time.monotonic()

    def toss_get(path, params=None, chart=False, retries=6):
        global TOKEN, _chart_request_count
        for attempt in range(retries):
            if chart:
                _chart_throttle()
                with _chart_count_lock:
                    _chart_request_count += 1
            used_token = TOKEN
            try:
                r = SESSION.get(BASE_URL+path, params=params or {}, timeout=45)
            except (requests.Timeout, requests.ConnectionError):
                time.sleep(min(16, 2**attempt)); continue
            if r.status_code == 401 and attempt == 0:
                with _token_lock:
                    if TOKEN == used_token:
                        TOKEN = issue_token()
                        SESSION.headers['Authorization'] = f'Bearer {TOKEN}'
                continue
            if r.status_code == 429:
                retry = float(r.headers.get('Retry-After') or min(8, 1.5**attempt))
                time.sleep(retry); continue
            if r.status_code in (500,502,503,504):
                time.sleep(min(8, 1.5**attempt)); continue
            r.raise_for_status()
            return r.json(), dict(r.headers)
        raise RuntimeError(f'Toss GET 재시도 소진: {path} {params}')

    print('OAuth token issued')

    _us_finish_stage('auth')

else:
    print('SKIP: RUN_US_MARKET')
