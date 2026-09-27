"""Officially verified overrides; raw provider records are preserved unchanged."""
import pandas as pd

def apply_verified_events(con, dates, ids, mark, terminal, out):
    rows=[]
    specs=[('WKME','2024-09-12',14.0,None,0.0,
            'https://news.sap.com/2024/09/sap-completes-walkme-acquisition/'),
           ('SONN','2025-12-03',0.0,'PURR',0.2,
            'https://classic.nasdaqtrader.com/TraderNews.aspx?id=ECA2025-647')]
    for symbol,settle,cash,acquirer,ratio,source in specs:
        lp=con.execute('SELECT closeadj,closeunadj,date FROM prices WHERE ticker=? ORDER BY date DESC LIMIT 1',[symbol]).fetchone()
        assert lp and lp[1]>0
        consideration=cash
        if acquirer:
            q=con.execute('SELECT date,open*closeunadj/close FROM prices WHERE ticker=? AND date>=? AND volume>0 AND open>0 ORDER BY date LIMIT 1',[acquirer,settle]).fetchone()
            assert q and pd.Timestamp(q[0])==pd.Timestamp(settle)
            consideration+=ratio*q[1]
        d=int(dates.searchsorted(pd.Timestamp(settle)));k=ids[symbol]
        assert dates[d]==pd.Timestamp(settle) and pd.Timestamp(lp[2])<dates[d]
        value=consideration*lp[0]/lp[1]
        mark[d:,k]=value
        terminal[k]=dict(day=d,known=True,value=value,symbol=symbol,bankruptcy=False)
        rows.append(dict(symbol=symbol,last_quote=lp[2],model_settlement=dates[d],cash_per_share=cash,
                         acquirer=acquirer,share_ratio=ratio,unadjusted_equivalent=consideration,
                         adjusted_equivalent=value,CVR_value_assumed=0,source=source,
                         assumption='cash-equivalent at next tradable session; actual settlement delay not supplied; SONN CVR excluded'))
    pd.DataFrame(rows).to_csv(out/'verified_event_overrides.csv',index=False)
    return rows
