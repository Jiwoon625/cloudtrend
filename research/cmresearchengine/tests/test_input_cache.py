"""Synthetic restart/egress/security tests. No production credentials or data."""
import hashlib
import io
import os
from pathlib import Path
import tempfile
import unittest
import json
import subprocess
from unittest.mock import patch

from test_storage import FakeHTTP, URL, USER, KEY
from transport_cache.store import CachedCMStore as SupabaseCMStore
from transport_cache.input_cache import InputCache


class InputCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cache = self.root / 'ciphertext'
        env = patch.dict(os.environ, {'CM_ENCRYPTED_INPUT_CACHE': str(self.cache)})
        env.start()
        self.addCleanup(env.stop)
        self.http = FakeHTTP()
        self.store = SupabaseCMStore(URL, KEY, USER, opener=self.http)
        self.data = b'PRIVATE_SYNTHETIC_RESEARCH_INPUT_DO_NOT_EXPOSE' * 10000
        self.args = dict(expected_size=len(self.data), expected_sha256=hashlib.sha256(self.data).hexdigest())
        self.relative = 'inputs/synthetic.tar'
        self.http.objects[self.store.object_key(self.relative)] = self.data

    def download(self, run, store=None, relative=None):
        target = self.root / run / 'data'
        (store or self.store).download_object(relative or self.relative, target, **self.args)
        self.assertEqual(target.read_bytes(), self.data)

    def object_gets(self):
        return sum(method == 'GET' and '/object/' in url for method, url, _ in self.http.calls)

    def envelope(self):
        return self.cache / (self.args['expected_sha256'] + '.enc')

    def test_fresh_runner_uses_verified_ciphertext_without_storage_download(self):
        self.download('first')
        self.assertEqual(self.object_gets(), 1)
        sealed = self.envelope().read_bytes()
        self.assertEqual(len(sealed), len(self.data) + 28)
        self.assertNotIn(self.data[:100], sealed)
        self.assertNotIn(KEY.encode(), sealed)
        # A completely different work directory simulates a new Actions runner.
        self.download('second')
        self.assertEqual(self.object_gets(), 1)

    def test_tamper_rejects_and_redownloads_then_reuses_repair(self):
        self.download('first')
        sealed = bytearray(self.envelope().read_bytes())
        sealed[100] ^= 1
        self.envelope().write_bytes(sealed)
        self.download('second')
        self.assertEqual(self.object_gets(), 2)
        self.assertTrue((self.cache / 'repair-needed').is_file())
        self.download('third')
        self.assertEqual(self.object_gets(), 2)

    def test_authenticated_but_wrong_plaintext_still_needs_pinned_hash(self):
        self.cache.mkdir()
        record = {'size': len(self.data), 'sha256': self.args['expected_sha256']}
        # Even a valid encryption tag never replaces the frozen source hash.
        with tempfile.TemporaryFile('w+b') as source:
            source.write(b'x' * len(self.data))
            InputCache(self.store, self.relative).save(source, record)
        self.download('first')
        self.assertEqual(self.object_gets(), 1)

    def test_rotation_cannot_decrypt_previous_key(self):
        self.download('first')
        rotated = SupabaseCMStore(URL, 'rotated-synthetic-key', USER, opener=self.http)
        self.download('second', store=rotated)
        self.assertEqual(self.object_gets(), 2)

    def test_cache_is_bound_to_project_and_user(self):
        self.download('first')
        other = SupabaseCMStore(URL, KEY, '00000000-0000-4000-8000-000000000002', opener=self.http)
        self.http.objects[other.object_key(self.relative)] = self.data
        self.download('second', store=other)
        self.assertEqual(self.object_gets(), 2)

    def test_failed_fallback_never_publishes_decrypted_partial_bytes(self):
        self.download('first')
        self.envelope().write_bytes(b'broken')
        self.http.objects.clear()
        target = self.root / 'second' / 'data'
        with self.assertRaises(FileNotFoundError):
            self.store.download_object(self.relative, target, **self.args)
        self.assertFalse(target.exists())
        self.assertEqual(list(target.parent.iterdir()), [])

    def test_checkpoint_state_is_never_cached(self):
        relative = 'checkpoints/' + 'a' * 64 + '/S01/data'
        self.http.objects[self.store.object_key(relative)] = self.data
        self.download('first', relative=relative)
        self.download('second', relative=relative)
        self.assertEqual(self.object_gets(), 2)
        self.assertFalse(self.cache.exists())

    def test_symlink_envelope_does_not_read_or_overwrite_target(self):
        self.cache.mkdir()
        outside = self.root / 'untouched'
        outside.write_bytes(b'keep')
        self.envelope().symlink_to(outside)
        self.download('first')
        self.assertEqual(outside.read_bytes(), b'keep')
        self.assertFalse(self.envelope().is_symlink())

    def test_cache_miss_or_eviction_downloads_once(self):
        self.download('first')
        self.envelope().unlink()
        (self.cache / 'repair-needed').unlink()
        self.download('second')
        self.assertEqual(self.object_gets(), 2)
        self.assertTrue((self.cache / 'repair-needed').exists())

    def test_runtime_source_identity_stays_unchanged_by_adapter(self):
        from cmresearchengine import runtime
        before = runtime.code_hashes()
        self.assertFalse(any('transport_cache' in path for path in before))
        self.download('first')
        self.download('second')
        self.assertEqual(runtime.code_hashes(), before)

    def test_wrapper_plan_is_identical_and_performs_no_research(self):
        plain = subprocess.check_output(['python', '-m', 'cmresearchengine.cli', 'plan'])
        cached = subprocess.check_output(['python', '-m', 'transport_cache', 'plan'])
        self.assertEqual(json.loads(plain), json.loads(cached))


if __name__ == '__main__':
    unittest.main()
