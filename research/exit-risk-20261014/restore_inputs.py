"""Join split transport and validate all materialized replay inputs before execution."""
from pathlib import Path
import hashlib,json
root=Path(__file__).resolve().parent
manifest=json.loads((root/'derived-input-manifest.json').read_text())
directory=root/'inputs/derived';directory.mkdir(parents=True,exist_ok=True)
for name,evidence in manifest.items():
 target=directory/name;parts=sorted(directory.glob(name+'.part*'))
 if not target.exists()and parts:
  temp=target.with_name(target.name+'.partial')
  with temp.open('wb')as dst:
   for p in parts:
    with p.open('rb')as src:
     for block in iter(lambda:src.read(1024*1024),b''):dst.write(block)
  assert temp.stat().st_size==evidence['bytes']
  assert hashlib.sha256(temp.read_bytes()).hexdigest()==evidence['sha256']
  temp.rename(target)
 if target.exists():
  assert target.stat().st_size==evidence['bytes'],name
  assert hashlib.sha256(target.read_bytes()).hexdigest()==evidence['sha256'],name
  print('Verified',name)
