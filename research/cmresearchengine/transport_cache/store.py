"""Input/evidence download adapter; all scientific engine sources stay intact."""
import os
from pathlib import Path
import uuid

from cmresearchengine.storage import SupabaseCMStore
from cmresearchengine.ingest import parent_fd, match_at
from .input_cache import InputCache


class CachedCMStore(SupabaseCMStore):
    def download_object(self, relative_key, target, *, expected_size, expected_sha256):
        # Preserve all original key and pinned size/hash validation before cache IO.
        from cmresearchengine.storage import SHA256
        self._object_route(relative_key)
        if (type(expected_size) is not int or expected_size < 0 or
                not isinstance(expected_sha256, str) or SHA256.fullmatch(expected_sha256) is None):
            raise ValueError('A pinned object size and SHA256 are required')
        cache = InputCache(self, relative_key)
        record = {'size': expected_size, 'sha256': expected_sha256}
        target = Path(target)
        with parent_fd(target, create=True) as (fd, name):
            if match_at(fd, name, record, target):
                return record
            if cache.root is not None:
                self.verify_private_bucket()
                temporary = '.cm-cache-' + uuid.uuid4().hex
                local_fd = os.open(temporary, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                   0o600, dir_fd=fd)
                try:
                    with os.fdopen(local_fd, 'w+b') as output:
                        restored = cache.restore(output, record)
                    if restored:
                        try:
                            os.link(temporary, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
                        except FileExistsError:
                            if not match_at(fd, name, record, target):
                                raise
                        os.fsync(fd)
                        return record
                finally:
                    os.unlink(temporary, dir_fd=fd)
        result = super().download_object(relative_key, target, **{
            'expected_size': expected_size, 'expected_sha256': expected_sha256})
        if cache.root is not None:
            with parent_fd(target) as (fd, name):
                # Revalidate after the original downloader before encrypting.
                if not match_at(fd, name, record, target):
                    raise ValueError('Verified input changed before cache save')
                local_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
                with os.fdopen(local_fd, 'rb') as source:
                    cache.save(source, record)
        return result
