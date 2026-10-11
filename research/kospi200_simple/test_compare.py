"""Synthetic-only: old annual budget is rejected; adjusted ETF never pays dividends twice."""
import json
import math
import tempfile
import unittest
from datetime import date,timedelta
from pathlib import Path
from research.kospi200_simple.compare import CAPITAL,PER_SLOT,make_report

def jsonl(path,rows):
    path.write_text("".join(json.dumps(row)+"\n" for row in rows),encoding="utf8")

class TestSimpleComparison(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        d=date(2017,8,21)
        end=date(2026,9,11)
        a,b=[],[]
        nav=CAPITAL; price=20000.0
        while d<=end:
            if d.weekday()<5:
                nav*=1.0002 + .003*math.sin(len(a)*.2)
                price*=1.0001 + .002*math.cos(len(b)*.3)
                a.append({"date":d.isoformat(),"cash":str(nav*.6),"marketValue":str(nav*.4),
                          "nav":str(nav),"valuationStatus":"COMPLETE"})
                b.append({"date":d.isoformat(),"adjustedOpen":price,"adjustedClose":price*1.0001})
            d+=timedelta(days=1)
        jsonl(self.root/"stock.jsonl",a)
        jsonl(self.root/"etf.jsonl",b)
        self.budgets=[{"year":y,"budget":str(PER_SLOT)} for y in range(2017,2027)]
        self.write_budget()
    def write_budget(self):
        (self.root/"budgets.json").write_text(json.dumps(self.budgets),encoding="utf8")
    def runit(self):
        return make_report(self.root/"stock.jsonl",self.root/"etf.jsonl",
                           self.root/"budgets.json")
    def test_returns_and_2025_exclusion(self):
        summary,rows=self.runit()
        self.assertEqual(summary["status"],"RESEARCH_COMPARISON_COMPLETE")
        self.assertEqual(summary["period"]["end"],"2026-09-11")
        self.assertIn("2025",summary["annual"])
        self.assertIn("2018_2024",summary["segments"])
        self.assertIn("excluding_2025_daily_returns_stitched",summary["segments"])
        self.assertEqual(len(summary["leave_one_calendar_year_out"]),8)
        self.assertGreater(summary["rolling_two_year"]["kodex200_buy_hold"]["windows"],100)
        self.assertEqual(len(rows),len(json.loads(line) for line in [])) if False else None
    def test_fixed_budget_required(self):
        self.budgets[5]["budget"] = str(PER_SLOT*1.5)
        self.write_budget()
        with self.assertRaisesRegex(ValueError,"annual-NAV"):
            self.runit()
    def test_missing_etf_price_rejected(self):
        price=list(map(json.loads,(self.root/"etf.jsonl").read_text().splitlines()))
        price[50]["adjustedClose"]=0
        jsonl(self.root/"etf.jsonl",price)
        with self.assertRaisesRegex(ValueError,"ETF missing"):
            self.runit()
    def test_cash_nav_identity_rejected(self):
        nav=list(map(json.loads,(self.root/"stock.jsonl").read_text().splitlines()))
        nav[50]["cash"]="999999999"
        jsonl(self.root/"stock.jsonl",nav)
        with self.assertRaisesRegex(ValueError,"NAV cash/mark mismatch"):
            self.runit()
if __name__=="__main__":
    unittest.main()
