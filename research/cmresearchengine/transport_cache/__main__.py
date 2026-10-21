"""Run the unchanged research CLI with an input-only transport adapter."""
from cmresearchengine import storage
from .store import CachedCMStore

storage.SupabaseCMStore = CachedCMStore

from cmresearchengine.cli import main

if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        # Match the original CLI's credential-safe terminal failure behavior.
        print('{"status":"RESEARCH_BLOCKED","detail":"Input cache or research validation failed; no private details logged"}', flush=True)
        raise SystemExit(2)
