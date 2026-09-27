"""US3.3 reproducible data audit and frozen feature preparation, Colab CPU."""
from pathlib import Path
import json, zipfile, hashlib, shutil, sys, gc, os
import duckdb
import pandas as pd
import numpy as np

ROOT=Path(os.environ.get('US33_DATA_ROOT','/content/drive/MyDrive/미국주식데이터'))
OUT=ROOT/'US33_validation_20260927'
OLD=Path(os.environ.get('US33_OLD_ROOT','/content/drive/MyDrive/CloudTrend/미국시장'))
RUNTIME=Path(os.environ.get('US33_RUNTIME_ROOT','/content')); RUNTIME.mkdir(parents=True,exist_ok=True)
LOCAL=RUNTIME/'us33_work'; LOCAL.mkdir(exist_ok=True)
OUT.mkdir(exist_ok=True)

def emit(label,obj):
    print(label,json.dumps(obj,ensure_ascii=False,default=str),flush=True)

def save(name,obj):
    (OUT/name).write_text(json.dumps(obj,ensure_ascii=False,default=str,indent=2))

def sector(sic):
    try: n=int(float(sic))
    except: return 'UNKNOWN'
    if n==3674:return 'SEMI'
    if n==3691:return 'BATTERY'
    if 3710<=n<=3716:return 'AUTO'
    if 2830<=n<=2836:return 'BIO'
    if n==2844 or 3840<=n<=3851 or 8000<=n<=8099:return 'HEALTH_SVC'
    if 7370<=n<=7379:return 'SOFTWARE'
    if 6000<=n<=6799:return 'FINANCE'
    if 3570<=n<=3579:return 'IT_HW'
    if 3720<=n<=3769 or 3500<=n<=3599:return 'SHIP_DEF'
    if 1000<=n<=1299 or 2800<=n<=2899 or 3300<=n<=3499:return 'CHEM_STEEL'
    if 1300<=n<=1399 or 4900<=n<=4999:return 'ENERGY'
    if 4800<=n<=4899 or 7800<=n<=7999:return 'TELCO_MEDIA'
    if 1500<=n<=1799 or 4000<=n<=4799:return 'CONSTRUCT'
    if 3600<=n<=3699 or 3570<=n<=3579 or 3800<=n<=3839:return 'IT_HW'
    if 100<=n<=999 or 2000<=n<=2799 or 3000<=n<=3299 or 3900<=n<=3999 or 5000<=n<=5999 or 7000<=n<=7369 or 7500<=n<=7699:return 'CONSUMER'
    return 'UNKNOWN'

def pct(col,reverse=False):
    expr=f'(RANK() OVER(PARTITION BY dt ORDER BY {col} NULLS LAST)-1)::DOUBLE/NULLIF(COUNT({col}) OVER(PARTITION BY dt)-1,0)'
    return f'CASE WHEN {col} IS NULL THEN NULL ELSE '+(f'1-({expr})' if reverse else expr)+' END'

def features(con,source,bench,target):
    # Seven strategy features only; formulas and non-null minimum-rank ties match frozen source.
    con.execute(f'''CREATE OR REPLACE TABLE {target} AS
    WITH b AS (SELECT dt,spy_close/LAG(spy_close) OVER(ORDER BY dt)-1 spy_ret1 FROM {bench}),
    a AS (SELECT *,
      close/LAG(close) OVER w-1 ret1,
      close/LAG(close,120) OVER w-1 ret120,
      close/LAG(close,252) OVER w-1 ret252,
      volume/NULLIF(AVG(volume) OVER w20,0)-1 relvol1_20,
      LN(AVG(close*volume) OVER w20+1) log_dollarvol20,
      ((MAX(high) OVER w9+MIN(low) OVER w9)/2)/NULLIF((MAX(high) OVER w26+MIN(low) OVER w26)/2,0)-1 ichimoku_tk_gap
      FROM {source}
      WINDOW w AS(PARTITION BY symbol ORDER BY dt),
      w20 AS(PARTITION BY symbol ORDER BY dt ROWS BETWEEN 19 PRECEDING AND CURRENT ROW),
      w9 AS(PARTITION BY symbol ORDER BY dt ROWS BETWEEN 8 PRECEDING AND CURRENT ROW),
      w26 AS(PARTITION BY symbol ORDER BY dt ROWS BETWEEN 25 PRECEDING AND CURRENT ROW)),
    x AS (SELECT a.*,b.spy_ret1,ABS(ret1)/NULLIF(close*volume,0) amihud1 FROM a LEFT JOIN b USING(dt))
    SELECT symbol,dt,ret120,ret252,relvol1_20,log_dollarvol20,ichimoku_tk_gap,
      AVG(amihud1) OVER(PARTITION BY symbol ORDER BY dt ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) amihud20,
      STDDEV_SAMP(ret1) OVER w60*SQRT(252.0) vol60_ann,
      COVAR_SAMP(ret1,spy_ret1) OVER w60/NULLIF(VAR_SAMP(spy_ret1) OVER w60,0) beta60_spy
    FROM x WINDOW w60 AS(PARTITION BY symbol ORDER BY dt ROWS BETWEEN 59 PRECEDING AND CURRENT ROW)''')
    emit('FEATURES_DONE',target)

def prepare():
    con=duckdb.connect(str(RUNTIME/'us33_validation.duckdb'))
    con.execute("SET memory_limit='4GB'");con.execute('SET threads=2')
    tables={r[0] for r in con.execute('SHOW TABLES').fetchall()}
    for table,file in [('prices','stocks.csv'),('master','tickers.csv'),('actions','actions.csv')]:
        if table not in tables:
            con.execute(f'CREATE TABLE {table} AS SELECT * FROM read_csv_auto(?,sample_size=100000)',[str(ROOT/file)])
    sector_input=Path(os.environ.get('US33_SECTOR_MAP',str(OLD/'us_stock_sector_map_14_v1_1_20260926.zip')))
    if sector_input.suffix=='.csv':sm=pd.read_csv(sector_input)
    else:
        z=zipfile.ZipFile(sector_input)
        sm=pd.read_csv(z.open('us_stock_sector_map_14_v1.csv'))
    sm.to_csv(OUT/'reference_sector_map_v11.csv',index=False)
    con.register('sm_df',sm)
    con.execute('CREATE OR REPLACE TABLE old_sectors AS SELECT symbol,sectorCode FROM sm_df')
    src=os.environ.get('US33_OLD_PRICE_GLOB')
    if not src:
        oldroot=next((OLD/'us1_price_backfill').iterdir())
        src=str(oldroot/'canonical/us_stock_daily_compacted/year=*/us_stock_daily.parquet')
    con.execute('''CREATE OR REPLACE TABLE old_prices AS SELECT symbol,CAST(tradeDateUsEastern AS DATE) dt,
        open,high,low,close,volume FROM read_parquet(?,union_by_name=true)''',[src])
    oldbench=os.environ.get('US33_OLD_BENCHMARK') or next(OLD.rglob('us_benchmarks_adjusted.parquet'))
    con.execute('CREATE OR REPLACE TABLE old_bench AS SELECT CAST(dt AS DATE) dt,spy_close FROM read_parquet(?)',[str(oldbench)])
    con.execute("CREATE OR REPLACE TABLE bench_prices AS SELECT * FROM read_csv_auto(?,sample_size=100000) WHERE ticker IN ('SPY','QQQ','IWM')",[str(ROOT/'funds.csv')])
    con.execute("CREATE OR REPLACE TABLE shar_bench AS SELECT date dt,close spy_close FROM bench_prices WHERE ticker='SPY'")
    end=min(con.sql('SELECT max(dt) FROM old_prices').fetchone()[0],con.sql('SELECT max(dt) FROM old_bench').fetchone()[0])
    save('frozen_design.json',dict(source_commit='770ee1e071c5bb3546f42e9d29cb574dff2c26c1',start='2017-01-01',end=end,
        configurations=[dict(style=s,n=n,sector_cap=cap,entry=.8,exit=.7 if s=='AGGRESSIVE' else .5,beta=.9,confirmation=.8)
        for s in ['AGGRESSIVE','BALANCED'] for n in [15,20] for cap in [2 if s=='AGGRESSIVE' else 3,None]],
        one_way_cost=.0015,signal_price='split-adjusted',execution_price='fully adjusted synthetic open',
        research_grade='POST_SELECTION_HISTORICAL_REVALIDATION',finalOosAllowed=False))
    m=con.sql('SELECT * FROM master WHERE "table"=\'SEP\'').df()
    a=con.sql("SELECT * FROM actions WHERE action NOT IN ('dividend','split')").df()
    norm=lambda s:str(s).replace('-','.').upper()
    oldnorm={norm(s):s for s in sm.symbol}
    m['old_symbol']=m.ticker.map(lambda s:oldnorm.get(norm(s)))
    m['is_common']=m.category.str.contains('Common Stock',na=False)
    m.to_csv(OUT/'security_master_audit.csv',index=False)
    new_symbols=set(m.ticker.map(norm))
    pd.DataFrame({'symbol':[s for s in sm.symbol if norm(s) not in new_symbols]}).to_csv(OUT/'unmatched_old_symbols.csv',index=False)
    con.register('m_df',m)
    con.execute('CREATE OR REPLACE TABLE security AS SELECT * FROM m_df')
    # Historical exchange/SIC intervals: initial value before earliest change comes from corresponding FROM event.
    ev=[]
    action_groups={s:g for s,g in a.groupby('ticker')}
    empty_actions=a.iloc[:0]
    for r in m.itertuples():
        aa=action_groups.get(r.ticker,empty_actions)
        for kind,current,fc,tc in [('sector',sector(r.siccode),'sicchangefrom','sicchangeto'),('exchange',r.exchange,'exchangefrom','exchangeto')]:
            changes=aa[aa.action==tc].sort_values('date')
            if len(changes):
                first=changes.iloc[0]['date'];fr=aa[(aa.action==fc)&(aa.date==first)]
                initial=(sector(fr.iloc[0]['value']) if kind=='sector' else fr.iloc[0].contraname) if len(fr) else 'UNKNOWN'
            else:initial=current
            ev.append(dict(symbol=r.ticker,dt=pd.Timestamp('1900-01-01'),kind=kind,value=initial))
            for c in changes.itertuples():ev.append(dict(symbol=r.ticker,dt=c.date,kind=kind,value=sector(c.value) if kind=='sector' else c.contraname))
    events=pd.DataFrame(ev)
    con.register('ev_df',events)
    con.execute('CREATE OR REPLACE TABLE history AS SELECT symbol,CAST(dt AS DATE) dt,kind,value FROM ev_df')
    events.to_parquet(OUT/'historical_sector_exchange.parquet',index=False)
    audit={
      'raw':con.sql('SELECT count(*) n,count(distinct ticker) symbols,min(date) first_date,max(date) last_date FROM prices').df().to_dict('records'),
      'duplicates':con.sql('SELECT count(*) FROM (SELECT ticker,date,count(*) n FROM prices GROUP BY 1,2 HAVING n>1)').fetchone()[0],
      'master':m.groupby(['category','isdelisted']).size().reset_index(name='n').to_dict('records'),
      'old':con.sql('SELECT count(*) n,count(distinct symbol) symbols,min(dt) first_date,max(dt) last_date FROM old_prices').df().to_dict('records'),
      'matched_master':int(m.old_symbol.notna().sum()),
      'invalid_prices':con.sql('SELECT count(*) FILTER(WHERE open<=0 OR close<=0 OR high<=0 OR low<=0) nonpositive,count(*) FILTER(WHERE high<low OR high<open OR high<close OR low>open OR low>close) ohlc_bad,count(*) FILTER(WHERE volume<0) negvolume FROM prices').df().to_dict('records'),
      'common_end':end,'historical_sector_unknown_events':int(((events.kind=='sector')&(events.value=='UNKNOWN')).sum()),
      'limitations':['Metadata category is current snapshot; historical category changes unavailable.',
         'Historical exchange dates can be provider estimates. SIC-to-14-sector crosswalk differs from prior curated thematic map.',
         'Acquisition consideration known historically but actual payment date and contingent rights not provided.',
         'Bankruptcy action value is MARKET CAP, never a per-share recovery amount. Unknown recovery needs sensitivity.']}
    save('data_audit.json',audit);emit('AUDIT',audit)
    con.execute('''CREATE OR REPLACE TABLE shar_prices AS SELECT ticker symbol,date dt,open,high,low,close,volume,
        closeadj,closeunadj FROM prices WHERE date>=DATE '2015-01-01' ''')
    features(con,'old_prices','old_bench','old_features')
    features(con,'shar_prices','shar_bench','shar_features')
    con.execute('''CREATE OR REPLACE TABLE shar_universe AS
      SELECT f.*,m.old_symbol,m.is_common,m.isdelisted,h.value sectorCode,e.value exchange,
        s.sectorCode legacy_sector
      FROM shar_features f JOIN security m ON m.ticker=f.symbol
      ASOF LEFT JOIN (SELECT * FROM history WHERE kind='sector') h ON f.symbol=h.symbol AND f.dt>=h.dt
      ASOF LEFT JOIN (SELECT * FROM history WHERE kind='exchange') e ON f.symbol=e.symbol AND f.dt>=e.dt
      LEFT JOIN old_sectors s ON m.old_symbol=s.symbol''')
    allowed="upper(exchange) IN ('NYSE','NASDAQ','NYSEMKT','NYSEARCA','BATS','AMEX','NYSEAMERICAN')"
    datasets={
      'legacy':"SELECT f.*,s.sectorCode FROM old_features f JOIN old_sectors s USING(symbol)",
      'matched_source':"SELECT * EXCLUDE(sectorCode),legacy_sector sectorCode FROM shar_universe WHERE old_symbol IS NOT NULL",
      'matched_pit':f"SELECT * FROM shar_universe WHERE old_symbol IS NOT NULL AND is_common AND {allowed}",
      'survivor_pit':f"SELECT * FROM shar_universe WHERE isdelisted='N' AND is_common AND {allowed}",
      'full_pit':f"SELECT * FROM shar_universe WHERE is_common AND {allowed}"}
    feats=['ret120','ret252','beta60_spy','ichimoku_tk_gap','relvol1_20','log_dollarvol20','amihud20']
    for name,query in datasets.items():
        ranks=','.join(f'{pct(f,f=="amihud20")} dr_{f}' for f in feats)
        con.execute(f'''CREATE OR REPLACE TABLE ranked_{name} AS
          WITH u AS ({query}),r AS(SELECT *,{ranks} FROM u WHERE dt>=DATE '2017-01-01' AND dt<=DATE '{end}'),
          m AS(SELECT *,0.5*dr_ret120+0.5*dr_ret252 mom_score FROM r)
          SELECT *,{pct('mom_score')} mom_pct FROM m''')
        folder=LOCAL/name;folder.mkdir(exist_ok=True)
        for year in range(2017,end.year+1):
            p=folder/f'year={year}.parquet'
            con.execute(f"COPY(SELECT symbol,dt,sectorCode,mom_pct,dr_beta60_spy,dr_ichimoku_tk_gap,dr_relvol1_20,dr_log_dollarvol20,dr_amihud20 FROM ranked_{name} WHERE year(dt)={year} ORDER BY dt,symbol) TO '{p}' (FORMAT PARQUET,COMPRESSION ZSTD)")
        counts=con.sql(f'SELECT year(dt) AS yr,count(*) n,count(distinct symbol) symbols FROM ranked_{name} WHERE mom_pct IS NOT NULL GROUP BY 1 ORDER BY 1').df()
        counts.to_csv(OUT/f'universe_counts_{name}.csv',index=False)
        emit('RANKED',{'dataset':name,'counts':counts.to_dict('records')})
    con.execute(f"COPY (SELECT * FROM shar_universe WHERE dt>=DATE '2017-01-01') TO '{OUT/'canonical_feature_inputs.parquet'}' (FORMAT PARQUET,COMPRESSION ZSTD)")
    con.close();emit('PREPARE_COMPLETE',str(OUT))

if __name__=='__main__':prepare()
