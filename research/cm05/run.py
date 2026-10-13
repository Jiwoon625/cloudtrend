"""One authorized, bounded build or analysis request; never self-dispatches."""
import json,os
from pathlib import Path

def main():
    req=json.loads((Path(__file__).parent/'REQUEST.json').read_text())
    if req.get('workers')!=1:raise ValueError('CM05 is limited to one worker')
    mode=req.get('mode','build')
    if mode=='build':
        from build import main as execute
    elif mode=='analyze':
        if not str(req.get('build_run_id','')).isdigit():raise ValueError('Completed build run ID required')
        from analyze import main as execute
    else:raise ValueError('Only build and analyze requests are supported')
    execute()
if __name__=='__main__':main()
