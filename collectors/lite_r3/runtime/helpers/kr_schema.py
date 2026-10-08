"""Narrow raw102/canonical103 publishing compatibility; original CSV stays immutable."""
RAW_SCREENING_COLUMNS = ['symbol', 'name', 'market', 'securityType', 'date', 'open', 'high', 'low', 'close', 'volume', 'tradingValue', 'marketCap', 'foreignNetBuyValue', 'institutionNetBuyValue', 'listedShares', 'krxVolume', 'krxTradingValue', 'krxMarketCap', 'krxListedShares', 'individualNetBuyValue', 'otherCorporationNetBuyValue', 'registeredForeignNetBuyValue', 'otherForeignNetBuyValue', 'financialInvestmentNetBuyValue', 'insuranceNetBuyValue', 'trustNetBuyValue', 'privateEquityFundNetBuyValue', 'bankNetBuyValue', 'otherFinancialInstitutionNetBuyValue', 'pensionFundNetBuyValue', 'individualBuyVolume', 'individualSellVolume', 'individualNetBuyVolume', 'foreignBuyVolume', 'foreignSellVolume', 'foreignNetBuyVolume', 'institutionBuyVolume', 'institutionSellVolume', 'institutionNetBuyVolume', 'otherCorporationBuyVolume', 'otherCorporationSellVolume', 'otherCorporationNetBuyVolume', 'financialInvestmentNetBuyVolume', 'insuranceNetBuyVolume', 'trustNetBuyVolume', 'privateEquityFundNetBuyVolume', 'bankNetBuyVolume', 'otherFinancialInstitutionNetBuyVolume', 'pensionFundNetBuyVolume', 'foreignHoldingQuantity', 'foreignHoldingLimitQuantity', 'foreignHoldingRate', 'foreignHoldingRatePct', 'cfdBuyBalanceQuantity', 'cfdBuyBalanceRate', 'cfdSellBalanceQuantity', 'cfdSellBalanceRate', 'investorUpdatedAt', 'programArbitrageBuyVolume', 'programArbitrageSellVolume', 'programArbitrageNetBuyVolume', 'programNonArbitrageBuyVolume', 'programNonArbitrageSellVolume', 'programNonArbitrageNetBuyVolume', 'programNetBuyVolume', 'shortSellingVolume', 'shortSellingAmount', 'shortSellingVolumeRate', 'shortSellingAmountRate', 'shortUpdatedAt', 'marginLoanNewQuantity', 'marginLoanReturnQuantity', 'marginLoanBalanceQuantity', 'marginLoanBalanceRate', 'marginLoanTradingRate', 'stockLoanNewQuantity', 'stockLoanReturnQuantity', 'stockLoanBalanceQuantity', 'stockLoanBalanceRate', 'stockLoanTradingRate', 'creditUpdatedAt', 'lendingExecutionQuantity', 'lendingRepaymentQuantity', 'lendingBalanceQuantity', 'lendingBalanceAmount', 'lendingUpdatedAt', 'etfNav', 'etfTradingValue', 'etfMarketCap', 'etfNetAssetTotalAmount', 'etfListedUnits', 'etfUnderlyingIndexName', 'etfUnderlyingIndexClose', 'etfPremiumDiscountRate', 'etfTrackingErrorRate', 'priceSource', 'tradingValueSource', 'marketCapSource', 'investorValueSource', 'investorVolumeSource', 'programTradeSource', 'marketFlowUpdatedAt']
CANONICAL_SCREENING_COLUMNS = ['symbol', 'name', 'market', 'type', 'date', 'open', 'high', 'low', 'close', 'volume', 'tradingValue', 'marketCap', 'foreignNetBuyValue', 'institutionNetBuyValue', 'sector', 'listedShares', 'krxVolume', 'krxTradingValue', 'krxMarketCap', 'krxListedShares', 'individualNetBuyValue', 'otherCorporationNetBuyValue', 'registeredForeignNetBuyValue', 'otherForeignNetBuyValue', 'financialInvestmentNetBuyValue', 'insuranceNetBuyValue', 'trustNetBuyValue', 'privateEquityFundNetBuyValue', 'bankNetBuyValue', 'otherFinancialInstitutionNetBuyValue', 'pensionFundNetBuyValue', 'individualBuyVolume', 'individualSellVolume', 'individualNetBuyVolume', 'foreignBuyVolume', 'foreignSellVolume', 'foreignNetBuyVolume', 'institutionBuyVolume', 'institutionSellVolume', 'institutionNetBuyVolume', 'otherCorporationBuyVolume', 'otherCorporationSellVolume', 'otherCorporationNetBuyVolume', 'financialInvestmentNetBuyVolume', 'insuranceNetBuyVolume', 'trustNetBuyVolume', 'privateEquityFundNetBuyVolume', 'bankNetBuyVolume', 'otherFinancialInstitutionNetBuyVolume', 'pensionFundNetBuyVolume', 'foreignHoldingQuantity', 'foreignHoldingLimitQuantity', 'foreignHoldingRate', 'foreignHoldingRatePct', 'cfdBuyBalanceQuantity', 'cfdBuyBalanceRate', 'cfdSellBalanceQuantity', 'cfdSellBalanceRate', 'investorUpdatedAt', 'programArbitrageBuyVolume', 'programArbitrageSellVolume', 'programArbitrageNetBuyVolume', 'programNonArbitrageBuyVolume', 'programNonArbitrageSellVolume', 'programNonArbitrageNetBuyVolume', 'programNetBuyVolume', 'shortSellingVolume', 'shortSellingAmount', 'shortSellingVolumeRate', 'shortSellingAmountRate', 'shortUpdatedAt', 'marginLoanNewQuantity', 'marginLoanReturnQuantity', 'marginLoanBalanceQuantity', 'marginLoanBalanceRate', 'marginLoanTradingRate', 'stockLoanNewQuantity', 'stockLoanReturnQuantity', 'stockLoanBalanceQuantity', 'stockLoanBalanceRate', 'stockLoanTradingRate', 'creditUpdatedAt', 'lendingExecutionQuantity', 'lendingRepaymentQuantity', 'lendingBalanceQuantity', 'lendingBalanceAmount', 'lendingUpdatedAt', 'etfNav', 'etfTradingValue', 'etfMarketCap', 'etfNetAssetTotalAmount', 'etfListedUnits', 'etfUnderlyingIndexName', 'etfUnderlyingIndexClose', 'etfPremiumDiscountRate', 'etfTrackingErrorRate', 'priceSource', 'tradingValueSource', 'marketCapSource', 'investorValueSource', 'investorVolumeSource', 'programTradeSource', 'marketFlowUpdatedAt']


def install_publish_schema_v204(namespace):
    import csv
    import hashlib
    import io
    from urllib.parse import quote
    ns = namespace
    raw_columns = list(RAW_SCREENING_COLUMNS)
    canonical_columns = list(CANONICAL_SCREENING_COLUMNS)
    normalized_raw = ['type' if col == 'securityType' else col for col in raw_columns]
    assert set(canonical_columns) == set(normalized_raw) | {'sector'}
    contracts = {ns['schema_hash'](raw_columns): False, ns['schema_hash'](canonical_columns): True}

    def normalize_columns(columns):
        columns = list(columns)
        normalized = ['type' if col == 'securityType' else col for col in columns]
        ns['require'](len(normalized) == len(set(normalized)), '원천 컬럼 또는 securityType/type 별칭이 중복됩니다.')
        ns['require'](set(normalized) in (set(normalized_raw), set(canonical_columns)),
                      '원천 schema가 승인된102열 또는 sector를 포함한103열 계약과 다릅니다.')
        return normalized

    def prepare_period_merge(ctx, rows, table):
        ns['require'](rows and len(rows) < 1000, '활성 source 목록이 없거나 조회 한도를 초과했습니다.')
        ns['require'](list(table.columns) == raw_columns, '새 수집 원본은 검증된102열 계약이어야 합니다.')
        ns['require'](all(record['schema_hash'] in contracts for record in rows), '기존 schema가 승인된102/103열 계약과 다릅니다.')
        promote = any(contracts[record['schema_hash']] for record in rows)
        incoming = table.rename(columns={'securityType':'type'}).copy()
        keys = set(zip(incoming.symbol, incoming.date))
        first, last = incoming.date.min(), incoming.date.max()
        existing = {}
        for record in rows:  # newest first; preserve older nonempty enrichment under blank new cells
            if record['max_date'] < first or record['min_date'] > last:
                continue
            url = ns['SUPABASE_URL']+'/storage/v1/object/authenticated/'+record['storage_bucket']+'/'+quote(record['storage_path'],safe='/')
            raw = ns['safe_request']('GET',url,headers=ns['sb_headers'](ctx)).content
            ns['require']('sha256:'+hashlib.sha256(raw).hexdigest() == record['file_hash'], '기존 원본 해시 불일치입니다.')
            if record.get('file_size_bytes') is not None:
                ns['require'](len(raw)==int(record['file_size_bytes']), '기존 원본 크기 불일치입니다.')
            header = next(csv.reader(io.StringIO(raw.decode('utf-8-sig'))), [])
            normalized = normalize_columns(header)
            ns['require'](ns['schema_hash'](header)==record['schema_hash'], '기존 파일 헤더와 등록 schema hash가 다릅니다.')
            seen = set()
            for part in ns['pd'].read_csv(io.BytesIO(raw),dtype=str,keep_default_na=False,encoding='utf-8-sig',chunksize=10000):
                ns['require'](list(part.columns)==header, '기존 원천 컬럼 해석이 일치하지 않습니다.')
                part.columns = normalized
                for row in part.loc[part.date.between(first,last)].to_dict('records'):
                    key = row['symbol'], row['date']
                    ns['require'](key not in seen, '기존 원천에 중복 종목·날짜가 있습니다.')
                    seen.add(key)
                    if key not in keys:
                        continue
                    # The newer nonempty cell wins; older values fill only its blanks.
                    newer = existing.setdefault(key, {})
                    for col, value in row.items():
                        if value is not None and str(value).strip() != '' and not str(newer.get(col,'')).strip():
                            newer[col] = value
        output, retained, sector_retained = [], 0, 0
        for row in incoming.to_dict('records'):
            previous = existing.get((row['symbol'],row['date']), {})
            merged = ns['merge_nonempty_row'](previous,row)
            retained += sum(bool(str(previous.get(k,'')).strip()) and not bool(str(row.get(k,'')).strip()) for k in normalized_raw)
            sector_retained += int(bool(str(previous.get('sector','')).strip()) and not bool(str(row.get('sector','')).strip()))
            output.append(merged)
        if promote:
            result = ns['pd'].DataFrame(output,columns=canonical_columns).fillna('')
        else:
            result = ns['pd'].DataFrame(output,columns=normalized_raw).fillna('').rename(columns={'type':'securityType'})
            result = result.loc[:,raw_columns]
        return result, {'overlapRows':len(existing),'preservedBlankCells':retained,
                        'schemaPolicy':'raw102-canonical103-preserve-sector-v1',
                        'preparedColumnCount':len(result.columns),'preservedSectorCells':sector_retained}

    ns['prepare_period_merge'] = prepare_period_merge
    ns['_CT_PUBLISH_SCHEMA_VERSION'] = 'raw102-canonical103-preserve-sector-v1'
