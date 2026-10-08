"""Exact, stock-only Supply Risk history checks; no source writes or strategy changes."""
import math
import re

SUPPLY_READINESS_VERSION = 'stock-session-v2'
_SUPPLY_FIELDS = ('shortSellingVolumeRate', 'lendingBalanceQuantity')


def _supply_number(value):
    if isinstance(value, bool):
        return None
    try:
        number = float(str(value).strip().replace(',', '').replace('%', ''))
        return number if math.isfinite(number) else None
    except (ValueError, TypeError):
        return None


def _supply_symbol(value):
    symbol = str(value or '').strip().upper()
    return symbol.zfill(6) if symbol.isdigit() else symbol


def supply_market_window(probes, cutoff, required=21):
    """Use both markets' observed sessions, never weekday guesses or row averages."""
    from datetime import date
    if set(probes) != {'KOSPI', 'KOSDAQ'}:
        raise ValueError('두 시장 지수의 실제 가격일이 모두 필요합니다.')
    calendars = []
    for symbol in ('KOSPI', 'KOSDAQ'):
        rows = probes[symbol].to_dict('records') if hasattr(probes[symbol], 'to_dict') else probes[symbol]
        dates = []
        for row in rows:
            day = str(row.get('date', ''))
            try:
                date.fromisoformat(day)
            except ValueError:
                raise ValueError('시장지수 날짜 형식이 올바르지 않습니다.') from None
            if day > cutoff:
                raise ValueError('시장지수에 조회 상한 이후 날짜가 있습니다.')
            if any((_supply_number(row.get(field)) or 0) <= 0 for field in ('open','high','low','close')):
                raise ValueError('시장지수의 유효한 OHLC 가격이 필요합니다.')
            if _supply_number(row['high']) < max(_supply_number(row[k]) for k in ('open','close','low')) or _supply_number(row['low']) > min(_supply_number(row[k]) for k in ('open','close','high')):
                raise ValueError('시장지수 OHLC 범위가 올바르지 않습니다.')
            dates.append(day)
        if len(dates) != len(set(dates)):
            raise ValueError('시장지수에 중복 거래일이 있습니다.')
        calendars.append(sorted(dates)[-(required + 1):])
    if calendars[0] != calendars[1] or len(calendars[0]) != required + 1:
        raise ValueError('두 지수의 최근 거래일 목록이 다르거나 22개 관측치가 부족합니다.')
    if (date.fromisoformat(cutoff) - date.fromisoformat(calendars[0][-1])).days > 14:
        raise ValueError('시장지수의 최신 거래일이 14일 넘게 오래되었습니다.')
    return calendars[0][-1], calendars[0][:-1]


def assess_supply_history(rows, stock_symbols, sessions, enabled_fields=_SUPPLY_FIELDS,
                          required=21, threshold=0.70):
    """Rows are the effective nonempty overlay of newest authoritative active sources."""
    symbols = sorted(set(_supply_symbol(s) for s in stock_symbols))
    fields = tuple(enabled_fields)
    base = dict(ready=False, requiredObservations=required, observations=0,
                eligibleStockCount=len(symbols), threshold=threshold,
                backfillSymbols=symbols, version=SUPPLY_READINESS_VERSION,
                sessionDates=list(sessions), source=None, reasons=[])
    if not symbols or any(not re.fullmatch(r'[0-9A-Z]{6}', s) for s in symbols):
        base['reasons'] = ['수집 대상 주식 분류/목록이 비어 있거나 올바르지 않습니다.']
        return base
    if not fields or any(f not in _SUPPLY_FIELDS for f in fields):
        base['reasons'] = ['활성 Supply Risk 지표가 없습니다.']
        return base
    if len(sessions) != required or len(set(sessions)) != required or list(sessions) != sorted(sessions):
        base['reasons'] = ['검증된 21개 고유 거래일이 필요합니다.']
        return base
    universe, days = set(symbols), set(sessions)
    keyed, duplicate, unknown = {}, False, set()
    for row in rows:
        symbol, day = _supply_symbol(row.get('symbol')), str(row.get('date', ''))
        if symbol not in universe or day not in days:
            continue
        key = (symbol, day)
        if key in keyed:
            duplicate = True
        keyed[key] = row
        if str(row.get('type', row.get('securityType', ''))).strip().upper() != 'STOCK':
            unknown.add(symbol)
    if duplicate:
        base['reasons'] = ['유효 이력에 중복 종목·거래일이 있습니다.']
        return base
    daily = []
    complete = []
    valid_by_symbol = {}
    for symbol in symbols:
        valid = []
        for day in sessions:
            row = keyed.get((symbol, day), {})
            values = [_supply_number(row.get(field)) for field in fields]
            ok = symbol not in unknown and (_supply_number(row.get('close')) or 0) > 0
            valid.append(bool(ok and all(v is not None and v >= 0 for v in values)))
        valid_by_symbol[symbol] = valid
        if all(valid):
            complete.append(symbol)
    for i, day in enumerate(sessions):
        count = sum(valid_by_symbol[s][i] for s in symbols)
        daily.append(dict(date=day, eligibleStockCount=len(symbols), validStockCount=count,
                          coverage=count / len(symbols)))
    observations = sum(d['coverage'] >= threshold for d in daily)
    ready = observations == required and len(complete) / len(symbols) >= threshold and not unknown
    base.update(ready=ready, observations=observations, dailyCoverage=daily,
                completeStockCount=len(complete), completeStockRate=len(complete)/len(symbols),
                backfillSymbols=sorted(universe-set(complete)), unknownClassificationSymbols=sorted(unknown))
    if unknown:
        base['reasons'].append(f'요청 주식 중 {len(unknown)}종목의 분류가 STOCK으로 확인되지 않습니다.')
    if observations < required:
        base['reasons'].append(f'주식 기준 70% 충족 거래일 {observations}/{required}')
    if len(complete)/len(symbols) < threshold:
        base['reasons'].append(f'21일 모두 유효한 주식 {len(complete)}/{len(symbols)}')
    return base


def install_supply_readiness(namespace):
    import functools
    import hashlib
    import io
    import json
    from pathlib import Path
    from urllib.parse import quote
    ns = namespace

    def history(ctx, sessions, required=21):
        stocks = list(ns.get('STOCKS', []))
        fields = tuple(field for flag, field in (
            ('COLLECT_TOSS_SHORT', _SUPPLY_FIELDS[0]), ('COLLECT_TOSS_LENDING', _SUPPLY_FIELDS[1])) if ns.get(flag))
        baseline = assess_supply_history([], stocks, sessions, fields, required)
        if not stocks or ctx is None:
            baseline['reasons'].append('등록 원천 확인 환경 또는 수집 대상 주식이 없습니다.')
            return baseline
        sources = ns['source_registry'](ctx)
        if not sources or len(sources) >= 1000:
            baseline['reasons'].append('활성 원천이 없거나 목록 조회 한도에 도달했습니다.')
            return baseline
        fingerprint = ns['source_fingerprint'](sources)
        effective, names = {}, []
        wanted = {'symbol','date','type','close', *fields}
        universe, days = set(stocks), set(sessions)
        aliases = ns['SOURCE_ALIASES']
        def canonical(column):
            compact = re.sub(r'[\s_()\-/]', '', str(column).lstrip('\ufeff').strip()).lower()
            return aliases.get(compact, compact)
        for source in sources:  # newest activated first, fill older nonempty values only
            if str(source.get('max_date', '')) < sessions[0] or str(source.get('min_date', '')) > sessions[-1]:
                continue
            print(f"[이력 확인] 원천 {len(names)+1}: {source.get('original_filename','CSV')} 읽기", flush=True)
            url = ns['SUPABASE_URL']+'/storage/v1/object/authenticated/'+source['storage_bucket']+'/'+quote(source['storage_path'], safe='/')
            raw = ns['safe_request']('GET', url, headers=ns['sb_headers'](ctx)).content
            ns['require']('sha256:'+hashlib.sha256(raw).hexdigest() == source['file_hash'], '준비도 확인 원천 해시가 다릅니다.')
            expected_size = source.get('file_size_bytes')
            ns['require'](expected_size is None or len(raw) == int(expected_size), '준비도 확인 원천 크기가 다릅니다.')
            table = ns['pd'].read_csv(io.BytesIO(raw), dtype=str, keep_default_na=False, encoding='utf-8-sig',
                                     usecols=lambda col: canonical(col) in wanted)
            table.columns = [canonical(col) for col in table.columns]
            ns['require'](len(set(table.columns)) == len(table.columns), '준비도 확인 컬럼이 중복됩니다.')
            ns['require']({'symbol','date','type','close'}.issubset(table.columns), '준비도 확인에 필요한 종목·날짜·분류·가격 컬럼이 없습니다.')
            table['symbol'] = table['symbol'].map(_supply_symbol)
            subset = table.loc[table.symbol.isin(universe) & table.date.isin(days)]
            ns['require'](not subset.duplicated(['symbol','date']).any(), '준비도 원천에 중복 종목·거래일이 있습니다.')
            for row in subset.to_dict('records'):
                # Analysis parser ignores rows without a valid positive close.
                if (_supply_number(row.get('close')) or 0) <= 0:
                    continue
                key = row['symbol'], row['date']
                prior = effective.setdefault(key, {})
                for field, value in row.items():
                    present = _supply_number(value) is not None if field in {'close', *fields} else bool(str(value).strip())
                    if field not in prior and present:
                        prior[field] = value
            names.append(source.get('original_filename', 'CSV'))
            baseline = assess_supply_history(effective.values(), stocks, sessions, fields, required)
            if baseline['ready']:
                break
        ns['require'](fingerprint == ns['source_fingerprint'](ns['source_registry'](ctx)), '이력 확인 도중 활성 원천이 바뀌었습니다. 다시 확인해야 합니다.')
        baseline['source'] = ', '.join(names)
        baseline['checkedSourceCount'] = len(names)
        baseline['sourceFingerprintHash'] = hashlib.sha256(json.dumps(fingerprint, separators=(',', ':')).encode()).hexdigest()
        return baseline

    def finalize(probes):
        required = int(ns['SUPPLY_RISK_REQUIRED_OBSERVATIONS'])
        actual, sessions = supply_market_window(probes, ns['COLLECTION_CUTOFF_DATE'], required)
        ns['COLLECTION_CUTOFF_DATE'] = actual
        ns['COLLECTION_CUTOFF_BEFORE'] = f'{actual}T23:59:59+09:00'
        ns['COLLECTION_REFERENCE_DATE'] = (ns['pd'].Timestamp(actual)+ns['pd'].Timedelta(days=1)).strftime('%Y-%m-%d')
        ns['TARGET_COUNT'] = ns['_CT_SUPPLY_REQUESTED_TARGET']
        ns['FLOW_COUNT'] = ns['_CT_SUPPLY_REQUESTED_FLOW']
        needed = ns['COLLECTION_PROFILE'] == 'SCREENING' and (ns['COLLECT_TOSS_SHORT'] or ns['COLLECT_TOSS_LENDING'])
        if needed and ns['STOCKS']:
            try:
                result = history(ns.get('PUBLISH_CONTEXT'), sessions, required)
            except Exception as exc:
                result = assess_supply_history([], ns['STOCKS'], sessions, required=required)
                result['reasons'].append(ns['redact_error'](str(exc), {}))
            if not result['ready']:
                ns['TARGET_COUNT'] = max(ns['TARGET_COUNT'], required)
                ns['FLOW_COUNT'] = max(ns['FLOW_COUNT'], required)
            ns['SUPPLY_RISK_BOOTSTRAP_ACTIVE'] = not result['ready']
        else:
            result = assess_supply_history([], [], sessions, required=required)
            result['applicable'] = False
            result['reasons'] = ['주식 Supply Risk 수집 대상이 없어 이력 판정을 적용하지 않습니다.']
            result['backfillSymbols'] = []
        ns['SUPPLY_RISK_HISTORY_STATUS'] = result
        ns['_CT_SUPPLY_BACKFILL_SYMBOLS'] = set(result['backfillSymbols'])
        ns['_CT_SUPPLY_COLLECTION_SESSIONS'] = sessions[1:] + [actual]
        descriptor = {'version': SUPPLY_READINESS_VERSION, 'sessions': sessions,
                      'target': ns['TARGET_COUNT'], 'flow': ns['FLOW_COUNT'],
                      'backfill': result['backfillSymbols'], 'actualDate': actual}
        suffix = hashlib.sha256(json.dumps(descriptor, sort_keys=True).encode()).hexdigest()[:16]
        # This happens before collection/checkpoint loading; the old namespace remains untouched.
        ns['RUN_PROFILE'] = ns['_CT_SUPPLY_BASE_PROFILE'] + '__supply_' + suffix
        ns['RUN_CACHE_KEY'] = hashlib.sha256(ns['RUN_PROFILE'].encode()).hexdigest()[:24]
        ns['CACHE_ROOT'] = ns['LOCAL_WORK_ROOT']/'stage_cache'/ns['COLLECTOR_SCHEMA_VERSION']/ns['RUN_CACHE_KEY']
        ns['CHECKPOINT_ROOT'] = ns['STATE_ROOT']/'checkpoints'/ns['COLLECTOR_SCHEMA_VERSION']/ns['RUN_CACHE_KEY']
        ns['CACHE_ROOT'].mkdir(parents=True, exist_ok=True)
        ns['CHECKPOINT_ROOT'].mkdir(parents=True, exist_ok=True)
        print(f"[이력 확인] 주식 {result['eligibleStockCount']}종목 기준, 유효일 {result['observations']}/{required}, "
              f"전체 요청 {ns['TARGET_COUNT']}일 / 부족 주식 {len(result['backfillSymbols'])}종목 선택 보충", flush=True)
        for reason in result['reasons']:
            print('[이력 확인] '+reason, flush=True)
        return result

    def install_counts():
        if ns.get('_CT_SUPPLY_COUNT_WRAPPED') is ns.get('get_candles_frame'):
            return
        candles, trends = ns['get_candles_frame'], ns['fetch_trend_frame']
        @functools.wraps(candles)
        def counted_candles(symbol, target_count=None, is_index=False):
            count = ns['TARGET_COUNT'] if target_count is None else target_count
            backfill = ns.get('_CT_SUPPLY_BACKFILL_SYMBOLS', set())
            if _supply_symbol(symbol) in backfill or (is_index and backfill):
                count = max(count, ns['SUPPLY_RISK_REQUIRED_OBSERVATIONS'])
            frame = candles(symbol, count, is_index)
            # A suspended/new listing may have fewer genuine rows in this market window.
            # Do not extend selected backfill beyond the index dates or fabricate prices.
            if (backfill and (_supply_symbol(symbol) in backfill or is_index)
                    and count <= ns['SUPPLY_RISK_REQUIRED_OBSERVATIONS']
                    and isinstance(frame, ns['pd'].DataFrame) and not frame.empty):
                frame = frame.loc[frame['date'].isin(ns['_CT_SUPPLY_COLLECTION_SESSIONS'])].copy()
            return frame
        @functools.wraps(trends)
        def counted_trends(symbol, suffix, parser, target_count=None):
            count = ns['FLOW_COUNT'] if target_count is None else target_count
            if _supply_symbol(symbol) in ns.get('_CT_SUPPLY_BACKFILL_SYMBOLS', set()):
                count = max(count, ns['SUPPLY_RISK_REQUIRED_OBSERVATIONS'])
            return trends(symbol, suffix, parser, count)
        ns['get_candles_frame'], ns['fetch_trend_frame'] = counted_candles, counted_trends
        ns['_CT_SUPPLY_COUNT_WRAPPED'] = counted_candles

    ns['supply_risk_history_status'] = history
    ns['finalize_supply_readiness'] = finalize
    ns['install_supply_counts'] = install_counts
