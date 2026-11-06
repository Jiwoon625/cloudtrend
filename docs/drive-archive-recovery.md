# Read historical objects after the Storage archive migration

The daily history UI reads database snapshots; it does not dereference
`analysis_runs.result_path`. Historical diagnostics and recovery commands do.
Keep those original paths and frozen provenance unchanged. Do not upload every
old bundle back into the operational Storage bucket.

CLI JSON readers, KOSPI historical source reads, and the bounded recovery
transport now accept a verified mounted-Drive archive **only after a missing
historical object response**. Live objects remain authoritative. Authentication,
permission, network and server failures are not replaced with old data.
Mutable serving caches, database reads and HEAD generation checks cannot use
the archive. Existing frozen input/manifest checks still run after the read.
The KOSPI executable admission remains an exact reviewed runtime digest; the
Python helper's source hash is pinned inside that runtime. Live generation
checks for publishing recovered evidence are still required and cannot be
substituted by an archive read.

Set these variables in the process running a historical command:

```bash
export CLOUDTREND_DRIVE_ARCHIVE_INDEX=/absolute/CloudTrend/99_Storage이관_20261106/archive-index.json
export CLOUDTREND_DRIVE_ARCHIVE_INDEX_SHA256=<reviewed-full-index-sha256>
export CLOUDTREND_DRIVE_ROOT=/absolute/CloudTrend
```

`CLOUDTREND_ARCHIVE_OBJECT_ROOT` optionally points to a previously extracted
archive tree containing the full original owner/path keys. Each object is
checked against the pinned index's size and SHA256 on every read. Without
that option, Python 3.11+ reads the mounted ZIPs, checks all numbered split
parts and reconstructed ZIP hashes, and verifies the requested member. Set
`CLOUDTREND_ARCHIVE_PYTHON` when `python3` is not the intended interpreter.
`CLOUDTREND_ARCHIVE_CACHE` selects the local ZIP cache (default: system temp).
These paths are local or mounted private Drive paths, never public links.

The index hash is mandatory. A corrupt index, missing ZIP part, bad object,
unsafe path, escaped symlink or oversized read stops the operation. No
Supabase or Drive objects, registries, run records or ledgers are modified by
the fallback reader. Unconfigured processes retain their original missing
object error; use the supplied private Drive launcher for the archived data.

Validation:

```bash
npx vitest run --config vitest.archive.config.ts
python3 -m unittest discover -s tests -p 'drive_archive_reader_test.py'
```
