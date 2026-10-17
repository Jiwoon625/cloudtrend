#!/usr/bin/env python3
"""Extract a bounded index-only diagnostic artifact from checksum-verified local originals.
No network, upload, price-series rewrite, source activation or strategy application.
"""
import argparse, hashlib, json, math
from pathlib import Path
from datetime import datetime, timezone
import pandas as pd


def build(source_dir, roster_file, output_file, available_from, cutoff_date):
    vintage = datetime.fromisoformat(available_from.replace("Z", "+00:00"))
    if vintage.tzinfo is None or datetime.fromisoformat(cutoff_date).date() > vintage.date():
        raise ValueError("Explicit cutoff and timezone-aware vintage are required")
    p = Path(source_dir)
    provenance = json.loads((p / 'provenance.json').read_text())
    qa = json.loads((p / 'research_completeness.json').read_text())
    sources, frames = [], []
    files = ['original.parquet'] + sorted(x.name for x in p.glob('cache_202610*.json')) + sorted(x.name for x in p.glob('daily_202610*.parquet'))
    for filename in files:
        raw = (p / filename).read_bytes()
        sha = hashlib.sha256(raw).hexdigest()
        if filename.endswith('.parquet'):
            expected = provenance['parquetSha256'][filename]
            if sha != expected:
                raise ValueError(f'Original bytes do not match manifest: {filename}')
            manifest_name = 'manifest.json' if filename == 'original.parquet' else 'manifest_' + filename[6:14] + '.json'
            manifest = json.loads((p / manifest_name).read_text())
            # The audit pins bytes; recheck the collector manifest independently.
            if sha not in json.dumps(manifest['etfParquet']):
                raise ValueError(f'Collector manifest mismatch: {filename}')
            frame = pd.read_parquet(p / filename, columns=['symbol', 'date', 'etfUnderlyingIndexName', 'etfUnderlyingIndexClose'])
            captured = manifest['createdAt']
        else:
            rows = json.loads(raw)
            frame = pd.DataFrame([{'symbol': r['ISU_CD'], 'date': f"{r['BAS_DD'][:4]}-{r['BAS_DD'][4:6]}-{r['BAS_DD'][6:8]}", 'etfUnderlyingIndexName': r['IDX_IND_NM'], 'etfUnderlyingIndexClose': r['OBJ_STKPRC_IDX']} for r in rows])
            # File capture timestamps are not provider publication timestamps.
            captured = None
        if str(frame.date.max()) > cutoff_date:
            raise ValueError(f'Source exceeds explicit cutoff: {filename}')
        frame['sourceId'] = filename
        frames.append(frame)
        sources.append({'id': filename, 'sha256': sha, 'uri': provenance['sourceLinks'][filename], 'capturedAt': captured, 'provider': 'KRX', 'field': 'OBJ_STKPRC_IDX', 'minDate': str(frame.date.min()), 'maxDate': str(frame.date.max())})
    all_rows = pd.concat(frames, ignore_index=True)
    all_rows['etfUnderlyingIndexClose'] = pd.to_numeric(all_rows.etfUnderlyingIndexClose.astype(str).str.replace(',', ''), errors='coerce')
    if all_rows.duplicated(['symbol', 'date']).any():
        raise ValueError('Duplicate symbol/date input; no silent source precedence is allowed')
    calendar = sorted(d for d in (set(qa['calendar']['dates']) | set(all_rows.date)) if d <= cutoff_date)[-66:]
    if calendar[-1] != cutoff_date:
        raise ValueError('Explicit cutoff is not represented in stored sources')
    roster = json.loads(Path(roster_file).read_text())
    groups = dict(tuple(all_rows.groupby('symbol')))
    symbols = []
    for instrument in sorted(roster, key=lambda x: x['symbol']):
        symbol = instrument['symbol']
        history = groups.get(symbol, all_rows.iloc[:0])
        names = sorted(set(str(x).strip() for x in history.etfUnderlyingIndexName.dropna() if str(x).strip()))
        window = history[history.date.isin(calendar)].sort_values('date')
        observations = []
        for row in window.itertuples():
            value = float(row.etfUnderlyingIndexClose)
            if not math.isfinite(value) or value <= 0:
                value = None
            observations.append([row.date, value, str(row.etfUnderlyingIndexName).strip() if pd.notna(row.etfUnderlyingIndexName) else '', row.sourceId])
        symbols.append({'symbol': symbol, 'name': instrument['name'], 'historicalIndexNames': names, 'observations': observations})
    artifact = {'version': 'underlying-index-diagnostic-v1', 'usage': 'diagnostic-only', 'availableFrom': available_from, 'cutoffDate': calendar[-1], 'calendarKind': 'observed-not-exchange-certified', 'calendar': calendar, 'independentIndexIdVerified': False, 'currencyAndMethodologyVerified': False, 'sources': sources, 'symbols': symbols}
    encoded = json.dumps(artifact, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
    Path(output_file).write_bytes(encoded)
    print(json.dumps({'sha256': hashlib.sha256(encoded).hexdigest(), 'bytes': len(encoded), 'symbols': len(symbols), 'observations': sum(len(s['observations']) for s in symbols), 'calendar': [calendar[0], calendar[-1]], 'usage': 'diagnostic-only'}))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-dir', required=True)
    parser.add_argument('--roster-file', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--available-from', required=True)
    parser.add_argument('--cutoff-date', required=True)
    args = parser.parse_args()
    build(args.source_dir, args.roster_file, args.output, args.available_from, args.cutoff_date)
