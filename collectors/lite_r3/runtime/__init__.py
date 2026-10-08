"""CloudTrend Lite r3 fixed-version daily runtime.

Call run_stage(name, notebook_globals) in STAGES order. Notebook configuration
and Colab Secrets remain outside this public package. Importing performs no collection or network calls.
"""
from importlib.resources import files as _package_files

RUNTIME_VERSION = 'cloudtrend-lite-r3-daily-v1'
STAGES = ('plan_init', 'common_init', 'kr_setup', 'kr_runtime', 'helpers', 'kr_connections', 'kr_universe', 'kr_functions', 'kr_master', 'kr_calendar', 'kr_enrichment_setup', 'kr_collection', 'kr_enrichment', 'kr_index', 'kr_save', 'kr_publish', 'kr_retry_saved', 'us_setup', 'us_auth', 'us_seed', 'us_master', 'us_collection', 'us_features', 'us_diagnostics', 'us_snapshot', 'us_upload', 'us_archive', 'us_dispatch', 'us_summary', 'integrated_summary')
REQUIREMENTS = ('pandas==2.2.3', 'requests==2.32.4', 'tqdm==4.67.1', 'pyarrow==23.0.1', 'beautifulsoup4')
_ROOT = _package_files(__package__)
_TEXT = {}
_CODE = {}

def _text(relative):
    if relative not in _TEXT:
        _TEXT[relative] = (_ROOT / relative).read_text(encoding='utf-8')
    return _TEXT[relative]

def _execute(relative, namespace):
    if relative not in _CODE:
        _CODE[relative] = compile(_text(relative), str(_ROOT / relative), 'exec')
    exec(_CODE[relative], namespace, namespace)

def run_stage(stage, namespace):
    if stage not in STAGES:
        raise ValueError('Unknown daily runtime stage: ' + str(stage))
    namespace['_CT_RUNTIME_TEXT'] = _text
    namespace['_CT_RUNTIME_EXEC'] = _execute
    _execute('stages/' + stage + '.py', namespace)
