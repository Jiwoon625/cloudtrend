"""Use the original CM synthetic fixture; its Parquet stub rejects real data I/O."""
from pathlib import Path
import sys
from cmresearchengine import runtime
sys.path.insert(0, str(runtime.ROOT / 'tests'))
import fixtures
