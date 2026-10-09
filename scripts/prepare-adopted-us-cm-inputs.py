"""Adapt verified expanded US monthly market inputs to current A0 atomic rows.

No feature recomputation, current-ACTIVE filtering, corporate-event lookup, or
price filling. Production TypeScript ranking and order execution remain shared.
"""
import argparse
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import resource
import time
import numpy as np
import pandas as pd

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('atomic',ROOT/'scripts/prepare-adopted-us-backtest.py')
atomic=importlib.util.module_from_spec(spec);spec.loader.exec_module(atomic)
PREFIX='data/comparison_inputs_closeadj_v2'
REFERENCE='outputs/colab_stage2_v1/reference_time'
POLICY='ALL_SOURCE_IDENTITIES_WITH_CURRENT_CATEGORY_AND_ASOF_EXCHANGE_RESEARCH_PROXY_NOT_PIT'
FEATURE='research/cmresearchengine/vendor/resumable_allocation/runtime/cm06_closeadj_features.py'
NORMALIZER='research/cmresearchengine/vendor/resumable_allocation/runtime/cm06_prepare_comparison.py'
FEATS=['ret120','ret252','beta60_spy','ichimoku_tk_gap','relvol1_20','adv20_usd','amihud20']

def sha(p):return atomic.sha(Path(p))
def evidence(p,**extra):return {'path':str(p),'bytes':p.stat().st_size,'sha256':sha(p),**extra}
def require(ok,message):
    if not ok: raise ValueError(message)

def atomic_rows(f):
    required={'symbol','session_date','comparison_open','comparison_high','comparison_low','comparison_close','volume','dollar_volume','active20','research_common_snapshot','research_exchange_eligible','universe_policy','signal_price_basis','permaticker','available_at'}|set(FEATS)
    require(required<=set(f),'Expanded prepared schema mismatch')
    require(f.universe_policy.eq(POLICY).all() and f.signal_price_basis.eq('CLOSEADJ_FEATURES_AND_EXECUTION').all(),'Expanded input policy mismatch')
    require(f.symbol.notna().all() and f.symbol.astype(str).str.len().gt(0).all() and not f.duplicated(['session_date','symbol']).any(),'Expanded identities invalid')
    o=pd.DataFrame(index=f.index)
    for col in atomic.FIELDS:o[col]=None
    direct={'symbol':'symbol','date':'session_date','open':'comparison_open','high':'comparison_high','low':'comparison_low','close':'comparison_close','volume':'volume','dollar_volume':'dollar_volume','name':'name','sector':'research_sector','active20':'active20','is_common_share':'research_common_snapshot','toss_tradable':'research_exchange_eligible',**{c:c for c in FEATS}}
    for dest,source in direct.items():
        if source in f:o[dest]=f[source]
    for col in ['active20','research_common_snapshot','research_exchange_eligible']:
        require(f[col].notna().all() and f[col].isin([True,False]).all(),'Explicit eligibility flags required')
    o['market']='US';o['currency']='USD';o['status']=None
    # The shared production CSV reader consumes physical lines. Never allow a
    # quoted metadata newline to shift prices/features silently. Preserve the
    # source and stop for a parser fix instead of stripping the original text.
    for col in ['symbol','date','name','sector','market','currency']:
        require(not o[col].astype('string').str.contains('\n',regex=False,na=False).any(),
                'Multiline metadata unsupported by current US CSV reader')
    # Provider categories and historical exchange eligibility are the approved
    # research proxy. The latest ACTIVE/toss broker list is never substituted.
    o.loc[o.symbol.eq('SPY'),['is_common_share','toss_tradable']]=False
    return o.replace([np.inf,-np.inf],np.nan)

def prepare(root,output,start,through):
    begun=time.monotonic();root=Path(root);output=Path(output)
    require(not output.exists() or not any(output.iterdir()),'Output must be new');output.mkdir(parents=True,exist_ok=True)
    prep_path=root/PREFIX/'PREPARATION_RESULT.json';prep=json.loads(prep_path.read_bytes())
    mp=root/PREFIX/'U/manifest.json';m=json.loads(mp.read_bytes())
    require(sha(mp)=='sha256:'+prep['engines']['U']['sha256'],'US monthly manifest changed')
    require(m['status']=='COMPLETE_NORMALIZED_INPUTS','US monthly input incomplete')
    calendar_path=root/REFERENCE/'data/reference_time/U_calendar.json'
    calendar=json.loads(calendar_path.read_bytes());bydate={s['session_date']:s for s in calendar}
    require(len(bydate)==len(calendar) and sorted(bydate)==[s['session_date'] for s in calendar],'Calendar must be unique and ordered')
    source_sessions=sorted(d for item in m['months'].values() for d in item['sessions'])
    require(len(source_sessions)==len(set(source_sessions)) and set(source_sessions)<=bydate.keys(),'Source calendar mismatch')
    expected=[d for d in source_sessions if start<=d<=through]
    require(expected and expected[0]==start and expected[-1]==through,'Requested endpoints outside source sessions')
    require(len([d for d in source_sessions if d<start])>=252,'Genuine 252-session feature warmup required')
    outputs=[];canonical=[];seen_identity={};seen_symbols=set();raw_rows=0;first_complete=0;session_quality=[]
    for month,item in sorted(m['months'].items()):
        path=mp.parent/item['path']
        require(path.parent==mp.parent and sha(path)=='sha256:'+item['sha256'],'US monthly file changed')
        f=pd.read_parquet(path)
        require(len(f)==item['rows'] and sorted(set(f.session_date))==item['sessions'],'Monthly row/session coverage mismatch')
        raw_rows+=len(f);seen_symbols.update(f.symbol)
        for symbol,p in f[['symbol','permaticker']].drop_duplicates().itertuples(index=False,name=None):
            if symbol=='SPY':continue
            require(pd.notna(p),'Missing original identity')
            p=str(p);p=p[:-2] if p.endswith('.0') and p[:-2].isdigit() else p
            require(symbol not in seen_identity or seen_identity[symbol]==p,'Ticker reuse requires identity-aware ledger')
            seen_identity[symbol]=p
        canonical.append(evidence(path,firstDate=item['sessions'][0],lastDate=item['sessions'][-1]))
        if item['sessions'][-1]<start or item['sessions'][0]>through:continue
        f=f[f.session_date.between(start,through)].copy()
        out=atomic_rows(f)
        for day,rows in out.groupby('date',sort=True):
            src=f.loc[f.session_date.eq(day)];clock=bydate[day]
            observed=pd.to_datetime(src.available_at,utc=True,format='mixed')
            require(observed.eq(pd.Timestamp(clock['close_available_at'])).all(),'Source close availability differs from verified calendar')
            spy=rows.loc[rows.symbol.eq('SPY')]
            require(len(spy)==1 and np.isfinite(float(spy.close.iloc[0])) and float(spy.close.iloc[0])>0,'SPY source session unavailable')
            require(pd.to_numeric(rows.loc[rows.symbol.ne('SPY'),'close'],errors='coerce').gt(0).any(),'Market-wide missing source session')
            complete=rows[FEATS].apply(pd.to_numeric,errors='coerce').notna().all(axis=1)&rows.symbol.ne('SPY')
            if not outputs:first_complete=int(complete.sum())
            target=output/(day+'.csv.gz')
            with target.open('xb') as raw:
                with gzip.GzipFile(fileobj=raw,mode='wb',mtime=0) as compressed:
                    compressed.write(rows.sort_values('symbol').to_csv(index=False,lineterminator='\n').encode())
            outputs.append({'date':day,'file':target.name,'bytes':target.stat().st_size,'sha256':sha(target),'rows':len(rows),'marketDataComplete':True})
            session_quality.append({'date':day,'rows':len(rows),'observedPositiveCloses':int(pd.to_numeric(rows.close,errors='coerce').gt(0).sum()),'rankEligibleMetadata':int((rows.is_common_share & rows.toss_tradable).sum())})
    require(raw_rows==m['rows'] and [x['date'] for x in outputs]==expected,'Full source coverage mismatch')
    warmup={'requiredPriorSessions':252,'canonicalSourceStart':source_sessions[0],'earliestEvaluationDate':source_sessions[252],'firstOutputDate':expected[0],'priorSessionsBeforeFirstOutput':sum(d<start for d in source_sessions),'completeRowsOnFirstOutput':first_complete}
    benchmark=root/REFERENCE/'data/us/spy_prepared_verified.parquet'
    manifest={'version':'adopted-us-cm-expanded-inputs-v1','firstDate':start,'lastDate':through,'throughDate':through,'sessions':expected,'featureWarmup':warmup,'preparationMetrics':{'elapsedSeconds':time.monotonic()-begun,'maxRssKiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss},'featureSource':FEATURE,'featureCodeHash':sha(ROOT/FEATURE),'normalizerSource':NORMALIZER,'normalizerCodeHash':sha(ROOT/NORMALIZER),'canonical':canonical,'benchmark':evidence(benchmark),'master':evidence(prep_path),'calendar':evidence(calendar_path),'files':outputs,'rows':sum(x['rows'] for x in outputs),'sourceRows':raw_rows,'sourceSymbols':len(seen_symbols),'sourceCoverageEndDate':source_sessions[-1],'sourceClocks':[{'date':d,'openAt':bydate[d]['open_at'],'closeAvailableAt':bydate[d]['close_available_at']} for d in expected],'universePolicy':POLICY,'annualBudgetPolicyId':'US_A0_ANNUAL_ENTRY_BUDGET_PRIOR_NAV_V1','tradePricePolicyId':'US_A0_COMPARISON_PRICE_8DP_LEDGER_V1','missingClosePolicyId':'US_A0_ALL_HELD_LAST_VALID_CLOSE_EXIT_V1','sessionQuality':session_quality,'limitations':['Current common-stock category and reconstructed as-of exchange metadata are a research proxy, not certified historical eligibility.','Existing CM expanded closeadj features are reused without recomputation; raw dollar volume and ADV remain unchanged.','Synthetic adjusted OHLC units are comparison units, not certified historical shares.','All held securities use first missing verified-session close to exit at the last observed valid close; this is a retrospective price proxy, not an executable historical fill.','No individual corporate-event lookup, entitlement adjustment, cash merger exception, or dividend cash ledger is applied.','No past NAV or cash is backdated; normal A0 costs and cash treatment apply at the proxy recognition session.','Annual new-entry principal is the preceding observed year-end NAV divided by 20; existing holdings and prior-year pending intent budgets are preserved.','Only executed trade prices are represented to 8 decimal places for the exact money ledger; original source/feature/valuation prices are retained.','Source end is not a disappearance event. No terminal liquidation.']}
    (output/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    return manifest

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--input-root',required=True);p.add_argument('--output',required=True);p.add_argument('--start',required=True);p.add_argument('--through',required=True);a=p.parse_args()
    result=prepare(a.input_root,a.output,a.start,a.through)
    print(json.dumps({k:result[k] for k in ['version','firstDate','lastDate','sourceRows','sourceSymbols','rows']}))
