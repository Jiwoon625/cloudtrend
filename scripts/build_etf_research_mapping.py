#!/usr/bin/env python3
"""Explicit snapshot mapping; labels infer exposures, not historical constituents."""
import argparse,re,json
from pathlib import Path
import pandas as pd

OVERRIDES={
 '455860':'BATTERY','0117V0':'ENERGY','139260':'IT_HW','261060':'IT_HW','243880':'IT_HW',
 '466940':'FINANCE','498410':'FINANCE','139280':'CONSUMER','150460':'CONSUMER','226380':'CONSUMER',
 '322400':'SOFTWARE','414270':'AUTO','457480':'AUTO','219390':'ENERGY','487230':'ENERGY',
 '367760':'IT_HW','0173Y0':'IT_HW','269420':'INFRA_EQUITY','0197X0':'SEMI','465350':'BATTERY',
 '0023A0':'MULTI_TECH','276650':'MULTI_TECH','298770':'MULTI_TECH','314250':'MULTI_TECH',
 '371160':'MULTI_TECH','372330':'MULTI_TECH','381170':'MULTI_TECH','465580':'MULTI_TECH',
 '472160':'MULTI_TECH','474220':'MULTI_TECH','483280':'MULTI_TECH','411420':'MULTI_TECH',
 '400970':'MULTI_TECH','401170':'MULTI_TECH','401470':'MULTI_TECH','368190':'MULTI_TECH',
 '456600':'MULTI_TECH','275980':'MULTI_TECH','364960':'MULTI_SECTOR',
}
REGION_OVERRIDE={'150460':'KR_EXPOSURE_UNVERIFIED','298770':'KR_TW','414270':'US_CN',
                 '483320':'GLOBAL','457480':'US','442580':'GLOBAL'}
CLASS_OVERRIDE={'481050':'bond_cash','219390':'equity','269420':'equity','367760':'equity','487230':'equity','0173Y0':'equity'}
STOCK_SECTORS={'AUTO','BATTERY','BIO','CHEM_STEEL','CONSTRUCT','CONSUMER','ENERGY','FINANCE','HEALTH_SVC','IT_HW','SEMI','SHIP_DEF','SOFTWARE','TELCO_MEDIA'}

def map_row(r):
    symbol=r.symbol;name=str(r['name']);text=name+' '+str(r.etfUnderlyingIndexName)
    asset=CLASS_OVERRIDE.get(symbol,r.assetClass)
    sector=OVERRIDES.get(symbol,r.sectorCode)
    if sector=='ETC':sector='MARKET_IDX'
    if asset in {'bond_cash','commodity_fx','mixed'}:sector={'bond_cash':'BOND_CASH','commodity_fx':'COMMODITY_FX','mixed':'MULTI_ASSET'}[asset]
    if asset=='reit_infra':sector='REIT'
    region='KR'
    for pattern,value in [(r'글로벌|선진국|신흥국|전세계|월드|WORLD|EMERGING','GLOBAL'),(r'미국|NASDAQ|S&P|NYSE|PHLX|U\.S\.|US TECH','US'),(r'중국|차이나|항셍|CHINA|HANG SENG|CSI |SZSE','CN'),(r'일본|TOPIX|NIKKEI','JP'),(r'인도네시아|INDONESIA','ID'),(r'인도|NIFTY','IN'),(r'베트남|VN30','VN'),(r'유럽|유로스탁스|EURO STOXX','EU'),(r'아시아|ASIA50','ASIA')]:
        if re.search(pattern,text,re.I):region=value;break
    region=REGION_OVERRIDE.get(symbol,region)
    local=region=='KR' and sector in STOCK_SECTORS
    if asset!='equity':rotation='excluded_nonplain_equity';market='not_researched'
    elif local:rotation='domestic_stock_sector';market='domestic_stock_sector'
    else:rotation='not_applicable_no_compatible_stock_sector';market='own_underlying_regime'
    return dict(symbol=symbol,name=name,underlyingIndexName=r.etfUnderlyingIndexName,legacyAssetClass=r.assetClass,assetClass=asset,legacySectorCode=r.sectorCode,sectorCode=sector,region=region,stockSectorCode=sector if local else '',rotationSource=rotation,marketSource=market,peerGroup=f'{region}:{sector}',basis='symbol_override_from_name_index' if symbol in OVERRIDES or symbol in CLASS_OVERRIDE else 'existing_sector_plus_name_index',confidence='exposure_verification_pending' if region=='KR_EXPOSURE_UNVERIFIED' else 'semantic_mapping_not_constituent_verified')

def main():
    p=argparse.ArgumentParser();p.add_argument('--panel',required=True);p.add_argument('--classification',required=True);p.add_argument('--output',required=True);a=p.parse_args()
    d=pd.read_parquet(a.panel).sort_values('date').drop_duplicates('symbol',keep='last')
    c=pd.read_csv(a.classification,dtype={'symbol':str})[['symbol','assetClass']];d=d.merge(c,on='symbol',validate='one_to_one')
    m=pd.DataFrame([map_row(r) for _,r in d.iterrows()]).sort_values('symbol');assert len(m)==393 and m.symbol.nunique()==393
    assert not m.sectorCode.isin(['ETC','']).any()
    Path(a.output).parent.mkdir(parents=True,exist_ok=True);m.to_csv(a.output,index=False)
    print(json.dumps({'symbols':len(m),'assets':m.assetClass.value_counts().to_dict(),'rotation':m.rotationSource.value_counts().to_dict(),'changedSectors':int((m.sectorCode!=m.legacySectorCode).sum()),'changedAssets':int((m.assetClass!=m.legacyAssetClass).sum())},ensure_ascii=False))
if __name__=='__main__':main()
