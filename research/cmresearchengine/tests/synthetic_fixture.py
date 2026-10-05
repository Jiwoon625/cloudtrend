# Synthetic fixture adapted from from original test_execution.py SHA256 28d6a80400e79f23c3d40f5a0e1b601c19c9dcf8c52ec8877d0dc81716607df4
import pandas as pd

def fixture():
    days=["2020-01-02","2020-01-03","2020-01-06","2020-01-07","2020-01-08","2020-01-09"]
    calendars={e:[{"session_date":d,"open_at":d+("T00:00:00Z" if e!="U" else "T14:30:00Z"),
                    "close_available_at":d+("T06:31:00Z" if e!="U" else "T21:01:00Z")}
                  for d in days] for e in ["K","E","U"]}
    panels={}
    for e in calendars:
        rows=[]
        for s in calendars[e]:
            row={"session_date":s["session_date"],"symbol":e+"_A","available_at":s["close_available_at"],
                 "raw_open":100.,"raw_close":100.,"raw_high":101.,"raw_low":99.,"raw_volume":100000.,
                 "market":"US" if e=="U" else "ETF" if e=="E" else "KOSDAQ",
                 "currency":"USD" if e=="U" else "KRW","score":6.,"eligible":True,"observed":True,"sector":"S",
                 "average_trading_value20":100000000.,"annual_volatility":.1,
                 "underlying_close":100.,"underlying_ma60":100.,"is_common_share":True,"toss_tradable":True,
                 "ret120":.1,"ret252":.2,"beta60_spy":1.,"ichimoku_tk_gap":.1,"relvol1_20":1.,
                 "adv20_usd":1000000.,"amihud20":.001,"active20":True}
            rows.append(row)
        panels[e]=pd.DataFrame(rows)
    fx=pd.DataFrame([{"available_at":"2020-01-01T00:00:00Z","krw_per_usd":1000.}])
    return panels,calendars,fx
