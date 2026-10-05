"""Prepare explicit exploratory inputs from completed CM06 checkpoints only.

No collection, false certifications, or historical runs.
Reads separately completed closeadj comparison features; original Stage2 retained.
"""
from pathlib import Path
import argparse
from datetime import datetime, timezone
import hashlib
import json
import zipfile

import numpy as np
import pandas as pd
import pyarrow.parquet as pq


def sha(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for b in iter(lambda: f.read(1024*1024), b""):
            h.update(b)
    return h.hexdigest()


def clean(value):
    if isinstance(value, dict): return {k: clean(v) for k,v in value.items()}
    if isinstance(value, (list, tuple, np.ndarray)): return [clean(v) for v in value]
    if isinstance(value, np.generic): return clean(value.item())
    if isinstance(value, float) and not np.isfinite(value): return None
    return value


def write_json(path, value):
    with Path(path).open("x", encoding="utf-8") as f:
        json.dump(clean(value), f, ensure_ascii=False, indent=2, allow_nan=False)


def read_symbol_audit(path):
    # NA is an actual ticker. Default CSV null inference must never erase it.
    frame = pd.read_csv(path,dtype={"symbol":str},keep_default_na=False)
    if frame.symbol.eq("").any() or frame.symbol.duplicated().any():
        raise ValueError("Empty or duplicate source ticker")
    return frame


def add_comparison_prices(frame, engine):
    f = frame.copy()
    if any(c in f for c in ("comparison_open", "comparison_close", "source_volume")):
        raise ValueError("Comparison fields already exist")
    f["source_volume"] = f.volume
    if engine == "U":
        valid = np.isfinite(f[["open","high","low","close","closeadj"]]).all(axis=1)
        valid &= f[["open","high","low","close","closeadj"]].gt(0).all(axis=1)
        valid &= f.high.ge(f[["open","close","low"]].max(axis=1)) & f.low.le(f[["open","close","high"]].min(axis=1))
        ratio = (f.closeadj/f.close).where(valid)
        valid &= np.isfinite(ratio) & np.isfinite(f.open*ratio) & np.isfinite(f.high*ratio) & np.isfinite(f.low*ratio)
        ratio = ratio.where(valid)
        f["comparison_ratio"] = ratio
        f["comparison_high"], f["comparison_low"] = f.high*ratio, f.low*ratio
        f["comparison_open"] = f.open * ratio
        f["comparison_close"] = f.closeadj.where(valid)
        f["comparison_price_basis"] = "CLOSEADJ_OHLC_RATIO_COMPARISON_V1"
        f["source_price_valid_for_comparison"] = valid
    else:
        f["comparison_open"] = f.open.where(np.isfinite(f.open) & f.open.gt(0))
        f["comparison_close"] = f.close.where(np.isfinite(f.close) & f.close.gt(0))
        f["comparison_high"] = f.high.where(np.isfinite(f.high) & f.high.gt(0))
        f["comparison_low"] = f.low.where(np.isfinite(f.low) & f.low.gt(0))
        f["comparison_price_basis"] = "EXISTING_TOSS_ADJUSTED_CANDLE_COMPARISON"
    f["comparison_unit_semantics"] = "INTEGER_COMPARISON_UNITS_NOT_HISTORICAL_SHARES"
    # Original raw fields, source prices, features, liquidity and flags are untouched.
    return f


def attach_us_research_metadata(frame, master, history):
    f = frame.copy()
    unknown = set(f.symbol)-set(master.index)-{"SPY"}
    if unknown: raise ValueError(f"US identities missing master: {sorted(unknown)[:20]}")
    f["research_common_snapshot"] = f.symbol.map(master.is_common).fillna(False).astype(bool) & f.symbol.ne("SPY")
    f["name"] = f.symbol.map(master["name"]).fillna(f.symbol)
    f["permaticker"] = f.symbol.map(master.permaticker)
    f["_dt"] = pd.to_datetime(f.session_date)
    f["_original_order"] = np.arange(len(f))
    for kind, name in (("exchange","research_exchange"),("sector","research_sector")):
        h = history.loc[history.kind.eq(kind),["symbol","dt","value"]].rename(columns={"value":name})
        f = pd.merge_asof(f.sort_values(["_dt","symbol"]), h.sort_values(["dt","symbol"]), left_on="_dt", right_on="dt", by="symbol", direction="backward", allow_exact_matches=True).drop(columns="dt")
    f = f.sort_values("_original_order").drop(columns=["_dt","_original_order"])
    allowed = {"NYSE","NASDAQ","NYSEMKT","NYSEARCA","BATS","AMEX","NYSEAMERICAN"}
    f["research_exchange_eligible"] = f.research_exchange.isin(allowed)
    f["sector"] = f.research_sector
    f["market"], f["currency"] = "US", "USD"
    # No isdelisted/current ACTIVE filter, toss_tradable, or historical category claim.
    f["universe_policy"] = "ALL_SOURCE_IDENTITIES_WITH_CURRENT_CATEGORY_AND_ASOF_EXCHANGE_RESEARCH_PROXY_NOT_PIT"
    return f


def add_documented_domo_join(master, history, symbol_audit):
    """One explicit related-ticker join; source price symbols are not renamed."""
    a = symbol_audit.set_index("symbol")
    if "DOMO" not in a.index or "HUCK" in a.index or "DOMO" in master.index:
        raise ValueError("DOMO/HUCK source identity conditions changed")
    m = master.loc["HUCK"]
    if str(m.permaticker) != "116453" or m.relatedtickers != "DOMO":
        raise ValueError("Prepared related-ticker evidence changed")
    if a.loc["DOMO","first_source_date"] != m.firstpricedate or a.loc["DOMO","last_source_date"] != m.lastpricedate:
        raise ValueError("DOMO price history does not match the declared related ticker")
    if history.symbol.eq("DOMO").any(): raise ValueError("Ambiguous pre-existing DOMO history")
    h = history.loc[history.symbol.eq("HUCK")].copy()
    if set(h.kind) != {"sector","exchange"}: raise ValueError("Missing related-ticker history")
    alias = master.loc[["HUCK"]].copy(); alias.index = ["DOMO"]
    h["symbol"] = "DOMO"
    return pd.concat([master,alias]), pd.concat([history,h],ignore_index=True)


def prepare(root, output):
    root, output = Path(root).resolve(), Path(output).resolve()
    result_path = root/"outputs/colab_stage2_v1/STAGE2_RESULT.json"
    result = json.loads(result_path.read_text())
    if result.get("status") != "INDEPENDENT_CHECKS_COMPLETE":
        raise ValueError("Stage2 independent checks not complete")
    if output.exists(): raise FileExistsError("Use a new attempt folder; existing results are preserved")
    output.mkdir(parents=True)
    ref = root/"outputs/colab_stage2_v1/reference_time"
    ref_manifest = json.loads((ref/"data/reference_time/manifest.json").read_text())
    calendars = {}
    for e, item in ref_manifest["calendars"].items():
        p = ref/item["file"]
        if sha(p) != item["sha256"]: raise ValueError("Calendar changed")
        calendars[e] = json.loads(p.read_text())
    evidence = root/"outputs/CM06_existing_US33_metadata_evidence_v1.zip"
    if sha(evidence) != "cf1eaf6d36eaabeccd2f94c39eb404e872c8628dac085ea020c481db2b1816e3":
        raise ValueError("Prepared metadata package changed")
    with zipfile.ZipFile(evidence) as z:
        master = pd.read_csv(z.open("us33_security_master_audit.csv"), keep_default_na=False, dtype={"ticker":str,"permaticker":str})
        history = pd.read_parquet(z.open("us33_historical_sector_exchange.parquet"))
    if master.ticker.duplicated().any() or master.permaticker.duplicated().any(): raise ValueError("Ambiguous master identity")
    expected_common = master.category.str.contains("Common Stock", regex=False)
    if not master.is_common.eq(expected_common).all(): raise ValueError("Common category derivation differs")
    master = master.set_index("ticker")
    if history.duplicated(["symbol","kind","dt"]).any(): raise ValueError("Ambiguous metadata history")
    us_dir = root/"data/us/closeadj_comparison_features_v1"
    um = json.loads((us_dir/"manifest.json").read_text())
    if um.get("status") != "COMPLETE_CLOSEADJ_COMPARISON_FEATURES" or um.get("signal_price_basis") != "CLOSEADJ_FEATURES_AND_EXECUTION": raise ValueError("Approved comparison features not ready")
    symbol_audit = read_symbol_audit(us_dir/"symbol_audit.csv")
    master, history = add_documented_domo_join(master,history,symbol_audit)
    sources = {"K":root/"data/kr/normalized_engine_input.parquet", "E":root/"data/etf/normalized_features_complete.parquet"}
    wanted = {
        "K": "symbol date session_date market currency sector score eligible observed observed_suspension priority rs_accel market_gate signal_close open high low close volume average_trading_value20 tradingValue tradingValueSource priceSource price_basis raw_execution_verified raw_open raw_close raw_volume".split(),
        "E": "symbol date session_date market currency sector open high low close volume signal_close score eligible annual_volatility underlying_close underlying_ma60 average_trading_value20 region krx_batch_pending technical priority health environment environment_source price_basis raw_execution_verified raw_open raw_close raw_volume".split(),
        "U": "symbol date session_date open high low close volume closeadj closeunadj signal_close ret120 ret252 beta60_spy ichimoku_tk_gap relvol1_20 adv20_usd amihud20 active20 dollar_volume adv20_prior signal_price_basis source_observed source_ohlc_consistent historical_eligibility_verified raw_execution_verified raw_open raw_close raw_volume price_basis".split(),
    }
    preparation = {"status":"PREPARING", "scope":"EXPLORATORY_CURRENT_POLICY_COMPARISON_NOT_HISTORICAL_EXECUTION_CERTIFICATION", "source_stage2_sha256":sha(result_path), "engines":{}, "historical_paths_completed":0, "original_stage2_recomputed":False, "new_comparison_features_computed":True, "signal_price_basis":"CLOSEADJ_FEATURES_AND_EXECUTION", "comparison_feature_manifest_sha256":sha(us_dir/"manifest.json"),
                   "explicit_metadata_join":{"source_symbol":"DOMO","master_ticker":"HUCK","permaticker":"116453","basis":"Prepared relatedtickers plus exact first/last source dates; no HUCK source-price identity","source_price_symbol_renamed":False,"historical_identity_certified":False}}
    for e in "KEU":
        dest = output/e; dest.mkdir()
        available = {s["session_date"]:s["close_available_at"] for s in calendars[e]}
        parts, first_signal, rows_total = {}, None, 0
        readiness_by_market = {}
        if e == "U":
            files_by_year = {}
            for item in um["outputs"]:
                p = us_dir/item["path"]
                if not p.resolve().is_relative_to(us_dir): raise ValueError("US input escapes root")
                if sha(p) != item["sha256"]: raise ValueError("US feature shard changed")
                files_by_year.setdefault(str(item["year"]), []).append(p)
            years = sorted(files_by_year)
        else:
            date_col = "date" if e == "K" else "session_date"
            dates = pq.read_table(sources[e],columns=[date_col]).column(0).to_pylist()
            years = sorted({str(d)[:4] for d in dates})
        for year in years:
            paths = files_by_year[year] if e == "U" else [sources[e]]
            schema = pq.ParquetFile(paths[0]).schema_arrow.names
            cols = [c for c in wanted[e] if c in schema]
            if e == "U":
                tables = [pq.read_table(p, columns=cols) for p in paths]
                import pyarrow as pa
                table = pa.concat_tables(tables); del tables
            else:
                table = pq.read_table(paths[0],columns=cols,filters=[(date_col,">=",year+"-01-01"),(date_col,"<=",year+"-12-31")])
            f = table.to_pandas(); del table
            if "session_date" not in f: f["session_date"] = f.date
            f["available_at"] = f.session_date.map(available)
            if f.available_at.isna().any(): raise ValueError("Source date outside verified calendar")
            if f.duplicated(["session_date","symbol"]).any(): raise ValueError("Repeated source symbol/date")
            if e == "U":
                if not f.signal_price_basis.eq("CLOSEADJ_FEATURES_AND_EXECUTION").all(): raise ValueError("Mixed signal basis")
                f = attach_us_research_metadata(f, master, history)
            else:
                f["currency"] = "KRW"
                if "market_gate" in f: f["market_gate"] = f.market_gate.map(clean)
            f = add_comparison_prices(f,e)
            f["availability_basis"] = "RESEARCH_CLOSE_PLUS_15_MINUTES_NOT_RECORDED_ARRIVAL"
            ready = f.research_common_snapshot & f.research_exchange_eligible & np.isfinite(f.ret120) & np.isfinite(f.ret252) if e=="U" else f.eligible.fillna(False) & np.isfinite(f.score)
            if e == "K":
                for market, group in f.loc[ready].groupby("market"):
                    if market == "KOSPI":
                        group = group.loc[group.market_gate.map(lambda g: isinstance(g,dict) and g.get("status") != "UNKNOWN" and g.get("evaluatedCount") == 4 and not g.get("incomplete") and not g.get("issues"))]
                    if len(group):
                        d = group.session_date.min()
                        readiness_by_market[market] = min(readiness_by_market.get(market,d),d)
            if ready.any():
                d = f.loc[ready,"session_date"].min()
                first_signal = min(first_signal,d) if first_signal else d
            for month, g in f.groupby(f.session_date.str[:7],sort=True):
                p = dest/(month+".parquet")
                if p.exists(): raise FileExistsError(p)
                g = g.sort_values(["session_date","symbol"])
                g.to_parquet(p,index=False,compression="zstd")
                parts[month] = {"path":p.name,"sha256":sha(p),"rows":len(g),"sessions":sorted(set(g.session_date))}
                rows_total += len(g)
            print(f"Comparison normalization {e} {year}: {rows_total:,} rows; existing prepared features reused",flush=True)
            del f
        if e == "K":
            if not {"KOSPI","KOSDAQ"}.issubset(readiness_by_market): raise ValueError("Both KR markets lack complete warm-up")
            first_signal = max(readiness_by_market["KOSPI"],readiness_by_market["KOSDAQ"])
        if first_signal is None: raise ValueError("No valid signal-ready session")
        manifest = {"status":"COMPLETE_NORMALIZED_INPUTS", "months":parts, "first_signal_ready":first_signal,"rows":rows_total,"historical_execution_certified":False}
        write_json(dest/"manifest.json",manifest)
        preparation["engines"][e] = {"manifest":str(dest/"manifest.json"),"sha256":sha(dest/"manifest.json"),"rows":rows_total,"first_signal_ready":first_signal}
    preparation["status"] = "NORMALIZED_INPUTS_READY_NOT_BACKTESTED"
    preparation["common_period_proposal"] = {"start_date":max(v["first_signal_ready"] for v in preparation["engines"].values()),"end_date":ref_manifest["common_calendar_overlap"]["end"]}
    preparation["created_at_utc"] = datetime.now(timezone.utc).isoformat()
    write_json(output/"PREPARATION_RESULT.json",preparation)
    print(json.dumps(preparation,ensure_ascii=False,indent=2),flush=True)


if __name__ == "__main__":
    p=argparse.ArgumentParser();p.add_argument("--root",required=True);p.add_argument("--output",required=True)
    a=p.parse_args();prepare(a.root,a.output)
