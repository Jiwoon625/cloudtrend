"""Append-only checkpoint commit chains with server-enforced fixed-ID fencing.

A state blob is uploaded/read back before a commit manifest. A commit's generated
next ID can be created exactly once: racing writers cannot overwrite each other.
No mutable latest pointer, folder-name uniqueness assumption, or remote deletion.
"""
import hashlib, json
from cm06_fresh_host_v1 import canonical, digest
from cm06_fresh_codec_v1 import pack, restore

JOURNAL_SCHEMA='CM06_FRESH_COMMIT_CHAIN_V1'
class CheckpointCorruption(RuntimeError): pass

class CandidateJournal:
    def __init__(self,store,first_commit_id,completed_id,identity):
        self.store=store;self.first=first_commit_id;self.completed_id=completed_id;self.identity=identity
        self.head=None;self.head_id=None;self.next_id=first_commit_id;self.sequence=0

    def _get(self,ident):
        try:return self.store.get_bytes(ident)
        except FileNotFoundError:return None

    def scan(self):
        self.head=None;self.head_id=None;self.next_id=self.first;self.sequence=0
        seen=set();previous_hash=None
        while True:
            ident=self.next_id
            if ident in seen:raise CheckpointCorruption('Commit chain cycle')
            seen.add(ident);raw=self._get(ident)
            if raw is None:break
            try:doc=json.loads(raw)
            except Exception as exc:raise CheckpointCorruption('Committed manifest is unreadable') from exc
            if (doc.get('schema')!=JOURNAL_SCHEMA or doc.get('identity')!=self.identity
                or doc.get('sequence')!=self.sequence+1 or doc.get('previous_sha256')!=previous_hash
                or not isinstance(doc.get('next_commit_id'),str) or doc['next_commit_id']==ident):
                raise CheckpointCorruption('Checkpoint chain identity/order mismatch')
            self.head=doc;self.head_id=ident;self.sequence=doc['sequence'];self.next_id=doc['next_commit_id']
            previous_hash=hashlib.sha256(raw).hexdigest()
        if self.head:
            # Full snapshots supersede prior payloads. Verify all small commit
            # links but download only the latest full state, not every old blob.
            payload=self._get(self.head['state_id'])
            if payload is None or len(payload)!=self.head['state_size'] or hashlib.sha256(payload).hexdigest()!=self.head['state_sha256']:
                raise CheckpointCorruption('Committed state blob missing/corrupted; prior valid checkpoint preserved')
        return self.head

    def load(self,runner):
        self.scan()
        if self.head:
            restore(runner,self.store.get_bytes(self.head['state_id']),self.identity)
        return runner

    def commit(self,runner,finished=False):
        if finished and (not getattr(runner,'_resume_finished',False) or (runner.queue and runner.queue[0][0]<=runner.end_at)):
            raise ValueError('Cannot mark unfinished replay complete')
        if self.head and self.head['finished']:raise ValueError('Finished checkpoint is immutable')
        payload=pack(runner,self.identity); state_sha=hashlib.sha256(payload).hexdigest()
        state_id=self.store.generate_id()
        self.store.put_bytes(state_id,'CM06_state_'+state_sha+'.json.gz',payload)
        # Explicit full readback before publishing the small commit marker.
        if self.store.get_bytes(state_id)!=payload:raise CheckpointCorruption('State readback verification failed')
        previous_sha=None
        if self.head_id:
            previous_sha=hashlib.sha256(self.store.get_bytes(self.head_id)).hexdigest()
        doc={'schema':JOURNAL_SCHEMA,'identity':self.identity,'sequence':self.sequence+1,
             'previous_sha256':previous_sha,'state_id':state_id,'state_size':len(payload),
             'state_sha256':state_sha,'next_commit_id':self.store.generate_id(),
             'processed_events':getattr(runner,'_resume_events',0),'at':runner.ledger.at.isoformat(),
             'fills':runner.fill_counter,'snapshots':len(runner.snapshots),'finished':bool(finished)}
        raw=canonical(doc);published_id=self.next_id
        self.store.put_bytes(published_id,'CM06_commit_'+digest(self.identity)[:16]+'_'+str(doc['sequence'])+'.json',raw)
        if self.store.get_bytes(published_id)!=raw:raise CheckpointCorruption('Commit readback verification failed')
        self.head=doc;self.head_id=published_id;self.next_id=doc['next_commit_id'];self.sequence=doc['sequence']
        return doc

    def complete(self,output_blob):
        if not self.head or not self.head['finished']:raise ValueError('Completion requires final committed state')
        sha=hashlib.sha256(output_blob).hexdigest();ident=self.store.generate_id()
        self.store.put_bytes(ident,'CM06_outputs_'+sha+'.zip',output_blob)
        if self.store.get_bytes(ident)!=output_blob:raise CheckpointCorruption('Output verification failed')
        doc={'schema':'CM06_FRESH_COMPLETED_V1','identity':self.identity,'final_commit_id':self.head_id,
             'final_commit_sha256':hashlib.sha256(self.store.get_bytes(self.head_id)).hexdigest(),
             'outputs_id':ident,'outputs_sha256':sha,'outputs_size':len(output_blob)}
        raw=canonical(doc)
        self.store.put_bytes(self.completed_id,'CM06_completed_'+digest(self.identity)[:16]+'.json',raw)
        if self.store.get_bytes(self.completed_id)!=raw:raise CheckpointCorruption('Completion readback failed')
        return doc

    def completed(self):
        raw=self._get(self.completed_id)
        if raw is None:return None
        try:doc=json.loads(raw)
        except Exception as exc:raise CheckpointCorruption('Completion marker unreadable') from exc
        if doc.get('schema')!='CM06_FRESH_COMPLETED_V1' or doc.get('identity')!=self.identity:
            raise CheckpointCorruption('Completed strategy identity mismatch')
        self.scan()
        if self.head_id!=doc['final_commit_id'] or not self.head or not self.head['finished']:
            raise CheckpointCorruption('Completion is not the reachable final checkpoint')
        final_raw=self._get(doc['final_commit_id']);outputs=self._get(doc['outputs_id'])
        if final_raw is None or hashlib.sha256(final_raw).hexdigest()!=doc['final_commit_sha256']:
            raise CheckpointCorruption('Final state commit missing/corrupted')
        final=json.loads(final_raw)
        if final.get('identity')!=self.identity or not final.get('finished'):
            raise CheckpointCorruption('Completion points at unfinished strategy')
        if outputs is None or len(outputs)!=doc['outputs_size'] or hashlib.sha256(outputs).hexdigest()!=doc['outputs_sha256']:
            raise CheckpointCorruption('Completed outputs missing/corrupted')
        return doc
