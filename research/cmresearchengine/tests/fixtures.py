"""Synthetic-only fixtures. No production input files or accounts."""
import sys
import types
import pandas as pd
try:import pyarrow.parquet
except ImportError:
    pa=types.ModuleType('pyarrow');pa.__version__='0.0.0';pq=types.ModuleType('pyarrow.parquet')
    def unavailable(*a,**k):raise RuntimeError('Synthetic tests cannot perform Parquet IO')
    pq.ParquetFile=unavailable;pq.read_table=unavailable;pa.parquet=pq
    sys.modules['pyarrow']=pa;sys.modules['pyarrow.parquet']=pq
from synthetic_fixture import fixture
from cmresearchengine import runtime
from cmresearchengine.replay import ResearchReplay
from cm06.registry import candidate_by_id
from cm06_comparison_execution import ExecutionContract
from cm06_dated_action_contract_v1 import ActionRegistry,StableInstrumentIdentityMap
from cm06_us_cash_t5_policy_v1 import USSessionCalendar
from cm06_fresh_codec_v1 import bind_identity

H='a'*64

def inputs():
    panels,calendars,fx=fixture()
    panels['K']['score']=[6.,8.,9.,6.,8.,9.]
    rows=[]
    for j,source in enumerate(panels['U'].to_dict('records')):
        for i in range(40):
            rank=(40-i) if j==1 else i+1
            rows.append(dict(source,symbol=f'U{i:02}',permaticker=str(i+100),
                ret120=float(rank),ret252=float(rank),beta60_spy=float(rank),ichimoku_tk_gap=float(rank)))
    panels['U']=pd.DataFrame(rows)
    for e,frame in panels.items():
        frame['comparison_open']=frame.raw_open;frame['comparison_close']=frame.raw_close
        frame['source_volume']=frame.raw_volume;frame['research_common_snapshot']=frame.is_common_share
        frame['research_exchange_eligible']=frame.toss_tradable;frame['signal_close']=frame.raw_close
    return panels,calendars,fx

def make(candidate=None,panels=None,calendars=None,fx=None,**kwargs):
    if panels is None:panels,calendars,fx=inputs()
    identities=StableInstrumentIdentityMap(tuple((f'U{i:02}',str(i+100)) for i in range(40)),H,H,True)
    registry=ActionRegistry.bind((),USSessionCalendar(calendars['U']),H)
    return ResearchReplay(candidate or candidate_by_id('S05'),
        ExecutionContract('2020-01-03','2020-01-07',fx_spread='0'),panels,calendars,fx,
        registry=registry,contexts=lambda session:{},instrument_identities=identities,context_sha256=H,**kwargs)

def identity(runner):return bind_identity({'scope':'SYNTHETIC_ONLY','deterministic_seed':12},runner)
