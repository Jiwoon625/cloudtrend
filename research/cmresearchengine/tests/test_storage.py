import hashlib, io, json, ssl, sys, tempfile, unittest
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cmresearchengine.storage import SupabaseCMStore, StorageError, StorageSecurityError, ImmutableConflict, _NoRedirect
URL = 'https://abcdefghijklmnopqrst.supabase.co'
USER = '00000000-0000-4000-8000-000000000001'
KEY = 'synthetic-test-key-only'
class Response(io.BytesIO):
    def __init__(self, value, url): super().__init__(value); self.url = url
    def geturl(self): return self.url
    def getcode(self): return 200
class FakeHTTP:
    def __init__(self):
        self.objects = {}; self.public = False; self.calls = []; self.failures = []; self.redirect = False; self.fail_after_write = False
    def open(self, request, timeout):
        self.calls.append((request.get_method(), request.full_url, dict(request.header_items())))
        if self.failures: raise self.failures.pop(0)
        if '/bucket/' in request.full_url:
            return Response(json.dumps({'id':'cloudtrend-data','name':'cloudtrend-data','public':self.public}).encode(), request.full_url)
        key = request.full_url.split('/object/cloudtrend-data/', 1)[1]
        if request.get_method() == 'POST':
            if key in self.objects: raise HTTPError(request.full_url, 400, 'hidden', {}, io.BytesIO(b'{"message":"The resource already exists"}'))
            self.objects[key] = request.data
            if self.fail_after_write:
                self.fail_after_write = False
                raise URLError(TimeoutError('sensitive details withheld'))
            return Response(b'{}', request.full_url)
        if key not in self.objects: raise HTTPError(request.full_url, 404, 'hidden', {}, io.BytesIO(b'{}'))
        return Response(self.objects[key], 'https://evil.test/' if self.redirect else request.full_url)
class StorageTests(unittest.TestCase):
    def setUp(self):
        self.http = FakeHTTP(); self.sleeps = []
        self.store = SupabaseCMStore(URL, KEY, USER, opener=self.http, sleep=self.sleeps.append)
        self.scoped = self.store.scoped_checkpoints('a'*64, 'S01')
    def test_host_and_user_validation_before_io(self):
        for url in ('http://abcdefghijklmnopqrst.supabase.co', 'https://evil.test', URL+'.evil.test', URL+'/path', URL+':443', 'https://a@abcdefghijklmnopqrst.supabase.co', URL+'?x'):
            with self.subTest(url=url), self.assertRaises(StorageSecurityError): SupabaseCMStore(url, KEY, USER, opener=self.http)
        with self.assertRaises(StorageSecurityError): SupabaseCMStore.from_env(environ={})
        with self.assertRaises(StorageSecurityError): SupabaseCMStore(URL, KEY, '../other', opener=self.http)
        self.assertFalse(self.http.calls)
    def test_environment_and_repr_redact(self):
        obj = SupabaseCMStore.from_env(environ={'SUPABASE_URL':URL,'SUPABASE_SERVICE_ROLE_KEY':KEY,'SUPABASE_USER_ID':USER}, opener=self.http)
        self.assertNotIn(KEY, repr(obj)); self.assertNotIn(URL, repr(obj))
    def test_private_bucket_required_on_every_operation(self):
        self.scoped.put_bytes('id','name.json',b'payload')
        self.http.public = True
        for op in (lambda:self.store.get_object('inputs/a.json'), lambda:self.store.put_object('results/a.json',b'a'), lambda:self.scoped.get_bytes('id')):
            with self.assertRaises(StorageSecurityError): op()
        self.assertEqual(len([x for x in self.http.calls if '/object/' in x[1]]), 1)
    def test_same_id_fencing_same_bytes_idempotent(self):
        self.scoped.put_bytes('same-id','first.json',b'same')
        self.scoped.put_bytes('same-id','changed.json',b'same')
        with self.assertRaises(ImmutableConflict): self.scoped.put_bytes('same-id','first.json',b'different')
        self.assertEqual(self.scoped.get_bytes('same-id'),b'same'); self.assertEqual(len(self.http.objects),1)
        self.assertIn(USER+'/research/cm/checkpoints/'+'a'*64+'/S01/same-id',self.http.objects)
        self.assertTrue(all(x[2]['X-upsert']=='false' for x in self.http.calls if x[0]=='POST'))
        self.assertTrue(all(x[0] in {'POST','GET'} for x in self.http.calls))
    def test_ambiguous_write_retry_remains_immutable(self):
        self.http.fail_after_write=True
        self.scoped.put_bytes('id','state.json',b'payload')
        self.assertEqual(self.scoped.get_bytes('id'),b'payload'); self.assertEqual(self.sleeps,[0.5])
        self.assertEqual(len(self.http.objects),1)
    def test_path_and_scope_protection(self):
        for key in ('../x','inputs/../x','/inputs/x','inputs//x','inputs/%2e%2e/x','inputs/x?y','inputs/x\\y','auth/x','user/research/cm/inputs/x'):
            with self.subTest(key=key), self.assertRaises(StorageSecurityError): self.store.get_object(key)
        for key in ('inputs/x','evidence/x'):
            with self.assertRaises(StorageSecurityError): self.store.put_object(key,b'no')
        with self.assertRaises(StorageSecurityError): self.store.put_bytes('id','name.json',b'no')
        with self.assertRaises(StorageSecurityError): self.scoped.get_bytes('../../other')
        self.assertFalse(self.http.calls)
    def test_root_manifest_create_only(self):
        self.store.put_object('manifest.json',b'{}'); self.store.put_object('manifest.json',b'{}')
        with self.assertRaises(ImmutableConflict): self.store.put_object('manifest.json',b'{"changed":true}')
        self.assertEqual(self.store.get_object('manifest.json'),b'{}')
    def test_missing_no_retry(self):
        with self.assertRaises(FileNotFoundError): self.scoped.get_bytes('missing')
        self.assertFalse(self.sleeps)
    def test_auth_tls_redirect_no_retry_or_leak(self):
        for failure in (HTTPError(URL,403,KEY,{},io.BytesIO(KEY.encode())), URLError(ssl.SSLCertVerificationError(KEY))):
            self.http.failures=[failure]
            with self.assertRaises(StorageError) as captured:self.store.verify_private_bucket()
            self.assertNotIn(KEY,str(captured.exception)); self.assertFalse(self.sleeps)
        with self.assertRaises(StorageSecurityError): _NoRedirect().redirect_request(Request(URL),None,302,'',{},'https://evil.test/')
        self.http.objects[self.store.object_key('inputs/a')]=b'a';self.http.redirect=True
        with self.assertRaises(StorageSecurityError):self.store.get_object('inputs/a')
    def test_retry_bound(self):
        self.http.failures=[URLError(TimeoutError('private')) for _ in range(4)]
        with self.assertRaises(StorageError):self.store.verify_private_bucket()
        self.assertEqual(len(self.http.calls),4); self.assertEqual(self.sleeps,[0.5,1.0,2.0])
    def test_stream_download_idempotent(self):
        data=b'data'*300000; self.http.objects[self.store.object_key('inputs/archive.tar')]=data
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'archive.tar'; args={'expected_size':len(data),'expected_sha256':hashlib.sha256(data).hexdigest()}
            self.store.download_object('inputs/archive.tar',path,**args)
            self.assertEqual(path.read_bytes(),data)
            self.store.download_object('inputs/archive.tar',path,**args)
            self.assertEqual(path.stat().st_mode&0o111,0)
    def test_short_clean_eof_retries_without_publishing_partial_file(self):
        import http.client
        class Socket:
            def __init__(self,data):self.data=data
            def makefile(self,mode):return io.BytesIO(self.data)
        class HTTPBody:
            def __init__(self,url,data,declared):
                self.url=url
                wire=b'HTTP/1.1 200 OK\r\nContent-Length: '+str(declared).encode()+b'\r\n\r\n'+data
                self.response=http.client.HTTPResponse(Socket(wire));self.response.begin()
            def geturl(self):return self.url
            def getcode(self):return self.response.status
            def read(self,n):return self.response.read(n)
            def __enter__(self):return self
            def __exit__(self,*args):self.response.close()
        class FirstShort(FakeHTTP):
            def __init__(self,data):super().__init__();self.data=data;self.downloads=0
            def open(self,request,timeout):
                if '/bucket/' in request.full_url:return super().open(request,timeout)
                self.downloads+=1
                return HTTPBody(request.full_url,self.data[:3] if self.downloads==1 else self.data,len(self.data))
        data=b'synthetic pinned complete content';remote=FirstShort(data);sleeps=[]
        store=SupabaseCMStore(URL,KEY,USER,opener=remote,sleep=sleeps.append)
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'archive.tar'
            store.download_object('inputs/archive.tar',path,expected_size=len(data),expected_sha256=hashlib.sha256(data).hexdigest())
            self.assertEqual(path.read_bytes(),data);self.assertEqual(remote.downloads,2);self.assertEqual(sleeps,[0.5])

    def test_corrupt_download_not_published(self):
        self.http.objects[self.store.object_key('inputs/archive.tar')]=b'bad'
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'archive.tar'
            with self.assertRaises(StorageError):self.store.download_object('inputs/archive.tar',path,expected_size=3,expected_sha256=hashlib.sha256(b'yes').hexdigest())
            self.assertFalse(path.exists());self.assertEqual(list(Path(directory).iterdir()),[])
    def test_local_collision_preserved(self):
        from cmresearchengine.ingest import LocalConflict
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'a.tar';path.write_bytes(b'existing')
            with self.assertRaises(LocalConflict):self.store.download_object('inputs/archive.tar',path,expected_size=3,expected_sha256=hashlib.sha256(b'yes').hexdigest())
            self.assertEqual(path.read_bytes(),b'existing')
if __name__=='__main__':unittest.main()
