import gzip,json,hashlib
from pathlib import Path
r=Path(__file__).resolve().parent
p=r/'inputs/derived/etf.signals.jsonl.gz'
with gzip.open(p,'wt',compresslevel=1)as out:
 for i in range(20):
  source=r/'inputs/research/stored'/f'score-{i:03}'/'attempt-1/signal-cache.jsonl.gz'
  with gzip.open(source,'rt')as f:
   for line in f:out.write(json.dumps(json.loads(line)['etfSnapshot'],separators=(',',':'))+'\n')
print('Compact ETF snapshot bytes',p.stat().st_size,hashlib.sha256(p.read_bytes()).hexdigest())
