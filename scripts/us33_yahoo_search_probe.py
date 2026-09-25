import json, requests
T=["AAPL","NVDA","TSLA","JPM","XOM","LLY","UNH","CAT","NEE","NFLX","AMZN","MU","F","NUE","LMT","PLTR","COIN","ZIM"]
s=requests.Session(); s.headers.update({"User-Agent":"Mozilla/5.0"})
out=[]
for t in T:
    try:
        r=s.get("https://query1.finance.yahoo.com/v1/finance/search",params={"q":t,"quotesCount":5,"newsCount":0},timeout=15)
        r.raise_for_status(); j=r.json()
        q=next((x for x in j.get("quotes",[]) if x.get("symbol")==t or x.get("symbol")==t.replace(".","-")), j.get("quotes",[None])[0] if j.get("quotes") else None)
        out.append({"symbol":t,"status":r.status_code,"quote":q})
    except Exception as e:
        out.append({"symbol":t,"error":repr(e)})
print(json.dumps(out,ensure_ascii=False))
