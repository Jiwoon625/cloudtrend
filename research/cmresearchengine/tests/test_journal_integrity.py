"""Synthetic regression for a changing backend response; no remote writes."""
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import tempfile
import unittest
from fixtures import make,identity
from cm06_fresh_codec_v1 import pack
from cm06_fresh_journal_v1 import CandidateJournal
from cm06_checkpoint_store import DirectoryStore

class JournalIntegrityTests(unittest.TestCase):
    def test_load_uses_exact_payload_verified_during_scan(self):
        with tempfile.TemporaryDirectory() as root:
            store=DirectoryStore(root);first=make();bound=identity(first)
            journal=CandidateJournal(store,'first','complete',bound)
            committed=journal.commit(first)
            advanced=make();advanced.step();alternate=pack(advanced,bound)
            normal=store.get_bytes;reads=[]
            def inconsistent(key):
                if key==committed['state_id']:
                    reads.append(key)
                    if len(reads)>1:return alternate
                return normal(key)
            store.get_bytes=inconsistent
            restored=journal.load(make())
            self.assertEqual(len(reads),1)
            self.assertEqual(restored._resume_events,0)
            self.assertEqual(journal.head['processed_events'],0)

if __name__=='__main__':unittest.main()

class CompletionIntegrityTests(unittest.TestCase):
    def test_completion_cannot_verify_a_different_second_read_of_head(self):
        import hashlib,json
        from cm06_fresh_host_v1 import canonical
        from cm06_fresh_journal_v1 import CheckpointCorruption
        with tempfile.TemporaryDirectory() as root:
            store=DirectoryStore(root);runner=make();runner.run();bound=identity(runner)
            journal=CandidateJournal(store,'first','complete',bound)
            journal.commit(runner,finished=True);marker=journal.complete(b'synthetic outputs')
            alternate=dict(journal.head,state_id='missing-state',state_sha256='f'*64)
            alternate_raw=canonical(alternate)
            forged=canonical(dict(marker,final_commit_sha256=hashlib.sha256(alternate_raw).hexdigest()))
            normal=store.get_bytes;reads=[]
            def inconsistent(key):
                if key=='complete':return forged
                if key=='first':
                    reads.append(key)
                    if len(reads)>1:return alternate_raw
                return normal(key)
            store.get_bytes=inconsistent
            with self.assertRaisesRegex(CheckpointCorruption,'Final state commit'):
                CandidateJournal(store,'first','complete',bound).completed()
            self.assertEqual(len(reads),1)
