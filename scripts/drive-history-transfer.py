"""Verified v7 transport and deterministic legacy adapter; no Supabase source writes."""
from __future__ import annotations
import argparse
import csv
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'collectors' / 'drive_history_v7'))
from history import Drive, atomic, prepare_baseline, require, sha

_spec = importlib.util.spec_from_file_location('drive_screening_transfer', Path(__file__).with_name('drive-screening-transfer.py'))
transfer = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(transfer)

ADAPTER_PART_BYTES = 40 * 1024 * 1024
MAX_ADAPTER_PARTS = 50


def prepare_run(drive, manifest_id, manifest_sha, output):
    """Preserve the exact original manifest and verified members for audit/restarts."""
    raw = drive.download(manifest_id)
    require(sha(raw) == manifest_sha, 'Run manifest hash mismatch')
    m = transfer.v7_manifest(raw)
    raw_zip = drive.download(m['files'][0]['fileId'])
    m, _, parts = transfer.inspect_v7_archive(raw_zip, raw)
    out = Path(output)
    for part in parts:
        atomic(out / 'delta' / part['name'], part['bytes'])
    atomic(out / 'run-manifest.json', raw)
    atomic(out / 'run-identity.json', json.dumps({'fileId': manifest_id, 'sha256': manifest_sha}, indent=2).encode())
    return m


def csv_line(values):
    text = io.StringIO(newline='')
    csv.writer(text, lineterminator='\n').writerow(values)
    return text.getvalue().encode('utf-8')


def coalesce_delta(manifest, output):
    """Combine only identical headers; preserve cell values and bound every output part."""
    groups = {}
    row_count = 0
    for entry in sorted(manifest['deltaMembers'], key=lambda e: e['name']):
        raw = (Path(output) / 'delta' / transfer.flat_csv_name(entry['name'])).read_bytes()
        require(len(raw) == entry['bytes'] and sha(raw) == entry['sha256'].removeprefix('sha256:'),
                'Delta member changed before adaptation')
        reader = csv.reader(io.StringIO(raw.decode('utf-8-sig'), newline=''), strict=True)
        header = next(reader, None)
        require(header and all(header) and len(set(header)) == len(header) and
                'symbol' in header and 'date' in header, 'Invalid delta CSV header')
        key = tuple(header)
        header_bytes = csv_line(header)
        require(len(header_bytes) < ADAPTER_PART_BYTES, 'Delta CSV header exceeds adapter limit')
        if key not in groups:
            require(len(groups) < MAX_ADAPTER_PARTS, 'Too many adapter header groups')
            groups[key] = [bytearray(header_bytes)]
        rows = 0
        for row in reader:
            if not row:
                continue
            require(len(row) == len(header), 'Delta CSV column count mismatch')
            encoded = csv_line(row)
            require(len(header_bytes) + len(encoded) <= ADAPTER_PART_BYTES,
                    'Delta CSV row exceeds adapter part limit')
            chunks = groups[key]
            if len(chunks[-1]) + len(encoded) > ADAPTER_PART_BYTES:
                require(sum(len(parts) for parts in groups.values()) < MAX_ADAPTER_PARTS,
                        'Too many adapter CSV parts')
                chunks.append(bytearray(header_bytes))
            chunks[-1].extend(encoded)
            rows += 1
            row_count += 1
        require(rows > 0, 'Empty delta CSV member')
    parts = []
    for chunks in groups.values():
        for chunk in chunks:
            raw = bytes(chunk)
            parts.append({'name': f'v7-input-{len(parts) + 1:03d}.csv', 'bytes': raw, 'sha256': sha(raw)})
    require(0 < len(parts) <= MAX_ADAPTER_PARTS, 'Too many adapter CSV parts')
    return parts, row_count



def require_publication_capacity(directory, checkpoint, manifest, parts):
    identities = {(manifest['runId'], part['sha256']) for part in parts}
    for parent in checkpoint['parents']:
        old = json.loads((Path(directory) / parent / 'input.json').read_text())
        identities.update((old['runId'], part['sha256']) for part in old['parts'])
    require(len(identities) <= transfer.MAX_PARENT_SOURCES,
            'Retained Drive history plus current inputs exceeds publication source limit')


def deterministic_archive(files):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, raw in sorted(files.items()):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, raw, compresslevel=9)
    return buffer.getvalue()


def build_adapter(output, manifest_id, manifest_sha):
    out = Path(output)
    raw_manifest = (out / 'run-manifest.json').read_bytes()
    require(sha(raw_manifest) == manifest_sha, 'Run manifest changed before adaptation')
    manifest = transfer.v7_manifest(raw_manifest)
    transfer.validate_group_manifest(manifest)
    parts, row_count = coalesce_delta(manifest, out)
    # Never rewrite the original. This is a separate manifest for derived transport bytes.
    derived = {key: value for key, value in manifest.items() if key not in ('deltaMembers', 'files')}
    derived.update({'csv': [{'file': part['name'], 'sha256': part['sha256'], 'bytes': len(part['bytes'])}
                            for part in parts], 'rowCount': row_count,
                    'originalV7ManifestSha256': manifest_sha, 'originalV7ManifestFileId': manifest_id,
                    'originalV7DeltaArchiveFileId': manifest['files'][0]['fileId'],
                    'originalV7DeltaArchiveSha256': manifest['files'][0]['sha256'].removeprefix('sha256:'),
                    'adapterVersion': 'v7-to-drive-screening-v1'})
    derived_raw = json.dumps(derived, ensure_ascii=False, sort_keys=True, indent=2).encode('utf-8')
    require(len(derived_raw) <= transfer.MAX_MANIFEST, 'Derived manifest exceeds publication proof limit')
    files = {'kr-outputs/' + part['name']: part['bytes'] for part in parts}
    files['kr-outputs/collection_manifest_v7_adapter.json'] = derived_raw
    files['kr-outputs/v7-origin.json'] = raw_manifest
    archive = deterministic_archive(files)
    require(len(archive) <= transfer.MAX_ARCHIVE, 'Derived archive exceeds size limit')
    # Reuse the established complete-coverage, duplicate-key and hash validator.
    verified_manifest, verified_raw, verified_parts = transfer.inspect_archive(archive, manifest['runId'])
    atomic(out / 'derived-kr-outputs.zip', archive)
    return archive, verified_manifest, verified_raw, verified_parts


def save_adapter(drive, folder, archive):
    require(isinstance(folder, str) and transfer.ID.fullmatch(folder), 'Invalid result folder ID')
    digest = sha(archive)
    name = 'v7-screening-input-' + digest + '.zip'
    found, token, seen_tokens = [], None, set()
    for _ in range(20):
        query = {'q': f"'{folder}' in parents and trashed=false and name='{name}'",
                 'pageSize': 100, 'fields': 'files(id,name),nextPageToken',
                 'supportsAllDrives': 'true', 'includeItemsFromAllDrives': 'true'}
        if token:
            query['pageToken'] = token
        page = json.loads(drive.call('files', query=query))
        require(isinstance(page, dict) and isinstance(page.get('files'), list), 'Invalid Drive artifact listing')
        found.extend(page['files'])
        require(len(found) <= 1 and all(f.get('name') == name for f in found),
                'Ambiguous derived Drive archive')
        token = page.get('nextPageToken')
        if not token:
            break
        require(isinstance(token, str) and token not in seen_tokens, 'Repeated Drive artifact page token')
        seen_tokens.add(token)
    else:
        raise ValueError('Drive artifact listing exceeds page limit')
    reused = bool(found)
    saved = found[0] if reused else drive.upload(folder, name, archive)
    archive_id = saved.get('id')
    require(isinstance(archive_id, str) and transfer.ID.fullmatch(archive_id), 'Invalid derived archive ID')
    require(sha(drive.download(archive_id)) == digest, 'Derived archive readback mismatch')
    return archive_id, digest, reused


def prepare(drive, manifest_id, manifest_sha, output, result_folder, publish=False):
    out = Path(output)
    require(not publish or manifest_id, 'Publishing requires a completed run manifest')
    require(not manifest_id or manifest_sha, 'Run SHA required')
    if manifest_id:
        require(isinstance(manifest_id, str) and transfer.ID.fullmatch(manifest_id) and
                isinstance(manifest_sha, str) and transfer.SHA256.fullmatch(manifest_sha),
                'Invalid run manifest identity')
    else:
        require(not (out / 'run-manifest.json').exists() and not (out / 'prepared/input.json').exists(),
                'Existing completed-run artifacts require a manifest identity or a new directory')
    prepare_baseline(out / 'baseline', drive=drive)
    if not manifest_id:
        return {'baselineOnly': True, 'supabaseResultMetadataGETs': 0}
    manifest = prepare_run(drive, manifest_id, manifest_sha, out)
    archive, derived, raw_manifest, parts = build_adapter(out, manifest_id, manifest_sha)
    prepared_dir = out / 'prepared'
    # Read parents even for calculation-only runs: both modes need the same full history.
    checkpoint = transfer.prepare_published_parents(drive, prepared_dir, manifest['actualLatestPriceDate'])
    require_publication_capacity(prepared_dir, checkpoint, derived, parts)
    archive_id, archive_sha, reused = save_adapter(drive, result_folder, archive)
    prepared = transfer.write_prepared_group(prepared_dir, raw_manifest, parts, run_id=derived['runId'],
        archive_id=archive_id, archive_sha=archive_sha, mode='publish' if publish else 'drive')
    prepared.update(checkpoint)
    prepared['folderId'] = result_folder
    atomic(prepared_dir / 'input.json', json.dumps(prepared, ensure_ascii=False, indent=2).encode('utf-8'))
    receipt = {'version': 'v7-drive-adapter-receipt-v1', 'originalManifestFileId': manifest_id,
               'originalManifestSha256': manifest_sha, 'archiveFileId': archive_id,
               'archiveSha256': archive_sha, 'derivedManifestSha256': sha(raw_manifest),
               'parts': len(parts), 'parentGroups': len(checkpoint['parents']),
               'reusedArchive': reused, 'sourceUploadsToSupabase': 0,
               'supabaseResultMetadataGETs': 1}
    atomic(out / 'adapter-receipt.json', json.dumps(receipt, ensure_ascii=False, indent=2).encode('utf-8'))
    return receipt


def main():
    p = argparse.ArgumentParser()
    p.add_argument('action', choices=['prepare', 'save'])
    p.add_argument('--directory', default='drive-history-work')
    p.add_argument('--manifest-id')
    p.add_argument('--manifest-sha')
    p.add_argument('--result-folder', required=True)
    p.add_argument('--publish', action='store_true')
    a = p.parse_args()
    d, out = Drive(), Path(a.directory)
    if a.action == 'prepare':
        receipt = prepare(d, a.manifest_id, a.manifest_sha, out, a.result_folder, a.publish)
        atomic(out / 'drive-network-receipt.json', json.dumps({'reads': d.reads,
            'historicalSupabaseGETs': 0, 'supabaseResultMetadataGETs': receipt['supabaseResultMetadataGETs']}).encode())
    else:
        files = [f for f in out.rglob('*.json') if f.name in ('execution-receipt.json', 'validation-receipt.json',
                 'screening-bundle.json', 'screening-summary.json', 'drive-network-receipt.json', 'adapter-receipt.json')]
        require(files, 'No results to save')
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as z:
            for f in files:
                z.write(f, str(f.relative_to(out)))
        attempt = os.environ.get('GITHUB_RUN_ID', 'local') + '-' + os.environ.get('GITHUB_RUN_ATTEMPT', '1')
        saved = d.upload(a.result_folder, 'drive-history-result-' + attempt + '.zip', buffer.getvalue())
        print(json.dumps({'resultFileId': saved['id'], 'readbackVerified': True}))


if __name__ == '__main__':
    main()
