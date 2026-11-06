import unittest
import tempfile
from unittest.mock import patch
from runtime.remote_lock import DatabaseLock, SharedDriveLock
from runtime.state import RunLock

USER='11111111-1111-4111-8111-111111111111'
A='22222222-2222-4222-8222-222222222222'
B='33333333-3333-4333-8333-333333333333'

class Response:
    def __init__(self, status, body): self.status_code,self.body=status,body
    def raise_for_status(self):
        if self.status_code >= 400: raise RuntimeError('HTTP error')
    def json(self): return self.body

class Transport:
    def __init__(self): self.owner=None; self.lost=False; self.read_error=False; self.posts=0
    def post(self, url, headers, json, timeout):
        self.posts+=1
        if self.owner: return Response(409,[])
        self.owner=json['owner_token']
        if self.lost: raise TimeoutError()
        return Response(201,[json])
    def get(self,url,headers,params,timeout):
        if self.read_error: raise TimeoutError()
        return Response(200,[{'owner_token':self.owner}] if self.owner else [])
    def delete(self,url,headers,params,timeout):
        if params['owner_token']=='eq.'+str(self.owner): self.owner=None
        return Response(200,[])

class RemoteLockTests(unittest.TestCase):
    def setUp(self):
        self.http=Transport()
        self.a=DatabaseLock('https://example.supabase.co','test',USER,A,self.http)
        self.b=DatabaseLock('https://example.supabase.co','test',USER,B,self.http)
    def test_different_vm_blocked_until_owner_release(self):
        self.a.acquire()
        with self.assertRaisesRegex(RuntimeError,'Another VM'): self.b.acquire()
        self.a.release();self.b.acquire()
        self.assertEqual(self.http.owner,B)
    def test_lost_post_response_requires_exact_readback_without_second_post(self):
        self.http.lost=True;self.a.acquire();self.assertEqual(self.http.posts,1)
    def test_read_failure_never_allows_work(self):
        self.http.lost=True;self.http.read_error=True
        with self.assertRaises(TimeoutError):self.a.acquire()
    def test_stale_release_cannot_delete_new_owner(self):
        self.a.acquire();self.a.release();self.b.acquire();self.a.release()
        self.assertEqual(self.http.owner,B)
    def test_same_vm_crash_resume_reuses_exact_owner_token(self):
        self.a.acquire();self.a.acquire();self.assertEqual(self.http.owner,A)
    def test_drive_path_never_uses_flock_only(self):
        with patch('runtime.remote_lock.SharedDriveLock') as guard:
            with RunLock('/content/drive/MyDrive/CloudTrend/test',settings={'x':1}):pass
            guard.assert_called_once()
            guard.return_value.__enter__.assert_called_once()
            guard.return_value.__exit__.assert_called_once()
    def test_new_attempt_rotates_token_to_reject_late_release(self):
        settings={'SUPABASE_URL':'https://example.supabase.co',
                  'SUPABASE_SERVICE_ROLE_KEY':'test','SUPABASE_USER_ID':USER}
        with tempfile.TemporaryDirectory() as tmp, \
             patch('tempfile.gettempdir',return_value=tmp), \
             patch.dict('sys.modules',{'requests':self.http}):
            with SharedDriveLock('/content/drive/test',settings) as first:
                token=first.remote.token
            with SharedDriveLock('/content/drive/test',settings) as second:
                self.assertNotEqual(token,second.remote.token)
                first.remote.release()
                self.assertEqual(self.http.owner,second.remote.token)

if __name__=='__main__': unittest.main()
