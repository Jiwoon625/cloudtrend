import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import numpy as np
import pandas as pd

ROOT=Path(__file__).resolve().parents[1]
def load(name,file):
    s=importlib.util.spec_from_file_location(name,ROOT/'scripts'/file);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
prep=load('prep_cm','prepare-adopted-us-cm-inputs.py')
stage=load('stage_cm','adopted-us-cm-inputs.py')

def rows(days):
    result=[]
    for d in days:
        for name,common in [('NA',True),('DELISTED',True),('ETF_TEST',False),('SPY',False)]:
            result.append(dict(symbol=name,session_date=d,comparison_open=2.,comparison_high=3.,comparison_low=1.,comparison_close=2.5,volume=100.,dollar_volume=999.,active20=True,research_common_snapshot=common,research_exchange_eligible=True,universe_policy=prep.POLICY,signal_price_basis='CLOSEADJ_FEATURES_AND_EXECUTION',permaticker={'NA':'1','DELISTED':'2','ETF_TEST':'3','SPY':None}[name],available_at=d+'T20:15:00Z',name=name,research_sector='TEST',**{c:0.1234567890123456 for c in prep.FEATS}))
    return pd.DataFrame(result)

class PreparedExpanded(unittest.TestCase):
    def test_preserves_original_liquidity_no_active_survivor_filter(self):
        f=rows(['2020-01-02']);f['status']='DELISTED'
        out=prep.atomic_rows(f)
        self.assertEqual(set(out.symbol),{'NA','DELISTED','ETF_TEST','SPY'})
        self.assertTrue(out.loc[out.symbol.eq('DELISTED'),'toss_tradable'].item())
        self.assertTrue(out.status.isna().all())
        self.assertEqual(out.dollar_volume.tolist(),[999.]*4)
        self.assertEqual(out.close.tolist(),[2.5]*4)
        self.assertFalse(out.loc[out.symbol.eq('ETF_TEST'),'is_common_share'].item())
        self.assertFalse(out.loc[out.symbol.eq('SPY'),'toss_tradable'].item())
        np.testing.assert_array_equal(out.ret252,f.ret252)
    def test_rejects_wrong_policy_and_duplicate_identity(self):
        f=rows(['2020-01-02']);f.loc[0,'universe_policy']='CURRENT_ACTIVE'
        with self.assertRaises(ValueError):prep.atomic_rows(f)
        f=rows(['2020-01-02'])
        with self.assertRaises(ValueError):prep.atomic_rows(pd.concat([f,f.iloc[:1]]))
    def test_null_gap_zero_volume_and_na_are_preserved(self):
        f=rows(['2020-01-02']);f.loc[0,'comparison_close']=np.nan;f.loc[1,'volume']=0
        out=prep.atomic_rows(f)
        self.assertEqual(out.symbol.iloc[0],'NA');self.assertTrue(pd.isna(out.close.iloc[0]));self.assertEqual(out.volume.iloc[1],0)
    def fixture(self,root):
        days=pd.bdate_range('2015-01-02',periods=260).strftime('%Y-%m-%d').tolist()
        u=root/prep.PREFIX/'U';u.mkdir(parents=True)
        calendar=root/prep.REFERENCE/'data/reference_time';calendar.mkdir(parents=True)
        (calendar/'U_calendar.json').write_text(json.dumps([dict(session_date=d,open_at=d+'T13:30:00Z',close_available_at=d+'T20:15:00Z') for d in days]))
        bench=root/prep.REFERENCE/'data/us/spy_prepared_verified.parquet';bench.parent.mkdir();pd.DataFrame({'date':days,'closeadj':1.}).to_parquet(bench)
        f=rows(days);months={}
        for month,g in f.groupby(f.session_date.str[:7]):
            path=u/(month+'.parquet');g.to_parquet(path,index=False)
            months[month]=dict(path=path.name,sha256=prep.sha(path)[7:],rows=len(g),sessions=sorted(g.session_date.unique()))
        m=dict(status='COMPLETE_NORMALIZED_INPUTS',months=months,rows=len(f));mp=u/'manifest.json';mp.write_text(json.dumps(m))
        (u.parent/'PREPARATION_RESULT.json').write_text(json.dumps({'engines':{'U':{'sha256':prep.sha(mp)[7:]}}}))
        return days
    def test_full_conversion_calendar_hashes_gzip_no_warmup_truncation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'input';days=self.fixture(root);out=Path(tmp)/'out'
            m=prep.prepare(root,out,days[252],days[-1])
            self.assertEqual(m['sourceSymbols'],4);self.assertEqual(m['sourceRows'],1040)
            self.assertEqual(m['featureWarmup']['priorSessionsBeforeFirstOutput'],252)
            self.assertEqual(m['sessions'],days[252:]);self.assertEqual(len(m['canonical']),12)
            f=pd.read_csv(out/m['files'][0]['file'],keep_default_na=False)
            self.assertIn('NA',set(f.symbol));self.assertTrue(all(x['marketDataComplete'] for x in m['files']))
            self.assertEqual(m['sourceCoverageEndDate'],days[-1]);self.assertEqual(len(m['sourceClocks']),8)
    def test_rejects_pre_warmup_and_corrupt_partition(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'input';days=self.fixture(root)
            with self.assertRaisesRegex(ValueError,'warmup'):prep.prepare(root,Path(tmp)/'out',days[251],days[-1])
            p=next((root/prep.PREFIX/'U').glob('*.parquet'));p.write_bytes(b'bad')
            with self.assertRaisesRegex(ValueError,'changed'):prep.prepare(root,Path(tmp)/'out2',days[252],days[-1])

class SelectedArchive(unittest.TestCase):
    def test_only_wanted_regular_members_extracted(self):
        import hashlib
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);path=root/'a.tar';records={};names=['data/a.json','data/b.json']
            with tarfile.open(path,'w') as a:
                for n in names:
                    b=b'{}';info=tarfile.TarInfo(n);info.size=len(b);info.mode=0o600;a.addfile(info,io.BytesIO(b));records[n]={'size':len(b),'sha256':hashlib.sha256(b).hexdigest()}
            d={**stage.ingest.hashes(path),'members':names};out=root/'out'
            stage.extract_selected(path,d,records,out,{names[0]})
            self.assertTrue((out/names[0]).exists());self.assertFalse((out/names[1]).exists())
    def test_symlink_member_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);path=root/'a.tar'
            with tarfile.open(path,'w') as a:
                i=tarfile.TarInfo('data/a.json');i.type=tarfile.SYMTYPE;i.linkname='/tmp/outside';a.addfile(i)
            d={**stage.ingest.hashes(path),'members':['data/a.json']}
            with self.assertRaises(stage.UsInputError):stage.extract_selected(path,d,{'data/a.json':{'size':0,'sha256':'0'*64}},root/'out',{'data/a.json'})

if __name__=='__main__':unittest.main()
