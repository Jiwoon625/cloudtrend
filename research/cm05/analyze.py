"""CM05 C/D inference on immutable build outputs; no portfolio-performance claims."""
import hashlib,io,json,os,time,resource
from pathlib import Path
import numpy as np
import pandas as pd
from core import require,asof_peer,forward_basket,period,boundary_mask,regression,bootstrap_coefficients,fdr,block_indices
from probe import CM05Store
from build import Output,CONTRACT

class Reader:
    def __init__(self,run):
        require(str(run).isdigit(),'invalid build ID');self.store=CM05Store.from_env();self.root='results/build-'+str(run)
        self.complete=json.loads(self.store.get_object(self.root+'/completion.json',max_bytes=2*1024**2))
        self.files={x['name']:x for x in self.complete['files']}
    def raw(self,name):
        rec=self.files[name];b=self.store.get_object(self.root+'/'+name,max_bytes=rec['bytes'])
        require(len(b)==rec['bytes'] and hashlib.sha256(b).hexdigest()==rec['sha256'],'build output changed')
        return b
    def frame(self,name):return pd.read_parquet(io.BytesIO(self.raw(name)))

def add_context(target,local,spy,fx):
    t=target.copy();t['decision_at']=pd.to_datetime(t.decision_at,utc=True)
    controls=['X1','X2','market_ret20','market_vol20']
    loc=local[['available_at']+controls].rename(columns={c:'local_'+c for c in controls}).sort_values('available_at')
    loc.available_at=pd.to_datetime(loc.available_at,utc=True)
    t=pd.merge_asof(t.sort_values('decision_at'),loc,left_on='decision_at',right_on='available_at',direction='backward',allow_exact_matches=False,tolerance=pd.Timedelta(days=3)).drop(columns='available_at')
    sp=spy[['available_at','market_ret20']].rename(columns={'available_at':'spy_available_at','market_ret20':'global_spy20'}).drop_duplicates('spy_available_at').sort_values('spy_available_at')
    sp.spy_available_at=pd.to_datetime(sp.spy_available_at,utc=True)
    t=pd.merge_asof(t.sort_values('decision_at'),sp,left_on='decision_at',right_on='spy_available_at',direction='backward',allow_exact_matches=False,tolerance=pd.Timedelta(days=7))
    f=fx.copy();f.available_at=pd.to_datetime(f.available_at,utc=True);f=f.sort_values('available_at').drop_duplicates('available_at',keep='last')
    f['fx_level']=pd.to_numeric(f.krw_per_usd,errors='coerce')
    t=pd.merge_asof(t.sort_values('decision_at'),f[['available_at','fx_level']].rename(columns={'available_at':'fx_available_at'}),left_on='decision_at',right_on='fx_available_at',direction='backward',allow_exact_matches=False,tolerance=pd.Timedelta(days=10))
    t['fx_change20']=t.fx_level.pct_change(20,fill_method=None)
    require(not(t.spy_available_at>=t.decision_at).any() and not(t.fx_available_at>=t.decision_at).any(),'future context')
    return t

def finite(v):return float(v) if np.isfinite(v) else None

def delta_bootstrap(d,block,seed=20261013,date_universe=None):
    # Sufficient statistics per date preserve every stock and sector together.
    x=d.assign(selected=d.gate.astype(int),selected_sum=d.target*d.gate).groupby('date').agg(n=('target','size'),total=('target','sum'),selected=('selected','sum'),selected_sum=('selected_sum','sum')).sort_index()
    if date_universe is not None:x=x.reindex(date_universe,fill_value=0)
    a=x.to_numpy(float);n,total,ns,ts=a.sum(axis=0)
    if n<100 or ns<20 or n-ns<20 or len(a)<63:return {'status':'INSUFFICIENT_SAMPLE','n':int(n),'selected_n':int(ns)}
    estimate=ts/ns-total/n;rng=np.random.default_rng(seed);vals=[]
    for _ in range(CONTRACT['bootstrap']['replicates']):
        nn,tt,ss,st=a[block_indices(len(a),rng,block)].sum(axis=0)
        if nn>0 and ss>0:vals.append(st/ss-tt/nn)
    lo,hi=np.quantile(vals,[.025,.975]);p=(1+sum(abs(np.array(vals)-estimate)>=abs(estimate)))/(len(vals)+1)
    return {'status':'ESTIMATED','n':int(n),'selected_n':int(ns),'effect':float(estimate),'ci_lower':float(lo),'ci_upper':float(hi),'p_block':float(p)}

def cluster_error(d,X,y):
    beta=np.linalg.lstsq(X,y,rcond=None)[0];score=X*(y-X@beta)[:,None];bread=np.linalg.pinv(X.T@X)
    def meat(groups):
        z=pd.DataFrame(score).groupby(np.asarray(groups)).sum().to_numpy();g=len(z)
        return z.T@z*(g/(g-1)) if g>1 else np.zeros((X.shape[1],X.shape[1]))
    # Within a single C hypothesis, sector is constant: only date clusters estimable.
    V=bread@meat(d.date)@bread
    return float(np.sqrt(max(0,V[1,1])))

def confirmation_cluster_diagnostic(d):
    if len(d)<100 or d.gate.nunique()<2 or d.sector.nunique()<2:
        return {'two_way_cluster_status':'INSUFFICIENT_CLUSTERS'}
    X=np.column_stack([np.ones(len(d)),d.gate.to_numpy(float)])
    y=d.target.to_numpy(float);beta=np.linalg.lstsq(X,y,rcond=None)[0]
    scores=X*(y-X@beta)[:,None];bread=np.linalg.pinv(X.T@X)
    def meat(groups):
        z=pd.DataFrame(scores).groupby(np.asarray(groups)).sum().to_numpy();g=len(z)
        return z.T@z*g/(g-1) if g>1 else np.zeros((2,2))
    covariance=bread@(meat(d.date)+meat(d.sector)-meat(d.date.astype(str)+'|'+d.sector.astype(str)))@bread
    variance=covariance[1,1]*(1-d.gate.mean())**2
    return {'two_way_cluster_status':'ESTIMATED' if variance>=0 else 'NON_POSITIVE_VARIANCE',
            'two_way_cluster_se':float(np.sqrt(variance)) if variance>=0 else None,
            'date_clusters':int(d.date.nunique()),'sector_clusters':int(d.sector.nunique())}

def main(build_run_id=None):
    start=time.monotonic();req=json.loads((Path(__file__).parent/'REQUEST.json').read_text());build_run_id=build_run_id or req['build_run_id'];r=Reader(build_run_id);out=Output();out.root='results/analysis-'+out.run
    require(json.loads(r.raw('contract.json'))==CONTRACT,'analysis contract changed after build')
    panel=r.frame('sector_panel.parquet');labels=r.frame('candidate_labels.parquet')
    fx=pd.read_csv(io.BytesIO(r.raw('h10_conservative_events.csv')))
    require({'available_at','krw_per_usd'}.issubset(fx.columns),'FX schema needs explicit adapter')
    spy=panel.loc[panel.market.eq('US')&panel.sector.eq('SEMI')].copy()
    # US panel market controls do not depend on SEMI availability; if missing, use benchmark directly.
    b=r.frame('benchmark_US.parquet').set_index('date');cal=r.frame('calendar_U.parquet').set_index('session_date')
    spy=pd.DataFrame({'date':b.index,'available_at':pd.to_datetime(cal.close_available_at.reindex(b.index).to_numpy(),utc=True),'market_ret20':b.close.pct_change(20,fill_method=None).to_numpy()})
    lead=[];cdatasets=[]
    for market,peer in [('KR','US'),('US','KR')]:
        for sec in CONTRACT['sectors']:
            local=panel.loc[panel.market.eq(market)&panel.sector.eq(sec)].sort_values('date').reset_index(drop=True)
            source=panel.loc[panel.market.eq(peer)&panel.sector.eq(sec)].sort_values('date').reset_index(drop=True)
            if local.empty or source.empty:
                for feature in ['X1','X2']:lead.append({'direction':peer+'->'+market,'sector':sec,'feature':feature,'period':'validation','horizon':5,'status':'MISSING_SECTOR'})
                continue
            for h in CONTRACT['C_horizons']:
                t=local[['date','open_at']].rename(columns={'open_at':'decision_at'}).copy();t['target']=forward_basket(local,h)
                t['boundary_ok']=boundary_mask(t.date,60)
                t=asof_peer(t,source);t=add_context(t,local,spy,fx)
                t=t.loc[t.date.ge('2018-01-01')&t.date.le(CONTRACT['end'])&t.boundary_ok].copy();t['period']=t.date.map(period);t['market']=market;t['sector']=sec;t['horizon']=h
                cdatasets.append(t)
                controls=['local_X1','local_X2','local_market_ret20','local_market_vol20','fx_change20']+(['global_spy20'] if market=='KR' else [])
                for feature in ['X1','X2']:
                    for name,g in [(name,t.loc[t.period.eq(name)]) for name in ['discovery','validation','2025','2026']]+[('all_reused',t),('all_ex2025',t.loc[~t.date.str.startswith('2025')])]:
                        rec,fit=regression(g,'peer_'+feature,controls)
                        rec.update(direction=peer+'->'+market,sector=sec,feature=feature,period=name,horizon=h,controls=','.join(controls),source_sessions=int(g.source_session.nunique()))
                        if fit:
                            rec['date_cluster_se']=cluster_error(*fit)
                            # Full bootstrap only preregistered primary validation 5-session family.
                            if name=='validation' and h==5:
                                rec.update(bootstrap_coefficients(fit,sorted(g.date.unique())))
                                rec['block21']=bootstrap_coefficients(fit,sorted(g.date.unique()),block=21)
                        lead.append(rec)
            print('CM05_LEADLAG_COMPLETE',peer+'->'+market,sec,flush=True)
    leadframe=pd.DataFrame(lead)
    if 'p_block' not in leadframe:leadframe['p_block']=np.nan
    primary=leadframe.period.eq('validation')&leadframe.horizon.eq(5)
    require(int(primary.sum())==56,'C hypothesis family incomplete')
    leadframe.loc[primary,'q_fdr56']=fdr(leadframe.loc[primary,'p_block'].to_numpy(),56)
    out.frame('leadlag_results.parquet',leadframe.astype({c:'str' for c in ['block21'] if c in leadframe}))
    out.frame('leadlag_observations.parquet',pd.concat(cdatasets,ignore_index=True))
    # Candidate filters are evaluated at original close-decision timestamps, not retrospectively at entry.
    joined=[]
    for (market,sec),g in labels.groupby(['market','sector'],dropna=False):
        srcmarket='KR' if market=='US' else 'US'
        source=panel.loc[panel.market.eq(srcmarket)&panel.sector.eq(sec)]
        if source.empty:
            g=g.copy();g['peer_X1']=np.nan;g['peer_X2']=np.nan;g['source_session']=None
        else:g=asof_peer(g,source)
        joined.append(g)
    d=pd.concat(joined,ignore_index=True);d['period']=d.date.map(period);out.frame('confirmation_observations.parquet',d)
    results=[]
    for market in ['KOSPI','KOSDAQ','US']:
        for feature in ['X1','X2']:
            for h in CONTRACT['D_horizons']:
                allg=d.loc[d.market.eq(market)&d.horizon.eq(h)&d.date.ge('2018-01-01')]
                for name,g in [(name,allg.loc[allg.period.eq(name)]) for name in ['discovery','validation','2025','2026']]+[('all_reused',allg),('all_ex2025',allg.loc[~allg.date.str.startswith('2025')])]:
                    observed=g.loc[g.status.eq('OBSERVED')].copy();common=observed.loc[observed['peer_'+feature].notna()].copy();common['gate']=common['peer_'+feature]>0
                    selected=common.loc[common.gate];rejected=common.loc[~common.gate]
                    rec={'market':market,'feature':feature,'horizon':h,'period':name,'all_candidates':len(g),'observed_baseline_n':len(observed),'common_baseline_n':len(common),'selected_n':len(selected),'source_missing_n':len(observed)-len(common),'endpoint_or_boundary_n':len(g)-len(observed),'all_baseline_mean':finite(observed.target.mean()),'common_baseline_mean':finite(common.target.mean()),'selected_mean':finite(selected.target.mean()),'rejected_mean':finite(rejected.target.mean()),'missed_outperformers':int((rejected.target>0).sum()),'avoided_absolute_losses':int((rejected.stock_return<0).sum()),'selection_ratio':len(selected)/len(common) if len(common) else None,'status':'DESCRIPTIVE_ONLY'}
                    if name=='validation' and h==20:
                        calendar=r.frame('calendar_'+('U' if market=='US' else 'K')+'.parquet')
                        date_universe=calendar.loc[calendar.session_date.between('2022-01-01','2024-12-31'),'session_date'].tolist()
                        rec.update(confirmation_cluster_diagnostic(common))
                        rec.update(delta_bootstrap(common,63,date_universe=date_universe));rec['block21']=delta_bootstrap(common,21,date_universe=date_universe)
                    results.append(rec)
    dr=pd.DataFrame(results)
    if 'p_block' not in dr:dr['p_block']=np.nan
    dp=dr.period.eq('validation')&dr.horizon.eq(20)
    require(int(dp.sum())==6,'D hypothesis family incomplete')
    dr.loc[dp,'q_fdr6']=fdr(dr.loc[dp,'p_block'].to_numpy(),6)
    out.frame('confirmation_results.parquet',dr.astype({c:'str' for c in ['block21'] if c in dr}))
    summary={'status':'C_D_EXPLORATORY_STATISTICS_COMPLETE','build_run_id':str(build_run_id),'C_primary_hypotheses':int(primary.sum()),'C_estimable':int((primary&leadframe.status.eq('ESTIMATED')).sum()),'C_q05':int((leadframe.loc[primary,'q_fdr56']<=.05).sum()),'D_primary_comparisons':int(dp.sum()),'D_estimable':int((dp&dr.status.eq('ESTIMATED')).sum()),'D_q05':int((dr.loc[dp,'q_fdr6']<=.05).sum()),'portfolio_E':'NOT_RUN; candidate-efficiency is not portfolio performance','mapping':'STATIC_VINTAGE_EXPLORATORY','elapsed_seconds':time.monotonic()-start,'peak_rss_kib':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}
    out.save('summary.json',summary);out.save('completion.json',{'files':out.files,'summary':summary})
    # Aggregate counts only; detailed research results remain in private storage.
    print('CM05_ANALYSIS_SUMMARY '+json.dumps(summary,sort_keys=True),flush=True)
if __name__=='__main__':main()
