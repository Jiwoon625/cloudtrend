"""Optional AES-GCM cache of hash-verified input/evidence objects only.

The public repository's Actions cache contains ciphertext, never research data,
credentials, checkpoint state, filenames, or an encryption key. Cache is advisory:
failed authentication or a pinned hash mismatch falls back to Storage.
"""
import hashlib
import os
from pathlib import Path
import stat
import subprocess
import uuid

CIPHER = Path(__file__).with_name('cache_cipher.mjs')


class InputCache:
    def __init__(self, store, relative_key):
        self.root = None
        configured = os.environ.get('CM_ENCRYPTED_INPUT_CACHE')
        if configured and relative_key.split('/', 1)[0] in {'inputs', 'evidence'}:
            root = Path(configured).absolute()
            if any(p.is_symlink() for p in (root, *root.parents)):
                raise ValueError('Cache directory cannot be a symlink')
            root.mkdir(parents=True, exist_ok=True, mode=0o700)
            self.root = root
        self.env = {**os.environ, 'CM_CACHE_SECRET': store._key,
                    'CM_CACHE_ORIGIN': store._url,
                    'CM_CACHE_USER': store.prefix.split('/')[0]}

    def _run(self, mode, digest, size, source, output):
        subprocess.run(['node', str(CIPHER), mode, digest, str(size)],
                       stdin=source, stdout=output, stderr=subprocess.DEVNULL,
                       env=self.env, check=True, timeout=600)

    def _mark_repair(self):
        try:
            marker = os.open(self.root / 'repair-needed',
                             os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            os.close(marker)
        except OSError:
            # A poisoned marker must not prevent verified Storage fallback.
            pass

    def restore(self, output, record):
        if self.root is None:
            return False
        path = self.root / (record['sha256'] + '.enc')
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, 'rb') as source:
                info = os.fstat(source.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size != record['size'] + 28:
                    raise ValueError('Invalid envelope')
                self._run('open', record['sha256'], record['size'], source, output)
            output.flush()
            output.seek(0)
            digest = hashlib.file_digest(output, 'sha256').hexdigest()
            if os.fstat(output.fileno()).st_size != record['size'] or digest != record['sha256']:
                raise ValueError('Cache does not match pinned input')
            os.fsync(output.fileno())
            print('CM_INPUT_CACHE_HIT bytes=' + str(record['size']), flush=True)
            return True
        except FileNotFoundError:
            self._mark_repair()
            return False
        except (OSError, ValueError, subprocess.SubprocessError):
            # Publication is handled by storage.py only after this returns True.
            output.seek(0)
            output.truncate()
            self._mark_repair()
            print('CM_INPUT_CACHE_REJECTED', flush=True)
            return False

    def save(self, source, record):
        if self.root is None:
            return
        temporary = self.root / ('.pending-' + uuid.uuid4().hex)
        try:
            source.flush()
            source.seek(0)
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as output:
                self._run('seal', record['sha256'], record['size'], source, output)
            os.replace(temporary, self.root / (record['sha256'] + '.enc'))
            print('CM_INPUT_CACHE_FILLED bytes=' + str(record['size']), flush=True)
        except (OSError, subprocess.SubprocessError):
            # Caching cannot turn a verified research input into a failed run.
            print('CM_INPUT_CACHE_SAVE_UNAVAILABLE', flush=True)
        finally:
            temporary.unlink(missing_ok=True)
